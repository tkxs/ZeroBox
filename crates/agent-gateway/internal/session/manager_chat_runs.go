package session

import (
	"encoding/json"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (m *Manager) StartPendingChatCommandRun(
	requestID string,
	conversationID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	workdir := ""
	if len(workdirInput) > 0 {
		workdir = workdirInput[0]
	}
	snapshot, created := m.createChatRun(requestID, conversationID, workdir)
	if !created {
		return snapshot, false, nil
	}
	return snapshot, true, nil
}

func (m *Manager) StartAcceptedChatCommandRun(
	requestID string,
	conversationID string,
	workdir string,
	initialPayloads []map[string]any,
) (ChatRunSnapshot, bool, int64, error) {
	m.chatStore.chatCommandMu.Lock()
	defer m.chatStore.chatCommandMu.Unlock()

	snapshot, created := m.createChatRun(requestID, conversationID, workdir)
	if !created {
		return snapshot, false, snapshot.LatestSeq, nil
	}

	m.MarkChatRunControl(snapshot.RequestID, conversationID, "accepted", "", "")
	acceptedSeq := snapshot.LatestSeq
	if acceptedSnapshot, ok := m.ChatRunSnapshot(snapshot.RequestID, conversationID); ok {
		snapshot = acceptedSnapshot
		acceptedSeq = acceptedSnapshot.LatestSeq
	}
	if len(initialPayloads) > 0 {
		m.MarkChatRunPayloads(snapshot.RequestID, conversationID, initialPayloads)
		if nextSnapshot, ok := m.ChatRunSnapshot(snapshot.RequestID, conversationID); ok {
			snapshot = nextSnapshot
		}
	}
	return snapshot, true, acceptedSeq, nil
}

func (m *Manager) createChatRun(
	requestID string,
	conversationID string,
	workdir string,
) (ChatRunSnapshot, bool) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return ChatRunSnapshot{}, false
	}
	conversationID = strings.TrimSpace(conversationID)
	workdir = strings.TrimSpace(workdir)
	now := time.Now()

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)

	if existing := m.chatStore.chatRuns[requestID]; existing != nil {
		return existing.snapshot(), false
	}

	m.chatStore.nextChatRunEpoch++
	latestSeq := m.latestConversationSeqLocked(conversationID)
	run := &chatRun{
		requestID:            requestID,
		conversationID:       conversationID,
		workdir:              workdir,
		runEpoch:             m.chatStore.nextChatRunEpoch,
		state:                ChatRunStateQueued,
		nextSeq:              latestSeq,
		updatedAt:            now,
		subscribers:          make(map[int]*chatRunSubscriber),
		relayBufferRetention: m.chatStore.relayBufferRetention,
	}
	m.chatStore.chatRuns[requestID] = run
	if conversationID != "" && m.chatRunCanClaimConversationLocked(conversationID, requestID) {
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
	return run.snapshot(), true
}

func (m *Manager) latestConversationSeqLocked(conversationID string) int64 {
	if conversationID == "" {
		return 0
	}
	var latestSeq int64
	for _, run := range m.chatStore.chatRuns {
		if run == nil || run.conversationID != conversationID {
			continue
		}
		if run.nextSeq > latestSeq {
			latestSeq = run.nextSeq
		}
	}
	return latestSeq
}

func (m *Manager) chatRunCanClaimConversationLocked(conversationID string, requestID string) bool {
	if conversationID == "" || requestID == "" {
		return false
	}
	currentRequestID := m.chatStore.chatRunByConversation[conversationID]
	if currentRequestID == "" || currentRequestID == requestID {
		return true
	}
	currentRun := m.chatStore.chatRuns[currentRequestID]
	return currentRun == nil || currentRun.done
}

func chatRunControlCanClaimConversation(controlType string, state string) bool {
	if normalizeChatRunState(state) == ChatRunStateRunning {
		return true
	}
	return controlType == "started"
}

func (m *Manager) RemoveChatRun(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) RemoveChatRunByConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return
	}
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	requestID := m.chatStore.chatRunByConversation[conversationID]
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		for candidateRequestID, candidateRun := range m.chatStore.chatRuns {
			if candidateRun.conversationID == conversationID {
				requestID = candidateRequestID
				run = candidateRun
				break
			}
		}
	}
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) ActiveChatRunSummaries() []ActiveChatRunSummary {
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	now := time.Now()
	m.pruneExpiredChatRunsLocked(now)

	seen := make(map[string]int, len(m.chatStore.chatRuns))
	summaries := make([]ActiveChatRunSummary, 0, len(m.chatStore.chatRuns))
	for _, run := range m.chatStore.chatRuns {
		if run == nil || run.done || !activeChatRunStates[run.state] {
			continue
		}
		conversationID := run.conversationID
		if conversationID == "" {
			continue
		}
		firstSeq := run.snapshot().FirstSeq
		if firstSeq <= 0 {
			firstSeq = run.nextSeq + 1
		}
		summary := ActiveChatRunSummary{
			ConversationID: conversationID,
			RequestID:      run.requestID,
			Workdir:        run.workdir,
			FirstSeq:       firstSeq,
			LatestSeq:      run.nextSeq,
			RunEpoch:       run.runEpoch,
			UpdatedAt:      run.updatedAt.UnixMilli(),
		}
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = summary.Workdir
			}
			currentOwner := m.chatStore.chatRunByConversation[conversationID]
			if shouldReplaceActiveChatRunSummary(summary, summaries[index], currentOwner) {
				summaries[index] = summary
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, summary)
	}
	return summaries
}

