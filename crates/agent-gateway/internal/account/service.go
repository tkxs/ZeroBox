package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

type Service struct {
	store             Store
	usa               *USAClient
	sessionTTL        time.Duration
	selectionLeaseTTL time.Duration
	now               func() time.Time
	deviceRevoker     func(userID int64, deviceID string)
	webKeyMu          sync.Mutex
	webKeys           map[int64]string
}

func (s *Service) SetDeviceRevoker(revoker func(userID int64, deviceID string)) {
	s.deviceRevoker = revoker
}

func NewService(store Store, usa *USAClient, sessionTTL, selectionLeaseTTL time.Duration) *Service {
	if sessionTTL <= 0 {
		sessionTTL = 30 * 24 * time.Hour
	}
	if selectionLeaseTTL <= 0 {
		selectionLeaseTTL = 8 * time.Hour
	}
	return &Service{store: store, usa: usa, sessionTTL: sessionTTL, selectionLeaseTTL: selectionLeaseTTL, now: time.Now, webKeys: make(map[int64]string)}
}

func (s *Service) Login(ctx context.Context, email, password string) (*LoginResult, *Session, error) {
	result, err := s.usa.Login(ctx, strings.TrimSpace(email), password)
	if err != nil || result.Requires2FA {
		return result, nil, err
	}
	session, err := s.createSession(ctx, result)
	return result, session, err
}

func (s *Service) Login2FA(ctx context.Context, tempToken, code string) (*LoginResult, *Session, error) {
	result, err := s.usa.Login2FA(ctx, strings.TrimSpace(tempToken), strings.TrimSpace(code))
	if err != nil {
		return nil, nil, err
	}
	session, err := s.createSession(ctx, result)
	return result, session, err
}

func (s *Service) PublicSettings(ctx context.Context) (json.RawMessage, error) {
	return s.usa.PublicSettings(ctx)
}

func (s *Service) SendVerifyCode(ctx context.Context, email string) (json.RawMessage, error) {
	return s.usa.SendVerifyCode(ctx, email)
}

func (s *Service) Register(ctx context.Context, email, password, verifyCode, invitationCode string) (*LoginResult, *Session, error) {
	result, err := s.usa.Register(ctx, email, password, verifyCode, invitationCode)
	if err != nil {
		return nil, nil, err
	}
	session, err := s.createSession(ctx, result)
	return result, session, err
}

func (s *Service) Session(ctx context.Context, id string) (*Session, error) {
	session, err := s.store.GetSession(ctx, strings.TrimSpace(id))
	if err != nil {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "account session is missing or expired"}
	}
	if session.AccessExpiresAt.After(s.now().Add(30 * time.Second)) {
		return session, nil
	}
	if session.RefreshToken == "" {
		_ = s.store.DeleteSession(ctx, session.ID)
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "account session expired"}
	}
	refreshed, err := s.usa.Refresh(ctx, session.RefreshToken)
	if err != nil {
		_ = s.store.DeleteSession(ctx, session.ID)
		return nil, err
	}
	session.AccessToken = refreshed.AccessToken
	session.RefreshToken = firstNonEmpty(refreshed.RefreshToken, session.RefreshToken)
	session.AccessExpiresAt = s.accessExpiry(refreshed.ExpiresIn)
	if len(refreshed.User) > 0 {
		session.User = refreshed.User
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) Refresh(ctx context.Context, id string) (*Session, error) {
	session, err := s.store.GetSession(ctx, id)
	if err != nil || session.RefreshToken == "" {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "account session cannot be refreshed"}
	}
	refreshed, err := s.usa.Refresh(ctx, session.RefreshToken)
	if err != nil {
		return nil, err
	}
	session.AccessToken = refreshed.AccessToken
	session.RefreshToken = firstNonEmpty(refreshed.RefreshToken, session.RefreshToken)
	session.AccessExpiresAt = s.accessExpiry(refreshed.ExpiresIn)
	if len(refreshed.User) > 0 {
		session.User = refreshed.User
	}
	return session, s.store.PutSession(ctx, session)
}

func (s *Service) Logout(ctx context.Context, id string) error {
	session, err := s.store.GetSession(ctx, id)
	if err == nil && session.RefreshToken != "" {
		_ = s.usa.Logout(ctx, session.RefreshToken)
	}
	return s.store.DeleteSession(ctx, id)
}

