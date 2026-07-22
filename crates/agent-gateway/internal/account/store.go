package account

import (
	"context"
	"crypto/subtle"
	"errors"
	"sort"
	"sync"
	"time"
)

var ErrNotFound = errors.New("not found")

type Store interface {
	PutSession(ctx context.Context, session *Session) error
	GetSession(ctx context.Context, id string) (*Session, error)
	DeleteSession(ctx context.Context, id string) error
	UpsertDevice(ctx context.Context, device *Device) error
	GetDevice(ctx context.Context, userID int64, deviceID string) (*Device, error)
	GetDeviceByID(ctx context.Context, deviceID string) (*Device, error)
	GetDeviceByInstallation(ctx context.Context, userID int64, installationID string) (*Device, error)
	ListDevices(ctx context.Context, userID int64) ([]Device, error)
	DeleteDevice(ctx context.Context, userID int64, deviceID string) error
	SetDevicePresence(ctx context.Context, deviceID string, online bool, at time.Time) error
	PutSelectionLease(ctx context.Context, lease *SelectionLease) error
	GetSelectionLease(ctx context.Context, id string) (*SelectionLease, error)
	PutCloudConversation(ctx context.Context, conversation *CloudConversation) error
	GetCloudConversation(ctx context.Context, userID int64, id string) (*CloudConversation, error)
	ListCloudConversations(ctx context.Context, userID int64) ([]CloudConversation, error)
	DeleteCloudConversation(ctx context.Context, userID int64, id string) error
	AddCloudMessage(ctx context.Context, message *CloudMessage) error
	ListCloudMessages(ctx context.Context, userID int64, conversationID string) ([]CloudMessage, error)
	PutWebSettings(ctx context.Context, userID int64, settings WebSettings) error
	GetWebSettings(ctx context.Context, userID int64) (*WebSettings, error)
	PutConversationRoute(ctx context.Context, route *ConversationRoute) error
	DeleteConversationRoute(ctx context.Context, userID int64, conversationID string) error
	ListConversationRoutes(ctx context.Context, userID int64) ([]ConversationRoute, error)
	PutDesktopHandoff(ctx context.Context, codeHash string, handoff *DesktopHandoff) error
	ConsumeDesktopHandoff(ctx context.Context, codeHash string) (*DesktopHandoff, error)
}

type MemoryStore struct {
	mu                 sync.RWMutex
	sessions           map[string]Session
	devices            map[string]Device
	leases             map[string]SelectionLease
	cloudConversations map[string]CloudConversation
	cloudMessages      map[string][]CloudMessage
	webSettings        map[int64]WebSettings
	conversationRoutes map[string]ConversationRoute
	handoffs           map[string]DesktopHandoff
	now                func() time.Time
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		sessions:           make(map[string]Session),
		devices:            make(map[string]Device),
		leases:             make(map[string]SelectionLease),
		cloudConversations: make(map[string]CloudConversation),
		cloudMessages:      make(map[string][]CloudMessage),
		webSettings:        make(map[int64]WebSettings),
		conversationRoutes: make(map[string]ConversationRoute),
		handoffs:           make(map[string]DesktopHandoff),
		now:                time.Now,
	}
}

func (s *MemoryStore) PutSession(_ context.Context, session *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[session.ID] = cloneSession(*session)
	return nil
}

func (s *MemoryStore) GetSession(_ context.Context, id string) (*Session, error) {
	s.mu.RLock()
	session, ok := s.sessions[id]
	s.mu.RUnlock()
	if !ok || !session.SessionExpiresAt.After(s.now()) {
		if ok {
			_ = s.DeleteSession(context.Background(), id)
		}
		return nil, ErrNotFound
	}
	copy := cloneSession(session)
	return &copy, nil
}

func (s *MemoryStore) DeleteSession(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
	return nil
}

func (s *MemoryStore) UpsertDevice(_ context.Context, device *Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.devices[device.ID] = cloneDevice(*device)
	return nil
}

func (s *MemoryStore) GetDevice(_ context.Context, userID int64, deviceID string) (*Device, error) {
	s.mu.RLock()
	device, ok := s.devices[deviceID]
	s.mu.RUnlock()
	if !ok || device.UserID != userID || device.RevokedAt != nil {
		return nil, ErrNotFound
	}
	copy := cloneDevice(device)
	return &copy, nil
}

func (s *MemoryStore) GetDeviceByID(_ context.Context, deviceID string) (*Device, error) {
	s.mu.RLock()
	device, ok := s.devices[deviceID]
	s.mu.RUnlock()
	if !ok || device.RevokedAt != nil {
		return nil, ErrNotFound
	}
	copy := cloneDevice(device)
	return &copy, nil
}

func (s *MemoryStore) GetDeviceByInstallation(_ context.Context, userID int64, installationID string) (*Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, device := range s.devices {
		if device.UserID == userID && device.InstallationID == installationID && device.RevokedAt == nil {
			copy := cloneDevice(device)
			return &copy, nil
		}
	}
	return nil, ErrNotFound
}

func (s *MemoryStore) ListDevices(_ context.Context, userID int64) ([]Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	devices := make([]Device, 0)
	for _, device := range s.devices {
		if device.UserID == userID && device.RevokedAt == nil {
			devices = append(devices, cloneDevice(device))
		}
	}
	sort.Slice(devices, func(i, j int) bool {
		if devices[i].Online != devices[j].Online {
			return devices[i].Online
		}
		return devices[i].Name < devices[j].Name
	})
	return devices, nil
}

