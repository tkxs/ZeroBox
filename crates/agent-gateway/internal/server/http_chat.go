package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

const maxChatCommandBytes = 2 * 1024 * 1024
const maxChatCommandsPerMinute = 120

func chatCommandsHTTP(cfg *config.Config, sm *session.Manager, limiter *chatRateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !allowStateChangingRequest(w, r) {
			return
		}
		if limiter != nil && !limiter.allow(chatRateLimitKey(r, "chat.commands"), maxChatCommandsPerMinute, time.Minute, time.Now()) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "chat command rate limit exceeded"})
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChatCommandBytes))
		if err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "chat command payload is too large"})
			return
		}
		commandType, body, baseMessageRef, err := decodeChatCommandPayload(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid chat command payload"})
			return
		}

		switch commandType {
		case "chat.submit":
			baseMessageRef = nil
		case "chat.edit_resend":
			if baseMessageRef == nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "base_message_ref is required"})
				return
			}
			if err := validateChatMessageRef(baseMessageRef); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
		case "chat.cancel":
			handleChatCancelCommandHTTP(w, r, cfg, sm, raw)
			return
		default:
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported chat command"})
			return
		}

		if err := normalizeChatRequestBody(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		traceID := newChatTraceID()
		logChatCommandSpan(traceID, "command_received", "", body.ConversationID, body.ClientRequestID, commandType)
		if !sm.IsOnline() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "agent offline"})
			return
		}

		requestID := "chat-command-" + uuid.NewString()
		initialPayloads := buildAcceptedChatCommandPayloads(body, baseMessageRef)
		start, err := startAcceptedChatCommand(sm, requestID, body, initialPayloads)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": websocketErrorMessage(err)})
			return
		}
		if start.Created {
			logChatCommandSpan(traceID, "initial_persist_done", start.RunID, start.ConversationID, body.ClientRequestID, commandType)
			go dispatchAcceptedChatCommand(context.Background(), cfg, sm, start, body, baseMessageRef, traceID)
		} else {
			logChatCommandSpan(traceID, "command_deduped", start.RunID, start.ConversationID, body.ClientRequestID, commandType)
		}

		writeJSON(w, http.StatusAccepted, map[string]any{
			"run_id":            start.RunID,
			"conversation_id":   start.ConversationID,
			"client_request_id": body.ClientRequestID,
			"accepted_seq":      start.AcceptedSeq,
			"state":             start.State,
			"deduped":           !start.Created,
		})
	}
}

func handleChatCancelCommandHTTP(
	w http.ResponseWriter,
	r *http.Request,
	cfg *config.Config,
	sm *session.Manager,
	raw []byte,
) {
	type cancelPayload struct {
		Type    string `json:"type"`
		Payload *struct {
			RunID          string `json:"run_id"`
			ConversationID string `json:"conversation_id"`
		} `json:"payload"`
	}
	var payload cancelPayload
	if err := decodeStrictJSON(raw, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid chat.cancel payload"})
		return
	}
	if strings.TrimSpace(payload.Type) != "chat.cancel" || payload.Payload == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid chat.cancel payload"})
		return
	}
	conversationID := strings.TrimSpace(payload.Payload.ConversationID)
	runID := strings.TrimSpace(payload.Payload.RunID)
	if conversationID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "conversation_id is required"})
		return
	}
	if !sm.IsOnline() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "agent offline"})
		return
	}
	if runID == "" {
		if snapshot, ok := sm.RunningChatRunSnapshot(conversationID); ok {
			runID = strings.TrimSpace(snapshot.RequestID)
			if conversationID == "" {
				conversationID = strings.TrimSpace(snapshot.ConversationID)
			}
		}
	}
	if runID == "" {
		writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "run_id": "", "conversation_id": conversationID})
		return
	}
	requestID := runID
	timeout := 10 * time.Second
	if cfg != nil && cfg.WebSocketWriteTimeout > 0 {
		timeout = cfg.WebSocketWriteTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	if err := sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload:   buildChatCancelCommandPayload(conversationID),
	}); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": websocketErrorMessage(err)})
		return
	}
	if runID != "" {
		sm.MarkChatRunControl(runID, conversationID, "cancelled", "", "")
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "run_id": runID, "conversation_id": conversationID})
}