func (s *Service) RefreshUser(ctx context.Context, session *Session) (json.RawMessage, error) {
	user, err := s.usa.Me(ctx, session.AccessToken)
	if err != nil {
		return nil, err
	}
	session.User = user
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, err
	}
	return user, nil
}

type RegisterDeviceInput struct {
	InstallationID   string      `json:"installation_id"`
	Name             string      `json:"name"`
	Platform         string      `json:"platform"`
	Version          string      `json:"version"`
	DeviceID         string      `json:"device_id,omitempty"`
	DeviceCredential string      `json:"device_credential,omitempty"`
	Workspaces       []Workspace `json:"workspaces"`
}

func (s *Service) RegisterDevice(ctx context.Context, userID int64, input RegisterDeviceInput) (*Device, string, error) {
	input.InstallationID = strings.TrimSpace(input.InstallationID)
	if input.InstallationID == "" || len(input.InstallationID) > 200 {
		return nil, "", &APIError{Status: http.StatusBadRequest, Message: "installation_id is required"}
	}
	workspaces, err := normalizeWorkspaces(input.Workspaces)
	if err != nil {
		return nil, "", err
	}
	now := s.now().UTC()
	existing, lookupErr := s.store.GetDeviceByInstallation(ctx, userID, input.InstallationID)
	if lookupErr == nil {
		if input.DeviceID != existing.ID || !VerifyDeviceCredential(existing, input.DeviceCredential) {
			return nil, "", &APIError{Status: http.StatusUnauthorized, Message: "existing device credential is required"}
		}
		existing.Name = normalizeDeviceName(input.Name, existing.Name)
		existing.Platform = strings.TrimSpace(input.Platform)
		existing.Version = strings.TrimSpace(input.Version)
		existing.Workspaces = workspaces
		existing.LastSeenAt = now
		return existing, "", s.store.UpsertDevice(ctx, existing)
	}
	if !errors.Is(lookupErr, ErrNotFound) {
		return nil, "", lookupErr
	}
	credential, err := randomToken(32)
	if err != nil {
		return nil, "", err
	}
	device := &Device{
		ID: uuid.NewString(), UserID: userID, InstallationID: input.InstallationID,
		Name: normalizeDeviceName(input.Name, "ZeroAgent device"), Platform: strings.TrimSpace(input.Platform),
		Version: strings.TrimSpace(input.Version), CredentialHash: hashToken(credential), Workspaces: workspaces,
		CreatedAt: now, LastSeenAt: now, Online: false,
	}
	if err := s.store.UpsertDevice(ctx, device); err != nil {
		return nil, "", err
	}
	return device, credential, nil
}

func (s *Service) RenameDevice(ctx context.Context, userID int64, deviceID, name string) (*Device, error) {
	device, err := s.store.GetDevice(ctx, userID, deviceID)
	if err != nil {
		return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "device name must be 1-100 characters"}
	}
	device.Name = name
	return device, s.store.UpsertDevice(ctx, device)
}

func (s *Service) RevokeDevice(ctx context.Context, userID int64, deviceID string) error {
	if err := s.store.DeleteDevice(ctx, userID, deviceID); err != nil {
		return &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	if s.deviceRevoker != nil {
		s.deviceRevoker(userID, deviceID)
	}
	return nil
}

func (s *Service) AuthenticateDevice(ctx context.Context, deviceID, credential string) (*Device, error) {
	device, err := s.store.GetDeviceByID(ctx, strings.TrimSpace(deviceID))
	if err != nil || !VerifyDeviceCredential(device, credential) {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "invalid device credential"}
	}
	if err := s.store.SetDevicePresence(ctx, device.ID, true, s.now().UTC()); err != nil {
		return nil, err
	}
	device.Online = true
	device.LastSeenAt = s.now().UTC()
	return device, nil
}

func (s *Service) TouchDevice(ctx context.Context, deviceID string) error {
	return s.store.SetDevicePresence(ctx, deviceID, true, s.now().UTC())
}

func (s *Service) MarkDeviceOffline(ctx context.Context, deviceID string) error {
	return s.store.SetDevicePresence(ctx, deviceID, false, s.now().UTC())
}

func (s *Service) ValidateSelection(ctx context.Context, controllerSessionID, leaseID string) (*Session, *SelectionLease, error) {
	session, err := s.Session(ctx, controllerSessionID)
	if err != nil {
		return nil, nil, err
	}
	lease, err := s.store.GetSelectionLease(ctx, strings.TrimSpace(leaseID))
	if err != nil || lease.UserID != session.UserID || lease.ControllerID != session.ID {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "selection lease is invalid or expired"}
	}
	return session, lease, nil
}

