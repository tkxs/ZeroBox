package account

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxRequestBodyBytes = 2 << 20

type HTTPHandler struct {
	service      *Service
	cookieSecure bool
}

func NewHTTPHandler(service *Service, cookieSecure bool) *HTTPHandler {
	return &HTTPHandler{service: service, cookieSecure: cookieSecure}
}

func (h *HTTPHandler) Register(mux *http.ServeMux) {
	h.registerWebChat(mux)
	mux.HandleFunc("GET /api/auth/settings", h.publicSettings)
	mux.HandleFunc("POST /api/auth/send-verify-code", h.sendVerifyCode)
	mux.HandleFunc("POST /api/auth/register", h.registerAccount)
	mux.HandleFunc("POST /api/auth/login", h.login)
	mux.HandleFunc("GET /api/auth/handoff", h.consumeDesktopHandoff)
	mux.HandleFunc("POST /api/auth/2fa", h.login2FA)
	mux.HandleFunc("POST /api/auth/refresh", h.withSession(h.refresh))
	mux.HandleFunc("POST /api/auth/logout", h.logout)
	mux.HandleFunc("GET /api/auth/me", h.withSession(h.me))
	mux.HandleFunc("GET /api/environments", h.withSession(h.environments))
	mux.HandleFunc("GET /api/conversation-routes", h.withSession(h.conversationRoutes))
	mux.HandleFunc("POST /api/execution-target/step-up", h.withSession(h.issueStepUp))
	mux.HandleFunc("POST /api/execution-target/select", h.withSession(h.selectTarget))
	mux.HandleFunc("POST /api/devices/register", h.withSession(h.registerDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", h.withSession(h.renameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", h.withSession(h.revokeDevice))
	mux.HandleFunc("/api/usa-zero/", h.withSession(h.proxyUSAZero))
	mux.HandleFunc("POST /api/desktop/devices/register", h.withDesktopSession(h.registerDevice))
	mux.HandleFunc("PATCH /api/desktop/devices/{id}", h.withDesktopSession(h.renameDevice))
	mux.HandleFunc("DELETE /api/desktop/devices/{id}", h.withDesktopSession(h.revokeDevice))
	mux.HandleFunc("GET /api/desktop/environments", h.withDesktopSession(h.desktopEnvironments))
	mux.HandleFunc("GET /api/desktop/conversation-routes", h.withDesktopSession(h.conversationRoutes))
	mux.HandleFunc("POST /api/desktop/execution-target/step-up", h.withDesktopSession(h.issueStepUp))
	mux.HandleFunc("POST /api/desktop/execution-target/select", h.withDesktopSession(h.selectTarget))
	mux.HandleFunc("POST /api/desktop/handoff", h.withDesktopSession(h.createDesktopHandoff))
}

func (h *HTTPHandler) publicSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.service.PublicSettings(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, settings)
}