func (s *MemoryStore) DeleteDevice(_ context.Context, userID int64, deviceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.devices[deviceID]
	if !ok || device.UserID != userID || device.RevokedAt != nil {
		return ErrNotFound
	}
	now := s.now().UTC()
	device.RevokedAt = &now
	device.Online = false
	s.devices[deviceID] = device
	return nil
}

func (s *MemoryStore) SetDevicePresence(_ context.Context, deviceID string, online bool, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.devices[deviceID]
	if !ok || device.RevokedAt != nil {
		return ErrNotFound
	}
	device.Online = online
	device.LastSeenAt = at.UTC()
	s.devices[deviceID] = device
	return nil
}

func (s *MemoryStore) PutSelectionLease(_ context.Context, lease *SelectionLease) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases[lease.ID] = *lease
	return nil
}

func (s *MemoryStore) GetSelectionLease(_ context.Context, id string) (*SelectionLease, error) {
	s.mu.RLock()
	lease, ok := s.leases[id]
	s.mu.RUnlock()
	if !ok || !lease.ExpiresAt.After(s.now()) {
		return nil, ErrNotFound
	}
	return &lease, nil
}

func (s *MemoryStore) PutCloudConversation(_ context.Context, conversation *CloudConversation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cloudConversations[conversation.ID] = *conversation
	return nil
}

func (s *MemoryStore) GetCloudConversation(_ context.Context, userID int64, id string) (*CloudConversation, error) {
	s.mu.RLock()
	conversation, ok := s.cloudConversations[id]
	s.mu.RUnlock()
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	return &conversation, nil
}

func (s *MemoryStore) ListCloudConversations(_ context.Context, userID int64) ([]CloudConversation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]CloudConversation, 0)
	for _, conversation := range s.cloudConversations {
		if conversation.UserID == userID {
			items = append(items, conversation)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	return items, nil
}

func (s *MemoryStore) DeleteCloudConversation(_ context.Context, userID int64, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	conversation, ok := s.cloudConversations[id]
	if !ok || conversation.UserID != userID {
		return ErrNotFound
	}
	delete(s.cloudConversations, id)
	delete(s.cloudMessages, id)
	return nil
}

func (s *MemoryStore) AddCloudMessage(_ context.Context, message *CloudMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cloudMessages[message.ConversationID] = append(s.cloudMessages[message.ConversationID], cloneCloudMessage(*message))
	conversation, ok := s.cloudConversations[message.ConversationID]
	if ok {
		conversation.UpdatedAt = message.CreatedAt
		s.cloudConversations[conversation.ID] = conversation
	}
	return nil
}

func (s *MemoryStore) ListCloudMessages(_ context.Context, userID int64, conversationID string) ([]CloudMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	items := s.cloudMessages[conversationID]
	result := make([]CloudMessage, len(items))
	for index := range items {
		result[index] = cloneCloudMessage(items[index])
	}
	return result, nil
}

func (s *MemoryStore) PutWebSettings(_ context.Context, userID int64, settings WebSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.webSettings[userID] = settings
	return nil
}

func (s *MemoryStore) GetWebSettings(_ context.Context, userID int64) (*WebSettings, error) {
	s.mu.RLock()
	settings, ok := s.webSettings[userID]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	return &settings, nil
}

func (s *MemoryStore) PutConversationRoute(_ context.Context, route *ConversationRoute) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conversationRoutes[route.ConversationID] = *route
	return nil
}

func (s *MemoryStore) DeleteConversationRoute(_ context.Context, userID int64, conversationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.conversationRoutes[conversationID]
	if !ok || route.UserID != userID {
		return ErrNotFound
	}
	delete(s.conversationRoutes, conversationID)
	return nil
}

func (s *MemoryStore) ListConversationRoutes(_ context.Context, userID int64) ([]ConversationRoute, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]ConversationRoute, 0)
	for _, route := range s.conversationRoutes {
		if route.UserID == userID {
			items = append(items, route)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	return items, nil
}

func (s *MemoryStore) PutDesktopHandoff(_ context.Context, codeHash string, handoff *DesktopHandoff) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handoffs[codeHash] = *handoff
	return nil
}

func (s *MemoryStore) ConsumeDesktopHandoff(_ context.Context, codeHash string) (*DesktopHandoff, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	handoff, ok := s.handoffs[codeHash]
	delete(s.handoffs, codeHash)
	if !ok || !handoff.ExpiresAt.After(s.now()) {
		return nil, ErrNotFound
	}
	return &handoff, nil
}

func VerifyDeviceCredential(device *Device, credential string) bool {
	if device == nil || device.CredentialHash == "" || credential == "" {
		return false
	}
	actual := hashToken(credential)
	return subtle.ConstantTimeCompare([]byte(actual), []byte(device.CredentialHash)) == 1
}

func cloneSession(session Session) Session {
	session.User = append([]byte(nil), session.User...)
	return session
}

func cloneDevice(device Device) Device {
	device.Workspaces = append([]Workspace(nil), device.Workspaces...)
	return device
}

func cloneCloudMessage(message CloudMessage) CloudMessage {
	message.Content = append([]byte(nil), message.Content...)
	message.Usage = append([]byte(nil), message.Usage...)
	return message
}
