package session

import (
	"errors"
	"fmt"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

var ErrAgentOffline = errors.New("agent offline")
var ErrTunnelNotFound = errors.New("tunnel not found")
var ErrTunnelExpired = errors.New("tunnel expired")
var ErrTunnelOverLimit = errors.New("tunnel connection limit exceeded")

const (
	chatRuntimeReadyTTL      = 15 * time.Second
	agentSessionHeartbeatTTL = 90 * time.Second
	defaultRuntimeReadyState = "ready"
)

type AuthSnapshot struct {
	AgentID      string
	AgentVersion string
	SessionID    string
}

type Manager struct {
	registry          *sessionRegistry
	syncHub           *syncHub
	convStreams       *conversationStreamStore
	tunnels           *tunnelRuntime
	workspaceHub      *workspaceActivityHub
	managedProcesses  *managedProcessHub
	statusSubs        *statusSubscriberHub
	deviceMu          sync.Mutex
	deviceManagers    map[string]*Manager
	historyObserverMu sync.RWMutex
	historyObserver   HistoryObserver
	identityUserID    int64
	identityDeviceID  string
}

type HistoryObserver func(userID int64, deviceID string, event *gatewayv1.HistorySyncEvent)

type AgentSession struct {
	AgentID      string
	AgentVersion string
	SessionID    string
	ConnectedAt  time.Time
	LastPing     time.Time

	toAgent chan *OutboundEnvelope
	pingCh  chan *gatewayv1.GatewayEnvelope
	done    chan struct{}

	closeOnce sync.Once
	closed    bool

	streamsMu sync.Mutex
	streams   map[string]*agentStream
}

type agentStream struct {
	ch        chan *gatewayv1.AgentEnvelope
	done      chan struct{}
	closeOnce sync.Once
}

type Status struct {
	Online                bool   `json:"online"`
	AgentReady            bool   `json:"agent_ready"`
	ChatRuntimeReady      bool   `json:"chat_runtime_ready"`
	AgentID               string `json:"agent_id"`
	AgentVersion          string `json:"agent_version"`
	SessionID             string `json:"session_id,omitempty"`
	ConnectedSince        int64  `json:"connected_since"`
	LastHeartbeat         int64  `json:"last_heartbeat"`
	RuntimeState          string `json:"runtime_state,omitempty"`
	RuntimeLastHeartbeat  int64  `json:"runtime_last_heartbeat,omitempty"`
	RuntimeWorkerID       string `json:"runtime_worker_id,omitempty"`
	RuntimeVisible        bool   `json:"runtime_visible,omitempty"`
	RuntimeActiveRunCount uint32 `json:"runtime_active_run_count,omitempty"`
}

func NewManager() *Manager {
	m := &Manager{
		registry:         newSessionRegistry(),
		syncHub:          newSyncHub(),
		tunnels:          newTunnelRuntime(),
		workspaceHub:     newWorkspaceActivityHub(),
		managedProcesses: newManagedProcessHub(),
		statusSubs:       newStatusSubscriberHub(),
		deviceManagers:   make(map[string]*Manager),
	}
	m.convStreams = newConversationStreamStore(m.IsOnline)
	go m.tunnelExpirySweepLoop()
	return m
}

func deviceManagerKey(userID int64, deviceID string) string {
	return fmt.Sprintf("%d:%s", userID, deviceID)
}

// DeviceManager returns the isolated runtime state for one account-owned device.
// Each child has independent streams, subscriptions, terminal state and AgentSession.
func (m *Manager) DeviceManager(userID int64, deviceID string) *Manager {
	key := deviceManagerKey(userID, deviceID)
	m.deviceMu.Lock()
	defer m.deviceMu.Unlock()
	if existing := m.deviceManagers[key]; existing != nil {
		return existing
	}
	child := NewManager()
	m.historyObserverMu.RLock()
	child.historyObserver = m.historyObserver
	m.historyObserverMu.RUnlock()
	child.identityUserID = userID
	child.identityDeviceID = deviceID
	m.deviceManagers[key] = child
	return child
}

func (m *Manager) SetHistoryObserver(observer HistoryObserver) {
	m.deviceMu.Lock()
	defer m.deviceMu.Unlock()
	m.historyObserverMu.Lock()
	m.historyObserver = observer
	m.historyObserverMu.Unlock()
	for _, child := range m.deviceManagers {
		child.historyObserverMu.Lock()
		child.historyObserver = observer
		child.historyObserverMu.Unlock()
	}
}

func (m *Manager) DisconnectDevice(userID int64, deviceID string) {
	key := deviceManagerKey(userID, deviceID)
	m.deviceMu.Lock()
	child := m.deviceManagers[key]
	delete(m.deviceManagers, key)
	m.deviceMu.Unlock()
	if child == nil {
		return
	}
	child.registry.mu.RLock()
	session := child.registry.session
	child.registry.mu.RUnlock()
	if session != nil {
		child.ClearSession(session)
	}
}
