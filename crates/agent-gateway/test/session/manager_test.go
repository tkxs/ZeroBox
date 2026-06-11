package session_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newTestSessionManager() *session.Manager {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	return sm
}

func assertDoneClosed(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for session done to close")
	}
}

func assertDoneOpen(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("session done is closed")
	default:
	}
}

func TestClearSessionDoesNotCloseReplacement(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	assertDoneClosed(t, first.Done())
	assertDoneOpen(t, second.Done())

	sm.ClearSession(first)
	if status := sm.Status(); !status.Online {
		t.Fatalf("status online = false after clearing stale session")
	}
	assertDoneOpen(t, second.Done())

	env := &gatewayv1.GatewayEnvelope{RequestId: "still-current"}
	if err := sm.SendToAgent(env); err != nil {
		t.Fatalf("SendToAgent after stale ClearSession: %v", err)
	}
	select {
	case got := <-second.Outbound():
		if got.GetRequestId() != "still-current" {
			t.Fatalf("request id = %q, want still-current", got.GetRequestId())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for current session outbound message")
	}

	sm.ClearSession(second)
	assertDoneClosed(t, second.Done())
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after clearing current session")
	}
	if err := sm.SendToAgent(env); !errors.Is(err, session.ErrAgentOffline) {
		t.Fatalf("SendToAgent after clearing current session = %v, want ErrAgentOffline", err)
	}
}

func TestClearSessionIfHeartbeatStaleClosesOnlyCurrentSession(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	time.Sleep(time.Millisecond)
	if sm.ClearSessionIfHeartbeatStale(first, time.Nanosecond) {
		t.Fatalf("stale first session should not close replacement session")
	}
	assertDoneOpen(t, second.Done())
	if status := sm.Status(); !status.Online {
		t.Fatalf("status online = false after stale old-session heartbeat timeout")
	}

	time.Sleep(time.Millisecond)
	if !sm.ClearSessionIfHeartbeatStale(second, time.Nanosecond) {
		t.Fatalf("current stale session was not cleared")
	}
	assertDoneClosed(t, second.Done())
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after current session heartbeat timeout")
	}
	if err := sm.SendToAgent(&gatewayv1.GatewayEnvelope{RequestId: "after-timeout"}); !errors.Is(err, session.ErrAgentOffline) {
		t.Fatalf("SendToAgent after heartbeat timeout = %v, want ErrAgentOffline", err)
	}
}

func TestChatRuntimeReadyRequiresFreshRuntimeHeartbeat(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)

	if status := sm.Status(); !status.Online || status.ChatRuntimeReady {
		t.Fatalf("initial status = %#v, want online without chat runtime readiness", status)
	}

	sm.UpdateRuntimeStatus(sess, &gatewayv1.RuntimeStatusEvent{
		WorkerId:       "runtime-1",
		State:          "ready",
		Visible:        true,
		ActiveRunCount: 0,
		Timestamp:      time.Now().Unix(),
	})
	if status := sm.Status(); !status.ChatRuntimeReady ||
		status.RuntimeState != "ready" ||
		status.RuntimeWorkerID != "runtime-1" ||
		status.RuntimeLastHeartbeat == 0 {
		t.Fatalf("ready runtime status = %#v", status)
	}

	sm.UpdateRuntimeStatus(sess, &gatewayv1.RuntimeStatusEvent{
		WorkerId:  "runtime-1",
		State:     "suspended",
		Timestamp: time.Now().Unix(),
	})
	if status := sm.Status(); status.ChatRuntimeReady || status.RuntimeState != "suspended" {
		t.Fatalf("suspended runtime status = %#v, want not ready", status)
	}

	sm.UpdateRuntimeStatus(sess, &gatewayv1.RuntimeStatusEvent{
		WorkerId:  "runtime-1",
		State:     "busy",
		Timestamp: time.Now().Unix(),
	})
	if !sm.ChatRuntimeReady() {
		t.Fatalf("busy runtime should be ready to manage chat runs")
	}

	sm.ClearSession(sess)
	if status := sm.Status(); status.ChatRuntimeReady || status.RuntimeState != "" {
		t.Fatalf("cleared session status = %#v, want runtime readiness reset", status)
	}
}