func (s *Service) DesktopSession(ctx context.Context, accessToken string) (*Session, error) {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "USA-Zero access token is required"}
	}
	user, err := s.usa.Me(ctx, accessToken)
	if err != nil {
		return nil, err
	}
	var identity struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(user, &identity) != nil || identity.ID <= 0 {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "USA-Zero identity is invalid"}
	}
	return &Session{
		ID: "desktop:" + hashToken(accessToken), UserID: identity.ID, User: user,
		AccessToken: accessToken, AccessExpiresAt: s.now().Add(15 * time.Minute),
		SessionExpiresAt: s.now().Add(15 * time.Minute),
	}, nil
}

func (s *Service) ValidateDesktopSelection(ctx context.Context, accessToken, leaseID string) (*Session, *SelectionLease, error) {
	session, err := s.DesktopSession(ctx, accessToken)
	if err != nil {
		return nil, nil, err
	}
	lease, err := s.store.GetSelectionLease(ctx, strings.TrimSpace(leaseID))
	if err != nil || lease.UserID != session.UserID || lease.ControllerID != session.ID {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "selection lease is invalid or expired"}
	}
	return session, lease, nil
}

func (s *Service) CreateDesktopHandoff(ctx context.Context, desktop *Session, selectionLeaseID string) (string, error) {
	lease, err := s.store.GetSelectionLease(ctx, strings.TrimSpace(selectionLeaseID))
	if err != nil || lease.UserID != desktop.UserID || lease.ControllerID != desktop.ID {
		return "", &APIError{Status: http.StatusUnauthorized, Message: "desktop selection lease is invalid or expired"}
	}
	code, err := randomToken(32)
	if err != nil {
		return "", err
	}
	handoff := &DesktopHandoff{
		UserID: desktop.UserID, User: desktop.User, AccessToken: desktop.AccessToken,
		SourceSelection: *lease, ExpiresAt: s.now().UTC().Add(60 * time.Second),
	}
	if err := s.store.PutDesktopHandoff(ctx, hashToken(code), handoff); err != nil {
		return "", err
	}
	return code, nil
}

func (s *Service) ConsumeDesktopHandoff(ctx context.Context, code string) (*Session, *SelectionLease, error) {
	handoff, err := s.store.ConsumeDesktopHandoff(ctx, hashToken(strings.TrimSpace(code)))
	if err != nil || !handoff.ExpiresAt.After(s.now()) {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "desktop handoff is invalid or expired"}
	}
	now := s.now().UTC()
	session := &Session{
		ID: uuid.NewString(), UserID: handoff.UserID, User: handoff.User, AccessToken: handoff.AccessToken,
		AccessExpiresAt: now.Add(12 * time.Hour), SessionExpiresAt: now.Add(12 * time.Hour),
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, nil, err
	}
	lease := handoff.SourceSelection
	lease.ID = uuid.NewString()
	lease.ControllerID = session.ID
	lease.ExpiresAt = now.Add(s.selectionLeaseTTL)
	if err := s.store.PutSelectionLease(ctx, &lease); err != nil {
		_ = s.store.DeleteSession(ctx, session.ID)
		return nil, nil, err
	}
	return session, &lease, nil
}

func (s *Service) Environments(ctx context.Context, userID int64, desktop bool, localDeviceID string) ([]Environment, error) {
	devices, err := s.store.ListDevices(ctx, userID)
	if err != nil {
		return nil, err
	}
	environments := make([]Environment, 0, len(devices)+1)
	if !desktop {
		environments = append(environments, Environment{
			RuntimeKind: RuntimeKindWebChat, Name: "网页对话", Online: true,
			Workspaces:        []Workspace{{ID: CloudWorkspaceID, Name: "云端对话"}},
			TargetFingerprint: TargetFingerprint(RuntimeKindWebChat, "", CloudWorkspaceID),
			Capabilities:      []string{"chat", "reasoning", "attachments", "model_native"},
		})
	}
	for _, device := range devices {
		name := device.Name
		if desktop && device.ID == localDeviceID {
			name = "此电脑"
		}
		lastSeen := device.LastSeenAt
		environments = append(environments, Environment{
			RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID, DeviceName: device.Name, Name: name, Online: device.Online,
			Platform: device.Platform, Version: device.Version, LastSeenAt: &lastSeen, Workspaces: device.Workspaces,
			Capabilities: []string{"agent", "files", "terminal", "git", "mcp", "hooks", "cron"},
		})
	}
	return environments, nil
}