func shouldReplaceActiveChatRunSummary(candidate ActiveChatRunSummary, current ActiveChatRunSummary, currentOwner string) bool {
	candidateIsOwner := currentOwner != "" && candidate.RequestID == currentOwner
	currentIsOwner := currentOwner != "" && current.RequestID == currentOwner
	if candidateIsOwner != currentIsOwner {
		return candidateIsOwner
	}
	return candidate.UpdatedAt > current.UpdatedAt
}

func (m *Manager) ConversationRunSummary(conversationID string) (ActiveChatRunSummary, bool) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return ActiveChatRunSummary{}, false
	}
	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	requestID := m.chatStore.chatRunByConversation[conversationID]
	if requestID == "" {
		return ActiveChatRunSummary{}, false
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		return ActiveChatRunSummary{}, false
	}
	firstSeq := run.snapshot().FirstSeq
	if firstSeq <= 0 {
		firstSeq = run.nextSeq + 1
	}
	return ActiveChatRunSummary{
		ConversationID: conversationID,
		RequestID:      run.requestID,
		Workdir:        run.workdir,
		FirstSeq:       firstSeq,
		LatestSeq:      run.nextSeq,
		RunEpoch:       run.runEpoch,
		UpdatedAt:      run.updatedAt.UnixMilli(),
	}, true
}

func (m *Manager) FailStartingChatRun(requestID string, message string) bool {
	return m.failChatRunIf(
		requestID,
		message,
		"Desktop backend did not accept the remote chat request. Please retry.",
		func(run *chatRun) bool {
			return run != nil && !run.done && normalizeChatRunState(run.state) == ChatRunStateQueued
		},
	)
}

func (m *Manager) FailUnstartedChatRun(requestID string, message string) bool {
	return m.failChatRunIf(
		requestID,
		message,
		"Desktop app accepted the remote chat request but did not start it. Please retry.",
		func(run *chatRun) bool {
			if run == nil || run.done {
				return false
			}
			state := normalizeChatRunState(run.state)
			return state != ChatRunStateQueued &&
				state != ChatRunStateDesktopQueued &&
				state != ChatRunStateRunning &&
				!isTerminalChatRunState(state)
		},
	)
}

func (m *Manager) failChatRunIf(
	requestID string,
	message string,
	defaultMessage string,
	shouldFail func(*chatRun) bool,
) bool {
	requestID = strings.TrimSpace(requestID)
	message = strings.TrimSpace(message)
	if requestID == "" {
		return false
	}
	if message == "" {
		message = defaultMessage
	}

	data, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		fallback, marshalErr := json.Marshal(map[string]string{"message": defaultMessage})
		if marshalErr != nil {
			fallback = []byte(`{"message":"Remote chat request failed. Please retry."}`)
		}
		data = fallback
	}

	now := time.Now()
	var broadcast *ChatBroadcastEvent
	var runSubscribers []*chatRunSubscriber

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if shouldFail == nil || !shouldFail(run) {
		m.chatStore.chatMu.Unlock()
		return false
	}

	run.nextSeq++
	run.updatedAt = now
	run.applyState(ChatRunStateFailed)
	run.expiresAt = now.Add(chatRunDoneRetention)
	chatEvent := &gatewayv1.ChatEvent{
		Type:           gatewayv1.ChatEvent_ERROR,
		ConversationId: run.conversationID,
		Data:           string(data),
	}
	broadcast = &ChatBroadcastEvent{
		RequestID:  requestID,
		Event:      chatEvent,
		Seq:        run.nextSeq,
		Workdir:    run.workdir,
		ReceivedAt: now,
	}
	run.appendEvent(broadcast)
	runSubscribers = run.collectSubscribers()
	m.chatStore.chatMu.Unlock()

	notifySubscribers(runSubscribers, broadcast)
	return true
}

type ChatRunSubscribeResult struct {
	EventCh     <-chan *ChatBroadcastEvent
	Done        <-chan struct{}
	Cleanup     func()
	Snapshot    ChatRunSnapshot
	GapDetected bool
	OldestSeq   int64
}

