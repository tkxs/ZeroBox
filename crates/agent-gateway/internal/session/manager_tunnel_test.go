package session

import (
	"errors"
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func onlineTunnelTestManager() *Manager {
	manager := NewManager()
	manager.SetSession(NewAgentSession(AuthSnapshot{
		AgentID:      "agent-a",
		AgentVersion: "test",
		SessionID:    "session-a",
	}))
	return manager
}

func createTestTunnel(t *testing.T, manager *Manager, name string) *gatewayv1.TunnelSummary {
	t.Helper()
	tunnel, err := manager.CreateTunnelFromAgent(&gatewayv1.TunnelControlRequest{
		Action:        "create",
		TargetUrl:     "http://localhost:3000/app",
		Name:          name,
		TtlSeconds:    3600,
		PublicBaseUrl: "https://gateway.example",
	})
	if err != nil {
		t.Fatalf("CreateTunnelFromAgent: %v", err)
	}
	if tunnel.GetSlug() == "" || tunnel.GetPublicUrl() == "" {
		t.Fatalf("created tunnel missing slug/public URL: %+v", tunnel)
	}
	return tunnel
}

func TestTunnelRegistryCreateLimitListAndClose(t *testing.T) {
	manager := onlineTunnelTestManager()

	var first *gatewayv1.TunnelSummary
	for i := 0; i < MaxTunnelsPerAgent; i++ {
		tunnel := createTestTunnel(t, manager, "app")
		if i == 0 {
			first = tunnel
		}
	}

	if _, err := manager.CreateTunnelFromAgent(&gatewayv1.TunnelControlRequest{
		Action:        "create",
		TargetUrl:     "http://localhost:3001",
		TtlSeconds:    3600,
		PublicBaseUrl: "https://gateway.example",
	}); !errors.Is(err, ErrTunnelLimitExceeded) {
		t.Fatalf("expected ErrTunnelLimitExceeded, got %v", err)
	}

	if got := len(manager.ListTunnels()); got != MaxTunnelsPerAgent {
		t.Fatalf("ListTunnels returned %d tunnels, want %d", got, MaxTunnelsPerAgent)
	}

	closed, err := manager.CloseTunnel(first.GetId())
	if err != nil {
		t.Fatalf("CloseTunnel: %v", err)
	}
	if closed.GetStatus() != "expired" {
		t.Fatalf("closed tunnel summary status = %q, want expired", closed.GetStatus())
	}
	if got := len(manager.ListTunnels()); got != MaxTunnelsPerAgent-1 {
		t.Fatalf("ListTunnels after close returned %d tunnels, want %d", got, MaxTunnelsPerAgent-1)
	}
}

func TestTunnelAcquireConnectionLimitAndRelease(t *testing.T) {
	manager := onlineTunnelTestManager()
	tunnel := createTestTunnel(t, manager, "app")

	leases := make([]*TunnelStreamLease, 0, MaxTunnelConnections)
	for i := 0; i < MaxTunnelConnections; i++ {
		lease, err := manager.AcquireTunnel(tunnel.GetSlug(), "stream-"+string(rune('a'+i)))
		if err != nil {
			t.Fatalf("AcquireTunnel %d: %v", i, err)
		}
		leases = append(leases, lease)
	}
	if _, err := manager.AcquireTunnel(tunnel.GetSlug(), "stream-over-limit"); !errors.Is(err, ErrTunnelOverLimit) {
		t.Fatalf("expected ErrTunnelOverLimit, got %v", err)
	}

	leases[0].Release()
	lease, err := manager.AcquireTunnel(tunnel.GetSlug(), "stream-after-release")
	if err != nil {
		t.Fatalf("AcquireTunnel after release: %v", err)
	}
	lease.Release()
	for _, item := range leases[1:] {
		item.Release()
	}

	summaries := manager.ListTunnels()
	if len(summaries) != 1 {
		t.Fatalf("ListTunnels returned %d tunnels, want 1", len(summaries))
	}
	if got := summaries[0].GetActiveConnections(); got != 0 {
		t.Fatalf("active connections after release = %d, want 0", got)
	}
}

func TestTunnelExpiredCannotBeAcquired(t *testing.T) {
	manager := onlineTunnelTestManager()
	tunnel := createTestTunnel(t, manager, "app")

	manager.tunnels.mu.Lock()
	manager.tunnels.tunnelsByID[tunnel.GetId()].expiresAt = time.Now().Add(-time.Second)
	manager.tunnels.mu.Unlock()

	if _, err := manager.AcquireTunnel(tunnel.GetSlug(), "stream-expired"); !errors.Is(err, ErrTunnelExpired) {
		t.Fatalf("expected ErrTunnelExpired, got %v", err)
	}
	summaries := manager.ListTunnels()
	if len(summaries) != 1 {
		t.Fatalf("ListTunnels returned %d tunnels, want 1", len(summaries))
	}
	if summaries[0].GetStatus() != "expired" {
		t.Fatalf("expired tunnel status = %q, want expired", summaries[0].GetStatus())
	}
}

func TestTunnelInfiniteTTLCreatesNonExpiringTunnel(t *testing.T) {
	manager := onlineTunnelTestManager()
	tunnel, err := manager.CreateTunnelFromAgent(&gatewayv1.TunnelControlRequest{
		Action:        "create",
		TargetUrl:     "http://localhost:3000/app",
		Name:          "app",
		TtlSeconds:    0,
		PublicBaseUrl: "https://gateway.example",
	})
	if err != nil {
		t.Fatalf("CreateTunnelFromAgent with infinite TTL: %v", err)
	}
	if tunnel.GetExpiresAt() != 0 {
		t.Fatalf("infinite tunnel expiresAt = %d, want 0", tunnel.GetExpiresAt())
	}
	if tunnel.GetStatus() != "active" {
		t.Fatalf("infinite tunnel status = %q, want active", tunnel.GetStatus())
	}

	manager.tunnels.mu.Lock()
	manager.tunnels.tunnelsByID[tunnel.GetId()].expiresAt = time.Time{}
	manager.tunnels.mu.Unlock()

	lease, err := manager.AcquireTunnel(tunnel.GetSlug(), "stream-infinite")
	if err != nil {
		t.Fatalf("AcquireTunnel for infinite tunnel: %v", err)
	}
	lease.Release()
}

func TestTunnelUpdateChangesTargetNameScopeAndTTL(t *testing.T) {
	manager := onlineTunnelTestManager()
	tunnel := createTestTunnel(t, manager, "app")

	updated, err := manager.UpdateTunnelFromAgent(&gatewayv1.TunnelControlRequest{
		Action:         "update",
		TunnelId:       tunnel.GetId(),
		TargetUrl:      "http://127.0.0.1:4000/dashboard",
		Name:           "dashboard",
		TtlSeconds:     0,
		ProjectPathKey: "project:/tmp/liveagent",
	})
	if err != nil {
		t.Fatalf("UpdateTunnelFromAgent: %v", err)
	}
	if updated.GetName() != "dashboard" {
		t.Fatalf("updated name = %q, want dashboard", updated.GetName())
	}
	if updated.GetTargetUrl() != "http://127.0.0.1:4000/dashboard" {
		t.Fatalf("updated target = %q", updated.GetTargetUrl())
	}
	if updated.GetExpiresAt() != 0 {
		t.Fatalf("updated expiresAt = %d, want 0", updated.GetExpiresAt())
	}
	if updated.GetProjectPathKey() != "project:/tmp/liveagent" {
		t.Fatalf("updated projectPathKey = %q", updated.GetProjectPathKey())
	}

	listed := manager.ListTunnels()
	if len(listed) != 1 {
		t.Fatalf("ListTunnels returned %d tunnels, want 1", len(listed))
	}
	if listed[0].GetId() != tunnel.GetId() || listed[0].GetTargetUrl() != updated.GetTargetUrl() {
		t.Fatalf("ListTunnels did not include updated tunnel: %+v", listed[0])
	}
}

func TestTunnelInfiniteTTLStaysActiveAndVisible(t *testing.T) {
	manager := onlineTunnelTestManager()

	tunnel, err := manager.CreateTunnelFromAgent(&gatewayv1.TunnelControlRequest{
		Action:         "create",
		TargetUrl:      "http://localhost:3000/app",
		Name:           "app",
		TtlSeconds:     0,
		PublicBaseUrl:  "https://gateway.example",
		ProjectPathKey: "/workspace/app",
	})
	if err != nil {
		t.Fatalf("CreateTunnelFromAgent: %v", err)
	}
	if tunnel.GetExpiresAt() != 0 {
		t.Fatalf("infinite tunnel expires_at = %d, want 0", tunnel.GetExpiresAt())
	}
	if tunnel.GetProjectPathKey() != "/workspace/app" {
		t.Fatalf("project_path_key = %q, want /workspace/app", tunnel.GetProjectPathKey())
	}

	summaries := manager.ListTunnels()
	if len(summaries) != 1 {
		t.Fatalf("ListTunnels returned %d tunnels, want 1", len(summaries))
	}
	if summaries[0].GetStatus() != "active" {
		t.Fatalf("infinite tunnel status = %q, want active", summaries[0].GetStatus())
	}
	if summaries[0].GetExpiresAt() != 0 {
		t.Fatalf("listed infinite tunnel expires_at = %d, want 0", summaries[0].GetExpiresAt())
	}
}

func TestTunnelUpdateChangesTargetNameTTLAndKeepsProjectScope(t *testing.T) {
	manager := onlineTunnelTestManager()
	tunnel := createTestTunnel(t, manager, "app")

	updated, err := manager.UpdateTunnelFromAgent(&gatewayv1.TunnelControlRequest{
		Action:         "update",
		TunnelId:       tunnel.GetId(),
		TargetUrl:      "http://localhost:3000/next",
		Name:           "next",
		TtlSeconds:     0,
		ProjectPathKey: "/workspace/app",
	})
	if err != nil {
		t.Fatalf("UpdateTunnelFromAgent: %v", err)
	}
	if updated.GetTargetUrl() != "http://localhost:3000/next" {
		t.Fatalf("target_url = %q, want http://localhost:3000/next", updated.GetTargetUrl())
	}
	if updated.GetName() != "next" {
		t.Fatalf("name = %q, want next", updated.GetName())
	}
	if updated.GetExpiresAt() != 0 {
		t.Fatalf("updated expires_at = %d, want 0", updated.GetExpiresAt())
	}
	if updated.GetProjectPathKey() != "/workspace/app" {
		t.Fatalf("project_path_key = %q, want /workspace/app", updated.GetProjectPathKey())
	}

	listed := manager.ListTunnels()
	if len(listed) != 1 {
		t.Fatalf("ListTunnels returned %d tunnels, want 1", len(listed))
	}
	if listed[0].GetTargetUrl() != "http://localhost:3000/next" {
		t.Fatalf("listed target_url = %q, want http://localhost:3000/next", listed[0].GetTargetUrl())
	}
}
