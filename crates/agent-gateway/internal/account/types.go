package account

import (
	"encoding/json"
	"time"
)

const (
	SessionCookieName       = "zerobox_session"
	RuntimeKindWebChat      = "web_chat"
	RuntimeKindDeviceAgent  = "device_agent"
	CloudWorkspaceID        = "cloud"
	StepUpPurposeTargetSwap = "execution_target_switch"
	SelectionScopeWorkspace = "workspace"
	SelectionScopeDevice    = "device"
)

type Session struct {
	ID               string          `json:"id"`
	UserID           int64           `json:"user_id"`
	User             json.RawMessage `json:"user"`
	AccessToken      string          `json:"access_token"`
	RefreshToken     string          `json:"refresh_token,omitempty"`
	AccessExpiresAt  time.Time       `json:"access_expires_at"`
	SessionExpiresAt time.Time       `json:"session_expires_at"`
}

type Workspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path,omitempty"`
	Kind      string `json:"kind,omitempty"`
	IsPinned  bool   `json:"is_pinned,omitempty"`
	PinnedAt  int64  `json:"pinned_at,omitempty"`
	Archived  bool   `json:"archived,omitempty"`
	Missing   bool   `json:"missing,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
}

type Device struct {
	ID             string      `json:"id"`
	UserID         int64       `json:"-"`
	InstallationID string      `json:"installation_id"`
	Name           string      `json:"name"`
	Platform       string      `json:"platform"`
	Version        string      `json:"version"`
	CredentialHash string      `json:"-"`
	Workspaces     []Workspace `json:"workspaces"`
	CreatedAt      time.Time   `json:"created_at"`
	LastSeenAt     time.Time   `json:"last_seen_at"`
	RevokedAt      *time.Time  `json:"revoked_at,omitempty"`
	Online         bool        `json:"online"`
}

type SelectionLease struct {
	ID             string    `json:"selection_lease"`
	UserID         int64     `json:"user_id"`
	ControllerID   string    `json:"-"`
	RuntimeKind    string    `json:"runtime_kind"`
	DeviceID       string    `json:"device_id,omitempty"`
	WorkspaceID    string    `json:"workspace_id"`
	Scope          string    `json:"scope,omitempty"`
	Target         string    `json:"target_fingerprint"`
	ConversationID string    `json:"conversation_id"`
	ExpiresAt      time.Time `json:"expires_at"`
}

func (l *SelectionLease) EffectiveScope() string {
	if l != nil && l.Scope == SelectionScopeDevice {
		return SelectionScopeDevice
	}
	return SelectionScopeWorkspace
}

type Environment struct {
	RuntimeKind       string      `json:"runtime_kind"`
	DeviceID          string      `json:"device_id,omitempty"`
	DeviceName        string      `json:"device_name,omitempty"`
	Name              string      `json:"name"`
	Online            bool        `json:"online"`
	Platform          string      `json:"platform,omitempty"`
	Version           string      `json:"version,omitempty"`
	LastSeenAt        *time.Time  `json:"last_seen_at,omitempty"`
	Workspaces        []Workspace `json:"workspaces"`
	TargetFingerprint string      `json:"target_fingerprint,omitempty"`
	Capabilities      []string    `json:"capabilities"`
}

type LoginResult struct {
	Requires2FA     bool            `json:"requires_2fa,omitempty"`
	TempToken       string          `json:"temp_token,omitempty"`
	UserEmailMasked string          `json:"user_email_masked,omitempty"`
	AccessToken     string          `json:"-"`
	RefreshToken    string          `json:"-"`
	ExpiresIn       int             `json:"-"`
	User            json.RawMessage `json:"user,omitempty"`
	UserID          int64           `json:"-"`
}

type CloudConversation struct {
	ID        string    `json:"id"`
	UserID    int64     `json:"-"`
	Title     string    `json:"title"`
	Model     string    `json:"model"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CloudMessage struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversation_id"`
	UserID         int64           `json:"-"`
	Role           string          `json:"role"`
	Content        json.RawMessage `json:"content"`
	Usage          json.RawMessage `json:"usage,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
}

type WebSettings struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
}

type ConversationRoute struct {
	ConversationID string    `json:"conversation_id"`
	UserID         int64     `json:"-"`
	RuntimeKind    string    `json:"runtime_kind"`
	DeviceID       string    `json:"device_id"`
	WorkspaceID    string    `json:"workspace_id"`
	Title          string    `json:"title"`
	Summary        string    `json:"summary"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	DeviceName     string    `json:"device_name,omitempty"`
	DeviceOnline   bool      `json:"device_online"`
}

type DesktopHandoff struct {
	UserID          int64           `json:"user_id"`
	User            json.RawMessage `json:"user"`
	AccessToken     string          `json:"access_token"`
	SourceSelection SelectionLease  `json:"source_selection"`
	ExpiresAt       time.Time       `json:"expires_at"`
}

type APIError struct {
	Status  int
	Code    int
	Reason  string
	Message string
}

func (e *APIError) Error() string { return e.Message }