func (m *Manager) SubscribeChatRun(
	requestID string,
	conversationID string,
	afterSeq int64,
) (*ChatRunSubscribeResult, error) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if afterSeq < 0 {
		afterSeq = 0
	}
	conversationReplayRequested := requestID == "" && conversationID != ""

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	now := time.Now()
	m.pruneExpiredChatRunsLocked(now)

	if conversationReplayRequested && conversationID != "" {
		if liveRequestID := m.chatStore.chatRunByConversation[conversationID]; liveRequestID != "" {
			requestID = liveRequestID
		}
	} else if requestID == "" && conversationID != "" {
		requestID = m.chatStore.chatRunByConversation[conversationID]
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		done := make(chan struct{})
		close(done)
		return &ChatRunSubscribeResult{
			Done:    done,
			Cleanup: func() {},
		}, ErrChatRunNotFound
	}

	var replay []*ChatBroadcastEvent
	gapDetected := false
	var oldestSeq int64

	if conversationReplayRequested && conversationID != "" {
		replay = m.collectConversationEventsLocked(conversationID, afterSeq)
	} else {
		replay = collectBufferedEventsAfterSeq(run, afterSeq)
	}

	if afterSeq > 0 && len(run.events) > 0 {
		oldestSeq = run.events[0].Seq
		if afterSeq < oldestSeq {
			gapDetected = true
		}
	}

	bufferSize := len(replay) + 128
	ch := make(chan *ChatBroadcastEvent, bufferSize)
	done := make(chan struct{})
	for _, event := range replay {
		ch <- event
	}

	subID := -1
	var subscriber *chatRunSubscriber
	doneClosed := false
	if !run.done {
		subID = m.chatStore.nextChatRunSubID
		m.chatStore.nextChatRunSubID++
		subscriber = &chatRunSubscriber{
			ch:   ch,
			done: done,
		}
		run.subscribers[subID] = subscriber
	} else if len(replay) == 0 {
		close(done)
		doneClosed = true
	}

	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			m.chatStore.chatMu.Lock()
			if subID >= 0 {
				if current := m.chatStore.chatRuns[requestID]; current != nil {
					delete(current.subscribers, subID)
				}
			}
			m.chatStore.chatMu.Unlock()
			if subscriber != nil {
				subscriber.close()
			} else if !doneClosed {
				close(done)
			}
		})
	}

	return &ChatRunSubscribeResult{
		EventCh:     ch,
		Done:        done,
		Cleanup:     cleanup,
		Snapshot:    run.snapshot(),
		GapDetected: gapDetected,
		OldestSeq:   oldestSeq,
	}, nil
}

func collectBufferedEventsAfterSeq(run *chatRun, afterSeq int64) []*ChatBroadcastEvent {
	if run == nil {
		return nil
	}
	replay := make([]*ChatBroadcastEvent, 0, len(run.events))
	for _, event := range run.events {
		if event.Seq > afterSeq {
			replay = append(replay, cloneChatBroadcastEvent(event))
		}
	}
	return replay
}

func (m *Manager) collectConversationEventsLocked(conversationID string, afterSeq int64) []*ChatBroadcastEvent {
	var replay []*ChatBroadcastEvent
	for _, run := range m.chatStore.chatRuns {
		if run == nil || run.conversationID != conversationID {
			continue
		}
		for _, event := range run.events {
			if event.Seq > afterSeq {
				replay = append(replay, cloneChatBroadcastEvent(event))
			}
		}
	}
	// Runs live in a map, so multi-run conversations (e.g. a queued prompt
	// auto-sent right after the previous run) would otherwise replay in
	// arbitrary run order.
	sort.SliceStable(replay, func(i, j int) bool {
		return replay[i].Seq < replay[j].Seq
	})
	return replay
}

func (m *Manager) ChatRunSnapshot(
	requestID string,
	conversationID string,
) (ChatRunSnapshot, bool) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(time.Now())

	if requestID == "" && conversationID != "" {
		requestID = m.chatStore.chatRunByConversation[conversationID]
	}
	run := m.chatStore.chatRuns[requestID]
	if run == nil {
		return ChatRunSnapshot{}, false
	}
	return run.snapshot(), true
}

func (m *Manager) RunningChatRunSnapshot(conversationID string) (ChatRunSnapshot, bool) {
	if conversationID == "" {
		return ChatRunSnapshot{}, false
	}

	m.chatStore.chatMu.Lock()
	defer m.chatStore.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(time.Now())

	if requestID := m.chatStore.chatRunByConversation[conversationID]; requestID != "" {
		if run := m.chatStore.chatRuns[requestID]; chatRunIsRunningForConversation(run, conversationID) {
			return run.snapshot(), true
		}
	}

	var best *chatRun
	for _, run := range m.chatStore.chatRuns {
		if !chatRunIsRunningForConversation(run, conversationID) {
			continue
		}
		if best == nil || run.updatedAt.After(best.updatedAt) {
			best = run
		}
	}
	if best == nil {
		return ChatRunSnapshot{}, false
	}
	return best.snapshot(), true
}

