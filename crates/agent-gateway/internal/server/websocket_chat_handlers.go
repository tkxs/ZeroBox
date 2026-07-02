package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

type chatSubscription struct {
	runID          string
	conversationID string
	sub            *session.ChatRunSubscribeResult
	cancel         context.CancelFunc
}

func (c *websocketConnection) handleChatSubscribe(req websocketRequest) {
	var payload struct {
		RunID          string `json:"run_id"`
		ConversationID string `json:"conversation_id"`
		AfterSeq       int64  `json:"after_seq"`
	}
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.subscribe payload")
		return
	}
	payload.RunID = strings.TrimSpace(payload.RunID)
	payload.ConversationID = strings.TrimSpace(payload.ConversationID)
	if payload.RunID == "" && payload.ConversationID == "" {
		_ = c.writeError(req.ID, "run_id or conversation_id is required")
		return
	}

	sub, err := c.sm.SubscribeChatRun(payload.RunID, payload.ConversationID, payload.AfterSeq)
	if err != nil {
		if errors.Is(err, session.ErrChatRunNotFound) {
			_ = c.writeError(req.ID, "chat run not found")
		} else {
			_ = c.writeError(req.ID, websocketErrorMessage(err))
		}
		return
	}

	subID := "chat-sub-" + uuid.NewString()[:8]
	ctx, cancel := context.WithCancel(context.Background())

	c.chatSubsMu.Lock()
	if c.chatSubs == nil {
		c.chatSubs = make(map[string]*chatSubscription)
	}
	c.chatSubs[subID] = &chatSubscription{
		runID:          sub.Snapshot.RequestID,
		conversationID: sub.Snapshot.ConversationID,
		sub:            sub,
		cancel:         cancel,
	}
	c.chatSubsMu.Unlock()

	resp := map[string]any{
		"subscription_id": subID,
		"snapshot": map[string]any{
			"run_id":          sub.Snapshot.RequestID,
			"conversation_id": sub.Snapshot.ConversationID,
			"state":           sub.Snapshot.State,
			"latest_seq":      sub.Snapshot.LatestSeq,
		},
	}
	if sub.GapDetected {
		resp["gap"] = true
		resp["oldest_buffered_seq"] = sub.OldestSeq
	}
	_ = c.writeResponse(req.ID, resp)

	go c.forwardChatEvents(ctx, subID, sub)
}

func (c *websocketConnection) forwardChatEvents(ctx context.Context, subID string, sub *session.ChatRunSubscribeResult) {
	defer sub.Cleanup()
	defer func() {
		_ = c.writeEvent("chat.subscription_end", map[string]any{
			"subscription_id": subID,
		})
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		case <-sub.Done:
			c.drainChatSubscriptionEvents(subID, sub)
			return
		case event, ok := <-sub.EventCh:
			if !ok {
				return
			}
			payload, terminal := chatBroadcastPayload(event)
			if payload == nil {
				continue
			}
			payload["subscription_id"] = subID
			payload["seq"] = event.Seq
			payload["run_id"] = strings.TrimSpace(event.RequestID)
			if err := c.writeEvent("chat.event", payload); err != nil {
				return
			}
			if terminal {
				return
			}
		}
	}
}

func (c *websocketConnection) handleChatUnsubscribe(req websocketRequest) {
	var payload struct {
		SubscriptionID string `json:"subscription_id"`
	}
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.unsubscribe payload")
		return
	}
	payload.SubscriptionID = strings.TrimSpace(payload.SubscriptionID)

	c.chatSubsMu.Lock()
	if cs, ok := c.chatSubs[payload.SubscriptionID]; ok {
		cs.cancel()
		delete(c.chatSubs, payload.SubscriptionID)
	}
	c.chatSubsMu.Unlock()

	_ = c.writeResponse(req.ID, map[string]any{"ok": true})
}

func (c *websocketConnection) handleChatCommand(req websocketRequest) {
	commandType, body, baseMessageRef, err := decodeChatCommandPayload(req.Payload)
	if err != nil {
		_ = c.writeError(req.ID, "invalid chat command payload")
		return
	}

	switch commandType {
	case "chat.submit":
		baseMessageRef = nil
	case "chat.edit_resend":
		if baseMessageRef == nil {
			_ = c.writeError(req.ID, "base_message_ref is required")
			return
		}
		if err := validateChatMessageRef(baseMessageRef); err != nil {
			_ = c.writeError(req.ID, err.Error())
			return
		}
	case "chat.cancel":
		c.handleChatCancel(req)
		return
	default:
		_ = c.writeError(req.ID, "unsupported chat command")
		return
	}

	if err := normalizeChatRequestBody(&body); err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	requestID := "chat-command-" + uuid.NewString()
	initialPayloads := buildAcceptedChatCommandPayloads(body, baseMessageRef)
	start, err := startAcceptedChatCommand(c.sm, requestID, body, initialPayloads)
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"run_id":          start.RunID,
		"conversation_id": start.ConversationID,
		"state":           start.State,
		"accepted_seq":    start.AcceptedSeq,
		"deduped":         !start.Created,
	})

	if start.Created {
		go dispatchAcceptedChatCommand(context.Background(), c.cfg, c.sm, start, body, baseMessageRef, newChatTraceID())
	}
}

