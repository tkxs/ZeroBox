package session

import "testing"

func sessionClosed(session *AgentSession) bool {
	select {
	case <-session.Done():
		return true
	default:
		return false
	}
}

func TestDeviceManagersIsolateAccountsAndReconnectOnlyOneDevice(t *testing.T) {
	root := NewManager()
	userOne := root.DeviceManager(1, "device-a")
	userTwo := root.DeviceManager(2, "device-a")
	if userOne == userTwo {
		t.Fatal("different accounts shared a device manager")
	}
	first := NewAgentSession(AuthSnapshot{AgentID: "one"})
	second := NewAgentSession(AuthSnapshot{AgentID: "two"})
	userOne.SetSession(first)
	userTwo.SetSession(second)
	if !userOne.IsOnline() || !userTwo.IsOnline() {
		t.Fatal("simultaneous account devices did not stay online")
	}
	replacement := NewAgentSession(AuthSnapshot{AgentID: "one-new"})
	userOne.SetSession(replacement)
	if !sessionClosed(first) {
		t.Fatal("same-device reconnect did not close the old session")
	}
	if sessionClosed(second) || !userTwo.IsOnline() {
		t.Fatal("one account reconnect evicted another account")
	}
	root.DisconnectDevice(1, "device-a")
	if !sessionClosed(replacement) || sessionClosed(second) {
		t.Fatal("device revocation was not isolated")
	}
}