func chatRunIsRunningForConversation(run *chatRun, conversationID string) bool {
	return run != nil &&
		!run.done &&
		run.conversationID == conversationID &&
		normalizeChatRunState(run.state) == ChatRunStateRunning
}

func (m *Manager) MarkChatRunControl(
	requestID string,
	conversationID string,
	controlType string,
	errorCode string,
	message string,
) {
	m.markChatRunControl(
		strings.TrimSpace(requestID),
		strings.TrimSpace(conversationID),
		strings.TrimSpace(controlType),
		"",
		strings.TrimSpace(errorCode),
		strings.TrimSpace(message),
		time.Now(),
	)
}

func (m *Manager) MarkChatRunPayload(
	requestID string,
	conversationID string,
	payload map[string]any,
) int64 {
	seqs := m.MarkChatRunPayloads(requestID, conversationID, []map[string]any{payload})
	if len(seqs) == 0 {
		return 0
	}
	return seqs[0]
}

func (m *Manager) MarkChatRunPayloads(
	requestID string,
	conversationID string,
	payloads []map[string]any,
) []int64 {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if requestID == "" || len(payloads) == 0 {
		return nil
	}

	now := time.Now()
	broadcasts := make([]*ChatBroadcastEvent, 0, len(payloads))
	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if run == nil || run.done {
		m.chatStore.chatMu.Unlock()
		if run == nil {
			log.Printf("MarkChatRunPayloads: no run for requestID=%s", requestID)
		}
		return nil
	}
	m.updateRunConversationLocked(run, requestID, conversationID, false)
	for _, payload := range payloads {
		broadcast := m.appendChatPayloadLocked(run, payload, now)
		if broadcast != nil {
			broadcasts = append(broadcasts, broadcast)
		}
	}
	runSubscribers := run.collectSubscribers()
	m.chatStore.chatMu.Unlock()

	if len(broadcasts) == 0 {
		return nil
	}
	for _, broadcast := range broadcasts {
		notifySubscribers(runSubscribers, broadcast)
	}
	seqs := make([]int64, 0, len(broadcasts))
	for _, broadcast := range broadcasts {
		seqs = append(seqs, broadcast.Seq)
	}
	return seqs
}

func (m *Manager) ApplyChatRuntimeSnapshot(snapshot *gatewayv1.ChatRuntimeSnapshot) {
	if snapshot == nil {
		return
	}
	requestID := strings.TrimSpace(snapshot.GetRunId())
	conversationID := strings.TrimSpace(snapshot.GetConversationId())
	if requestID == "" || conversationID == "" {
		return
	}
	state := normalizeChatRunState(snapshot.GetState())
	if state == "" {
		state = ChatRunStateRunning
	}
	now := chatRuntimeSnapshotTime(snapshot.GetUpdatedAt())
	workdir := strings.TrimSpace(snapshot.GetCwd())

	payload := map[string]any{
		"type":                      "runtime_snapshot",
		"conversation_id":           conversationID,
		"run_id":                    requestID,
		"state":                     state,
		"updated_at":                now.UnixMilli(),
		"revision":                  snapshot.GetRevision(),
		"entries_json":              strings.TrimSpace(snapshot.GetEntriesJson()),
		"tool_status":               strings.TrimSpace(snapshot.GetToolStatus()),
		"tool_status_is_compaction": snapshot.GetToolStatusIsCompaction(),
	}
	if workerID := strings.TrimSpace(snapshot.GetWorkerId()); workerID != "" {
		payload["worker_id"] = workerID
	}

	var broadcast *ChatBroadcastEvent
	var runSubscribers []*chatRunSubscriber
	var activityKind string
	var activityConversationID string
	var activityWorkdir string
	terminalState := isTerminalChatRunState(state)

	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	created := false
	if run == nil {
		m.chatStore.nextChatRunEpoch++
		run = &chatRun{
			requestID:            requestID,
			conversationID:       conversationID,
			workdir:              workdir,
			runEpoch:             m.chatStore.nextChatRunEpoch,
			state:                state,
			nextSeq:              m.latestConversationSeqLocked(conversationID),
			updatedAt:            now,
			subscribers:          make(map[int]*chatRunSubscriber),
			relayBufferRetention: m.chatStore.relayBufferRetention,
		}
		m.chatStore.chatRuns[requestID] = run
		created = true
	}
	if run.done && !terminalState {
		m.chatStore.chatMu.Unlock()
		return
	}
	previousState := normalizeChatRunState(run.state)
	m.updateRunConversationLocked(run, requestID, conversationID, state == ChatRunStateRunning)
	if workdir != "" {
		run.workdir = workdir
	}
	run.applyState(state)
	run.updatedAt = now
	if terminalState {
		run.expiresAt = now.Add(chatRunDoneRetention)
	}
	broadcast = m.appendChatPayloadLocked(run, payload, now)
	runSubscribers = run.collectSubscribers()
	if state == ChatRunStateRunning && (created || previousState != ChatRunStateRunning) {
		activityKind = "running"
	} else if terminalState {
		activityKind = "idle"
	}
	activityConversationID = run.conversationID
	activityWorkdir = run.workdir
	m.chatStore.chatMu.Unlock()

	if broadcast == nil {
		return
	}
	notifySubscribers(runSubscribers, broadcast)
	if terminalState {
		for _, s := range runSubscribers {
			s.close()
		}
	}
	if activityKind != "" {
		m.broadcastChatRunActivity(activityKind, activityConversationID, activityWorkdir, now)
	}
}