func TestClearSessionIfHeartbeatStaleFailsOpenChatRuns(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)
	if _, _, err := sm.StartPendingChatRunWithClientRequest(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatRunWithClientRequest: %v", err)
	}
	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	time.Sleep(time.Millisecond)
	if !sm.ClearSessionIfHeartbeatStale(sess, time.Nanosecond) {
		t.Fatalf("current stale session was not cleared")
	}
	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("event type = %v, want ERROR", event.Event.GetType())
		}
		if !strings.Contains(event.Event.GetData(), "Desktop agent disconnected") {
			t.Fatalf("event data = %q", event.Event.GetData())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for heartbeat timeout chat error")
	}
}

func TestDispatchFromStaleSessionIsIgnored(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	ch, done, cleanup, err := sm.RegisterStream("request-1")
	if err != nil {
		t.Fatalf("RegisterStream: %v", err)
	}
	defer cleanup()

	staleEnv := &gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_Error{
			Error: &gatewayv1.ErrorResponse{Code: 500, Message: "stale"},
		},
	}
	sm.DispatchFromAgentForSession(first, staleEnv)
	select {
	case got := <-ch:
		t.Fatalf("received stale session envelope: %#v", got)
	case <-done:
		t.Fatalf("stream closed while current session is still active")
	case <-time.After(50 * time.Millisecond):
	}

	currentEnv := &gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_Error{
			Error: &gatewayv1.ErrorResponse{Code: 500, Message: "current"},
		},
	}
	sm.DispatchFromAgentForSession(second, currentEnv)
	select {
	case got := <-ch:
		if got.GetError().GetMessage() != "current" {
			t.Fatalf("error message = %q, want current", got.GetError().GetMessage())
		}
	case <-done:
		t.Fatalf("stream closed before current session dispatch")
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for current session envelope")
	}
}

func TestSendToAgentUnblocksWhenSessionCloses(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)

	errCh := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				errCh <- fmt.Errorf("panic: %v", recovered)
			}
		}()
		for i := 0; i < 128; i += 1 {
			_ = sm.SendToAgent(&gatewayv1.GatewayEnvelope{RequestId: fmt.Sprintf("request-%d", i)})
		}
		errCh <- nil
	}()

	time.Sleep(10 * time.Millisecond)
	sm.ClearSession(sess)

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatalf("SendToAgent did not unblock after session close")
	}
}

func TestSendToAgentContextReturnsWhenOutboundQueueIsFull(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)

	for i := 0; i < 64; i += 1 {
		if err := sm.SendToAgent(&gatewayv1.GatewayEnvelope{RequestId: fmt.Sprintf("queued-%d", i)}); err != nil {
			t.Fatalf("prime outbound queue: %v", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	err := sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{RequestId: "blocked"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SendToAgentContext with full queue = %v, want context deadline exceeded", err)
	}
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after SendToAgentContext timeout")
	}
}

func TestRemoveChatRunByConversationReleasesBufferedRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	if _, err := sm.StartChatRun("request-1", "conversation-1"); err != nil {
		t.Fatalf("StartChatRun: %v", err)
	}

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun before remove: %v", err)
	}
	if snapshot.RequestID != "request-1" {
		t.Fatalf("snapshot request id = %q, want request-1", snapshot.RequestID)
	}

	sm.RemoveChatRunByConversation("conversation-1")
	assertDoneClosed(t, done)
	cleanup()
	select {
	case event := <-ch:
		t.Fatalf("unexpected replay event after remove: %#v", event)
	default:
	}

	_, missingDone, missingCleanup, _, err := sm.SubscribeChatRun("", "conversation-1", 0)
	defer missingCleanup()
	assertDoneClosed(t, missingDone)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun after remove = %v, want ErrChatRunNotFound", err)
	}
}

