package account

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const maxWebChatBodyBytes = 32 << 20

func (h *HTTPHandler) registerWebChat(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-settings", h.withSession(h.getWebSettings))
	mux.HandleFunc("PATCH /api/web-settings", h.withSession(h.updateWebSettings))
	mux.HandleFunc("GET /api/web-chat/conversations", h.withSession(h.listCloudConversations))
	mux.HandleFunc("POST /api/web-chat/conversations", h.withSession(h.createCloudConversation))
	mux.HandleFunc("PATCH /api/web-chat/conversations/{id}", h.withSession(h.updateCloudConversation))
	mux.HandleFunc("DELETE /api/web-chat/conversations/{id}", h.withSession(h.deleteCloudConversation))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/messages", h.withSession(h.listCloudMessages))
	mux.HandleFunc("POST /api/web-chat/completions", h.withSession(h.streamCloudCompletion))
	mux.HandleFunc("GET /api/web-chat/provider-keys/{id}/models", h.withSession(h.webProviderModels))
}

func (h *HTTPHandler) webProviderModels(w http.ResponseWriter, r *http.Request, session *Session) {
	keyID, err := strconv.ParseInt(strings.TrimSpace(r.PathValue("id")), 10, 64)
	if err != nil || keyID <= 0 {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "invalid API key ID"})
		return
	}
	models, err := h.service.WebProviderModels(r.Context(), session, keyID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

func (h *HTTPHandler) updateCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Title string `json:"title"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	conversation, err := h.service.RenameCloudConversation(
		r.Context(),
		session.UserID,
		r.PathValue("id"),
		request.Title,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": conversation})
}

func (h *HTTPHandler) getWebSettings(w http.ResponseWriter, r *http.Request, session *Session) {
	settings, err := h.service.WebSettings(r.Context(), session.UserID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (h *HTTPHandler) updateWebSettings(w http.ResponseWriter, r *http.Request, session *Session) {
	var request WebSettings
	if !decodeRequest(w, r, &request) {
		return
	}
	settings, err := h.service.UpdateWebSettings(r.Context(), session.UserID, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (h *HTTPHandler) listCloudConversations(w http.ResponseWriter, r *http.Request, session *Session) {
	items, err := h.service.ListCloudConversations(r.Context(), session.UserID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": items})
}

func (h *HTTPHandler) createCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Model string `json:"model"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	conversation, err := h.service.CreateCloudConversation(r.Context(), session.UserID, request.Model)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"conversation": conversation})
}

func (h *HTTPHandler) deleteCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := h.service.DeleteCloudConversation(r.Context(), session.UserID, r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) listCloudMessages(w http.ResponseWriter, r *http.Request, session *Session) {
	items, err := h.service.CloudMessages(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		if err == ErrNotFound {
			writeError(w, &APIError{Status: http.StatusNotFound, Message: "conversation not found"})
		} else {
			writeError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": items})
}

func (h *HTTPHandler) streamCloudCompletion(w http.ResponseWriter, r *http.Request, session *Session) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWebChatBodyBytes)
	var request struct {
		ConversationID  string          `json:"conversation_id"`
		Model           string          `json:"model"`
		Content         json.RawMessage `json:"content"`
		ReasoningEffort string          `json:"reasoning_effort,omitempty"`
	}
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&request); err != nil || len(request.Content) == 0 {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "conversation_id, model and content are required"})
		return
	}
	conversation, err := h.service.store.GetCloudConversation(r.Context(), session.UserID, strings.TrimSpace(request.ConversationID))
	if err != nil {
		writeError(w, &APIError{Status: http.StatusNotFound, Message: "conversation not found"})
		return
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = "gpt-5.1"
	}
	now := time.Now().UTC()
	userMessage := &CloudMessage{
		ID: uuid.NewString(), ConversationID: conversation.ID, UserID: session.UserID,
		Role: "user", Content: append([]byte(nil), request.Content...), CreatedAt: now,
	}
	if err := h.service.AddCloudMessage(r.Context(), userMessage); err != nil {
		writeError(w, err)
		return
	}
	if conversation.Title == "" || conversation.Title == "新对话" {
		conversation.Title = cloudConversationTitle(request.Content)
	}
	conversation.Model = model
	conversation.UpdatedAt = now
	_ = h.service.UpdateCloudConversation(r.Context(), conversation)

	messages, err := h.service.CloudMessages(r.Context(), session.UserID, conversation.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	upstreamMessages := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		var content any
		if err := json.Unmarshal(message.Content, &content); err != nil {
			continue
		}
		upstreamMessages = append(upstreamMessages, map[string]any{"role": message.Role, "content": content})
	}
	payload := map[string]any{
		"model": model, "messages": upstreamMessages, "stream": true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if effort := strings.TrimSpace(request.ReasoningEffort); effort != "" {
		payload["reasoning_effort"] = effort
	}
	_, _ = h.service.UpdateWebSettings(r.Context(), session.UserID, WebSettings{
		Model: model, ReasoningEffort: request.ReasoningEffort,
	})
	encoded, _ := json.Marshal(payload)
	apiKey, err := h.service.WebAPIKey(r.Context(), session)
	if err != nil {
		writeError(w, err)
		return
	}
	upstream, err := h.service.usa.StreamChatCompletion(r.Context(), apiKey, encoded)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = upstream.Body.Close() }()
	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(upstream.Body, 1<<20))
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(upstream.StatusCode)
		_, _ = w.Write(body)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := w.(http.Flusher)
	reader := bufio.NewReader(upstream.Body)
	var assistant bytes.Buffer
	var usage json.RawMessage
	for {
		line, readErr := reader.ReadString('\n')
		if line != "" {
			_, _ = io.WriteString(w, line)
			if flusher != nil {
				flusher.Flush()
			}
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "data:") {
				data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
				if data != "[DONE]" {
					var chunk struct {
						Choices []struct {
							Delta struct {
								Content string `json:"content"`
							} `json:"delta"`
						} `json:"choices"`
						Usage json.RawMessage `json:"usage"`
					}
					if json.Unmarshal([]byte(data), &chunk) == nil {
						for _, choice := range chunk.Choices {
							assistant.WriteString(choice.Delta.Content)
						}
						if len(chunk.Usage) > 0 && string(chunk.Usage) != "null" {
							usage = append([]byte(nil), chunk.Usage...)
						}
					}
				}
			}
		}
		if readErr != nil {
			break
		}
	}
	if assistant.Len() > 0 {
		persistCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		content, _ := json.Marshal(assistant.String())
		_ = h.service.AddCloudMessage(persistCtx, &CloudMessage{
			ID: uuid.NewString(), ConversationID: conversation.ID, UserID: session.UserID,
			Role: "assistant", Content: content, Usage: usage, CreatedAt: time.Now().UTC(),
		})
	}
}

func cloudConversationTitle(content json.RawMessage) string {
	var text string
	if json.Unmarshal(content, &text) != nil {
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(content, &parts) == nil {
			for _, part := range parts {
				if part.Type == "text" {
					text += part.Text
				}
			}
		}
	}
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return "新对话"
	}
	runes := []rune(text)
	if len(runes) > 48 {
		return string(runes[:48]) + "..."
	}
	return text
}