func chatRuntimeSnapshotTime(updatedAt int64) time.Time {
	if updatedAt <= 0 {
		return time.Now()
	}
	if updatedAt < 10_000_000_000 {
		return time.Unix(updatedAt, 0)
	}
	return time.UnixMilli(updatedAt)
}

func (m *Manager) broadcastChatEvent(requestID string, event *gatewayv1.ChatEvent) {
	if event == nil {
		return
	}

	requestID = strings.TrimSpace(requestID)
	conversationID := strings.TrimSpace(event.GetConversationId())
	now := time.Now()
	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	broadcast := &ChatBroadcastEvent{
		RequestID:  requestID,
		Event:      event,
		ReceivedAt: now,
	}
	var runSubscribers []*chatRunSubscriber
	var activityKind string
	var activityConversationID string
	var activityWorkdir string
	run := m.chatStore.chatRuns[requestID]
	if run == nil && requestID != "" {
		m.chatStore.nextChatRunEpoch++
		latestSeq := m.latestConversationSeqLocked(conversationID)
		run = &chatRun{
			requestID:            requestID,
			conversationID:       conversationID,
			runEpoch:             m.chatStore.nextChatRunEpoch,
			state:                ChatRunStateQueued,
			nextSeq:              latestSeq,
			updatedAt:            now,
			subscribers:          make(map[int]*chatRunSubscriber),
			relayBufferRetention: m.chatStore.relayBufferRetention,
		}
		m.chatStore.chatRuns[requestID] = run
		if conversationID != "" && m.chatRunCanClaimConversationLocked(conversationID, requestID) {
			m.chatStore.chatRunByConversation[conversationID] = requestID
		}
	}
	if run == nil || run.done {
		m.chatStore.chatMu.Unlock()
		return
	}
	previousState := normalizeChatRunState(run.state)
	m.updateRunConversationLocked(run, requestID, conversationID, false)
	if normalizeChatRunState(run.state) != ChatRunStateRunning && !isTerminalChatEvent(event) {
		run.applyState(ChatRunStateRunning)
	}
	run.nextSeq++
	run.updatedAt = now
	broadcast.Seq = run.nextSeq
	broadcast.Workdir = run.workdir
	if isTerminalChatEvent(event) {
		if event.GetType() == gatewayv1.ChatEvent_DONE {
			run.applyState(ChatRunStateCompleted)
		} else {
			run.applyState(ChatRunStateFailed)
		}
		run.expiresAt = now.Add(chatRunDoneRetention)
	}
	nextState := normalizeChatRunState(run.state)
	activityKind, activityConversationID, activityWorkdir = detectRunActivity(run, previousState, nextState)
	run.appendEvent(broadcast)
	runSubscribers = run.collectSubscribers()
	m.chatStore.chatMu.Unlock()

	notifySubscribers(runSubscribers, broadcast)
	if isTerminalChatEvent(event) {
		for _, s := range runSubscribers {
			s.close()
		}
	}
	if activityKind != "" {
		m.broadcastChatRunActivity(activityKind, activityConversationID, activityWorkdir, now)
	}
}

func (m *Manager) broadcastChatControl(requestID string, control *gatewayv1.ChatControlEvent) {
	if control == nil {
		return
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		requestID = strings.TrimSpace(control.GetRequestId())
	}
	conversationID := strings.TrimSpace(control.GetConversationId())
	controlType := strings.TrimSpace(control.GetType())
	state := normalizeChatRunState(control.GetState())
	if state == "" {
		state = controlTypeToState[controlType]
	}
	errorCode := strings.TrimSpace(control.GetErrorCode())
	message := strings.TrimSpace(control.GetMessage())
	m.markChatRunControl(requestID, conversationID, controlType, state, errorCode, message, time.Now())
}