func TestStartChatRunWithClientRequestReusesExistingRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first, created, err := sm.StartChatRunWithClientRequest(
		"request-1",
		"",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartChatRunWithClientRequest first: %v", err)
	}
	if !created {
		t.Fatalf("first run created = false, want true")
	}
	if first.RequestID != "request-1" {
		t.Fatalf("first request id = %q, want request-1", first.RequestID)
	}
	if first.ClientRequestID != "client-submit-1" {
		t.Fatalf("first client request id = %q, want client-submit-1", first.ClientRequestID)
	}

	duplicate, created, err := sm.StartChatRunWithClientRequest(
		"request-2",
		"",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartChatRunWithClientRequest duplicate: %v", err)
	}
	if created {
		t.Fatalf("duplicate run created = true, want false")
	}
	if duplicate.RequestID != "request-1" {
		t.Fatalf("duplicate request id = %q, want original request-1", duplicate.RequestID)
	}

	_, missingDone, missingCleanup, _, err := sm.SubscribeChatRun("request-2", "", 0)
	defer missingCleanup()
	assertDoneClosed(t, missingDone)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun duplicate request = %v, want ErrChatRunNotFound", err)
	}

	sm.RemoveChatRun("request-1")
	restarted, created, err := sm.StartChatRunWithClientRequest(
		"request-3",
		"",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartChatRunWithClientRequest after remove: %v", err)
	}
	if !created {
		t.Fatalf("restarted run created = false, want true")
	}
	if restarted.RequestID != "request-3" {
		t.Fatalf("restarted request id = %q, want request-3", restarted.RequestID)
	}
}

func TestPendingChatRunBecomesActiveOnlyAfterStartedEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	snapshot, created, err := sm.StartPendingChatRunWithClientRequest(
		"request-1",
		"conversation-1",
		"client-submit-1",
		"/workspace",
	)
	if err != nil {
		t.Fatalf("StartPendingChatRunWithClientRequest: %v", err)
	}
	if !created || snapshot.RequestID != "request-1" {
		t.Fatalf("pending run = %#v created=%v", snapshot, created)
	}
	if got := sm.ActiveChatRunConversationIDs(); len(got) != 0 {
		t.Fatalf("pending active chat runs = %#v, want empty", got)
	}

	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"type":"accepted"}`,
			},
		},
	})
	if got := sm.ActiveChatRunConversationIDs(); len(got) != 0 {
		t.Fatalf("accepted active chat runs = %#v, want empty", got)
	}
	if sm.FailStartingChatRun("request-1", "desktop did not accept") {
		t.Fatalf("accepted pending run should not fail the accept watchdog")
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"type":"started"}`,
			},
		},
	})

	got := sm.ActiveChatRunConversationIDs()
	want := []string{"conversation-1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat runs after started = %#v, want %#v", got, want)
	}
	select {
	case event := <-ch:
		t.Fatalf("started control event leaked to subscriber: %#v", event)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestFailStartingChatRunBroadcastsErrorAndClearsActiveSummary(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, _, err := sm.StartPendingChatRunWithClientRequest(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatRunWithClientRequest: %v", err)
	}
	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	if !sm.FailStartingChatRun("request-1", "desktop did not accept") {
		t.Fatalf("FailStartingChatRun returned false")
	}

	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("event type = %v, want ERROR", event.Event.GetType())
		}
		if !strings.Contains(event.Event.GetData(), "desktop did not accept") {
			t.Fatalf("event data = %q", event.Event.GetData())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for starting run failure event")
	}
	if got := sm.ActiveChatRunConversationIDs(); len(got) != 0 {
		t.Fatalf("active chat runs after failed start = %#v, want empty", got)
	}
	if status := sm.Status(); status.Online {
		t.Fatalf("status online = true after chat run failed before desktop accept")
	}
}