func (h *HTTPHandler) sendVerifyCode(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Email string `json:"email"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, err := h.service.SendVerifyCode(r.Context(), request.Email)
	if err != nil {
		writeError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, result)
}

func (h *HTTPHandler) registerAccount(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Email          string `json:"email"`
		Password       string `json:"password"`
		VerifyCode     string `json:"verify_code"`
		InvitationCode string `json:"invitation_code"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, session, err := h.service.Register(
		r.Context(), request.Email, request.Password, request.VerifyCode, request.InvitationCode,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", result.User)
}

func (h *HTTPHandler) conversationRoutes(w http.ResponseWriter, r *http.Request, session *Session) {
	routes, err := h.service.ConversationRoutesForDevice(r.Context(), session.UserID, r.URL.Query().Get("device_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": routes})
}

func (h *HTTPHandler) login(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, session, err := h.service.Login(r.Context(), request.Email, request.Password)
	if err != nil {
		writeError(w, err)
		return
	}
	if result.Requires2FA {
		writeJSON(w, http.StatusOK, map[string]any{
			"requires_2fa": true, "temp_token": result.TempToken, "user_email_masked": result.UserEmailMasked,
		})
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", result.User)
}

func (h *HTTPHandler) login2FA(w http.ResponseWriter, r *http.Request) {
	var request struct {
		TempToken string `json:"temp_token"`
		TOTPCode  string `json:"totp_code"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, session, err := h.service.Login2FA(r.Context(), request.TempToken, request.TOTPCode)
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", result.User)
}

func (h *HTTPHandler) createDesktopHandoff(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		SelectionLease string `json:"selection_lease"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	code, err := h.service.CreateDesktopHandoff(r.Context(), session, request.SelectionLease)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"handoff_code": code, "expires_in": 60})
}

func (h *HTTPHandler) consumeDesktopHandoff(w http.ResponseWriter, r *http.Request) {
	session, lease, err := h.service.ConsumeDesktopHandoff(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	query := url.Values{}
	query.Set("selection_lease", lease.ID)
	query.Set("runtime_kind", lease.RuntimeKind)
	query.Set("device_id", lease.DeviceID)
	query.Set("workspace_id", lease.WorkspaceID)
	query.Set("conversation_id", lease.ConversationID)
	if r.URL.Query().Get("controller_surface") == "desktop_embed" {
		query.Set("controller_surface", "desktop_embed")
		query.Set("local_device_id", r.URL.Query().Get("local_device_id"))
	}
	http.Redirect(w, r, "/?"+query.Encode(), http.StatusSeeOther)
}

func (h *HTTPHandler) refresh(w http.ResponseWriter, r *http.Request, session *Session) {
	updated, err := h.service.Refresh(r.Context(), session.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, updated)
	writeRawObject(w, http.StatusOK, "user", updated.User)
}

func (h *HTTPHandler) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(SessionCookieName); err == nil {
		_ = h.service.Logout(r.Context(), cookie.Value)
	}
	h.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) me(w http.ResponseWriter, r *http.Request, session *Session) {
	user, err := h.service.RefreshUser(r.Context(), session)
	if err != nil {
		writeError(w, err)
		return
	}
	writeRawObject(w, http.StatusOK, "user", user)
}

func (h *HTTPHandler) environments(w http.ResponseWriter, r *http.Request, session *Session) {
	desktop := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("surface")), "desktop")
	environments, err := h.service.Environments(r.Context(), session.UserID, desktop, r.URL.Query().Get("local_device_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"environments": environments})
}

func (h *HTTPHandler) desktopEnvironments(w http.ResponseWriter, r *http.Request, session *Session) {
	environments, err := h.service.Environments(r.Context(), session.UserID, true, r.URL.Query().Get("local_device_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"environments": environments})
}

func (h *HTTPHandler) issueStepUp(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Password          string `json:"password"`
		TargetFingerprint string `json:"target_fingerprint"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, err := h.service.IssueStepUp(r.Context(), session, request.Password, request.TargetFingerprint)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result)
}

func (h *HTTPHandler) selectTarget(w http.ResponseWriter, r *http.Request, session *Session) {
	var request SelectTargetInput
	if !decodeRequest(w, r, &request) {
		return
	}
	lease, err := h.service.SelectTarget(r.Context(), session, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

func (h *HTTPHandler) registerDevice(w http.ResponseWriter, r *http.Request, session *Session) {
	var request RegisterDeviceInput
	if !decodeRequest(w, r, &request) {
		return
	}
	device, credential, err := h.service.RegisterDevice(r.Context(), session.UserID, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": device, "device_credential": credential})
}

func (h *HTTPHandler) renameDevice(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Name string `json:"name"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	device, err := h.service.RenameDevice(r.Context(), session.UserID, r.PathValue("id"), request.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": device})
}

func (h *HTTPHandler) revokeDevice(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := h.service.RevokeDevice(r.Context(), session.UserID, r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) proxyUSAZero(w http.ResponseWriter, r *http.Request, session *Session) {
	apiPath := strings.TrimPrefix(r.URL.Path, "/api/usa-zero/")
	if r.URL.RawQuery != "" {
		apiPath += "?" + r.URL.RawQuery
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes))
	if err != nil {
		writeError(w, &APIError{Status: http.StatusRequestEntityTooLarge, Message: "request body is too large"})
		return
	}
	data, err := h.service.usa.Proxy(r.Context(), r.Method, apiPath, session.AccessToken, body)
	if err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) {
			writeJSON(w, apiError.Status, map[string]any{
				"code": apiError.Code, "message": apiError.Message, "reason": apiError.Reason,
			})
			return
		}
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"code":0,"message":"success","data":`))
	_, _ = w.Write(data)
	_, _ = w.Write([]byte("}"))
}

type authenticatedHandler func(http.ResponseWriter, *http.Request, *Session)

func (h *HTTPHandler) withSession(next authenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil || strings.TrimSpace(cookie.Value) == "" {
			writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "account login required"})
			return
		}
		session, err := h.service.Session(r.Context(), cookie.Value)
		if err != nil {
			h.clearSessionCookie(w)
			writeError(w, err)
			return
		}
		next(w, r, session)
	}
}

func (h *HTTPHandler) withDesktopSession(next authenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "USA-Zero access token is required"})
			return
		}
		session, err := h.service.DesktopSession(r.Context(), parts[1])
		if err != nil {
			writeError(w, err)
			return
		}
		next(w, r, session)
	}
}

func (h *HTTPHandler) setSessionCookie(w http.ResponseWriter, session *Session) {
	maxAge := int(time.Until(session.SessionExpiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookieName, Value: session.ID, Path: "/", HttpOnly: true,
		Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode,
		Expires: session.SessionExpiresAt, MaxAge: maxAge,
	})
}

func (h *HTTPHandler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookieName, Value: "", Path: "/", HttpOnly: true,
		Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode,
		Expires: time.Unix(1, 0), MaxAge: -1,
	})
}

func decodeRequest(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "invalid request body"})
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "request body must contain one JSON object"})
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "internal server error"
	code := 0
	reason := ""
	var apiError *APIError
	if errors.As(err, &apiError) {
		status, message, code, reason = apiError.Status, apiError.Message, apiError.Code, apiError.Reason
	}
	if status < 400 {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, map[string]any{"error": message, "code": code, "reason": reason})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeRawObject(w http.ResponseWriter, status int, key string, value json.RawMessage) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"` + key + `":`))
	_, _ = w.Write(value)
	_, _ = w.Write([]byte("}"))
}

func writeRawJSON(w http.ResponseWriter, status int, value json.RawMessage) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(value)
}