func (s *Service) IssueStepUp(ctx context.Context, session *Session, password, target string) (json.RawMessage, error) {
	return s.usa.IssueStepUp(ctx, session.AccessToken, password, target)
}

type SelectTargetInput struct {
	Proof       string `json:"proof"`
	RuntimeKind string `json:"runtime_kind"`
	DeviceID    string `json:"device_id,omitempty"`
	WorkspaceID string `json:"workspace_id"`
	Scope       string `json:"scope,omitempty"`
	Target      string `json:"target_fingerprint"`
}

func (s *Service) Device(ctx context.Context, userID int64, deviceID string) (*Device, error) {
	device, err := s.store.GetDevice(ctx, userID, strings.TrimSpace(deviceID))
	if err != nil {
		return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	return device, nil
}

func (s *Service) SelectTarget(ctx context.Context, session *Session, input SelectTargetInput) (*SelectionLease, error) {
	input.RuntimeKind = strings.TrimSpace(input.RuntimeKind)
	input.DeviceID = strings.TrimSpace(input.DeviceID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.Scope = strings.TrimSpace(input.Scope)
	if input.Scope == "" {
		input.Scope = SelectionScopeWorkspace
	}
	expectedTarget := TargetFingerprint(input.RuntimeKind, input.DeviceID, input.WorkspaceID)
	if input.Target != expectedTarget {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "target fingerprint does not match the requested environment"}
	}
	switch input.RuntimeKind {
	case RuntimeKindWebChat:
		if input.DeviceID != "" || input.WorkspaceID != CloudWorkspaceID || input.Scope != SelectionScopeWorkspace {
			return nil, &APIError{Status: http.StatusBadRequest, Message: "invalid web chat workspace"}
		}
	case RuntimeKindDeviceAgent:
		device, err := s.store.GetDevice(ctx, session.UserID, input.DeviceID)
		if err != nil {
			return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
		}
		if !device.Online {
			return nil, &APIError{Status: http.StatusConflict, Message: "device is offline"}
		}
		switch input.Scope {
		case SelectionScopeDevice:
			if input.WorkspaceID != "" {
				return nil, &APIError{Status: http.StatusBadRequest, Message: "device-scoped selection cannot include workspace_id"}
			}
		case SelectionScopeWorkspace:
			if !hasWorkspace(device.Workspaces, input.WorkspaceID) {
				return nil, &APIError{Status: http.StatusForbidden, Message: "workspace is not published by this device"}
			}
		default:
			return nil, &APIError{Status: http.StatusBadRequest, Message: "unsupported selection scope"}
		}
	default:
		return nil, &APIError{Status: http.StatusBadRequest, Message: "unsupported runtime_kind"}
	}
	if err := s.usa.ConsumeStepUp(ctx, session.AccessToken, input.Proof, expectedTarget); err != nil {
		return nil, err
	}
	now := s.now().UTC()
	lease := &SelectionLease{
		ID: uuid.NewString(), UserID: session.UserID, ControllerID: session.ID,
		RuntimeKind: input.RuntimeKind, DeviceID: input.DeviceID, WorkspaceID: input.WorkspaceID,
		Scope: input.Scope, Target: expectedTarget, ConversationID: uuid.NewString(), ExpiresAt: now.Add(s.selectionLeaseTTL),
	}
	if err := s.store.PutSelectionLease(ctx, lease); err != nil {
		return nil, err
	}
	return lease, nil
}

func (s *Service) createSession(ctx context.Context, result *LoginResult) (*Session, error) {
	now := s.now().UTC()
	session := &Session{
		ID: uuid.NewString(), UserID: result.UserID, User: result.User,
		AccessToken: result.AccessToken, RefreshToken: result.RefreshToken,
		AccessExpiresAt: s.accessExpiry(result.ExpiresIn), SessionExpiresAt: now.Add(s.sessionTTL),
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) accessExpiry(expiresIn int) time.Time {
	if expiresIn <= 0 {
		expiresIn = 15 * 60
	}
	return s.now().UTC().Add(time.Duration(expiresIn) * time.Second)
}

func TargetFingerprint(runtimeKind, deviceID, workspaceID string) string {
	return strings.Join([]string{strings.TrimSpace(runtimeKind), strings.TrimSpace(deviceID), strings.TrimSpace(workspaceID)}, ":")
}

func (s *Service) CreateCloudConversation(ctx context.Context, userID int64, model string) (*CloudConversation, error) {
	now := s.now().UTC()
	conversation := &CloudConversation{
		ID: uuid.NewString(), UserID: userID, Title: "新对话", Model: strings.TrimSpace(model),
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.PutCloudConversation(ctx, conversation); err != nil {
		return nil, err
	}
	return conversation, nil
}

func (s *Service) ListCloudConversations(ctx context.Context, userID int64) ([]CloudConversation, error) {
	return s.store.ListCloudConversations(ctx, userID)
}

func (s *Service) RenameCloudConversation(
	ctx context.Context,
	userID int64,
	conversationID string,
	title string,
) (*CloudConversation, error) {
	conversation, err := s.store.GetCloudConversation(ctx, userID, strings.TrimSpace(conversationID))
	if err != nil {
		return nil, ErrNotFound
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "conversation title is required"}
	}
	if len([]rune(title)) > 120 {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "conversation title is too long"}
	}
	conversation.Title = title
	conversation.UpdatedAt = time.Now().UTC()
	if err := s.store.PutCloudConversation(ctx, conversation); err != nil {
		return nil, err
	}
	return conversation, nil
}

func (s *Service) CloudMessages(ctx context.Context, userID int64, conversationID string) ([]CloudMessage, error) {
	return s.store.ListCloudMessages(ctx, userID, conversationID)
}

func (s *Service) DeleteCloudConversation(ctx context.Context, userID int64, conversationID string) error {
	if err := s.store.DeleteCloudConversation(ctx, userID, conversationID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return &APIError{Status: http.StatusNotFound, Message: "conversation not found"}
		}
		return err
	}
	return nil
}