func TestFailUnstartedChatRunBroadcastsErrorUnlessStarted(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, _, err := sm.StartPendingChatRunWithClientRequest(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatRunWithClientRequest request-1: %v", err)
	}
	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	if sm.FailUnstartedChatRun("request-1", "desktop app did not start") {
		t.Fatalf("unaccepted pending run should not fail the render-start watchdog")
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"type":"accepted"}`,
			},
		},
	})

	if !sm.FailUnstartedChatRun("request-1", "desktop app did not start") {
		t.Fatalf("FailUnstartedChatRun returned false for accepted pending run")
	}
	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("event type = %v, want ERROR", event.Event.GetType())
		}
		if !strings.Contains(event.Event.GetData(), "desktop app did not start") {
			t.Fatalf("event data = %q", event.Event.GetData())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for unstarted run failure event")
	}

	if _, _, err := sm.StartPendingChatRunWithClientRequest(
		"request-2",
		"conversation-2",
		"client-submit-2",
	); err != nil {
		t.Fatalf("StartPendingChatRunWithClientRequest request-2: %v", err)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-2",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-2",
				Data:           `{"type":"started"}`,
			},
		},
	})
	if sm.FailUnstartedChatRun("request-2", "desktop app did not start") {
		t.Fatalf("started run should not fail the render-start watchdog")
	}
}

func TestTerminalChatRunStateIsImmutable(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, _, err := sm.StartPendingChatRunWithClientRequest(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil {
		t.Fatalf("StartPendingChatRunWithClientRequest: %v", err)
	}
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_ERROR,
				ConversationId: "conversation-1",
				Data:           `{"message":"startup failed"}`,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatControl{
			ChatControl: &gatewayv1.ChatControlEvent{
				Type:           "completed",
				State:          session.ChatRunStateCompleted,
				RequestId:      "request-1",
				ConversationId: "conversation-1",
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"late token"}`,
			},
		},
	})

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.State != session.ChatRunStateFailed {
		t.Fatalf("terminal state = %q, want %q", snapshot.State, session.ChatRunStateFailed)
	}

	select {
	case event := <-ch:
		if event.Event == nil || event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("replayed event = %#v, want ERROR", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for replayed error event")
	}
	select {
	case event := <-ch:
		t.Fatalf("terminal completion control should be ignored after failure: %#v", event)
	default:
	}
}

func TestDesktopBroadcastChatEventCreatesAttachableRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "conversation-live-conversation-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"hello"}`,
			},
		},
	})

	ch, done, cleanup, snapshot, err := sm.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	assertDoneOpen(t, done)
	if snapshot.RequestID != "conversation-live-conversation-1" {
		t.Fatalf("snapshot request id = %q, want conversation-live-conversation-1", snapshot.RequestID)
	}

	select {
	case event := <-ch:
		if event.Seq != 1 {
			t.Fatalf("event seq = %d, want 1", event.Seq)
		}
		if event.Event.GetType() != gatewayv1.ChatEvent_TOKEN {
			t.Fatalf("event type = %v, want TOKEN", event.Event.GetType())
		}
		if event.Event.GetConversationId() != "conversation-1" {
			t.Fatalf("conversation id = %q, want conversation-1", event.Event.GetConversationId())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for replayed desktop chat event")
	}
}