func (m *Manager) markChatRunControl(
	requestID string,
	conversationID string,
	controlType string,
	state string,
	errorCode string,
	message string,
	now time.Time,
) {
	if requestID == "" {
		return
	}

	state = normalizeChatRunState(state)
	if controlType == "" {
		controlType = stateToControlType[normalizeChatRunState(state)]
		if controlType == "" {
			controlType = "progress"
		}
	}

	var activityKind string
	var activityConversationID string
	var activityWorkdir string
	m.chatStore.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	run := m.chatStore.chatRuns[requestID]
	if run == nil && controlType == "started" && conversationID != "" {
		// GUI-local runs (e.g. a queued prompt auto-sent by the desktop app)
		// announce themselves with a bare "started" control before any chat
		// event or runtime snapshot reaches the gateway. Register the run here
		// so the "running" activity broadcast is not lost and remote clients
		// can attach immediately.
		m.chatStore.nextChatRunEpoch++
		run = &chatRun{
			requestID:            requestID,
			conversationID:       conversationID,
			runEpoch:             m.chatStore.nextChatRunEpoch,
			state:                ChatRunStateQueued,
			nextSeq:              m.latestConversationSeqLocked(conversationID),
			updatedAt:            now,
			subscribers:          make(map[int]*chatRunSubscriber),
			relayBufferRetention: m.chatStore.relayBufferRetention,
		}
		m.chatStore.chatRuns[requestID] = run
	}
	if run == nil || run.done {
		m.chatStore.chatMu.Unlock()
		if run == nil {
			log.Printf("markChatRunControl: no run for requestID=%s controlType=%s", requestID, controlType)
		}
		return
	}
	previousState := normalizeChatRunState(run.state)
	canClaim := chatRunControlCanClaimConversation(controlType, state)
	m.updateRunConversationLocked(run, requestID, conversationID, canClaim)
	broadcast := m.appendChatControlLocked(run, controlType, errorCode, message, now)
	nextState := normalizeChatRunState(run.state)
	activityKind, activityConversationID, activityWorkdir = detectRunActivity(run, previousState, nextState)
	runSubscribers := run.collectSubscribers()
	m.chatStore.chatMu.Unlock()

	if span := chatControlSpanName(broadcast.Control); span != "" {
		logChatRunSpan(span, broadcast)
	}
	notifySubscribers(runSubscribers, broadcast)
	if isTerminalChatRunState(nextState) {
		for _, s := range runSubscribers {
			s.close()
		}
	}
	if activityKind != "" {
		m.broadcastChatRunActivity(activityKind, activityConversationID, activityWorkdir, now)
	}
}

func (m *Manager) DispatchFromAgent(env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(nil, env)
}

func (m *Manager) DispatchFromAgentForSession(session *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(session, env)
}

func (m *Manager) dispatchFromAgent(expected *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.registry.mu.RLock()
	session := m.registry.session
	m.registry.mu.RUnlock()
	if session == nil || (expected != nil && session != expected) {
		return
	}

	if runtimeStatus := env.GetRuntimeStatus(); runtimeStatus != nil {
		m.UpdateRuntimeStatus(session, runtimeStatus)
		return
	}

	if runtimeSnapshot := env.GetChatRuntimeSnapshot(); runtimeSnapshot != nil {
		m.ApplyChatRuntimeSnapshot(runtimeSnapshot)
		return
	}

	if chatEvent := env.GetChatEvent(); chatEvent != nil {
		m.broadcastChatEvent(env.GetRequestId(), chatEvent)
	}

	if chatControl := env.GetChatControl(); chatControl != nil {
		m.broadcastChatControl(env.GetRequestId(), chatControl)
	}

	if historySync := env.GetHistorySync(); historySync != nil {
		m.broadcastHistorySync(historySync)
		return
	}

	if settingsSync := env.GetSettingsSync(); settingsSync != nil {
		m.broadcastSettingsSync(settingsSync)
		return
	}

	if terminalEvent := env.GetTerminalEvent(); terminalEvent != nil {
		m.broadcastTerminalEvent(terminalEvent)
		return
	}

	if sftpEvent := env.GetSftpEvent(); sftpEvent != nil {
		m.broadcastSftpEvent(sftpEvent)
		return
	}

	if chatQueueEvent := env.GetChatQueueEvent(); chatQueueEvent != nil {
		m.broadcastChatQueueEvent(chatQueueEvent)
		return
	}

	if tunnelFrame := env.GetTunnelFrame(); tunnelFrame != nil {
		m.dispatchTunnelFrame(tunnelFrame)
		return
	}

	if tunnelControl := env.GetTunnelControl(); tunnelControl != nil {
		m.handleAgentTunnelControl(session, env.GetRequestId(), tunnelControl)
		return
	}

	session.dispatch(env)
}

// chatRun methods

func (r *chatRun) snapshot() ChatRunSnapshot {
	var firstSeq int64
	if len(r.events) > 0 {
		firstSeq = r.events[0].Seq
	}
	return ChatRunSnapshot{
		RequestID:      r.requestID,
		ConversationID: r.conversationID,
		Workdir:        r.workdir,
		FirstSeq:       firstSeq,
		LatestSeq:      r.nextSeq,
		RunEpoch:       r.runEpoch,
		State:          r.state,
		Done:           r.done,
	}
}