func (s *Service) WebAPIKey(ctx context.Context, session *Session) (string, error) {
	s.webKeyMu.Lock()
	defer s.webKeyMu.Unlock()
	if key := s.webKeys[session.UserID]; key != "" {
		return key, nil
	}
	key, err := s.usa.EnsureWebAPIKey(ctx, session.AccessToken)
	if err != nil {
		return "", err
	}
	s.webKeys[session.UserID] = key
	return key, nil
}

func (s *Service) WebProviderModels(ctx context.Context, session *Session, keyID int64) (json.RawMessage, error) {
	return s.usa.ModelsForAPIKey(ctx, session.AccessToken, keyID)
}

func (s *Service) AddCloudMessage(ctx context.Context, message *CloudMessage) error {
	return s.store.AddCloudMessage(ctx, message)
}

func (s *Service) UpdateCloudConversation(ctx context.Context, conversation *CloudConversation) error {
	return s.store.PutCloudConversation(ctx, conversation)
}

func (s *Service) WebSettings(ctx context.Context, userID int64) (*WebSettings, error) {
	settings, err := s.store.GetWebSettings(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return &WebSettings{Model: "gpt-5.1", ReasoningEffort: "medium"}, nil
	}
	return settings, err
}

func (s *Service) UpdateWebSettings(ctx context.Context, userID int64, input WebSettings) (*WebSettings, error) {
	input.Model = strings.TrimSpace(input.Model)
	input.ReasoningEffort = strings.TrimSpace(input.ReasoningEffort)
	if input.Model == "" || len(input.Model) > 200 {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "model must be 1-200 characters"}
	}
	switch input.ReasoningEffort {
	case "low", "medium", "high":
	default:
		return nil, &APIError{Status: http.StatusBadRequest, Message: "reasoning_effort must be low, medium or high"}
	}
	if err := s.store.PutWebSettings(ctx, userID, input); err != nil {
		return nil, err
	}
	return &input, nil
}