func chatBroadcastPayload(event *session.ChatBroadcastEvent) (map[string]any, bool) {
	if len(event.Payload) > 0 {
		payload := cloneChatPayload(event.Payload)
		if seq := event.Seq; seq > 0 {
			payload["seq"] = seq
		}
		if len(event.Workdir) > 0 {
			if workdir := strings.TrimSpace(event.Workdir); workdir != "" {
				payload["workdir"] = workdir
			}
		}
		trimLargeToolContentForSSE(payload, "")
		return publicChatPayload(payload), isTerminalChatPayload(payload)
	}
	if event.Control != nil {
		payload := chatControlPayload(event.Control, event.Seq, event.Workdir)
		return publicChatPayload(payload), isTerminalChatControlPayload(event.Control)
	}
	if event.Event != nil {
		payload := chatEventPayload(event.Event, event.Seq, event.Workdir)
		return publicChatPayload(payload), event.Event.GetType() == gatewayv1.ChatEvent_DONE ||
			event.Event.GetType() == gatewayv1.ChatEvent_ERROR
	}
	return nil, false
}

func isTerminalChatPayload(payload map[string]any) bool {
	eventType, _ := payload["type"].(string)
	switch strings.TrimSpace(eventType) {
	case "done", "completed", "error", "failed", "cancelled":
		return true
	case "runtime_snapshot":
		state, _ := payload["state"].(string)
		switch strings.TrimSpace(state) {
		case "completed", "failed", "cancelled":
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func cloneChatPayload(input map[string]any) map[string]any {
	if len(input) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func publicChatPayload(payload map[string]any) map[string]any {
	delete(payload, "request_id")
	return payload
}

func parseAfterSeq(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
		return parsed
	}
	return 0
}

func allowStateChangingRequest(w http.ResponseWriter, r *http.Request) bool {
	if !originAllowed(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden origin"})
		return false
	}
	if strings.TrimSpace(r.Header.Get("X-LiveAgent-CSRF")) == "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing csrf header"})
		return false
	}
	return true
}

func originAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	requestURL := requestURLForOriginCheck(r)
	if requestURL == nil {
		return false
	}
	if sameOrigin(parsed, requestURL) {
		return true
	}
	originHost := strings.TrimSpace(parsed.Hostname())
	requestHost := strings.TrimSpace(requestURL.Hostname())
	if originHost == "" || requestHost == "" {
		return false
	}
	return isLoopbackHost(originHost) && isLoopbackHost(requestHost)
}

func requestURLForOriginCheck(r *http.Request) *url.URL {
	if r == nil {
		return nil
	}
	scheme := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	scheme = strings.ToLower(strings.TrimSpace(strings.Split(scheme, ",")[0]))
	switch scheme {
	case "http", "https":
	default:
		return nil
	}
	host := strings.TrimSpace(r.Host)
	if host == "" {
		return nil
	}
	return &url.URL{Scheme: scheme, Host: host}
}

func sameOrigin(a *url.URL, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(a.Scheme), strings.TrimSpace(b.Scheme)) {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(a.Hostname()), strings.TrimSpace(b.Hostname())) {
		return false
	}
	return originPort(a) == originPort(b)
}

func originPort(u *url.URL) string {
	if u == nil {
		return ""
	}
	if port := strings.TrimSpace(u.Port()); port != "" {
		return port
	}
	switch strings.ToLower(strings.TrimSpace(u.Scheme)) {
	case "http", "ws":
		return "80"
	case "https", "wss":
		return "443"
	default:
		return ""
	}
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