func (r *chatRun) applyState(state string) {
	state = normalizeChatRunState(state)
	if state == "" {
		state = ChatRunStateQueued
	}
	r.state = state
	r.done = isTerminalChatRunState(state)
}

func (r *chatRun) appendEvent(event *ChatBroadcastEvent) {
	if r == nil || event == nil {
		return
	}
	if event.ReceivedAt.IsZero() {
		event.ReceivedAt = time.Now()
	}
	r.events = append(r.events, cloneChatBroadcastEvent(event))
	r.evictExpiredEvents()
}

func (r *chatRun) evictExpiredEvents() {
	retention := r.relayBufferRetention
	if retention <= 0 {
		retention = defaultRelayBufferRetention
	}
	cutoff := time.Now().Add(-retention)
	i := 0
	for i < len(r.events) && r.events[i].ReceivedAt.Before(cutoff) {
		i++
	}
	if i > 0 {
		copy(r.events, r.events[i:])
		r.events = r.events[:len(r.events)-i]
	}
}

func (r *chatRun) shouldPrune(now time.Time) bool {
	if r == nil {
		return true
	}
	if r.done {
		return !r.expiresAt.IsZero() && now.After(r.expiresAt)
	}
	return !r.updatedAt.IsZero() && now.Sub(r.updatedAt) > chatRunStaleRetention
}

func (s *chatRunSubscriber) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (m *Manager) updateRunConversationLocked(run *chatRun, requestID string, conversationID string, canClaim bool) {
	if conversationID == "" {
		return
	}
	if run.conversationID != "" && run.conversationID != conversationID {
		if m.chatStore.chatRunByConversation[run.conversationID] == requestID {
			delete(m.chatStore.chatRunByConversation, run.conversationID)
		}
	}
	run.conversationID = conversationID
	if canClaim || m.chatRunCanClaimConversationLocked(conversationID, requestID) {
		m.chatStore.chatRunByConversation[conversationID] = requestID
	}
}

func (r *chatRun) collectSubscribers() []*chatRunSubscriber {
	subs := make([]*chatRunSubscriber, 0, len(r.subscribers))
	for _, s := range r.subscribers {
		subs = append(subs, s)
	}
	return subs
}

func notifySubscribers(subscribers []*chatRunSubscriber, broadcast *ChatBroadcastEvent) {
	for _, s := range subscribers {
		select {
		case <-s.done:
		case s.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
}

func (m *Manager) pruneExpiredChatRunsLocked(now time.Time) {
	for requestID, run := range m.chatStore.chatRuns {
		if run == nil {
			delete(m.chatStore.chatRuns, requestID)
			continue
		}
		if run.shouldPrune(now) {
			m.removeChatRunLocked(requestID, run)
		}
	}
}

func (m *Manager) removeChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatStore.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatStore.chatRunByConversation, run.conversationID)
	}
	delete(m.chatStore.chatRuns, requestID)
	for _, subscriber := range run.subscribers {
		subscriber.close()
	}
}

func cloneChatBroadcastEvent(event *ChatBroadcastEvent) *ChatBroadcastEvent {
	if event == nil {
		return nil
	}
	return &ChatBroadcastEvent{
		RequestID:  event.RequestID,
		Event:      event.Event,
		Control:    event.Control,
		Payload:    cloneChatPayloadMap(event.Payload),
		Seq:        event.Seq,
		Workdir:    event.Workdir,
		ReceivedAt: event.ReceivedAt,
	}
}

func cloneChatPayloadMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]any, len(input))
	for k, v := range input {
		out[k] = v
	}
	return out
}

// State constants and helpers

var validChatRunStates = map[string]bool{
	ChatRunStateQueued:        true,
	ChatRunStateDelivered:     true,
	ChatRunStateClaimed:       true,
	ChatRunStateStarting:      true,
	ChatRunStateDesktopQueued: true,
	ChatRunStateRunning:       true,
	ChatRunStateCompleted:     true,
	ChatRunStateFailed:        true,
	ChatRunStateCancelled:     true,
}

func normalizeChatRunState(state string) string {
	if validChatRunStates[state] {
		return state
	}
	return ""
}

var terminalChatRunStates = map[string]bool{
	ChatRunStateCompleted: true,
	ChatRunStateFailed:    true,
	ChatRunStateCancelled: true,
}

func isTerminalChatRunState(state string) bool {
	return terminalChatRunStates[normalizeChatRunState(state)]
}

var activeChatRunStates = map[string]bool{
	ChatRunStateQueued:    true,
	ChatRunStateDelivered: true,
	ChatRunStateClaimed:   true,
	ChatRunStateStarting:  true,
	ChatRunStateRunning:   true,
}