func TestCompletedHistoryUpsertDoesNotPreemptTerminalChatEvent(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, err := sm.StartChatRun("request-1", "conversation-1"); err != nil {
		t.Fatalf("StartChatRun: %v", err)
	}

	ch, done, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{}`,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "history-sync-1",
		Payload: &gatewayv1.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv1.HistorySyncEvent{
				Kind:           "upsert",
				ConversationId: "conversation-1",
				Conversation: &gatewayv1.ConversationSummary{
					Id: "conversation-1",
				},
			},
		},
	})

	assertDoneOpen(t, done)
	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_DONE {
			t.Fatalf("event type = %v, want DONE", event.Event.GetType())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for terminal chat event")
	}

	_, missingDone, missingCleanup, _, err := sm.SubscribeChatRun("", "conversation-1", 0)
	defer missingCleanup()
	assertDoneClosed(t, missingDone)
	if !errors.Is(err, session.ErrChatRunNotFound) {
		t.Fatalf("SubscribeChatRun after release = %v, want ErrChatRunNotFound", err)
	}
}

func TestActiveChatRunConversationIDsReturnsOpenRuns(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	if _, err := sm.StartChatRun("request-b", "conversation-b"); err != nil {
		t.Fatalf("StartChatRun request-b: %v", err)
	}
	if _, err := sm.StartChatRun("request-a", "conversation-a"); err != nil {
		t.Fatalf("StartChatRun request-a: %v", err)
	}
	if _, err := sm.StartChatRun("request-empty", ""); err != nil {
		t.Fatalf("StartChatRun request-empty: %v", err)
	}
	if _, err := sm.StartChatRun("request-a-duplicate", "conversation-a"); err != nil {
		t.Fatalf("StartChatRun request-a-duplicate: %v", err)
	}

	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-b",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-b",
				Data:           `{}`,
			},
		},
	})

	got := sm.ActiveChatRunConversationIDs()
	want := []string{"conversation-a"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat run conversation ids = %#v, want %#v", got, want)
	}
}

func TestClearSessionFailsOpenChatRuns(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	sess := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(sess)
	first, created, err := sm.StartChatRunWithClientRequest(
		"request-1",
		"conversation-1",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartChatRunWithClientRequest: %v", err)
	}
	if !created || first.RequestID != "request-1" {
		t.Fatalf("first run = %#v created=%v", first, created)
	}

	ch, done, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	sm.ClearSession(sess)
	assertDoneClosed(t, sess.Done())
	assertDoneOpen(t, done)

	select {
	case event := <-ch:
		if event.Event.GetType() != gatewayv1.ChatEvent_ERROR {
			t.Fatalf("event type = %v, want ERROR", event.Event.GetType())
		}
		if event.Event.GetConversationId() != "conversation-1" {
			t.Fatalf("conversation id = %q, want conversation-1", event.Event.GetConversationId())
		}
		if !strings.Contains(event.Event.GetData(), "Desktop agent disconnected") {
			t.Fatalf("event data = %q, want disconnect message", event.Event.GetData())
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for disconnect chat error")
	}

	if got := sm.ActiveChatRunConversationIDs(); len(got) != 0 {
		t.Fatalf("active chat runs after disconnect = %#v, want empty", got)
	}

	restarted, created, err := sm.StartChatRunWithClientRequest(
		"request-2",
		"conversation-1",
		"client-submit-1",
	)
	if err != nil {
		t.Fatalf("StartChatRunWithClientRequest retry: %v", err)
	}
	if !created || restarted.RequestID != "request-2" {
		t.Fatalf("retry run = %#v created=%v, want new request-2", restarted, created)
	}
}

func TestStaleClearSessionDoesNotFailReplacementChatRun(t *testing.T) {
	t.Parallel()

	sm := newTestSessionManager()
	first := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(first)
	second := session.NewAgentSession(sm.LatestAuthSnapshot())
	sm.SetSession(second)

	if _, err := sm.StartChatRun("request-current", "conversation-current"); err != nil {
		t.Fatalf("StartChatRun: %v", err)
	}
	sm.ClearSession(first)

	got := sm.ActiveChatRunConversationIDs()
	want := []string{"conversation-current"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("active chat runs after stale clear = %#v, want %#v", got, want)
	}
	assertDoneOpen(t, second.Done())
}