func (s *Service) RecordDeviceHistorySync(userID int64, deviceID string, event *gatewayv1.HistorySyncEvent) {
	if userID <= 0 || strings.TrimSpace(deviceID) == "" || event == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conversationID := strings.TrimSpace(event.GetConversationId())
	if conversationID == "" && event.GetConversation() != nil {
		conversationID = strings.TrimSpace(event.GetConversation().GetId())
	}
	if _, err := uuid.Parse(conversationID); err != nil {
		return
	}
	if strings.EqualFold(strings.TrimSpace(event.GetKind()), "delete") {
		_ = s.store.DeleteConversationRoute(ctx, userID, conversationID)
		return
	}
	conversation := event.GetConversation()
	if conversation == nil {
		return
	}
	device, err := s.store.GetDevice(ctx, userID, deviceID)
	if err != nil {
		return
	}
	workspaceID := "unknown"
	for _, workspace := range device.Workspaces {
		if equalWorkspacePath(workspace.Path, conversation.GetCwd()) {
			workspaceID = workspace.ID
			break
		}
	}
	createdAt := historyEpochTime(conversation.GetCreatedAt())
	updatedAt := historyEpochTime(conversation.GetUpdatedAt())
	if createdAt.IsZero() {
		createdAt = s.now().UTC()
	}
	if updatedAt.IsZero() {
		updatedAt = createdAt
	}
	title := strings.TrimSpace(conversation.GetTitle())
	if title == "" {
		title = "新对话"
	}
	summaryParts := make([]string, 0, 2)
	if conversation.GetMessageCount() > 0 {
		summaryParts = append(summaryParts, fmt.Sprintf("%d 条消息", conversation.GetMessageCount()))
	}
	if model := strings.TrimSpace(conversation.GetModel()); model != "" {
		summaryParts = append(summaryParts, model)
	}
	_ = s.store.PutConversationRoute(ctx, &ConversationRoute{
		ConversationID: conversationID, UserID: userID, RuntimeKind: RuntimeKindDeviceAgent,
		DeviceID: deviceID, WorkspaceID: workspaceID, Title: title,
		Summary: strings.Join(summaryParts, " · "), CreatedAt: createdAt, UpdatedAt: updatedAt,
	})
}

func (s *Service) ConversationRoutes(ctx context.Context, userID int64) ([]ConversationRoute, error) {
	return s.ConversationRoutesForDevice(ctx, userID, "")
}

func (s *Service) ConversationRoutesForDevice(ctx context.Context, userID int64, deviceID string) ([]ConversationRoute, error) {
	routes, err := s.store.ListConversationRoutes(ctx, userID)
	if err != nil {
		return nil, err
	}
	devices, err := s.store.ListDevices(ctx, userID)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]Device, len(devices))
	for _, device := range devices {
		byID[device.ID] = device
	}
	filtered := make([]ConversationRoute, 0, len(routes))
	deviceID = strings.TrimSpace(deviceID)
	for index := range routes {
		if deviceID != "" && routes[index].DeviceID != deviceID {
			continue
		}
		if device, ok := byID[routes[index].DeviceID]; ok {
			routes[index].DeviceName = device.Name
			routes[index].DeviceOnline = device.Online
		} else {
			routes[index].DeviceName = "已撤销设备"
		}
		filtered = append(filtered, routes[index])
	}
	return filtered, nil
}

func equalWorkspacePath(left, right string) bool {
	normalize := func(value string) string {
		return strings.ToLower(strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(value), `\`, "/"), "/"))
	}
	return normalize(left) != "" && normalize(left) == normalize(right)
}

func historyEpochTime(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	if value > 10_000_000_000 {
		return time.UnixMilli(value).UTC()
	}
	return time.Unix(value, 0).UTC()
}

func normalizeWorkspaces(input []Workspace) ([]Workspace, error) {
	seen := make(map[string]struct{}, len(input))
	result := make([]Workspace, 0, len(input))
	for _, workspace := range input {
		workspace.ID = strings.TrimSpace(workspace.ID)
		workspace.Name = strings.TrimSpace(workspace.Name)
		workspace.Path = strings.TrimSpace(workspace.Path)
		workspace.Kind = strings.TrimSpace(workspace.Kind)
		if workspace.ID == "" || workspace.Name == "" || workspace.Path == "" || len(workspace.Path) > 4096 {
			return nil, &APIError{Status: http.StatusBadRequest, Message: "each workspace requires id, name and path"}
		}
		if _, ok := seen[workspace.ID]; ok {
			return nil, &APIError{Status: http.StatusBadRequest, Message: "workspace ids must be unique"}
		}
		seen[workspace.ID] = struct{}{}
		result = append(result, workspace)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func hasWorkspace(workspaces []Workspace, id string) bool {
	for _, workspace := range workspaces {
		if workspace.ID == id {
			return true
		}
	}
	return false
}

func normalizeDeviceName(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if len(value) > 100 {
		return value[:100]
	}
	return value
}

func randomToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate secure token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}