var controlTypeToState = map[string]string{
	"accepted":      ChatRunStateQueued,
	"delivered":     ChatRunStateDelivered,
	"claimed":       ChatRunStateClaimed,
	"starting":      ChatRunStateStarting,
	"queued_in_gui": ChatRunStateDesktopQueued,
	"started":       ChatRunStateRunning,
	"completed":     ChatRunStateCompleted,
	"failed":        ChatRunStateFailed,
	"cancelled":     ChatRunStateCancelled,
}

var stateToControlType = map[string]string{
	ChatRunStateQueued:        "accepted",
	ChatRunStateDelivered:     "delivered",
	ChatRunStateClaimed:       "claimed",
	ChatRunStateStarting:      "starting",
	ChatRunStateDesktopQueued: "queued_in_gui",
	ChatRunStateRunning:       "started",
	ChatRunStateCompleted:     "completed",
	ChatRunStateFailed:        "failed",
	ChatRunStateCancelled:     "cancelled",
}

func isTerminalChatEvent(event *gatewayv1.ChatEvent) bool {
	if event == nil {
		return false
	}
	return event.GetType() == gatewayv1.ChatEvent_DONE || event.GetType() == gatewayv1.ChatEvent_ERROR
}

func detectRunActivity(run *chatRun, previousState, nextState string) (kind, conversationID, workdir string) {
	if isTerminalChatRunState(nextState) {
		kind = "idle"
	} else if previousState != ChatRunStateRunning && nextState == ChatRunStateRunning {
		kind = "running"
	}
	if kind != "" {
		conversationID = run.conversationID
		workdir = run.workdir
	}
	return
}

func (m *Manager) appendChatControlLocked(
	run *chatRun,
	controlType string,
	errorCode string,
	message string,
	now time.Time,
) *ChatBroadcastEvent {
	if run == nil {
		return nil
	}
	state := controlTypeToState[controlType]
	if state == "" {
		state = normalizeChatRunState(run.state)
	}
	if state == "" {
		state = ChatRunStateQueued
	}
	run.applyState(state)
	run.updatedAt = now
	if isTerminalChatRunState(state) {
		run.expiresAt = now.Add(chatRunDoneRetention)
	}
	run.nextSeq++
	seq := run.nextSeq
	if controlType == "" {
		controlType = stateToControlType[normalizeChatRunState(state)]
		if controlType == "" {
			controlType = "progress"
		}
	}
	control := &gatewayv1.ChatControlEvent{
		RequestId:      run.requestID,
		ConversationId: run.conversationID,
		RunEpoch:       run.runEpoch,
		Type:           controlType,
		State:          run.state,
		ErrorCode:      errorCode,
		Message:        message,
		Seq:            seq,
	}
	broadcast := &ChatBroadcastEvent{
		RequestID:  run.requestID,
		Control:    control,
		Seq:        seq,
		Workdir:    run.workdir,
		ReceivedAt: now,
	}
	run.appendEvent(broadcast)
	return broadcast
}

func (m *Manager) appendChatPayloadLocked(
	run *chatRun,
	payload map[string]any,
	now time.Time,
) *ChatBroadcastEvent {
	if run == nil || len(payload) == 0 {
		return nil
	}
	run.updatedAt = now
	run.nextSeq++
	seq := run.nextSeq
	nextPayload := cloneChatPayloadMap(payload)
	if nextPayload == nil {
		nextPayload = make(map[string]any)
	}
	nextPayload["request_id"] = run.requestID
	nextPayload["conversation_id"] = run.conversationID
	nextPayload["run_epoch"] = run.runEpoch
	nextPayload["state"] = run.state
	nextPayload["seq"] = seq
	broadcast := &ChatBroadcastEvent{
		RequestID:  run.requestID,
		Payload:    nextPayload,
		Seq:        seq,
		Workdir:    run.workdir,
		ReceivedAt: now,
	}
	run.appendEvent(broadcast)
	return broadcast
}

func chatControlSpanName(control *gatewayv1.ChatControlEvent) string {
	if control == nil {
		return ""
	}
	switch control.GetType() {
	case "claimed":
		return "runtime_claimed"
	case "started":
		return "runtime_started"
	case "completed":
		return "run_completed"
	case "failed":
		return "run_failed"
	case "cancelled":
		return "run_cancelled"
	default:
		return ""
	}
}

func logChatRunSpan(span string, event *ChatBroadcastEvent) {
	if event == nil {
		return
	}
	runID := event.RequestID
	conversationID := ""
	if event.Control != nil {
		conversationID = event.Control.GetConversationId()
	} else if event.Payload != nil {
		if value, ok := event.Payload["conversation_id"].(string); ok {
			conversationID = value
		}
	} else if event.Event != nil {
		conversationID = event.Event.GetConversationId()
	}
	log.Printf(
		"chat_run_span span=%s run_id=%q conversation_id=%q seq=%d",
		span,
		runID,
		conversationID,
		event.Seq,
	)
}