func (c *websocketConnection) handleChatCancel(req websocketRequest) {
	var payload struct {
		ConversationID string `json:"conversation_id"`
		RunID          string `json:"run_id"`
	}
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.cancel payload")
		return
	}
	payload.ConversationID = strings.TrimSpace(payload.ConversationID)
	payload.RunID = strings.TrimSpace(payload.RunID)
	if payload.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	runID := payload.RunID
	if runID == "" {
		if snapshot, ok := c.sm.RunningChatRunSnapshot(payload.ConversationID); ok {
			runID = strings.TrimSpace(snapshot.RequestID)
		}
	}
	if runID == "" {
		_ = c.writeResponse(req.ID, map[string]any{"ok": true, "run_id": "", "conversation_id": payload.ConversationID})
		return
	}

	timeout := 10 * time.Second
	if c.cfg != nil && c.cfg.WebSocketWriteTimeout > 0 {
		timeout = c.cfg.WebSocketWriteTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := c.sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: runID,
		Timestamp: time.Now().Unix(),
		Payload:   buildChatCancelCommandPayload(payload.ConversationID),
	}); err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	c.sm.MarkChatRunControl(runID, payload.ConversationID, "cancelled", "", "")
	_ = c.writeResponse(req.ID, map[string]any{"ok": true, "run_id": runID, "conversation_id": payload.ConversationID})
}

func (c *websocketConnection) handleChatReplay(req websocketRequest) {
	var payload struct {
		RunID          string `json:"run_id"`
		ConversationID string `json:"conversation_id"`
		AfterSeq       int64  `json:"after_seq"`
	}
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid chat.replay payload")
		return
	}
	payload.RunID = strings.TrimSpace(payload.RunID)
	payload.ConversationID = strings.TrimSpace(payload.ConversationID)
	if payload.ConversationID == "" {
		_ = c.writeError(req.ID, "conversation_id is required")
		return
	}

	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	replayRequestID := "chat-replay-" + uuid.NewString()[:8]
	timeout := 30 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	env, err := awaitAgentUnaryResponse(ctx, c.sm, replayRequestID, &gatewayv1.GatewayEnvelope{
		RequestId: replayRequestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ChatEventReplay{
			ChatEventReplay: &gatewayv1.ChatEventReplayRequest{
				RunId:          payload.RunID,
				ConversationId: payload.ConversationID,
				AfterSeq:       payload.AfterSeq,
			},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	replayResp := env.GetChatEventReplayResp()
	if replayResp == nil {
		_ = c.writeError(req.ID, "unexpected replay response")
		return
	}

	events := make([]map[string]any, 0, len(replayResp.GetEvents()))
	for _, re := range replayResp.GetEvents() {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(re.GetEventJson()), &parsed); err != nil {
			continue
		}
		parsed["seq"] = re.GetSeq()
		events = append(events, parsed)
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"run_id":          replayResp.GetRunId(),
		"conversation_id": replayResp.GetConversationId(),
		"events":          events,
		"complete":        replayResp.GetComplete(),
	})
}

func (c *websocketConnection) drainChatSubscriptionEvents(subID string, sub *session.ChatRunSubscribeResult) {
	for {
		select {
		case event, ok := <-sub.EventCh:
			if !ok {
				return
			}
			payload, _ := chatBroadcastPayload(event)
			if payload == nil {
				continue
			}
			payload["subscription_id"] = subID
			payload["seq"] = event.Seq
			payload["run_id"] = strings.TrimSpace(event.RequestID)
			_ = c.writeEvent("chat.event", payload)
		default:
			return
		}
	}
}

func (c *websocketConnection) cleanupChatSubscriptions() {
	c.chatSubsMu.Lock()
	for id, cs := range c.chatSubs {
		cs.cancel()
		delete(c.chatSubs, id)
	}
	c.chatSubsMu.Unlock()
}

