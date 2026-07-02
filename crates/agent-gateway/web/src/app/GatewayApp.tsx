import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  Terminal,
} from "@/components/icons";

import type { ChatHistorySummary } from "@/lib/chat/chatHistory";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@/lib/chat/uploadedFiles";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RightDockPanel } from "@/components/project-tools/RightDockPanel";
import { LocaleContext, t as translate } from "@/i18n";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@/components/chat/MentionComposer";
import { ChatHistorySidebar } from "@/components/chat/ChatHistorySidebar";
import { SharedHistoryManagerModal } from "@/components/chat/SharedHistoryManagerModal";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { ChatComposerBar, type ChatQueueTurnPreview } from "@/pages/chat/ChatComposerBar";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { SkillsHubPage } from "@/pages/skills-hub/SkillsHubPage";
import { McpHubPage } from "@/pages/mcp-hub/McpHubPage";
import type { SectionId } from "@/pages/settings/types";
import { useChatSkills } from "@/pages/chat/useChatSkills";
import { queuedChatTurnHasContent } from "@/pages/chat/queue/chatTurnQueue";
import { mergeAlwaysEnabledSkillNames } from "@/lib/skills";
import { buildModelOptions, sortHistoryItems, VIBING_STATUS } from "@/lib/chat/chatPageHelpers";
import { SettingsPage } from "@/pages/SettingsPage";
import {
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  getRightDockFileTreeState,
  getRightDockProjectState,
  getSshProjectHostIds,
  getNextTheme,
  isAgentDevMode,
  isRightDockSingletonTabOpen,
  normalizeChatRuntimeControlsForProvider,
  openRightDockSingletonTab,
  removeRightDockProjectState,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  workspaceProjectPathKey,
  updateChatRuntimeControlsForProvider,
  updateCustomSettings,
  updateRightDockFileTreeState,
  updateRightDockProjectState,
  updateRightDockWidth,
  updateSshProjectHostIds,
  type AppSettings,
  type ChatRuntimeControls,
  type WorkspaceProject,
  DEFAULT_WORKSPACE_PROJECT_ID,
} from "@/lib/settings";
import { toModelValue } from "@/lib/providers/llm";

import { terminalSessionBelongsToProject } from "@/lib/terminal/sessionStore";
import type { TerminalSession } from "@/lib/terminal/types";
import type {
  AgentStatus,
  ChatQueueItemSummary,
  ChatQueueSnapshot,
  ChatEvent,
  ChatRuntimeSnapshotEvent,
  ConversationSummary,
  GatewayHistoryEvent,
  HistoryDetail,
  HistoryShareStatus,
  HistoryWorkdirSummary,
  LiveConversationStreamSnapshot,
  LiveConversationStreamStore,
} from "@/lib/gatewayTypes";
import {
  filterConversationSummariesForScope,
  historyConversationMatchesFilter,
} from "@/lib/chat/historyListScope";
import {
  buildOptimisticConversationTitle,
  chatEntryDedupKey,
  pushChatEvent,
  resolveConversationBrowserTitle,
  type ChatEntry,
} from "@/lib/chatUi";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";

const CHAT_STREAM_NOT_AVAILABLE_RE = /\bchat stream not available\b/i;
const RECOVERABLE_TRANSPORT_MESSAGE_RE =
  /\b(?:502\s+bad\s+gateway|503\s+service\s+unavailable|504\s+gateway\s+timeout|bad\s+gateway|gateway\s+timeout|service\s+unavailable|temporarily\s+unavailable|failed\s+to\s+fetch|networkerror|network\s+error|load\s+failed|connection\s+(?:reset|closed|lost)|socket\s+hang\s+up|err_(?:network|internet_disconnected|connection_(?:reset|closed|refused)))\b/i;

function isChatStreamNotAvailableMessage(value: unknown) {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : String(value ?? "");
  return CHAT_STREAM_NOT_AVAILABLE_RE.test(message.trim());
}
function isRecoverableChatStreamTransportMessage(value: unknown) {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : String(value ?? "");
  return RECOVERABLE_TRANSPORT_MESSAGE_RE.test(message.trim());
}
function isChatStreamNotAvailableEvent(event: ChatEvent) {
  return event.type === "error" && isChatStreamNotAvailableMessage(event.message);
}
function collectAssistantLikeText(entries: ChatEntry[]) {
  return entries.map((e) => (e.kind === "assistant" || e.kind === "thinking" || e.kind === "error" ? e.text : "")).join("\n").trim();
}
function shouldHydrateRestoredConversationSnapshot(params: {
  currentEntries: ChatEntry[];
  historyEntries: ChatEntry[];
  liveEntries?: ChatEntry[];
}) {
  if (params.historyEntries.length === 0) return false;
  const liveEntries = params.liveEntries ?? [];
  if (params.currentEntries.length === 0 && liveEntries.length === 0) return true;
  const currentText = collectAssistantLikeText([...params.currentEntries, ...liveEntries]);
  const historyText = collectAssistantLikeText(params.historyEntries);
  if (historyText.length === 0) return liveEntries.length === 0 && params.historyEntries.length > params.currentEntries.length;
  if (currentText.length === 0) return true;
  return historyText.length > currentText.length;
}
import { memoryDeleteProject } from "@/lib/memory/api";
function chatEntryContentKey(entry: ChatEntry) {
  return chatEntryDedupKey(entry);
}

function hasEquivalentTailEntries(existing: ChatEntry[], tail: ChatEntry[]) {
  if (tail.length === 0 || existing.length < tail.length) return false;
  const offset = existing.length - tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (chatEntryContentKey(existing[offset + i]) !== chatEntryContentKey(tail[i])) return false;
  }
  return true;
}

function findEntryOverlap(existing: ChatEntry[], incoming: ChatEntry[]) {
  const max = Math.min(existing.length, incoming.length);
  for (let overlap = max; overlap > 0; overlap--) {
    let matches = true;
    const start = existing.length - overlap;
    for (let i = 0; i < overlap; i++) {
      if (chatEntryContentKey(existing[start + i]) !== chatEntryContentKey(incoming[i])) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
}

function mergeHistorySnapshotEntries(
  existing: ChatEntry[],
  incoming: ChatEntry[],
  options?: { isFullSnapshot?: boolean },
) {
  const isFullSnapshot = options?.isFullSnapshot === true;
  if (incoming.length === 0) return isFullSnapshot ? [] : existing;
  if (hasEquivalentTailEntries(existing, incoming)) return existing;
  if (existing.length === 0) return incoming.map((e) => structuredClone(e));
  const overlap = findEntryOverlap(existing, incoming);
  if (overlap > 0) {
    return [...existing.slice(0, existing.length - overlap), ...incoming.map((e) => structuredClone(e))];
  }
  if (incoming.length >= existing.length || isFullSnapshot) {
    return incoming.map((e) => structuredClone(e));
  }
  return existing;
}

function appendCommittedLiveEntries(existing: ChatEntry[], live: ChatEntry[]) {
  if (live.length === 0 || hasEquivalentTailEntries(existing, live)) return existing;
  const overlap = findEntryOverlap(existing, live);
  const base = overlap > 0 ? existing.slice(0, existing.length - overlap) : existing;
  const toCommit = overlap > 0 ? live.slice(overlap) : live;
  if (toCommit.length === 0) return base;
  return [...base, ...toCommit.map((e, i) => ({ ...structuredClone(e), id: `committed-live-${e.kind}-${base.length + i}` }))];
}
const EMPTY_LIVE_SNAPSHOT: LiveConversationStreamSnapshot = {
  revision: 0,
  entries: [],
  toolStatus: null,
  toolStatusIsCompaction: false,
};

function isSnapshotChatEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.kind !== "string") return false;
  switch (v.kind) {
    case "user": return typeof v.text === "string" && Array.isArray(v.attachments);
    case "assistant": case "thinking": case "error": return typeof v.text === "string";
    case "tool_call": return v.toolCall != null && typeof v.toolCall === "object";
    case "tool_result": return v.toolResult != null && typeof v.toolResult === "object";
    case "hosted_search": return v.hostedSearch != null && typeof v.hostedSearch === "object";
    default: return false;
  }
}

function parseSnapshotEntries(json: string | undefined): ChatEntry[] {
  const raw = typeof json === "string" ? json.trim() : "";
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter(isSnapshotChatEntry) : []; }
  catch { return []; }
}

function isTerminalStreamEvent(event: ChatEvent) {
  if (event.type === "done" || event.type === "error") return true;
  if (event.type !== "completed" && event.type !== "failed" && event.type !== "cancelled") return false;
  return event.state === "completed" || event.state === "failed" || event.state === "cancelled";
}

function isControlStreamEvent(event: ChatEvent) {
  switch (event.type) {
    case "accepted": case "user_message": case "rebased": case "projection_updated":
    case "delivered": case "claimed": case "starting": case "queued_in_gui":
    case "started": case "progress": case "completed": case "failed": case "cancelled":
      return true;
    default: return false;
  }
}

function createLiveConversationStreamStore(): LiveConversationStreamStore {
  let snapshot = EMPTY_LIVE_SNAPSHOT;
  let draft = EMPTY_LIVE_SNAPSHOT;
  let rafId: number | null = null;
  let latestSnapshotRev = 0;
  let latestSnapshotSeq = 0;
  const seenSeqs = new Set<number>();
  const listeners = new Set<() => void>();

  const emit = () => { listeners.forEach((l) => l()); };
  const cancel = () => { if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; } };
  const commit = () => { rafId = null; if (snapshot !== draft) { snapshot = draft; emit(); } };
  const schedule = (flush?: boolean) => {
    if (flush) { cancel(); snapshot = draft; emit(); return; }
    if (rafId === null) rafId = requestAnimationFrame(commit);
  };
  const update = (next: LiveConversationStreamSnapshot, flush?: boolean) => {
    draft = { ...next, revision: draft.revision + 1 };
    schedule(flush);
  };

  const readSeq = (event: { seq?: number }) => {
    const s = event.seq;
    return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.floor(s) : null;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    appendEvent: (event, opts) => {
      const seq = readSeq(event);
      if (seq !== null) {
        if (latestSnapshotSeq > 0 && seq <= latestSnapshotSeq) return;
        if (seenSeqs.has(seq)) return;
        seenSeqs.add(seq);
      }
      if (event.type === "tool_status") {
        const status = typeof event.status === "string" && event.status.trim() ? event.status.trim() : null;
        const isCompaction = Boolean(status) && event.isCompaction === true;
        if (draft.toolStatus === status && draft.toolStatusIsCompaction === isCompaction) return;
        update({ ...draft, toolStatus: status, toolStatusIsCompaction: isCompaction }, opts?.flush);
        return;
      }
      const terminal = isTerminalStreamEvent(event);
      const shouldAppend = event.type === "user_message" || event.type === "error" || event.type === "failed" || (!terminal && !isControlStreamEvent(event));
      const nextEntries = shouldAppend ? pushChatEvent(draft.entries, event) : draft.entries;
      const clearStatus = terminal;
      if (nextEntries === draft.entries && (!clearStatus || (draft.toolStatus === null && !draft.toolStatusIsCompaction))) return;
      update({
        ...draft,
        entries: nextEntries,
        toolStatus: clearStatus ? null : draft.toolStatus,
        toolStatusIsCompaction: clearStatus ? false : draft.toolStatusIsCompaction,
      }, opts?.flush);
    },
    applySnapshot: (event, opts) => {
      const seq = readSeq(event);
      const rev = typeof event.revision === "number" && event.revision > 0 ? Math.floor(event.revision) : 0;
      if (rev > 0 && latestSnapshotRev > 0 && rev < latestSnapshotRev) return;
      if (rev > 0 && rev === latestSnapshotRev && seq !== null && latestSnapshotSeq > 0 && seq <= latestSnapshotSeq) return;
      const entries = parseSnapshotEntries(event.entries_json);
      const toolStatus = typeof event.tool_status === "string" && event.tool_status.trim() ? event.tool_status.trim() : null;
      const toolStatusIsCompaction = Boolean(toolStatus) && event.tool_status_is_compaction === true;
      latestSnapshotRev = Math.max(latestSnapshotRev, rev);
      if (seq !== null) { latestSnapshotSeq = Math.max(latestSnapshotSeq, seq); seenSeqs.add(seq); }
      update({ ...draft, entries, toolStatus, toolStatusIsCompaction }, opts?.flush);
    },
    setToolStatus: (toolStatus, isCompaction = false, opts) => {
      const status = typeof toolStatus === "string" && toolStatus.trim() ? toolStatus.trim() : null;
      const nextIsCompaction = Boolean(status) && isCompaction;
      if (draft.toolStatus === status && draft.toolStatusIsCompaction === nextIsCompaction) return;
      update({ ...draft, toolStatus: status, toolStatusIsCompaction: nextIsCompaction }, opts?.flush);
    },
    reset: () => {
      if (draft.entries.length === 0 && draft.toolStatus === null && !draft.toolStatusIsCompaction) { cancel(); return; }
      draft = { ...EMPTY_LIVE_SNAPSHOT, revision: draft.revision + 1 };
      seenSeqs.clear();
      latestSnapshotRev = 0;
      latestSnapshotSeq = 0;
      cancel();
      snapshot = draft;
      emit();
    },
    flush: () => { cancel(); commit(); },
  };
}

const LOCAL_DRAFT_PREFIX = "__local_draft__:";
function createLocalDraftConversationId() {
  return `${LOCAL_DRAFT_PREFIX}${crypto.randomUUID()}`;
}
function isLocalDraftConversationId(id: string) {
  return id.trim().startsWith(LOCAL_DRAFT_PREFIX);
}
import {
  applyGatewayHistoryEvent,
  normalizeRunningConversations,
  reconcileConversationSummaries,
  resolveRunningConversationStreamAfterSeq,
  upsertConversationSummary,
} from "@/lib/historySync";
import { parseHistoryShareToken } from "@/lib/historyShare";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { HistoryShareModal } from "@/components/chat/HistoryShareModal";
import { useGatewayScrollAffordance } from "@/components/useGatewayScrollAffordance";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsSyncLoading } from "@/pages/SettingsSyncLoading";
import { SharedHistoryPage } from "@/pages/SharedHistoryPage";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import {
  applyWorkspaceProjectConversationActivityMap,
  buildWorkspaceProjectActivityUpdatedAts,
  findWorkspaceProject,
  mergeWorkspaceProjectActivityUpdatedAts,
  mergeWorkspaceProjectsWithHistory,
  workspaceProjectActivityUpdatedAtsEqual,
} from "@/lib/workspaceProjects";
import {
  CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS,
  CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_PREPARING_STATUS,
  CHAT_RUNTIME_STARTING_STATUS,
  CHAT_RUNTIME_STARTING_STATUS_DELAY_MS,
  DEFAULT_BROWSER_TITLE,
  DRAFT_HISTORY_ADOPTION_WINDOW_MS,
  HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
  HISTORY_LIST_PAGE_SIZE,
  HISTORY_SWITCH_OVERLAY_MIN_MS,
  HISTORY_TITLE_POSITION_LOCK_MS,
  LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS,
  MAX_UPLOAD_FILES,
  MCP_HUB_BROWSER_TITLE,
  NEW_CONVERSATION_BROWSER_TITLE,
  PAGE_RESTORE_HISTORY_REFRESH_THROTTLE_MS,
  PROJECT_HISTORY_DELETE_PAGE_SIZE,
  PROTECTED_DRAFT_CONVERSATION,
  SHARED_HISTORY_BROWSER_TITLE,
  SHARED_HISTORY_LIST_PAGE_SIZE,
  SKILLS_HUB_BROWSER_TITLE,
} from "./constants";
import {
  buildGatewaySelectedModel,
  buildGatewaySystemSettings,
  asErrorMessage,
  isAbortError,
  isChatControlEvent,
  isChatEventTitleFinal,
  isTerminalChatEvent,
  isChatRuntimeReadyStatus,
  isPreparingChatControlEvent,
  isRuntimeStartedChatControlEvent,
  isTerminalChatControlEvent,
  normalizeGatewayTimestampMs,
  normalizeOptionalStatus,
  readChatEventTitle,
  readTunnelManagerToolChange,
  waitForMinimumHistoryListLoading,
} from "./chatEventUtils";
import {
  buildTextFromComposerDraft,
  importPastedTextsAsFiles,
} from "./chatDraft";
import { FileDropOverlay } from "./FileDropOverlay";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import { UserMenu } from "./UserMenu";
import { WorkspaceOverlayHost } from "./WorkspaceOverlayHost";
import {
  createConversationRuntimeEntry,
  createWorkspaceProjectFromPath,
  formatTranslation,
  getDefaultWorkspaceProjectPath,
  hasDetachedHistorySelection,
  hasLocalDraftConversation,
  isMobileSidebarLayout,
  pickConversationSummary,
  resolveConversationTitle,
  resolveVisibleConversationId,
  shouldOpenSidebarByDefault,
  toChatHistorySummary,
} from "./historyUtils";
import type {
  ConversationRuntimeEntry,
  ModelProviderSource,
  OverlayState,
  PendingDraftConversationMigration,
  ReloadHistoryOptions,
  RunningConversationRuntime,
  SendChatFn,
  SendChatOptions,
} from "./types";
import { useGatewayClients } from "./hooks/useGatewayClients";
import { useGatewaySession } from "./hooks/useGatewaySession";
import { useGatewaySettingsSync } from "./hooks/useGatewaySettingsSync";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { useProjectToolsRuntime } from "./hooks/useProjectToolsRuntime";

function resolveRunningConversationRunKey(
  runtime: Pick<RunningConversationRuntime, "runId"> | null | undefined,
) {
  return runtime?.runId?.trim() ?? "";
}

function readGatewayChatEventRunId(event: ChatEvent) {
  const runId = (event as ChatEvent & { __gatewayRunId?: unknown }).__gatewayRunId;
  return typeof runId === "string" ? runId.trim() : "";
}

export default function GatewayApp() {
  const historyShareToken = useMemo(() => parseHistoryShareToken(), []);
  const {
    token,
    loginToken,
    authSubmitting,
    authError,
    setLoginToken,
    setAuthError,
    login: handleLoginSubmit,
    clearSession,
  } = useGatewaySession(historyShareToken);
  const { api, terminalClient, sftpClient, gitClient } = useGatewayClients(token);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatToolStatus, setChatToolStatus] = useState<string | null>(null);
  const [chatToolStatusIsCompaction, setChatToolStatusIsCompaction] = useState(false);
  const [historyListLoading, setHistoryListLoading] = useState(false);
  const [historyListLoadingMore, setHistoryListLoadingMore] = useState(false);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyMutating, setHistoryMutating] = useState(false);
  const [historyItems, setHistoryItems] = useState<ConversationSummary[]>([]);
  const [historyWorkdirs, setHistoryWorkdirs] = useState<HistoryWorkdirSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [localRunningConversationIds, setLocalRunningConversationIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [queuedChatTurns, setQueuedChatTurns] = useState<ChatQueueItemSummary[]>([]);
  const [, setChatQueueRevision] = useState(0);
  const [remoteRunningConversationIds, setRemoteRunningConversationIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [remoteRunningConversationRuntime, setRemoteRunningConversationRuntime] = useState<
    ReadonlyMap<string, RunningConversationRuntime>
  >(() => new Map());
  const [projectActivityUpdatedAtOverrides, setProjectActivityUpdatedAtOverrides] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(null);
  const [selectedHistoryEntries, setSelectedHistoryEntries] = useState<ChatEntry[]>([]);
  const [historySwitchOverlay, setHistorySwitchOverlay] = useState<{
    conversationId: string;
    startedAt: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [overlay, setOverlay] = useState<OverlayState>("closed");
  const {
    settings,
    setSettings,
    settingsSyncReady,
    settingsSyncError,
    settingsSaveState,
  } = useGatewaySettingsSync({ token, api });
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const isAgentMode = settings.system.executionMode !== "text";
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, historyWorkdirs),
    [historyWorkdirs, settings.system],
  );
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectId] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const missingWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.missingWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const activeWorkspaceProject = useMemo(
    () => findWorkspaceProject(workspaceProjects, activeWorkspaceProjectId),
    [activeWorkspaceProjectId, workspaceProjects],
  );
  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId]);
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";
  const historyListFilter = useMemo(
    () =>
      isAgentMode
        ? { cwd: activeWorkspaceProjectPath || "__liveagent_no_project__" }
        : { cwdEmpty: true },
    [activeWorkspaceProjectPath, isAgentMode],
  );
  const historyScopeKey = isAgentMode
    ? `cwd:${activeWorkspaceProjectPath || "__liveagent_no_project__"}`
    : "cwd-empty";
  const [sidebarOpen, setSidebarOpen] = useState(shouldOpenSidebarByDefault);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState("");
  const [shareConversation, setShareConversation] = useState<ChatHistorySummary | null>(null);
  const [shareStatus, setShareStatus] = useState<HistoryShareStatus | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharedManagerOpen, setSharedManagerOpen] = useState(false);
  const [sharedManagerStatuses, setSharedManagerStatuses] = useState<
    Record<string, HistoryShareStatus | undefined>
  >({});
  const [sharedManagerLoadingIds, setSharedManagerLoadingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerUpdatingIds, setSharedManagerUpdatingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sharedManagerErrors, setSharedManagerErrors] = useState<
    Record<string, string | undefined>
  >({});
  const [sharedHistoryItems, setSharedHistoryItems] = useState<ChatHistorySummary[]>([]);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<"chat" | "skills-hub" | "mcp-hub">("chat");
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [tunnelRefreshToken, setTunnelRefreshToken] = useState(0);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  const {
    scrollAreaRef: transcriptScrollAreaRef,
    showJumpToBottom: showTranscriptJumpToBottom,
    jumpToBottom: jumpTranscriptToBottom,
    stickToBottom: stickTranscriptToBottom,
    isAtBottom: isTranscriptAtBottom,
    syncAutoScroll: syncTranscriptAutoScroll,
    refreshScrollState: refreshTranscriptScrollState,
    preserveScrollPosition: preserveTranscriptScrollPosition,
  } = useGatewayScrollAffordance();
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  const conversationIdRef = useRef(conversationId);
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  const statusRef = useRef<AgentStatus | null>(status);
  const chatBusyRef = useRef(chatBusy);
  const chatMessagesRef = useRef(chatMessages);
  const chatErrorRef = useRef(chatError);
  const chatToolStatusRef = useRef(chatToolStatus);
  const chatToolStatusIsCompactionRef = useRef(chatToolStatusIsCompaction);
  const queuedChatTurnsRef = useRef<ChatQueueItemSummary[]>([]);
  const chatQueueConversationIdRef = useRef("");
  const chatQueueRevisionRef = useRef(0);
  const queuedChatEditSessionRef = useRef<{ itemId: string; revision: number } | null>(null);
  const selectedHistoryRef = useRef(selectedHistory);
  const selectedHistoryEntriesRef = useRef(selectedHistoryEntries);
  const historyItemsRef = useRef(historyItems);
  const historyTotalRef = useRef(historyTotal);
  const historyHasMoreRef = useRef(historyHasMore);
  const historyListFilterRef = useRef(historyListFilter);
  const historyScopeKeyRef = useRef(historyScopeKey);
  const nextHistoryPageRef = useRef(1);
  const historyListPageLoadingRef = useRef(false);
  const sharedHistoryItemsRef = useRef<ChatHistorySummary[]>([]);
  const sharedHistoryListRequestRef = useRef<Promise<ChatHistorySummary[]> | null>(null);
  const localRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const remoteRunningConversationIdsRef = useRef<ReadonlySet<string>>(new Set());
  const remoteRunningConversationRuntimeRef = useRef<
    ReadonlyMap<string, RunningConversationRuntime>
  >(new Map());
  const liveConversationStreamStoresRef = useRef<Map<string, LiveConversationStreamStore>>(
    new Map(),
  );
  const conversationRuntimeCacheRef = useRef<Map<string, ConversationRuntimeEntry>>(new Map());
  const displayedConversationWorkdirRef = useRef("");
  const conversationAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const conversationEventStreamsRef = useRef<Map<string, { controller: AbortController; runId: string }>>(new Map());
  const completedLiveStreamMarkersRef = useRef<Map<string, { at: number; timeoutId: number }>>(new Map());
  const pendingHistoryRefreshAfterLiveCompletionRef = useRef<Set<string>>(new Set());
  const optimisticTitleConversationIdsRef = useRef<Set<string>>(new Set());
  const titlePositionLockedConversationIdsRef = useRef<Set<string>>(new Set());
  const titlePositionLockTimeoutsRef = useRef<Map<string, number>>(new Map());
  const blockedHistoryHydrationConversationIdsRef = useRef<Set<string>>(new Set());
  const activeEditResendTransactionsRef = useRef<
    Map<string, { generation: number; clientRequestId: string }>
  >(new Map());
  const visibleHistorySnapshotRefreshSeqRef = useRef<Map<string, number>>(new Map());
  const restoredPageHistoryRefreshAtRef = useRef<Map<string, number>>(new Map());
  const historyLoadSequenceRef = useRef(0);
  const visibleConversationRevisionRef = useRef(0);
  const previousDisplayedConversationIdRef = useRef("");
  const pendingDisplayedConversationAutoBottomRef = useRef<string | null>(null);
  const draftConversationPinnedRef = useRef(false);
  const protectedConversationRef = useRef("");
  const chatStartLocksRef = useRef<Set<string>>(new Set());
  const chatPreflightInFlightRef = useRef(false);
  const chatStartInFlightRef = useRef(false);
  const chatRuntimePreparePromiseRef = useRef<Promise<AgentStatus> | null>(null);
  const submitInFlightRef = useRef(false);
  const pendingDraftConversationMigrationRef = useRef<PendingDraftConversationMigration | null>(
    null,
  );
  const sendChatRef = useRef<SendChatFn | null>(null);
  const isImportingPastedTextRef = useRef(false);
  const resetProjectToolsRuntimeRef = useRef(() => undefined as void);
  const persistProjectConversationActivityRef = useRef(
    (_activity: ReadonlyMap<string, number>) => undefined as void,
  );
  const {
    pendingUploadedFiles,
    pendingUploadedFilesRef,
    pendingUploadsByConversationRef,
    isUploadingFiles,
    isUploadingFilesRef,
    isFileDropActive,
    fileInputRef,
    setIsUploadingFiles,
    getPendingUploadsForConversation,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    clearPendingUploads,
    handleImportReadableFiles,
    handleFileDragEnter,
    handleFileDragOver: handlePendingFileDragOver,
    handleFileDragLeave,
    handleFileDrop: handlePendingFileDrop,
  } = usePendingUploads({
    token,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale: settings.locale,
    executionMode: settings.system.executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    setChatError,
  });

  const applyChatQueueSnapshot = useCallback((snapshot: ChatQueueSnapshot | null | undefined) => {
    if (!snapshot) return;
    const visibleConversationId = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    if (snapshot.conversationId !== visibleConversationId) {
      return;
    }
    const revision = Number(snapshot.revision ?? 0);
    const isSameQueueConversation = snapshot.conversationId === chatQueueConversationIdRef.current;
    if (isSameQueueConversation && revision < chatQueueRevisionRef.current) {
      return;
    }
    chatQueueConversationIdRef.current = snapshot.conversationId;
    chatQueueRevisionRef.current = revision;
    queuedChatTurnsRef.current = snapshot.items.slice();
    setChatQueueRevision(revision);
    setQueuedChatTurns(snapshot.items.slice());
  }, []);

  const recordProjectActivity = useCallback(
    (workdir?: string | null, updatedAt?: number | null) => {
      const pathKey = workspaceProjectPathKey(workdir ?? "");
      if (!pathKey) {
        return;
      }
      const nextUpdatedAt =
        typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
          ? updatedAt
          : Date.now();
      setProjectActivityUpdatedAtOverrides((current) => {
        if ((current.get(pathKey) ?? 0) >= nextUpdatedAt) {
          return current;
        }
        return mergeWorkspaceProjectActivityUpdatedAts(
          current,
          new Map([[pathKey, nextUpdatedAt]]),
        );
      });
      persistProjectConversationActivityRef.current(new Map([[pathKey, nextUpdatedAt]]));
    },
    [],
  );

  useEffect(() => {
    if (!api) return;
    return api.subscribeChatQueue((snapshot) => {
      applyChatQueueSnapshot(snapshot);
    });
  }, [api, applyChatQueueSnapshot]);

  useEffect(() => {
    const historyActivity = buildWorkspaceProjectActivityUpdatedAts(historyWorkdirs);
    if (historyActivity.size === 0) {
      return;
    }
    setProjectActivityUpdatedAtOverrides((current) => {
      const next = mergeWorkspaceProjectActivityUpdatedAts(current, historyActivity);
      return workspaceProjectActivityUpdatedAtsEqual(current, next) ? current : next;
    });
    persistProjectConversationActivityRef.current(historyActivity);
  }, [historyWorkdirs]);

  function getVisibleComposerConversationId() {
    return resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current);
  }

  function cacheVisibleComposerDraft(conversationId = getVisibleComposerConversationId()) {
    const targetConversationId = conversationId.trim();
    const composer = composerRef.current;
    if (!targetConversationId || !composer) {
      return;
    }

    const draft = composer.getDraft();
    if (draft.isEmpty || !draft.text.trim()) {
      composerDraftCacheRef.current.delete(targetConversationId);
      return;
    }

    composerDraftCacheRef.current.set(targetConversationId, draft);
  }

  function clearCachedComposerDraft(conversationId = getVisibleComposerConversationId()) {
    const targetConversationId = conversationId.trim();
    if (!targetConversationId) {
      return;
    }
    composerDraftCacheRef.current.delete(targetConversationId);
  }

  const commitHistoryListState = useCallback(
    (conversations: ConversationSummary[], total: number, nextPage: number, hasMore?: boolean) => {
      const scopedConversations = filterConversationSummariesForScope(
        conversations,
        historyListFilterRef.current,
      );
      const nextTotal = Math.max(0, total);
      const nextHasMore = hasMore ?? scopedConversations.length < nextTotal;

      historyItemsRef.current = scopedConversations;
      historyTotalRef.current = nextTotal;
      historyHasMoreRef.current = nextHasMore;
      nextHistoryPageRef.current = Math.max(1, nextPage);
      setHistoryItems(scopedConversations);
      setHistoryTotal(nextTotal);
      setHistoryHasMore(nextHasMore);
    },
    [],
  );

  const updateHistoryItems = useCallback(
    (updater: (current: ConversationSummary[]) => ConversationSummary[]) => {
      const current = historyItemsRef.current;
      const next = filterConversationSummariesForScope(
        updater(current),
        historyListFilterRef.current,
      );
      const delta = next.length - current.length;
      commitHistoryListState(
        next,
        Math.max(next.length, historyTotalRef.current + delta),
        nextHistoryPageRef.current,
      );
    },
    [commitHistoryListState],
  );

  const unlockHistoryTitlePosition = useCallback((conversationIdValue: string) => {
    const conversationId = conversationIdValue.trim();
    if (!conversationId) {
      return;
    }
    const timeoutId = titlePositionLockTimeoutsRef.current.get(conversationId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      titlePositionLockTimeoutsRef.current.delete(conversationId);
    }
    titlePositionLockedConversationIdsRef.current.delete(conversationId);
  }, []);

  const lockHistoryTitlePosition = useCallback((conversationIdValue: string) => {
    const conversationId = conversationIdValue.trim();
    if (!conversationId) {
      return;
    }

    const existingTimeoutId = titlePositionLockTimeoutsRef.current.get(conversationId);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    titlePositionLockedConversationIdsRef.current.add(conversationId);
    const timeoutId = window.setTimeout(() => {
      titlePositionLockTimeoutsRef.current.delete(conversationId);
      titlePositionLockedConversationIdsRef.current.delete(conversationId);
    }, HISTORY_TITLE_POSITION_LOCK_MS);
    titlePositionLockTimeoutsRef.current.set(conversationId, timeoutId);
  }, []);

  const isHydrationBlocked = (conversationId: string) =>
    blockedHistoryHydrationConversationIdsRef.current.has(conversationId) ||
    getConversationAbortController(conversationId) !== null;

  const getPendingDraftId = () =>
    pendingDraftConversationMigrationRef.current?.draftConversationId.trim() ?? "";

  const getHistoryPositionLockedConversationIds = useCallback(() => {
    const conversationIds = new Set([
      ...optimisticTitleConversationIdsRef.current,
      ...titlePositionLockedConversationIdsRef.current,
      ...blockedHistoryHydrationConversationIdsRef.current,
    ]);
    return conversationIds;
  }, []);

  const clearHistoryTitlePositionLocks = useCallback(() => {
    for (const timeoutId of titlePositionLockTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    titlePositionLockTimeoutsRef.current.clear();
    titlePositionLockedConversationIdsRef.current.clear();
  }, []);

  useEffect(() => clearHistoryTitlePositionLocks, [clearHistoryTitlePositionLocks]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    selectedHistoryIdRef.current = selectedHistoryId;
  }, [selectedHistoryId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    chatBusyRef.current = chatBusy;
  }, [chatBusy]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    chatErrorRef.current = chatError;
  }, [chatError]);

  useEffect(() => {
    chatToolStatusRef.current = chatToolStatus;
  }, [chatToolStatus]);

  useEffect(() => {
    chatToolStatusIsCompactionRef.current = chatToolStatusIsCompaction;
  }, [chatToolStatusIsCompaction]);

  useEffect(() => {
    selectedHistoryRef.current = selectedHistory;
  }, [selectedHistory]);

  useEffect(() => {
    selectedHistoryEntriesRef.current = selectedHistoryEntries;
  }, [selectedHistoryEntries]);

  useEffect(() => {
    historyItemsRef.current = historyItems;
  }, [historyItems]);

  useEffect(() => {
    historyTotalRef.current = historyTotal;
  }, [historyTotal]);

  useEffect(() => {
    historyHasMoreRef.current = historyHasMore;
  }, [historyHasMore]);

  useEffect(() => {
    historyListFilterRef.current = historyListFilter;
    if (historyScopeKeyRef.current === historyScopeKey) {
      return;
    }
    historyScopeKeyRef.current = historyScopeKey;
    historyListPageLoadingRef.current = false;
    commitHistoryListState([], 0, 1, false);
    setHistoryError(null);
    setHistoryListLoading(true);
  }, [commitHistoryListState, historyListFilter, historyScopeKey]);

  function getDisplayedConversationId() {
    return resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
  }

  function isDisplayedConversation(targetConversationId: string) {
    const conversationIdValue = targetConversationId.trim();
    return conversationIdValue !== "" && getDisplayedConversationId() === conversationIdValue;
  }

  useEffect(() => {
    localRunningConversationIdsRef.current = localRunningConversationIds;
  }, [localRunningConversationIds]);

  const applyLiveConversationTitle = useCallback(
    (
      targetConversationId: string,
      nextTitle: string,
      options?: {
        isFinal?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      const title = nextTitle.trim();
      if (!conversationIdValue || !title) {
        return;
      }

      const updatedAt = Date.now();
      lockHistoryTitlePosition(conversationIdValue);
      if (options?.isFinal) {
        optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
      }
      updateHistoryItems((current) => {
        const existing = pickConversationSummary(current, conversationIdValue);
        return upsertConversationSummary(
          current,
          {
            id: conversationIdValue,
            title,
            created_at: existing?.created_at ?? updatedAt,
            updated_at: existing?.updated_at ?? updatedAt,
            message_count: existing?.message_count ?? 1,
          },
          { preserveExistingUpdatedAt: existing !== null },
        );
      });
    },
    [lockHistoryTitlePosition, updateHistoryItems],
  );

  const applyChatToolStatus = useCallback(
    (nextStatus: string | null | undefined, isCompaction = false) => {
      const status = typeof nextStatus === "string" ? nextStatus.trim() : "";
      setChatToolStatus(status || null);
      setChatToolStatusIsCompaction(Boolean(status) && isCompaction);
    },
    [],
  );

  const getConversationLiveStreamStore = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return null;
    }
    const existing = liveConversationStreamStoresRef.current.get(conversationIdValue);
    if (existing) {
      return existing;
    }
    const created = createLiveConversationStreamStore();
    liveConversationStreamStoresRef.current.set(conversationIdValue, created);
    return created;
  }, []);

  const buildVisibleRuntimeEntry = useCallback(
    () =>
      createConversationRuntimeEntry({
        messages: chatMessagesRef.current,
        error: chatErrorRef.current,
        toolStatus: chatToolStatusRef.current,
        toolStatusIsCompaction: chatToolStatusIsCompactionRef.current,
        isSending: chatBusyRef.current,
        workdir: conversationRuntimeCacheRef.current.get(conversationIdRef.current.trim())?.workdir,
      }),
    [],
  );

  const syncVisibleConversationRuntime = useCallback(
    (targetConversationId: string, entry: ConversationRuntimeEntry) => {
      conversationIdRef.current = targetConversationId;
      selectedHistoryIdRef.current = targetConversationId;
      chatMessagesRef.current = entry.messages;
      chatErrorRef.current = entry.error;
      chatToolStatusRef.current = entry.toolStatus;
      chatToolStatusIsCompactionRef.current = entry.toolStatusIsCompaction;
      chatBusyRef.current = entry.isSending;
      setConversationId(targetConversationId);
      setSelectedHistoryId(targetConversationId);
      setChatMessages(entry.messages);
      setChatError(entry.error);
      applyChatToolStatus(entry.toolStatus, entry.toolStatusIsCompaction);
      setChatBusy(entry.isSending);
    },
    [applyChatToolStatus],
  );

  const cacheVisibleConversationRuntime = useCallback(
    (targetConversationId?: string) => {
      const conversationIdValue = (targetConversationId ?? conversationIdRef.current).trim();
      if (!conversationIdValue) {
        return;
      }
      conversationRuntimeCacheRef.current.set(conversationIdValue, buildVisibleRuntimeEntry());
    },
    [buildVisibleRuntimeEntry],
  );

  const updateConversationRuntimeEntry = useCallback(
    (
      targetConversationId: string,
      updater: (previous: ConversationRuntimeEntry) => ConversationRuntimeEntry,
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return createConversationRuntimeEntry();
      }

      const previous =
        conversationIdRef.current === conversationIdValue &&
        (selectedHistoryIdRef.current === "" ||
          selectedHistoryIdRef.current === conversationIdValue)
          ? buildVisibleRuntimeEntry()
          : (conversationRuntimeCacheRef.current.get(conversationIdValue) ??
            createConversationRuntimeEntry());
      const next = createConversationRuntimeEntry(updater(previous));
      conversationRuntimeCacheRef.current.set(conversationIdValue, next);

      if (
        conversationIdRef.current === conversationIdValue &&
        (selectedHistoryIdRef.current === "" ||
          selectedHistoryIdRef.current === conversationIdValue)
      ) {
        chatMessagesRef.current = next.messages;
        chatErrorRef.current = next.error;
        chatToolStatusRef.current = next.toolStatus;
        chatToolStatusIsCompactionRef.current = next.toolStatusIsCompaction;
        chatBusyRef.current = next.isSending;
        setChatMessages(next.messages);
        setChatError(next.error);
        applyChatToolStatus(next.toolStatus, next.toolStatusIsCompaction);
        setChatBusy(next.isSending);
      }

      return next;
    },
    [applyChatToolStatus, buildVisibleRuntimeEntry],
  );

  useEffect(() => {
    const nextWorkdir = activeWorkspaceProjectPath.trim();
    if (!isAgentMode || !nextWorkdir) {
      return;
    }
    const conversationIdValue = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
    if (!conversationIdValue || !isLocalDraftConversationId(conversationIdValue)) {
      return;
    }
    if (
      chatBusyRef.current ||
      localRunningConversationIdsRef.current.has(conversationIdValue) ||
      remoteRunningConversationIdsRef.current.has(conversationIdValue)
    ) {
      return;
    }
    if (chatMessagesRef.current.length > 0 || pendingUploadedFilesRef.current.length > 0) {
      return;
    }
    const currentWorkdir =
      conversationRuntimeCacheRef.current.get(conversationIdValue)?.workdir?.trim() || "";
    if (currentWorkdir === nextWorkdir) {
      return;
    }
    updateConversationRuntimeEntry(conversationIdValue, (current) => ({
      ...current,
      workdir: nextWorkdir,
    }));
  }, [activeWorkspaceProjectPath, isAgentMode, updateConversationRuntimeEntry]);

  const setConversationRunningState = useCallback(
    (targetConversationId: string, isRunning: boolean) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }

      const runtimeWorkdir =
        conversationRuntimeCacheRef.current.get(conversationIdValue)?.workdir?.trim() || "";
      const persistedWorkdir =
        historyItemsRef.current.find((item) => item.id === conversationIdValue)?.cwd?.trim() || "";
      recordProjectActivity(runtimeWorkdir || persistedWorkdir, Date.now());

      updateConversationRuntimeEntry(conversationIdValue, (previous) => ({
        ...previous,
        isSending: isRunning,
      }));
      setLocalRunningConversationIds((current) => {
        const hasConversation = current.has(conversationIdValue);
        if ((isRunning && hasConversation) || (!isRunning && !hasConversation)) {
          return current;
        }
        const next = new Set(current);
        if (isRunning) {
          next.add(conversationIdValue);
        } else {
          next.delete(conversationIdValue);
        }
        localRunningConversationIdsRef.current = next;
        return next;
      });
    },
    [recordProjectActivity, updateConversationRuntimeEntry],
  );

  const setConversationAbortController = useCallback(
    (targetConversationId: string, controller: AbortController | null) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      if (controller) {
        conversationAbortControllersRef.current.set(conversationIdValue, controller);
        return;
      }
      conversationAbortControllersRef.current.delete(conversationIdValue);
    },
    [],
  );

  const getConversationAbortController = useCallback((targetConversationId: string) => {
    return conversationAbortControllersRef.current.get(targetConversationId.trim()) ?? null;
  }, []);

  const clearConversationLiveStream = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      liveConversationStreamStoresRef.current.get(conversationIdValue)?.reset();
      liveConversationStreamStoresRef.current.delete(conversationIdValue);
      pendingHistoryRefreshAfterLiveCompletionRef.current.delete(conversationIdValue);
    },
    [],
  );

  const clearAllConversationLiveStreams = useCallback(() => {
    liveConversationStreamStoresRef.current.forEach((store) => store.reset());
    liveConversationStreamStoresRef.current.clear();
    pendingHistoryRefreshAfterLiveCompletionRef.current.clear();
  }, []);

  const hasRetainedConversationLiveStream = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return false;
    }
    const store = liveConversationStreamStoresRef.current.get(conversationIdValue);
    if (!store) {
      return false;
    }
    return store.getSnapshot().entries.length > 0 ||
      conversationEventStreamsRef.current.has(conversationIdValue);
  }, []);

  const commitConversationLiveStreamToRuntime = useCallback(
    (
      targetConversationId: string,
      options?: {
        clearLiveStream?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }

      const liveStore = liveConversationStreamStoresRef.current.get(conversationIdValue);
      liveStore?.flush();
      const liveEntries = liveStore?.getSnapshot().entries ?? [];
      if (liveEntries.length === 0) {
        if (options?.clearLiveStream) {
          clearConversationLiveStream(conversationIdValue);
        }
        return false;
      }

      updateConversationRuntimeEntry(conversationIdValue, (current) => {
        const nextMessages = appendCommittedLiveEntries(current.messages, liveEntries);
        if (nextMessages === current.messages) {
          return current;
        }
        return {
          ...current,
          messages: nextMessages,
        };
      });

      const selectedConversationId = selectedHistoryIdRef.current.trim();
      const visibleConversationId = conversationIdRef.current.trim();
      if (
        selectedConversationId === conversationIdValue &&
        visibleConversationId !== conversationIdValue
      ) {
        setSelectedHistoryEntries((current) => appendCommittedLiveEntries(current, liveEntries));
      }

      if (options?.clearLiveStream) {
        clearConversationLiveStream(conversationIdValue);
      }
      return true;
    },
    [clearConversationLiveStream, updateConversationRuntimeEntry],
  );

  const fetchVisibleHistoryGuarded = async (
    targetConversationId: string,
    currentApi: typeof api,
    options?: { allowDuringEditTransaction?: boolean },
  ): Promise<{ detail: HistoryDetail; entries: ChatEntry[]; conversationId: string } | null> => {
    const conversationIdValue = targetConversationId.trim();
    if (!currentApi || !conversationIdValue) return null;
    if (
      options?.allowDuringEditTransaction !== true &&
      activeEditResendTransactionsRef.current.has(conversationIdValue)
    ) {
      return null;
    }

    const isStillVisible = () =>
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
      conversationIdValue;

    if (!isStillVisible()) return null;

    const refreshSeq =
      (visibleHistorySnapshotRefreshSeqRef.current.get(conversationIdValue) ?? 0) + 1;
    visibleHistorySnapshotRefreshSeqRef.current.set(conversationIdValue, refreshSeq);

    let detail: HistoryDetail;
    let entries: ChatEntry[];
    try {
      detail = await currentApi.getHistory(conversationIdValue, {
        maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
      });
      entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
    } catch {
      return null;
    }

    if (
      visibleHistorySnapshotRefreshSeqRef.current.get(conversationIdValue) !== refreshSeq ||
      !isStillVisible()
    ) {
      return null;
    }

    const detailConversationId = detail.conversation_id.trim();
    if (detailConversationId !== "" && detailConversationId !== conversationIdValue) return null;

    return { detail, entries, conversationId: conversationIdValue };
  };

  const refreshVisibleConversationHistorySnapshot = useCallback(
    async (
      targetConversationId: string,
      currentApi = api,
      options?: { allowIdle?: boolean; allowDuringEditTransaction?: boolean },
    ) => {
      const cid = targetConversationId.trim();
      if (
        getConversationAbortController(cid) !== null ||
        localRunningConversationIdsRef.current.has(cid)
      ) {
        return;
      }

      const result = await fetchVisibleHistoryGuarded(targetConversationId, currentApi, options);
      if (!result) return;
      const { detail, entries, conversationId: conversationIdValue } = result;

      if (
        getConversationAbortController(conversationIdValue) !== null ||
        localRunningConversationIdsRef.current.has(conversationIdValue) ||
        (options?.allowIdle !== true &&
          !remoteRunningConversationIdsRef.current.has(conversationIdValue) &&
          !hasRetainedConversationLiveStream(conversationIdValue))
      ) {
        return;
      }

      const isFullSnapshot = detail.has_more === false;
      const mergeOptions = { isFullSnapshot };
      const liveStore = liveConversationStreamStoresRef.current.get(conversationIdValue);
      const liveSnapshotEntries = liveStore?.getSnapshot().entries ?? [];
      const marker = completedLiveStreamMarkersRef.current.get(conversationIdValue);
      const liveSnapshotIsCompletedRetention =
        marker !== undefined &&
        Date.now() - marker.at <= LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS;
      const liveStreamConflictsWithSnapshot =
        isFullSnapshot &&
        liveSnapshotEntries.length > 0 &&
        liveSnapshotIsCompletedRetention &&
        !hasEquivalentTailEntries(entries, liveSnapshotEntries);

      if (selectedHistoryIdRef.current.trim() === conversationIdValue) {
        selectedHistoryRef.current = detail;
        setSelectedHistory(detail);
        setSelectedHistoryEntries((current) =>
          mergeHistorySnapshotEntries(current, entries, mergeOptions),
        );
      }

      updateConversationRuntimeEntry(conversationIdValue, (current) => {
        const nextMessages = mergeHistorySnapshotEntries(current.messages, entries, mergeOptions);
        if (nextMessages === current.messages) {
          return current;
        }
        return {
          ...current,
          messages: nextMessages,
        };
      });

      if (liveStreamConflictsWithSnapshot) {
        clearConversationLiveStream(conversationIdValue);
      }
    },
    [
      api,
      clearConversationLiveStream,
      getConversationAbortController,
      hasRetainedConversationLiveStream,
      updateConversationRuntimeEntry,
    ],
  );

  const migrateConversationLiveStream = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      const previousStore = liveConversationStreamStoresRef.current.get(previousId);
      if (previousStore) {
        liveConversationStreamStoresRef.current.delete(previousId);
        liveConversationStreamStoresRef.current.set(nextId, previousStore);
      }
    },
    [],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

  const migrateConversation = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }

      const previousRuntime =
        conversationRuntimeCacheRef.current.get(previousId) ??
        (conversationIdRef.current === previousId ? buildVisibleRuntimeEntry() : null);
      if (previousRuntime) {
        conversationRuntimeCacheRef.current.set(nextId, previousRuntime);
      }
      conversationRuntimeCacheRef.current.delete(previousId);

      const controller = conversationAbortControllersRef.current.get(previousId);
      if (controller) {
        conversationAbortControllersRef.current.delete(previousId);
        conversationAbortControllersRef.current.set(nextId, controller);
      }

      setLocalRunningConversationIds((current) => {
        if (!current.has(previousId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(previousId);
        next.add(nextId);
        localRunningConversationIdsRef.current = next;
        return next;
      });

      migrateConversationLiveStream(previousId, nextId);

      if (conversationIdRef.current === previousId) {
        conversationIdRef.current = nextId;
        setConversationId(nextId);
      }
      if (selectedHistoryIdRef.current === previousId) {
        selectedHistoryIdRef.current = nextId;
        setSelectedHistoryId(nextId);
      }
      if (protectedConversationRef.current.trim() === previousId) {
        protectedConversationRef.current = nextId;
      }
      if (blockedHistoryHydrationConversationIdsRef.current.delete(previousId)) {
        blockedHistoryHydrationConversationIdsRef.current.add(nextId);
      }

      const shouldPreserveOptimisticTitle =
        optimisticTitleConversationIdsRef.current.delete(previousId);
      if (shouldPreserveOptimisticTitle) {
        optimisticTitleConversationIdsRef.current.add(nextId);
      }
      if (titlePositionLockedConversationIdsRef.current.has(previousId)) {
        unlockHistoryTitlePosition(previousId);
        lockHistoryTitlePosition(nextId);
      }

      updateHistoryItems((current) => {
        const previousSummary = pickConversationSummary(current, previousId);
        if (!previousSummary) {
          return current;
        }

        const nextSummary = pickConversationSummary(current, nextId);
        const mergedSummary = {
          ...previousSummary,
          ...(nextSummary ?? {}),
          id: nextId,
          title: shouldPreserveOptimisticTitle
            ? previousSummary.title
            : nextSummary?.title?.trim() || previousSummary.title,
          provider_id: nextSummary?.provider_id || previousSummary.provider_id,
          model: nextSummary?.model || previousSummary.model,
          session_id: nextSummary?.session_id || previousSummary.session_id,
          cwd: nextSummary?.cwd || previousSummary.cwd,
          is_pinned: nextSummary?.is_pinned ?? previousSummary.is_pinned,
          pinned_at:
            "pinned_at" in (nextSummary ?? {}) ? nextSummary?.pinned_at : previousSummary.pinned_at,
          is_shared: nextSummary?.is_shared ?? previousSummary.is_shared,
        };
        const withoutMigratedRows = current.filter(
          (item) => item.id !== previousId && item.id !== nextId,
        );
        return upsertConversationSummary(withoutMigratedRows, mergedSummary, {
          preserveExistingTitle: shouldPreserveOptimisticTitle,
        });
      });
    },
    [
      buildVisibleRuntimeEntry,
      lockHistoryTitlePosition,
      migrateConversationLiveStream,
      unlockHistoryTitlePosition,
      updateHistoryItems,
    ],
  );

  const getActivePendingDraftMigration = () => {
    const pending = pendingDraftConversationMigrationRef.current;
    if (!pending) {
      return null;
    }
    const draftId = pending.draftConversationId.trim();
    if (
      !draftId ||
      !isLocalDraftConversationId(draftId) ||
      conversationIdRef.current.trim() !== draftId ||
      selectedHistoryIdRef.current.trim() !== draftId ||
      protectedConversationRef.current.trim() !== draftId
    ) {
      return null;
    }
    return localRunningConversationIdsRef.current.has(draftId) || isHydrationBlocked(draftId)
      ? pending
      : null;
  };

  const isRecentPendingDraftConversation = (
    conversation: Pick<ConversationSummary, "created_at" | "updated_at"> | undefined,
    pending: PendingDraftConversationMigration,
  ) => {
    const conversationTimestamp =
      normalizeGatewayTimestampMs(conversation?.created_at) ||
      normalizeGatewayTimestampMs(conversation?.updated_at);
    return (
      conversationTimestamp <= 0 ||
      conversationTimestamp >= pending.startedAt - DRAFT_HISTORY_ADOPTION_WINDOW_MS
    );
  };

  const maybeAdoptActiveDraftConversation = useCallback(
    (conversation: ConversationSummary | undefined) => {
      const nextId = conversation?.id?.trim() ?? "";
      const pending = getActivePendingDraftMigration();
      if (!pending || !nextId || isLocalDraftConversationId(nextId)) {
        return false;
      }

      const draftId = pending.draftConversationId.trim();
      if (!draftId || draftId === nextId) {
        return false;
      }

      if (!isRecentPendingDraftConversation(conversation, pending)) {
        return false;
      }

      pendingDraftConversationMigrationRef.current = null;
      migrateConversation(draftId, nextId);
      return true;
    },
    [migrateConversation],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "tunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  const handleTunnelManagerChatEvent = useCallback(
    (event: ChatEvent) => {
      const change = readTunnelManagerToolChange(event);
      if (!change) return;
      setTunnelRefreshToken((current) => current + 1);
      if (change.action === "create") {
        ensureTunnelToolTab(change.projectPathKey);
      }
    },
    [ensureTunnelToolTab],
  );

  const persistProjectConversationActivity = useCallback(
    (activity: ReadonlyMap<string, number>) => {
      if (activity.size === 0) {
        return;
      }
      setSettings((prev) => {
        const hiddenProjectPathKeys = new Set(
          prev.system.hiddenWorkspaceProjectPaths.map(workspaceProjectPathKey),
        );
        const workspaceProjects = applyWorkspaceProjectConversationActivityMap(
          prev.system.workspaceProjects,
          activity,
          { hiddenProjectPathKeys },
        );
        if (!workspaceProjects) {
          return prev;
        }
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );
  persistProjectConversationActivityRef.current = persistProjectConversationActivity;

  const refreshHistoryWorkdirs = useCallback(
    async (currentApi = api) => {
      if (!currentApi) {
        setHistoryWorkdirs([]);
        return;
      }
      try {
        const response = await currentApi.listHistoryWorkdirs();
        setHistoryWorkdirs(response.workdirs);
      } catch (error) {
        console.warn("Failed to load chat history workdirs", error);
      }
    },
    [api],
  );

  useEffect(() => {
    void refreshHistoryWorkdirs(api);
  }, [api, refreshHistoryWorkdirs]);

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) {
          return prev;
        }
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              missingWorkspaceProjectPaths,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject, currentApi = api) => {
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      if (!currentApi) {
        return !missingWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path));
      }
      try {
        await currentApi.listDirs(path, 1);
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [api, missingWorkspaceProjectPathKeys, setWorkspaceProjectDirectoryMissing],
  );

  const activateWorkspaceProject = useCallback(
    (project: WorkspaceProject, options?: { startConversation?: boolean }) => {
      const pathKey = project.path.trim();
      if (!pathKey) return;
      const normalizedPathKey = workspaceProjectPathKey(pathKey);
      const targetProject =
        workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        ) ?? project;
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ?? targetProject;
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    name: item.id === DEFAULT_WORKSPACE_PROJECT_ID ? item.name : nextProject.name,
                    path: nextProject.path,
                    kind:
                      item.id === DEFAULT_WORKSPACE_PROJECT_ID
                        ? "managed"
                        : nextProject.kind === "history"
                          ? item.kind
                          : nextProject.kind,
                    updatedAt: item.updatedAt,
                    lastConversationAt:
                      Math.max(item.lastConversationAt ?? 0, nextProject.lastConversationAt ?? 0) ||
                      undefined,
                  }
                : item,
            )
          : [...prev.system.workspaceProjects, nextProject];
        const nextSystem = resolveWorkspaceProjects(
          {
            ...prev.system,
            workspaceProjects,
            activeWorkspaceProjectId: existing?.id ?? nextProject.id,
            hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
          },
          getDefaultWorkspaceProjectPath(prev.system),
        );
        return {
          ...prev,
          system: nextSystem,
        };
      });
      if (options?.startConversation) {
        setActiveView("chat");
        startNewConversation({ workdir: targetProject.path });
      }
    },
    [setSettings, workspaceProjects],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      if (isMobileSidebarLayout()) {
        setSidebarOpen(false);
      }
      activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) {
        return;
      }

      if (isMobileSidebarLayout()) {
        setSidebarOpen(false);
      }
      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSettings],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setProjectPickerOpen(true);
  }, []);

  const handleWorkdirPickerSelect = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(normalizedPath, "managed"));
      void refreshHistoryWorkdirs(api);
    },
    [activateWorkspaceProject, api, refreshHistoryWorkdirs],
  );

  const commitWorkspaceProjectRename = useCallback(
    (project: WorkspaceProject, nextNameInput: string) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const nextName = nextNameInput.trim();
      if (!nextName || nextName === project.name) return;
      setSettings((prev) => {
        const pathKey = workspaceProjectPathKey(project.path);
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        const updatedProject: WorkspaceProject = {
          ...(existing ?? project),
          id: existing?.id ?? project.id,
          name: nextName,
          kind: (existing ?? project).kind === "history" ? "folder" : (existing ?? project).kind,
          updatedAt: Date.now(),
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleStartRenamingWorkspaceProject = useCallback((project: WorkspaceProject) => {
    if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
    setProjectRenamingId(project.id);
    setProjectRenameDraft(project.name);
  }, []);

  const handleCommitWorkspaceProjectRename = useCallback(() => {
    if (!projectRenamingId) {
      return;
    }
    const project = workspaceProjects.find((item) => item.id === projectRenamingId);
    if (project) {
      commitWorkspaceProjectRename(project, projectRenameDraft);
    }
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, [commitWorkspaceProjectRename, projectRenameDraft, projectRenamingId, workspaceProjects]);

  const handleCancelWorkspaceProjectRename = useCallback(() => {
    setProjectRenamingId(null);
    setProjectRenameDraft("");
  }, []);

  const handleSetWorkspaceProjectPinned = useCallback(
    (project: WorkspaceProject, isPinned: boolean) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;

      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        if (!existing && !isPinned) {
          return prev;
        }

        const now = Date.now();
        const source = existing ?? project;
        const updatedProject: WorkspaceProject = {
          ...source,
          id: existing?.id ?? source.id,
          kind: source.id === DEFAULT_WORKSPACE_PROJECT_ID ? "managed" : source.kind,
          updatedAt: now,
          isPinned,
          pinnedAt: isPinned ? now : null,
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleSidebarProjectsCollapsedChange = useCallback(
    (projectsCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            projectsCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            recentCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  useEffect(() => {
    if (!api) {
      return;
    }

    const unsubscribe = api.subscribeStatus((nextStatus, error) => {
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setStatusError(error);
    });
    return () => {
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    remoteRunningConversationIdsRef.current = remoteRunningConversationIds;
  }, [remoteRunningConversationIds]);

  useEffect(() => {
    remoteRunningConversationRuntimeRef.current = remoteRunningConversationRuntime;
  }, [remoteRunningConversationRuntime]);

  const setRemoteConversationRunningState = useCallback(
    (
      targetConversationId: string,
      isRunning: boolean,
      runtime?: {
        runId?: string;
        workdir?: string;
        firstSeq?: number;
        runEpoch?: number;
        updatedAt?: number;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }
      const current = remoteRunningConversationIdsRef.current;
      const hasConversation = current.has(conversationIdValue);
      const existingRuntime = remoteRunningConversationRuntimeRef.current.get(conversationIdValue);
      const runtimeRunId = runtime?.runId?.trim() || existingRuntime?.runId || "";
      if (isRunning && !runtimeRunId) {
        return;
      }
      const runtimeWorkdir = runtime?.workdir?.trim() || existingRuntime?.workdir || "";
      const runtimeFirstSeq =
        typeof runtime?.firstSeq === "number" &&
        Number.isFinite(runtime.firstSeq) &&
        runtime.firstSeq > 0
          ? Math.floor(runtime.firstSeq)
          : existingRuntime?.firstSeq;
      const runtimeRunEpoch =
        typeof runtime?.runEpoch === "number" &&
        Number.isFinite(runtime.runEpoch) &&
        runtime.runEpoch > 0
          ? Math.floor(runtime.runEpoch)
          : existingRuntime?.runEpoch;
      const runtimeUpdatedAt =
        typeof runtime?.updatedAt === "number" &&
        Number.isFinite(runtime.updatedAt) &&
        runtime.updatedAt > 0
          ? runtime.updatedAt
          : existingRuntime?.updatedAt || Date.now();
      const nextRunKey = isRunning
        ? resolveRunningConversationRunKey({
            runId: runtimeRunId || undefined,
          })
        : "";
      const previousRunKey =
        resolveRunningConversationRunKey(existingRuntime) ||
        (conversationEventStreamsRef.current.get(conversationIdValue)?.runId ?? "");
      if (isRunning && nextRunKey && previousRunKey !== nextRunKey) {
        const existingStream = conversationEventStreamsRef.current.get(conversationIdValue);
        if (existingStream) {
          conversationEventStreamsRef.current.delete(conversationIdValue);
          existingStream.controller.abort();
        }
        const existingMarker = completedLiveStreamMarkersRef.current.get(conversationIdValue);
        if (existingMarker) {
          window.clearTimeout(existingMarker.timeoutId);
          completedLiveStreamMarkersRef.current.delete(conversationIdValue);
        }
        clearConversationLiveStream(conversationIdValue);
      }
      recordProjectActivity(runtimeWorkdir, runtimeUpdatedAt);
      if (!isRunning && !hasConversation && !existingRuntime) {
        return;
      }
      if (!isRunning || !hasConversation) {
        const next = new Set(current);
        if (isRunning) {
          next.add(conversationIdValue);
        } else {
          next.delete(conversationIdValue);
        }
        remoteRunningConversationIdsRef.current = next;
        setRemoteRunningConversationIds(next);
      }

      const currentRuntime = remoteRunningConversationRuntimeRef.current;
      const existing = currentRuntime.get(conversationIdValue);
      if (!isRunning) {
        if (!existing) {
          return;
        }
        const nextRuntime = new Map(currentRuntime);
        nextRuntime.delete(conversationIdValue);
        remoteRunningConversationRuntimeRef.current = nextRuntime;
        setRemoteRunningConversationRuntime(nextRuntime);
        return;
      }

      const nextRuntimeEntry: RunningConversationRuntime = {
        runId: runtimeRunId || undefined,
        workdir: runtimeWorkdir || undefined,
        firstSeq: runtimeFirstSeq,
        runEpoch: runtimeRunEpoch,
        updatedAt: Math.max(existing?.updatedAt ?? 0, runtimeUpdatedAt),
      };
      if (
        existing?.runId === nextRuntimeEntry.runId &&
        existing?.workdir === nextRuntimeEntry.workdir &&
        existing?.firstSeq === nextRuntimeEntry.firstSeq &&
        existing?.runEpoch === nextRuntimeEntry.runEpoch &&
        existing?.updatedAt === nextRuntimeEntry.updatedAt
      ) {
        return;
      }
      const nextRuntime = new Map(currentRuntime);
      nextRuntime.set(conversationIdValue, nextRuntimeEntry);
      remoteRunningConversationRuntimeRef.current = nextRuntime;
      setRemoteRunningConversationRuntime(nextRuntime);
    },
    [clearConversationLiveStream, recordProjectActivity],
  );

  const stopConversationEventStreamSubscription = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return;
    }
    const stream = conversationEventStreamsRef.current.get(conversationIdValue);
    if (!stream) {
      return;
    }
    conversationEventStreamsRef.current.delete(conversationIdValue);
    stream.controller.abort();
  }, []);

  const stopAllConversationEventStreamSubscriptions = useCallback(() => {
    const streams = [...conversationEventStreamsRef.current.values()];
    conversationEventStreamsRef.current.clear();
    for (const { controller } of streams) {
      controller.abort();
    }
  }, []);

  const clearCompletedLiveStreamMarker = useCallback((targetConversationId: string) => {
    const conversationIdValue = targetConversationId.trim();
    if (!conversationIdValue) {
      return;
    }
    const existingMarker = completedLiveStreamMarkersRef.current.get(conversationIdValue);
    if (existingMarker) {
      window.clearTimeout(existingMarker.timeoutId);
    }
    completedLiveStreamMarkersRef.current.delete(conversationIdValue);
  }, []);

  const clearAllCompletedLiveStreamMarkers = useCallback(() => {
    for (const { timeoutId } of completedLiveStreamMarkersRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    completedLiveStreamMarkersRef.current.clear();
  }, []);

  const hasRecentlyCompletedLiveStream = useCallback(
    (targetConversationId: string) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }
      const marker = completedLiveStreamMarkersRef.current.get(conversationIdValue);
      if (!marker) {
        return false;
      }
      if (Date.now() - marker.at > LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS) {
        clearCompletedLiveStreamMarker(conversationIdValue);
        return false;
      }
      return true;
    },
    [clearCompletedLiveStreamMarker],
  );

  const clearConversationStreamingState = useCallback(
    (
      targetConversationId: string,
      options?: {
        remoteRunId?: string;
        preserveRemoteRun?: boolean;
        preserveRemoteRunOnMismatch?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }

      liveConversationStreamStoresRef.current
        .get(conversationIdValue)
        ?.setToolStatus(null, false, { flush: true });
      const expectedRemoteRunKey = resolveRunningConversationRunKey({
        runId: options?.remoteRunId,
      });
      const currentRemoteRunKey = resolveRunningConversationRunKey(
        remoteRunningConversationRuntimeRef.current.get(conversationIdValue),
      );
      const shouldClearRemoteRunning =
        !options?.preserveRemoteRun &&
        (!options?.preserveRemoteRunOnMismatch ||
          !expectedRemoteRunKey ||
          !currentRemoteRunKey ||
          expectedRemoteRunKey === currentRemoteRunKey);
      if (shouldClearRemoteRunning) {
        setRemoteConversationRunningState(conversationIdValue, false);
      }
      setConversationAbortController(conversationIdValue, null);
      setConversationRunningState(conversationIdValue, false);
      updateConversationRuntimeEntry(conversationIdValue, (current) => {
        if (!current.isSending && current.toolStatus === null && !current.toolStatusIsCompaction) {
          return current;
        }
        return {
          ...current,
          isSending: false,
          toolStatus: null,
          toolStatusIsCompaction: false,
        };
      });
    },
    [
      setConversationAbortController,
      setConversationRunningState,
      setRemoteConversationRunningState,
      updateConversationRuntimeEntry,
    ],
  );

  const finalizeTerminalLiveStream = useCallback(
    (
      targetConversationId: string,
      currentApi = api,
      clearStreamingStateOptions?: {
        remoteRunId?: string;
        preserveRemoteRun?: boolean;
        preserveRemoteRunOnMismatch?: boolean;
      },
    ) => {
      const conversationIdValue = targetConversationId.trim();
      if (!conversationIdValue) {
        return;
      }

      const existingMarker = completedLiveStreamMarkersRef.current.get(conversationIdValue);
      if (existingMarker) {
        window.clearTimeout(existingMarker.timeoutId);
      }
      const timeoutId = window.setTimeout(() => {
        completedLiveStreamMarkersRef.current.delete(conversationIdValue);
      }, LIVE_STREAM_HISTORY_REFRESH_SUPPRESS_MS);
      completedLiveStreamMarkersRef.current.set(conversationIdValue, { at: Date.now(), timeoutId });

      const isVisibleConversation =
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
        conversationIdValue;
      const shouldKeepBottom = isVisibleConversation && isTranscriptAtBottom();

      if (!isVisibleConversation) {
        flushSync(() => {
          clearConversationLiveStream(conversationIdValue);
          clearConversationStreamingState(conversationIdValue, clearStreamingStateOptions);
        });
      } else {
        preserveTranscriptScrollPosition(
          () => {
            flushSync(() => {
              commitConversationLiveStreamToRuntime(conversationIdValue, {
                clearLiveStream: false,
              });
              clearConversationStreamingState(conversationIdValue, clearStreamingStateOptions);
            });
          },
          { stickToBottom: shouldKeepBottom },
        );

        if (shouldKeepBottom) {
          stickTranscriptToBottom();
        } else {
          refreshTranscriptScrollState();
        }
      }

      if (currentApi && pendingHistoryRefreshAfterLiveCompletionRef.current.has(conversationIdValue)) {
        pendingHistoryRefreshAfterLiveCompletionRef.current.delete(conversationIdValue);
        void refreshVisibleConversationHistorySnapshot(conversationIdValue, currentApi, {
          allowIdle: true,
        });
      }
    },
    [
      api,
      clearConversationLiveStream,
      clearConversationStreamingState,
      commitConversationLiveStreamToRuntime,
      isTranscriptAtBottom,
      preserveTranscriptScrollPosition,
      refreshTranscriptScrollState,
      refreshVisibleConversationHistorySnapshot,
      stickTranscriptToBottom,
    ],
  );

  const applyChatRuntimeSnapshotEvent = useCallback(
    (
      event: ChatRuntimeSnapshotEvent,
      fallbackConversationId: string,
      currentApi = api,
    ) => {
      const conversationIdValue =
        event.conversation_id?.trim() || fallbackConversationId.trim();
      if (!conversationIdValue) {
        return false;
      }

      const liveStore = getConversationLiveStreamStore(conversationIdValue);
      if (!liveStore) {
        return false;
      }

      liveStore.applySnapshot(event, { flush: true });

      const state = event.state ?? "running";
      const terminalState =
        state === "completed" || state === "failed" || state === "cancelled";
      setRemoteConversationRunningState(conversationIdValue, !terminalState, {
        runId: event.run_id,
        workdir: event.workdir,
        updatedAt: normalizeGatewayTimestampMs(event.updated_at),
      });

      if (terminalState) {
        finalizeTerminalLiveStream(conversationIdValue, currentApi);
      }

      return terminalState;
    },
    [
      api,
      finalizeTerminalLiveStream,
      getConversationLiveStreamStore,
      setRemoteConversationRunningState,
    ],
  );

  const recoverUnavailableConversationStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }

      clearConversationLiveStream(conversationIdValue);
      clearConversationStreamingState(conversationIdValue);
      void refreshVisibleConversationHistorySnapshot(conversationIdValue, currentApi, {
        allowIdle: true,
      });
    },
    [
      api,
      clearConversationLiveStream,
      clearConversationStreamingState,
      refreshVisibleConversationHistorySnapshot,
    ],
  );

  const subscribeVisibleConversationEventStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }
      if (isLocalDraftConversationId(conversationIdValue)) {
        return;
      }
      if (!remoteRunningConversationIdsRef.current.has(conversationIdValue)) {
        return;
      }
      if (
        localRunningConversationIdsRef.current.has(conversationIdValue) ||
        getConversationAbortController(conversationIdValue) !== null
      ) {
        return;
      }
      if (
        resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) !==
        conversationIdValue
      ) {
        return;
      }

      const runtime = remoteRunningConversationRuntimeRef.current.get(conversationIdValue);
      const nextRunKey = resolveRunningConversationRunKey(runtime);
      if (!nextRunKey) {
        return;
      }
      const existingStream =
        conversationEventStreamsRef.current.get(conversationIdValue);
      if (existingStream) {
        if (!nextRunKey || existingStream.runId === nextRunKey) {
          return;
        }
        conversationEventStreamsRef.current.delete(conversationIdValue);
        existingStream.controller.abort();
      }

      const controller = new AbortController();
      conversationEventStreamsRef.current.set(conversationIdValue, { controller, runId: nextRunKey });
      clearCompletedLiveStreamMarker(conversationIdValue);
      const liveStore = getConversationLiveStreamStore(conversationIdValue);
      if (!liveStore) {
        conversationEventStreamsRef.current.delete(conversationIdValue);
        return;
      }
      void refreshVisibleConversationHistorySnapshot(conversationIdValue, currentApi);
      const streamAfterSeq = resolveRunningConversationStreamAfterSeq(runtime?.firstSeq, {
        runId: runtime?.runId,
      });

      void (async () => {
        let terminalEventSeen = false;
        let recoverableTransportErrorSeen = false;
        try {
          for await (const event of currentApi.streamChatEvents(conversationIdValue, {
            runId: runtime?.runId,
            afterSeq: streamAfterSeq,
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) {
              return;
            }

            const eventConversationId = event.conversation_id?.trim() || conversationIdValue;
            const liveTitle = readChatEventTitle(event);
            if (liveTitle && isChatEventTitleFinal(event)) {
              applyLiveConversationTitle(eventConversationId, liveTitle, {
                isFinal: true,
              });
            }

            if (event.type === "runtime_snapshot") {
              const terminalSnapshot = applyChatRuntimeSnapshotEvent(
                event,
                conversationIdValue,
                currentApi,
              );
              if (terminalSnapshot) {
                terminalEventSeen = true;
                return;
              }
              continue;
            }

            if (event.type === "tool_status") {
              const normalizedStatus = normalizeOptionalStatus(event.status);
              const isCompaction = normalizedStatus !== null && event.isCompaction === true;
              liveStore.setToolStatus(normalizedStatus, isCompaction);
              continue;
            }

            if (isChatStreamNotAvailableEvent(event)) {
              terminalEventSeen = true;
              recoverUnavailableConversationStream(conversationIdValue, currentApi);
              return;
            }

            const terminalEvent = isTerminalChatEvent(event);
            liveStore.appendEvent(event, { flush: terminalEvent });
            handleTunnelManagerChatEvent(event);

            if (terminalEvent) {
              terminalEventSeen = true;
              finalizeTerminalLiveStream(conversationIdValue, currentApi, {
                remoteRunId: nextRunKey,
                preserveRemoteRunOnMismatch: true,
              });
              return;
            }

          }
        } catch (error) {
          if (!isAbortError(error)) {
            const message = asErrorMessage(error, "chat event stream failed");
            if (isChatStreamNotAvailableMessage(message)) {
              terminalEventSeen = true;
              recoverUnavailableConversationStream(conversationIdValue, currentApi);
              return;
            }
            if (isRecoverableChatStreamTransportMessage(message)) {
              recoverableTransportErrorSeen = true;
              liveStore.flush();
              return;
            }
            liveStore.appendEvent(
              {
                type: "error",
                message,
                conversation_id: conversationIdValue,
              },
              { flush: true },
            );
            terminalEventSeen = true;
            finalizeTerminalLiveStream(conversationIdValue, currentApi, {
              remoteRunId: nextRunKey,
              preserveRemoteRunOnMismatch: true,
            });
          }
        } finally {
          if (
            conversationEventStreamsRef.current.get(conversationIdValue)?.controller === controller
          ) {
            conversationEventStreamsRef.current.delete(conversationIdValue);
          }
          if (!terminalEventSeen && controller.signal.aborted) {
            liveStore.flush();
          }
          if (recoverableTransportErrorSeen && !controller.signal.aborted) {
            liveStore.flush();
            clearConversationStreamingState(conversationIdValue, { preserveRemoteRun: true });
            window.setTimeout(() => {
              if (
                remoteRunningConversationIdsRef.current.has(conversationIdValue) &&
                !conversationEventStreamsRef.current.has(conversationIdValue)
              ) {
                subscribeVisibleConversationEventStream(conversationIdValue, currentApi);
              }
            }, 500);
          } else if (!terminalEventSeen && !controller.signal.aborted) {
            liveStore.flush();
            clearConversationStreamingState(conversationIdValue);
          }
        }
      })();
    },
    [
      api,
      applyLiveConversationTitle,
      clearCompletedLiveStreamMarker,
      clearConversationStreamingState,
      finalizeTerminalLiveStream,
      getConversationAbortController,
      getConversationLiveStreamStore,
      applyChatRuntimeSnapshotEvent,
      handleTunnelManagerChatEvent,
      recoverUnavailableConversationStream,
      refreshVisibleConversationHistorySnapshot,
    ],
  );

  useEffect(() => {
    if (!api) {
      remoteRunningConversationIdsRef.current = new Set();
      setRemoteRunningConversationIds(new Set());
      remoteRunningConversationRuntimeRef.current = new Map();
      setRemoteRunningConversationRuntime(new Map());
      stopAllConversationEventStreamSubscriptions();
      clearAllCompletedLiveStreamMarkers();
      clearAllConversationLiveStreams();
      return;
    }

    const unsubscribe = api.subscribeHistory((event: GatewayHistoryEvent) => {
      const targetConversationId = event.conversation_id.trim();
      if (!targetConversationId) {
        return;
      }

      if (event.kind === "running" || event.kind === "idle") {
        const pending = getActivePendingDraftMigration();
        if (pending) {
          const targetId = targetConversationId;
          if (
            !isLocalDraftConversationId(targetId) &&
            targetId !== pending.draftConversationId.trim()
          ) {
            const existing = pickConversationSummary(historyItemsRef.current, targetId);
            if (!existing || isRecentPendingDraftConversation(existing, pending)) {
              return;
            }
          }
        }
      }

      if (event.kind === "running" || event.kind === "idle") {
        if (event.kind === "running" && !event.run_id?.trim()) {
          return;
        }
        const eventRunKey = event.run_id?.trim()
          ? resolveRunningConversationRunKey({ runId: event.run_id })
          : "";
        if (event.kind === "idle") {
          const activeStream = conversationEventStreamsRef.current.get(targetConversationId);
          const activeRunKey =
            activeStream?.runId ??
            resolveRunningConversationRunKey(
              remoteRunningConversationRuntimeRef.current.get(targetConversationId),
            );
          if (activeRunKey && (!eventRunKey || activeRunKey !== eventRunKey)) {
            if (!activeStream) {
              subscribeVisibleConversationEventStream(targetConversationId, api);
            }
            void refreshHistoryWorkdirs(api);
            return;
          }
        }
        setRemoteConversationRunningState(targetConversationId, event.kind === "running", {
          runId: event.run_id,
          workdir: event.conversation?.cwd,
          firstSeq: event.first_seq,
          runEpoch: event.run_epoch,
          updatedAt: event.updated_at ?? event.conversation?.updated_at,
        });
        if (event.kind === "running") {
          subscribeVisibleConversationEventStream(targetConversationId, api);
          return;
        }

        void refreshHistoryWorkdirs(api);

        if (hasRecentlyCompletedLiveStream(targetConversationId)) {
          return;
        }

        const visibleConversationId = resolveVisibleConversationId(
          selectedHistoryIdRef.current,
          conversationIdRef.current,
        );
        const hasLocalDraft =
          pendingUploadedFilesRef.current.length > 0 ||
          (composerRef.current?.hasContent() ?? false);
        const hasRetainedLiveTranscript = hasRetainedConversationLiveStream(targetConversationId);
        if (
          visibleConversationId === targetConversationId &&
          !isHydrationBlocked(targetConversationId) &&
          !chatBusyRef.current &&
          !hasLocalDraft &&
          !hasRetainedLiveTranscript
        ) {
          void refreshVisibleConversationHistorySnapshot(targetConversationId, api, {
            allowIdle: true,
          });
        } else if (!hasRetainedLiveTranscript) {
          clearConversationLiveStream(targetConversationId);
        }
        return;
      }

      if (event.kind === "upsert") {
        recordProjectActivity(event.conversation.cwd, event.conversation.updated_at);
        maybeAdoptActiveDraftConversation(event.conversation);
      }

      const matchesCurrentHistoryScope =
        event.kind !== "upsert" ||
        historyConversationMatchesFilter(event.conversation, historyListFilterRef.current);
      updateHistoryItems((current) => {
        if (event.kind === "upsert" && !matchesCurrentHistoryScope) {
          return current.filter((item) => item.id !== targetConversationId);
        }
        return applyGatewayHistoryEvent(current, event, {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
        });
      });
      if (event.kind === "upsert" || event.kind === "delete" || event.kind === "idle") {
        void refreshHistoryWorkdirs(api);
      }
      setHistoryError(null);
      setRemoteRunningConversationIds((current) => {
        if (event.kind !== "delete" || !current.has(targetConversationId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(targetConversationId);
        remoteRunningConversationIdsRef.current = next;
        return next;
      });
      if (event.kind === "delete") {
        setRemoteRunningConversationRuntime((current) => {
          if (!current.has(targetConversationId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(targetConversationId);
          remoteRunningConversationRuntimeRef.current = next;
          return next;
        });
      }

      // Keep the current draft/selection stable: remote changes only refresh
      // the recent-conversations list unless they target the active row.
      if (event.kind === "delete") {
        optimisticTitleConversationIdsRef.current.delete(targetConversationId);
        unlockHistoryTitlePosition(targetConversationId);
        stopConversationEventStreamSubscription(targetConversationId);
        clearCompletedLiveStreamMarker(targetConversationId);
        clearConversationLiveStream(targetConversationId);
        if (
          conversationIdRef.current === targetConversationId ||
          selectedHistoryIdRef.current === targetConversationId
        ) {
          startNewConversation({
            workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
          });
        }
        return;
      }

      const visibleConversationId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      );
      const isRemoteConversationRunning =
        remoteRunningConversationIdsRef.current.has(targetConversationId);
      const hydrationBlocked = isHydrationBlocked(targetConversationId);
      const hasLocalDraft =
        pendingUploadedFilesRef.current.length > 0 || (composerRef.current?.hasContent() ?? false);
      if (
        event.kind === "upsert" &&
        visibleConversationId === targetConversationId &&
        !isRemoteConversationRunning &&
        hasRecentlyCompletedLiveStream(targetConversationId)
      ) {
        pendingHistoryRefreshAfterLiveCompletionRef.current.delete(targetConversationId);
        void refreshVisibleConversationHistorySnapshot(targetConversationId, api, {
          allowIdle: true,
        });
        return;
      }
      if (
        event.kind === "upsert" &&
        visibleConversationId === targetConversationId &&
        isRemoteConversationRunning &&
        !hydrationBlocked &&
        !localRunningConversationIdsRef.current.has(targetConversationId)
      ) {
        pendingHistoryRefreshAfterLiveCompletionRef.current.add(targetConversationId);
        subscribeVisibleConversationEventStream(targetConversationId, api);
        void refreshVisibleConversationHistorySnapshot(targetConversationId, api);
      }
      if (
        event.kind === "upsert" &&
        visibleConversationId === targetConversationId &&
        !isRemoteConversationRunning &&
        !hydrationBlocked &&
        !chatBusyRef.current &&
        !hasLocalDraft &&
        !hasRetainedConversationLiveStream(targetConversationId)
      ) {
        void refreshVisibleConversationHistorySnapshot(targetConversationId, api, {
          allowIdle: true,
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    api,
    activeWorkspaceProjectPath,
    subscribeVisibleConversationEventStream,
    clearAllCompletedLiveStreamMarkers,
    clearAllConversationLiveStreams,
    clearCompletedLiveStreamMarker,
    clearConversationLiveStream,
    getConversationAbortController,
    getHistoryPositionLockedConversationIds,
    handleTunnelManagerChatEvent,
    hasRecentlyCompletedLiveStream,
    hasRetainedConversationLiveStream,
    isAgentMode,
    maybeAdoptActiveDraftConversation,
    recordProjectActivity,
    refreshVisibleConversationHistorySnapshot,
    refreshHistoryWorkdirs,
    setRemoteConversationRunningState,
    stopAllConversationEventStreamSubscriptions,
    stopConversationEventStreamSubscription,
    unlockHistoryTitlePosition,
    updateHistoryItems,
  ]);

  useEffect(() => {
    if (!status?.online) {
      stopAllConversationEventStreamSubscriptions();
      return;
    }
    const visibleConversationId = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    if (visibleConversationId && remoteRunningConversationIdsRef.current.has(visibleConversationId)) {
      subscribeVisibleConversationEventStream(visibleConversationId, api);
    }
  }, [api, status?.online, stopAllConversationEventStreamSubscriptions, subscribeVisibleConversationEventStream]);

  async function selectHistory(
    conversationIdValue: string,
    currentApi = api,
    options?: {
      syncChat?: boolean;
      resetLiveStream?: boolean;
      clearLiveStream?: boolean;
      fullHistory?: boolean;
      scrollToBottom?: boolean;
    },
  ) {
    if (!currentApi) {
      return;
    }

    const loadSequence = invalidateHistoryLoad();
    const selectionRevision = markVisibleConversationRevision();
    const currentVisibleConversationId = conversationIdRef.current.trim();
    const previousSelectedHistoryId = selectedHistoryIdRef.current.trim();
    const isChangingSelectedHistory = previousSelectedHistoryId !== conversationIdValue;
    const isSwitchingVisibleConversation =
      currentVisibleConversationId !== "" && currentVisibleConversationId !== conversationIdValue;
    if (options?.scrollToBottom) {
      pendingDisplayedConversationAutoBottomRef.current = conversationIdValue;
    }
    if (options?.syncChat && isSwitchingVisibleConversation) {
      cacheVisibleConversationRuntime(currentVisibleConversationId);
    }

    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = conversationIdValue;
    selectedHistoryIdRef.current = conversationIdValue;
    setSelectedHistoryId(conversationIdValue);
    if (isChangingSelectedHistory) {
      setSelectedHistory(null);
      setSelectedHistoryEntries([]);
    }

    if (options?.resetLiveStream) {
      clearConversationLiveStream(conversationIdValue);
    }

    setHistoryDetailLoading(true);
    try {
      const detail = await currentApi.getHistory(
        conversationIdValue,
        options?.fullHistory ? undefined : { maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES },
      );
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      setSelectedHistory(detail);
      setSelectedHistoryEntries(entries);
      if (options?.syncChat) {
        const shouldPreserveLiveRuntime =
          isHydrationBlocked(detail.conversation_id) ||
          remoteRunningConversationIdsRef.current.has(detail.conversation_id);
        if (shouldPreserveLiveRuntime) {
          return;
        }
        if (options.clearLiveStream) {
          clearConversationLiveStream(conversationIdValue);
        }
        const currentRuntime =
          conversationIdRef.current.trim() === detail.conversation_id &&
          (selectedHistoryIdRef.current.trim() === "" ||
            selectedHistoryIdRef.current.trim() === detail.conversation_id)
            ? buildVisibleRuntimeEntry()
            : (conversationRuntimeCacheRef.current.get(detail.conversation_id) ??
              createConversationRuntimeEntry());
        const nextMessages = mergeHistorySnapshotEntries(currentRuntime.messages, entries, {
          isFullSnapshot: detail.has_more === false,
        });
        const nextRuntime = createConversationRuntimeEntry({
          messages: nextMessages,
          error: null,
          toolStatus: null,
          isSending: localRunningConversationIdsRef.current.has(detail.conversation_id),
          workdir: detail.conversation?.cwd,
        });
        conversationRuntimeCacheRef.current.set(detail.conversation_id, nextRuntime);
        const shouldSyncRuntime =
          conversationIdRef.current.trim() !== detail.conversation_id ||
          selectedHistoryIdRef.current.trim() !== detail.conversation_id ||
          nextRuntime.messages !== currentRuntime.messages ||
          nextRuntime.error !== currentRuntime.error ||
          nextRuntime.toolStatus !== currentRuntime.toolStatus ||
          nextRuntime.toolStatusIsCompaction !== currentRuntime.toolStatusIsCompaction ||
          nextRuntime.isSending !== currentRuntime.isSending ||
          nextRuntime.workdir !== currentRuntime.workdir;
        if (!shouldSyncRuntime) {
          return;
        }
        syncVisibleConversationRuntime(detail.conversation_id, nextRuntime);
      }
    } catch (error) {
      if (
        historyLoadSequenceRef.current !== loadSequence ||
        visibleConversationRevisionRef.current !== selectionRevision
      ) {
        return;
      }
      const message = asErrorMessage(error, "history detail request failed");
      const fallbackDetail = {
        conversation_id: conversationIdValue,
        messages_json: message,
        has_more: false,
      } satisfies HistoryDetail;
      const fallbackEntries: ChatEntry[] = [
        {
          id: `history-error-${conversationIdValue}`,
          kind: "error",
          text: message,
        },
      ];
      setSelectedHistory(fallbackDetail);
      setSelectedHistoryEntries(fallbackEntries);
      if (options?.syncChat) {
        if (isHydrationBlocked(conversationIdValue)) {
          return;
        }
        if (options.clearLiveStream) {
          clearConversationLiveStream(conversationIdValue);
        }
        const nextRuntime = createConversationRuntimeEntry({
          messages: fallbackEntries,
          error: message,
          toolStatus: null,
          isSending: localRunningConversationIdsRef.current.has(conversationIdValue),
          workdir: conversationRuntimeCacheRef.current.get(conversationIdValue)?.workdir,
        });
        conversationRuntimeCacheRef.current.set(conversationIdValue, nextRuntime);
        syncVisibleConversationRuntime(conversationIdValue, nextRuntime);
      }
    } finally {
      if (
        historyLoadSequenceRef.current === loadSequence &&
        visibleConversationRevisionRef.current === selectionRevision
      ) {
        setHistoryDetailLoading(false);
      }
    }
  }

  async function reloadHistory(currentApi = api, options?: ReloadHistoryOptions) {
    if (!currentApi) {
      return;
    }

    const silent = options?.silent === true;
    const loadingStartedAt = Date.now();
    if (!silent) {
      setHistoryListLoading(true);
      setHistoryError(null);
    }
    const requestScopeKey = historyScopeKeyRef.current;
    const requestFilter = historyListFilterRef.current;
    try {
      const response = await currentApi.listHistory(1, HISTORY_LIST_PAGE_SIZE, requestFilter);
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const runningConversations = normalizeRunningConversations(response.running_conversations);
      for (const runningConversation of runningConversations) {
        setRemoteConversationRunningState(runningConversation.conversation_id, true, {
          runId: runningConversation.run_id,
          workdir: runningConversation.cwd,
          firstSeq: runningConversation.first_seq,
          runEpoch: runningConversation.run_epoch,
          updatedAt: runningConversation.updated_at,
        });
      }
      for (const runningConversation of runningConversations) {
        subscribeVisibleConversationEventStream(runningConversation.conversation_id, currentApi);
      }
      const runningConversationIds = runningConversations.map((item) => item.conversation_id);
      const retainedConversationIds = new Set<string>([
        ...blockedHistoryHydrationConversationIdsRef.current,
        ...localRunningConversationIdsRef.current,
        ...remoteRunningConversationIdsRef.current,
        ...runningConversationIds,
      ]);
      for (const [id, store] of liveConversationStreamStoresRef.current) {
        if (store.getSnapshot().entries.length > 0) {
          retainedConversationIds.add(id);
        }
      }
      if (silent) {
        for (const item of historyItemsRef.current) {
          retainedConversationIds.add(item.id);
        }
      }
      const conversations = reconcileConversationSummaries(
        historyItemsRef.current,
        response.conversations,
        {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
          retainConversationIds: retainedConversationIds,
        },
      );
      const refreshedNextPage = response.conversations.length > 0 ? 2 : 1;
      const nextPage = silent
        ? Math.max(nextHistoryPageRef.current, refreshedNextPage)
        : refreshedNextPage;
      commitHistoryListState(conversations, response.total_count, nextPage);

      let adoptedPendingDraftConversationId = "";
      if (options?.adoptPendingDraftConversation === true) {
        for (const conversation of conversations) {
          if (maybeAdoptActiveDraftConversation(conversation)) {
            adoptedPendingDraftConversationId = conversation.id.trim();
            blockedHistoryHydrationConversationIdsRef.current.delete(adoptedPendingDraftConversationId);
            break;
          }
        }
      }

      if (options?.skipSelectionSync) {
        return;
      }

      const currentConversationId = conversationIdRef.current;
      const currentSelectedHistoryId = selectedHistoryIdRef.current;
      const currentChatMessages = chatMessagesRef.current;
      const currentSelectedHistory = selectedHistoryRef.current;
      const requestedPreferredConversationId = options?.preferredConversationId?.trim() ?? "";
      const requestedConversationId =
        requestedPreferredConversationId !== "" &&
        !isLocalDraftConversationId(requestedPreferredConversationId)
          ? requestedPreferredConversationId
          : adoptedPendingDraftConversationId || requestedPreferredConversationId;
      const protectedConversationId = protectedConversationRef.current.trim();
      const isProtectedDraftConversation = protectedConversationId === PROTECTED_DRAFT_CONVERSATION;
      const hadCurrentConversationInHistory =
        pickConversationSummary(historyItemsRef.current, currentConversationId) !== null;

      const currentSummary = pickConversationSummary(conversations, currentConversationId);
      const protectedConversationSummary =
        protectedConversationId && !isProtectedDraftConversation
          ? pickConversationSummary(conversations, protectedConversationId)
          : null;

      if (
        currentConversationId &&
        !isLocalDraftConversationId(currentConversationId) &&
        hadCurrentConversationInHistory &&
        currentSummary === null
      ) {
        startNewConversation({
          workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
        });
        return;
      }

      if (isProtectedDraftConversation) {
        return;
      }

      if (
        protectedConversationId &&
        protectedConversationSummary === null &&
        (requestedConversationId === "" || requestedConversationId === protectedConversationId) &&
        (currentConversationId === protectedConversationId ||
          currentSelectedHistoryId === protectedConversationId)
      ) {
        return;
      }

      const requestedConversationSummary =
        requestedConversationId !== ""
          ? pickConversationSummary(conversations, requestedConversationId)
          : null;
      const shouldKeepCurrentConversation =
        requestedConversationId !== "" &&
        requestedConversationSummary === null &&
        currentConversationId === requestedConversationId &&
        currentChatMessages.length > 0;

      if (shouldKeepCurrentConversation) {
        return;
      }

      const shouldKeepDraftConversation = hasLocalDraftConversation({
        conversationId: currentConversationId,
        selectedHistoryId: currentSelectedHistoryId,
        requestedConversationId,
        chatMessageCount: currentChatMessages.length,
        pendingUploadCount: pendingUploadedFilesRef.current.length,
        draftPinned: draftConversationPinnedRef.current,
      });
      if (shouldKeepDraftConversation) {
        return;
      }

      const isCurrentConversationRunning =
        currentConversationId !== "" &&
        localRunningConversationIdsRef.current.has(currentConversationId) &&
        (currentSelectedHistoryId === "" || currentSelectedHistoryId === currentConversationId) &&
        requestedConversationId === "";
      if (isCurrentConversationRunning) {
        return;
      }

      const preferredConversationId =
        requestedConversationSummary?.id ??
        protectedConversationSummary?.id ??
        (pickConversationSummary(conversations, currentSelectedHistoryId)
          ? currentSelectedHistoryId
          : pickConversationSummary(conversations, currentConversationId)
            ? currentConversationId
            : currentConversationId && currentChatMessages.length > 0
              ? ""
              : (conversations[0]?.id ?? ""));

      if (!preferredConversationId) {
        if (!currentConversationId) {
          setSelectedHistoryId("");
          setSelectedHistory(null);
          setSelectedHistoryEntries([]);
        }
        return;
      }

      setSelectedHistoryId(preferredConversationId);
      protectedConversationRef.current = preferredConversationId;

      const shouldSyncChat =
        options?.hydrateSelection === true ||
        ((currentConversationId === "" || isLocalDraftConversationId(currentConversationId)) &&
          currentChatMessages.length === 0);
      const shouldHydrateSelection =
        shouldSyncChat || currentSelectedHistory?.conversation_id !== preferredConversationId;

      if (shouldHydrateSelection) {
        await selectHistory(preferredConversationId, currentApi, {
          syncChat: shouldSyncChat,
          resetLiveStream: false,
          clearLiveStream:
            shouldSyncChat && !remoteRunningConversationIdsRef.current.has(preferredConversationId),
          scrollToBottom: shouldSyncChat,
        });
      }
    } catch (error) {
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const message = asErrorMessage(error, "history request failed");
      setHistoryError(message);
      if (silent) {
        return;
      }
      setSelectedHistory({
        conversation_id: "",
        messages_json: message,
      });
      setSelectedHistoryEntries([
        {
          id: "history-list-error",
          kind: "error",
          text: message,
        },
      ]);
    } finally {
      if (!silent && requestScopeKey === historyScopeKeyRef.current) {
        await waitForMinimumHistoryListLoading(loadingStartedAt);
        setHistoryListLoading(false);
      }
    }
  }

  const loadMoreHistory = useCallback(async () => {
    if (!api || historyListPageLoadingRef.current || !historyHasMoreRef.current) {
      return;
    }

    historyListPageLoadingRef.current = true;
    setHistoryListLoadingMore(true);
    const requestScopeKey = historyScopeKeyRef.current;
    const requestFilter = historyListFilterRef.current;
    try {
      const pageNumber = nextHistoryPageRef.current;
      const response = await api.listHistory(pageNumber, HISTORY_LIST_PAGE_SIZE, requestFilter);
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      const runningConversations = normalizeRunningConversations(response.running_conversations);
      for (const runningConversation of runningConversations) {
        setRemoteConversationRunningState(runningConversation.conversation_id, true, {
          runId: runningConversation.run_id,
          workdir: runningConversation.cwd,
          firstSeq: runningConversation.first_seq,
          runEpoch: runningConversation.run_epoch,
          updatedAt: runningConversation.updated_at,
        });
      }
      const retainConversationIds = new Set(historyItemsRef.current.map((item) => item.id));
      const conversations = reconcileConversationSummaries(
        historyItemsRef.current,
        response.conversations,
        {
          preserveTitleConversationIds: optimisticTitleConversationIdsRef.current,
          preserveUpdatedAtConversationIds: getHistoryPositionLockedConversationIds(),
          retainConversationIds,
        },
      );
      const nextPage = response.conversations.length === 0 ? pageNumber : pageNumber + 1;
      commitHistoryListState(conversations, response.total_count, nextPage);
      setHistoryError(null);
    } catch (error) {
      if (requestScopeKey !== historyScopeKeyRef.current) {
        return;
      }
      setHistoryError(asErrorMessage(error, "读取更多历史列表失败"));
    } finally {
      if (requestScopeKey === historyScopeKeyRef.current) {
        historyListPageLoadingRef.current = false;
        setHistoryListLoadingMore(false);
      }
    }
  }, [
    api,
    commitHistoryListState,
    getHistoryPositionLockedConversationIds,
    setRemoteConversationRunningState,
  ]);

  const recoverUnavailableActiveConversationStream = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const targetId = targetConversationId.trim();
      if (!currentApi || !targetId) {
        return;
      }

      const visibleConversationId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      const effectiveConversationId =
        !isLocalDraftConversationId(targetId) && targetId !== ""
          ? targetId
          : visibleConversationId !== "" && !isLocalDraftConversationId(visibleConversationId)
            ? visibleConversationId
            : targetId;

      clearConversationLiveStream(targetId);
      clearConversationStreamingState(targetId);
      if (effectiveConversationId !== targetId) {
        clearConversationLiveStream(effectiveConversationId);
        clearConversationStreamingState(effectiveConversationId);
      }

      if (!isLocalDraftConversationId(effectiveConversationId)) {
        recoverUnavailableConversationStream(effectiveConversationId, currentApi);
        return;
      }

      void reloadHistory(currentApi, {
        hydrateSelection: true,
        silent: true,
        adoptPendingDraftConversation: true,
      });
    },
    [
      api,
      clearConversationLiveStream,
      clearConversationStreamingState,
      recoverUnavailableConversationStream,
      reloadHistory,
    ],
  );

  const recoverCompletedVisibleConversationFromHistorySnapshot = useCallback(
    async (targetConversationId: string, currentApi = api) => {
      const result = await fetchVisibleHistoryGuarded(targetConversationId, currentApi);
      if (!result) return false;
      const { detail, entries, conversationId: conversationIdValue } = result;

      const liveStore = liveConversationStreamStoresRef.current.get(conversationIdValue);
      liveStore?.flush();
      const liveEntries = liveStore?.getSnapshot().entries ?? [];
      const currentEntries =
        conversationIdRef.current.trim() === conversationIdValue &&
        (selectedHistoryIdRef.current.trim() === "" ||
          selectedHistoryIdRef.current.trim() === conversationIdValue)
          ? chatMessagesRef.current
          : selectedHistoryIdRef.current.trim() === conversationIdValue
            ? selectedHistoryEntriesRef.current
            : (conversationRuntimeCacheRef.current.get(conversationIdValue)?.messages ?? []);

      if (
        !shouldHydrateRestoredConversationSnapshot({
          currentEntries,
          historyEntries: entries,
          liveEntries,
        })
      ) {
        return false;
      }

      const mergeOptions = { isFullSnapshot: detail.has_more === false };
      pendingHistoryRefreshAfterLiveCompletionRef.current.delete(conversationIdValue);
      blockedHistoryHydrationConversationIdsRef.current.delete(conversationIdValue);
      clearConversationLiveStream(conversationIdValue);
      clearConversationStreamingState(conversationIdValue);
      setHistoryDetailLoading(false);

      if (selectedHistoryIdRef.current.trim() === conversationIdValue) {
        selectedHistoryRef.current = detail;
        setSelectedHistory(detail);
        setSelectedHistoryEntries((current) =>
          mergeHistorySnapshotEntries(current, entries, mergeOptions),
        );
      }

      updateConversationRuntimeEntry(conversationIdValue, (current) => ({
        ...current,
        messages: mergeHistorySnapshotEntries(current.messages, entries, mergeOptions),
        error: null,
        toolStatus: null,
        toolStatusIsCompaction: false,
        isSending: false,
      }));
      pendingDisplayedConversationAutoBottomRef.current = conversationIdValue;
      return true;
    },
    [
      api,
      clearConversationLiveStream,
      clearConversationStreamingState,
      updateConversationRuntimeEntry,
    ],
  );

  const prepareChatRuntime = useCallback(
    async (
      reason: string,
      currentApi = api,
      timeoutMs = CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
    ): Promise<AgentStatus> => {
      if (!currentApi) {
        throw new Error("Gateway client is not ready.");
      }

      if (!chatRuntimePreparePromiseRef.current) {
        chatPreflightInFlightRef.current = true;
        chatRuntimePreparePromiseRef.current = currentApi
          .prepareChatRuntime(reason)
          .then((nextStatus) => {
            statusRef.current = nextStatus;
            setStatus(nextStatus);
            setStatusError(null);
            return nextStatus;
          })
          .catch((error) => {
            setStatusError(asErrorMessage(error, "status request failed"));
            throw error;
          })
          .finally(() => {
            chatRuntimePreparePromiseRef.current = null;
            chatPreflightInFlightRef.current = false;
          });
      }

      const preparePromise = chatRuntimePreparePromiseRef.current;
      if (!preparePromise) {
        throw new Error("Gateway chat runtime preparation did not start.");
      }
      if (timeoutMs <= 0) {
        return preparePromise;
      }

      let timeoutId: number | null = null;
      try {
        return await Promise.race([
          preparePromise,
          new Promise<AgentStatus>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              reject(new Error("Desktop chat runtime is recovering. Please retry shortly."));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      }
    },
    [api],
  );

  const recoverVisibleConversationAfterPageRestore = useCallback(
    (currentApi = api) => {
      if (!currentApi) {
        return;
      }

      if (
        chatPreflightInFlightRef.current ||
        chatStartInFlightRef.current ||
        submitInFlightRef.current
      ) {
        return;
      }

      const visibleConversationId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!visibleConversationId) {
        return;
      }

      const now = Date.now();
      const lastRefreshAt =
        restoredPageHistoryRefreshAtRef.current.get(visibleConversationId) ?? 0;
      if (now - lastRefreshAt < PAGE_RESTORE_HISTORY_REFRESH_THROTTLE_MS) {
        return;
      }
      restoredPageHistoryRefreshAtRef.current.set(visibleConversationId, now);

      if (isLocalDraftConversationId(visibleConversationId)) {
        void reloadHistory(currentApi, {
          preferredConversationId: visibleConversationId,
          hydrateSelection: true,
          silent: true,
          adoptPendingDraftConversation: true,
        });
        return;
      }

      const hasLocalRunningState =
        isHydrationBlocked(visibleConversationId) ||
        localRunningConversationIdsRef.current.has(visibleConversationId);
      const hasRetainedLiveStream = hasRetainedConversationLiveStream(visibleConversationId);
      const isRemoteRunning = remoteRunningConversationIdsRef.current.has(visibleConversationId);

      if (hasLocalRunningState || hasRetainedLiveStream || isRemoteRunning) {
        void recoverCompletedVisibleConversationFromHistorySnapshot(
          visibleConversationId,
          currentApi,
        ).then((hydrated) => {
          if (hydrated) {
            return;
          }
          if (remoteRunningConversationIdsRef.current.has(visibleConversationId)) {
            subscribeVisibleConversationEventStream(visibleConversationId, currentApi);
          }
        });
        return;
      }

      void refreshVisibleConversationHistorySnapshot(visibleConversationId, currentApi, {
        allowIdle: true,
      });
    },
    [
      api,
      subscribeVisibleConversationEventStream,
      getConversationAbortController,
      hasRetainedConversationLiveStream,
      recoverCompletedVisibleConversationFromHistorySnapshot,
      refreshVisibleConversationHistorySnapshot,
      reloadHistory,
    ],
  );
  const recoverVisibleConversationAfterPageRestoreRef = useRef(
    recoverVisibleConversationAfterPageRestore,
  );

  useEffect(() => {
    recoverVisibleConversationAfterPageRestoreRef.current =
      recoverVisibleConversationAfterPageRestore;
  }, [recoverVisibleConversationAfterPageRestore]);

  useEffect(() => {
    if (!api || !status?.online) {
      return;
    }
    if (chatPreflightInFlightRef.current || chatStartInFlightRef.current) {
      return;
    }

    const currentConversationId = conversationIdRef.current.trim();
    const shouldKeepNewConversation =
      chatMessagesRef.current.length === 0 &&
      selectedHistoryIdRef.current.trim() === "" &&
      (currentConversationId === "" || isLocalDraftConversationId(currentConversationId));

    void reloadHistory(api, {
      skipSelectionSync: shouldKeepNewConversation,
      hydrateSelection:
        !shouldKeepNewConversation &&
        chatMessagesRef.current.length === 0 &&
        (currentConversationId === "" || isLocalDraftConversationId(currentConversationId)),
    });
  }, [api, historyScopeKey, status?.online]);

  useEffect(() => {
    if (!api || historyShareToken || status?.online !== true) {
      return;
    }

    let delayedRestoreTimer: number | null = null;
    const runRecovery = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void prepareChatRuntime(
        "foreground",
        api,
        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
      )
        .catch(() => undefined)
        .finally(() => {
          recoverVisibleConversationAfterPageRestoreRef.current(api);
          if (delayedRestoreTimer !== null) {
            window.clearTimeout(delayedRestoreTimer);
          }
          delayedRestoreTimer = window.setTimeout(() => {
            delayedRestoreTimer = null;
            recoverVisibleConversationAfterPageRestoreRef.current(api);
          }, PAGE_RESTORE_HISTORY_REFRESH_THROTTLE_MS + 350);
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        runRecovery();
      }
    };

    window.addEventListener("pageshow", runRecovery);
    window.addEventListener("focus", runRecovery);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("resume", runRecovery);
    runRecovery();

    return () => {
      if (delayedRestoreTimer !== null) {
        window.clearTimeout(delayedRestoreTimer);
      }
      window.removeEventListener("pageshow", runRecovery);
      window.removeEventListener("focus", runRecovery);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("resume", runRecovery);
    };
  }, [api, historyShareToken, prepareChatRuntime, status?.online]);

  useEffect(() => {
    if (!api || historyShareToken || status?.online !== true) {
      return;
    }

    const keepWarm = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void prepareChatRuntime(
        "keep-warm",
        api,
        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
      ).catch(() => undefined);
    };

    keepWarm();
    const intervalId = window.setInterval(keepWarm, CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [api, historyShareToken, prepareChatRuntime, status?.online]);

  async function sendChat(message: string, options?: SendChatOptions) {
    if (!api || chatBusyRef.current) {
      return;
    }

    const uploadedFiles = options?.uploadedFiles ?? [];
    let activeConversationId = options?.conversationId?.trim() || conversationIdRef.current.trim();
    if (!activeConversationId) {
      activeConversationId = createLocalDraftConversationId();
      conversationIdRef.current = activeConversationId;
      selectedHistoryIdRef.current = activeConversationId;
      setConversationId(activeConversationId);
      setSelectedHistoryId(activeConversationId);
    }
    const startedAsDraftConversation = isLocalDraftConversationId(activeConversationId);
    const pendingDraft = getPendingDraftId();
    if (pendingDraft && pendingDraft !== activeConversationId) {
      const message = "上一条新会话仍在创建，请等待它出现在历史记录后再发送新会话。";
      updateConversationRuntimeEntry(activeConversationId, (current) => ({
        ...current,
        error: message,
      }));
      return;
    }
    if (
      chatStartLocksRef.current.has(activeConversationId) ||
      getConversationAbortController(activeConversationId) !== null ||
      localRunningConversationIdsRef.current.has(activeConversationId)
    ) {
      return;
    }
    clearCachedComposerDraft(activeConversationId);
    const lockedConversationIds = new Set<string>([activeConversationId]);
    chatStartLocksRef.current.add(activeConversationId);

    // Committing a retained live reply moves it from the live section into the
    // virtualized history list. For the visible conversation, run that move as
    // one synchronous, scroll-compensated commit — otherwise the virtualizer
    // paints a frame with estimated row heights and the transcript visibly
    // jumps right as the prompt is sent.
    const retainedLiveEntryCount =
      liveConversationStreamStoresRef.current.get(activeConversationId)?.getSnapshot().entries
        .length ?? 0;
    const isVisibleConversationAtSend =
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
      activeConversationId;
    if (retainedLiveEntryCount > 0 && isVisibleConversationAtSend) {
      preserveTranscriptScrollPosition(
        () => {
          flushSync(() => {
            commitConversationLiveStreamToRuntime(activeConversationId, {
              clearLiveStream: true,
            });
          });
        },
        { stickToBottom: isTranscriptAtBottom() },
      );
    } else {
      commitConversationLiveStreamToRuntime(activeConversationId, {
        clearLiveStream: true,
      });
    }
    getConversationLiveStreamStore(activeConversationId);
    const controller = new AbortController();
    setConversationAbortController(activeConversationId, controller);
    const clientRequestId =
      options?.clientRequestId?.trim() ||
      `webui-chat-${activeConversationId}-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const persistedConversationWorkdir =
      pickConversationSummary(historyItemsRef.current, activeConversationId)?.cwd?.trim() || "";
    const runtimeConversationWorkdir =
      conversationRuntimeCacheRef.current.get(activeConversationId)?.workdir?.trim() || "";
    const effectiveWorkdir = isAgentMode
      ? options?.workdir?.trim() ||
        persistedConversationWorkdir ||
        runtimeConversationWorkdir ||
        activeWorkspaceProjectPath ||
        settings.system.workdir.trim()
      : "";
    const optimisticDraftTitle = buildOptimisticConversationTitle(message);
    draftConversationPinnedRef.current = false;
    pendingDraftConversationMigrationRef.current = startedAsDraftConversation
      ? {
          draftConversationId: activeConversationId,
          startedAt,
        }
      : null;
    protectedConversationRef.current = activeConversationId;
    blockedHistoryHydrationConversationIdsRef.current.add(activeConversationId);
    if (
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
      activeConversationId
    ) {
      stickTranscriptToBottom();
    }
    const optimisticUserEntryId =
      options?.optimisticUserEntryId?.trim() || `user-${crypto.randomUUID()}`;
    const shouldAppendOptimisticUserEntry = options?.skipOptimisticUserEntry !== true;
    updateConversationRuntimeEntry(activeConversationId, (current) => ({
      ...current,
      error: null,
      toolStatus: null,
      toolStatusIsCompaction: false,
      isSending: true,
      workdir: effectiveWorkdir || undefined,
      messages: shouldAppendOptimisticUserEntry
        ? [
            ...current.messages,
            {
              id: optimisticUserEntryId,
              kind: "user",
              text: message,
              attachments: uploadedFiles,
            },
          ]
        : current.messages,
    }));
    if (startedAsDraftConversation) {
      optimisticTitleConversationIdsRef.current.add(activeConversationId);
      updateHistoryItems((current) =>
        upsertConversationSummary(
          current,
          {
            id: activeConversationId,
            title: optimisticDraftTitle,
            created_at: startedAt,
            updated_at: startedAt,
            message_count: 1,
            provider_id: settings.selectedModel?.customProviderId ?? "gateway",
            model: settings.selectedModel?.model ?? "gateway",
            cwd: effectiveWorkdir || undefined,
          },
          { preserveExistingTitle: true },
        ),
      );
    }

    let terminalEventSeen = false;
    let queuedInGuiSeen = false;
    let recoverableTransportErrorSeen = false;
    let runActive = false;
    let runtimeStarted = false;
    let activeGatewayRunId = "";
    const preserveRemoteRunCleanupOptions = () => ({
      remoteRunId: activeGatewayRunId,
      preserveRemoteRunOnMismatch: true,
    });
    let runtimeStartingStatusTimer: number | null = null;
    const clearRuntimeStartingStatusTimer = () => {
      if (runtimeStartingStatusTimer === null) {
        return;
      }
      window.clearTimeout(runtimeStartingStatusTimer);
      runtimeStartingStatusTimer = null;
    };
    const clearRuntimeStartingStatus = () => {
      updateConversationRuntimeEntry(activeConversationId, (current) => {
        if (current.toolStatus !== CHAT_RUNTIME_STARTING_STATUS) {
          return current;
        }
        return {
          ...current,
          toolStatus: null,
          toolStatusIsCompaction: false,
        };
      });
    };
    const shouldShowRuntimeStartingStatus = () =>
      !isChatRuntimeReadyStatus(statusRef.current);
    const scheduleRuntimeStartingStatusTimer = () => {
      clearRuntimeStartingStatusTimer();
      if (!shouldShowRuntimeStartingStatus()) {
        return;
      }
      runtimeStartingStatusTimer = window.setTimeout(() => {
        runtimeStartingStatusTimer = null;
        if (
          runtimeStarted ||
          terminalEventSeen ||
          controller.signal.aborted ||
          !shouldShowRuntimeStartingStatus()
        ) {
          return;
        }
        updateConversationRuntimeEntry(activeConversationId, (current) => {
          if (!current.isSending || current.toolStatus) {
            return current;
          }
          return {
            ...current,
            toolStatus: CHAT_RUNTIME_STARTING_STATUS,
            toolStatusIsCompaction: false,
          };
        });
      }, CHAT_RUNTIME_STARTING_STATUS_DELAY_MS);
    };
    const markRunActive = () => {
      if (runActive) {
        return;
      }
      runActive = true;
      setConversationRunningState(activeConversationId, true);
    };
    const markRuntimeStarted = () => {
      if (runtimeStarted) {
        return;
      }
      runtimeStarted = true;
      clearRuntimeStartingStatusTimer();
      markRunActive();
      clearRuntimeStartingStatus();
    };
    const markRunPreparing = () => {
      markRunActive();
      updateConversationRuntimeEntry(activeConversationId, (current) => {
        if (!current.isSending || current.toolStatus) {
          return current;
        }
        return {
          ...current,
          toolStatus: CHAT_RUNTIME_PREPARING_STATUS,
          toolStatusIsCompaction: false,
        };
      });
    };
    const runtimeControls = normalizeChatRuntimeControlsForProvider(
      options?.runtimeControls ?? settings.chatRuntimeControls,
      {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      },
    );
    try {
      chatStartInFlightRef.current = true;
      scheduleRuntimeStartingStatusTimer();
      // The command request is itself the reliable wake-up signal for a suspended
      // desktop WebView. Keep the status refresh in the background so a stale
      // runtime heartbeat cannot block the request that would wake it.
      void prepareChatRuntime("send", api, CHAT_RUNTIME_PREPARE_TIMEOUT_MS)
        .then((nextStatus) => {
          statusRef.current = nextStatus;
          if (isChatRuntimeReadyStatus(nextStatus)) {
            clearRuntimeStartingStatusTimer();
            clearRuntimeStartingStatus();
          }
        })
        .catch(() => undefined);
      const gatewaySelectedModel = buildGatewaySelectedModel(settings.selectedModel, activeProviders);
      const gatewaySystemSettings = buildGatewaySystemSettings(settings, effectiveWorkdir);
      const targetConversationId = isLocalDraftConversationId(activeConversationId)
        ? undefined
        : activeConversationId;
      const chatStream = api.commandChat({
        type: options?.editMessageRef ? "chat.edit_resend" : "chat.submit",
        message,
        conversationId: targetConversationId,
        selectedModel: gatewaySelectedModel,
        systemSettings: gatewaySystemSettings,
        signal: controller.signal,
        uploadedFiles,
        clientRequestId,
        runtimeControls,
        baseMessageRef: options?.editMessageRef,
        queuePolicy: options?.queuePolicy ?? "auto",
      });
      for await (const event of chatStream) {
        const eventRunId = readGatewayChatEventRunId(event);
        if (eventRunId) {
          activeGatewayRunId = eventRunId;
        }
        if (event.conversation_id && event.conversation_id !== "") {
          const nextConversationId = event.conversation_id.trim();
          if (nextConversationId !== activeConversationId) {
            const previousConversationId = activeConversationId;
            if (
              pendingDraftConversationMigrationRef.current?.draftConversationId ===
              previousConversationId
            ) {
              pendingDraftConversationMigrationRef.current = null;
            }
            migrateConversation(previousConversationId, nextConversationId);
            activeConversationId = nextConversationId;
            lockedConversationIds.add(activeConversationId);
            if (runActive) {
              setConversationRunningState(previousConversationId, false);
              setConversationRunningState(activeConversationId, true);
            }
          }
          const summary = pickConversationSummary(historyItemsRef.current, activeConversationId);
          if (!summary && startedAsDraftConversation) {
            optimisticTitleConversationIdsRef.current.add(activeConversationId);
            updateHistoryItems((current) => {
              const existing = pickConversationSummary(current, activeConversationId);
              if (existing) {
                return current;
              }
              return upsertConversationSummary(
                current,
                {
                  id: activeConversationId,
                  title: optimisticDraftTitle,
                  created_at: startedAt,
                  updated_at: startedAt,
                  message_count: 1,
                  cwd: effectiveWorkdir || undefined,
                },
                { preserveExistingTitle: true },
              );
            });
          }
        }
        if (event.type === "runtime_snapshot") {
          markRuntimeStarted();
          const terminalSnapshot = applyChatRuntimeSnapshotEvent(event, activeConversationId, api);
          if (terminalSnapshot) {
            terminalEventSeen = true;
            clearRuntimeStartingStatusTimer();
            clearConversationStreamingState(
              activeConversationId,
              preserveRemoteRunCleanupOptions(),
            );
            break;
          }
          continue;
        }

        if (isChatControlEvent(event)) {
          if (event.type === "queued_in_gui" || event.state === "desktop_queued") {
            terminalEventSeen = true;
            queuedInGuiSeen = true;
            clearRuntimeStartingStatusTimer();
            clearConversationStreamingState(
              activeConversationId,
              preserveRemoteRunCleanupOptions(),
            );
            updateConversationRuntimeEntry(activeConversationId, (current) => ({
              ...current,
              messages: current.messages.filter((entry) => entry.id !== optimisticUserEntryId),
              error: null,
              toolStatus: null,
              toolStatusIsCompaction: false,
              isSending: false,
            }));
            const queueConversationId = event.conversation_id?.trim() || activeConversationId;
            void api
              .chatQueueGet(queueConversationId)
              .then((response) => applyChatQueueSnapshot(response.snapshot))
              .catch(() => undefined);
            return;
          }
          if (event.type === "user_message") {
            markRunPreparing();
            continue;
          }
          if (isTerminalChatControlEvent(event)) {
            terminalEventSeen = true;
            clearRuntimeStartingStatusTimer();
            if (event.type === "failed" || event.state === "failed") {
              getConversationLiveStreamStore(activeConversationId)?.appendEvent(event, {
                flush: true,
              });
            }
            finalizeTerminalLiveStream(
              activeConversationId,
              api,
              preserveRemoteRunCleanupOptions(),
            );
            break;
          } else if (isRuntimeStartedChatControlEvent(event)) {
            markRuntimeStarted();
            updateConversationRuntimeEntry(activeConversationId, (current) => ({
              ...current,
              toolStatus: VIBING_STATUS,
              toolStatusIsCompaction: false,
            }));
          } else if (isPreparingChatControlEvent(event)) {
            markRunPreparing();
          }
          continue;
        }
        markRuntimeStarted();
        if (isChatStreamNotAvailableEvent(event)) {
          terminalEventSeen = true;
          recoverUnavailableActiveConversationStream(activeConversationId, api);
          return;
        }
        if (event.type === "tool_status") {
          const normalizedStatus = normalizeOptionalStatus(event.status);
          const isCompaction = normalizedStatus !== null && event.isCompaction === true;
          getConversationLiveStreamStore(activeConversationId)?.setToolStatus(
            normalizedStatus,
            isCompaction,
          );
          updateConversationRuntimeEntry(activeConversationId, (current) => ({
            ...current,
            toolStatus: normalizedStatus,
            toolStatusIsCompaction: isCompaction,
          }));
        } else {
          const terminalEvent = isTerminalChatEvent(event);
          getConversationLiveStreamStore(activeConversationId)?.appendEvent(event, {
            flush: terminalEvent,
          });
          handleTunnelManagerChatEvent(event);
          if (terminalEvent) {
            terminalEventSeen = true;
            clearRuntimeStartingStatusTimer();
            const liveTitle = readChatEventTitle(event);
            if (liveTitle && isChatEventTitleFinal(event)) {
              applyLiveConversationTitle(
                event.conversation_id?.trim() || activeConversationId,
                liveTitle,
                { isFinal: true },
              );
            }
            finalizeTerminalLiveStream(
              activeConversationId,
              api,
              preserveRemoteRunCleanupOptions(),
            );
            break;
          }
        }
        const liveTitle = readChatEventTitle(event);
        if (liveTitle && isChatEventTitleFinal(event)) {
          applyLiveConversationTitle(
            event.conversation_id?.trim() || activeConversationId,
            liveTitle,
            { isFinal: true },
          );
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const message = asErrorMessage(error, "chat request failed");
        if (isChatStreamNotAvailableMessage(message)) {
          terminalEventSeen = true;
          recoverUnavailableActiveConversationStream(activeConversationId, api);
        } else if (
          isRecoverableChatStreamTransportMessage(message) &&
          (runActive ||
            runtimeStarted ||
            activeGatewayRunId !== "" ||
            remoteRunningConversationIdsRef.current.has(activeConversationId))
        ) {
          recoverableTransportErrorSeen = true;
          getConversationLiveStreamStore(activeConversationId)?.flush();
        } else {
          updateConversationRuntimeEntry(activeConversationId, (current) => ({
            ...current,
            error: message,
          }));
        }
      }
    } finally {
      clearRuntimeStartingStatusTimer();
      chatStartInFlightRef.current = false;
      clearConversationStreamingState(activeConversationId, {
        ...preserveRemoteRunCleanupOptions(),
        preserveRemoteRun: recoverableTransportErrorSeen,
      });
      if (remoteRunningConversationIdsRef.current.has(activeConversationId)) {
        subscribeVisibleConversationEventStream(activeConversationId, api);
      }
      if (status?.online && (!terminalEventSeen || queuedInGuiSeen)) {
        void reloadHistory(api, {
          preferredConversationId: activeConversationId,
          skipSelectionSync: true,
          silent: true,
        });
      }
      if (queuedInGuiSeen && status?.online) {
        const queuedConvId = activeConversationId;
        const delayedReload = () =>
          void reloadHistory(api, {
            preferredConversationId: queuedConvId,
            skipSelectionSync: true,
            silent: true,
          });
        setTimeout(delayedReload, 3000);
        setTimeout(delayedReload, 8000);
      }
      if (!options?.editMessageRef) {
        blockedHistoryHydrationConversationIdsRef.current.delete(activeConversationId);
      }
      if (
        pendingDraftConversationMigrationRef.current?.draftConversationId === activeConversationId
      ) {
        pendingDraftConversationMigrationRef.current = null;
        if (startedAsDraftConversation && isLocalDraftConversationId(activeConversationId)) {
          optimisticTitleConversationIdsRef.current.delete(activeConversationId);
          unlockHistoryTitlePosition(activeConversationId);
          updateHistoryItems((current) =>
            current.filter((item) => item.id !== activeConversationId),
          );
          if (
            conversationIdRef.current === activeConversationId ||
            selectedHistoryIdRef.current === activeConversationId
          ) {
            startNewConversation({
              workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
            });
          }
        }
      }
      for (const conversationIdValue of lockedConversationIds) {
        chatStartLocksRef.current.delete(conversationIdValue);
      }
    }
  }

  // Edit-resend is memoized across settings sync; always call the latest sender
  // so model and execution-mode overrides stay aligned with the visible WebUI state.
  sendChatRef.current = sendChat;

  async function cancelChat(targetConversationId?: string) {
    const activeConversationId = targetConversationId?.trim() || conversationIdRef.current.trim();
    if (!activeConversationId) {
      return;
    }
    const controller = getConversationAbortController(activeConversationId);
    const cancelRunId =
      conversationEventStreamsRef.current.get(activeConversationId)?.runId ??
      remoteRunningConversationRuntimeRef.current.get(activeConversationId)?.runId ??
      "";
    const isVisibleConversation =
      resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
      activeConversationId;
    const shouldKeepBottom = isVisibleConversation && isTranscriptAtBottom();
    const cancelRequest =
      !controller &&
      api &&
      activeConversationId !== "" &&
      !isLocalDraftConversationId(activeConversationId)
        ? api.cancelChat(activeConversationId, cancelRunId).catch((error) => {
            if (!isAbortError(error)) {
              updateConversationRuntimeEntry(activeConversationId, (current) => ({
                ...current,
                error: asErrorMessage(error, "cancel chat request failed"),
              }));
            }
          })
        : null;
    controller?.abort();
    stopConversationEventStreamSubscription(activeConversationId);
    if (isVisibleConversation) {
      preserveTranscriptScrollPosition(
        () => {
          flushSync(() => {
            commitConversationLiveStreamToRuntime(activeConversationId, {
              clearLiveStream: false,
            });
            clearConversationStreamingState(activeConversationId);
          });
        },
        { stickToBottom: shouldKeepBottom },
      );
      if (shouldKeepBottom) {
        stickTranscriptToBottom();
      } else {
        refreshTranscriptScrollState();
      }
    } else {
      clearConversationStreamingState(activeConversationId);
    }
    if (cancelRequest) {
      await cancelRequest;
    }
  }

  async function materializeComposerDraftForSend(
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
  ) {
    let text = (
      isAgentMode && draft.largePastes.length > 0
        ? draft.textWithoutLargePastes
        : buildTextFromComposerDraft(draft)
    ).trim();
    let uploadedFiles = files;

    if (isAgentMode && draft.largePastes.length > 0) {
      setChatError(null);
      isImportingPastedTextRef.current = true;
      setIsUploadingFiles(true);
      try {
        const imported = await importPastedTextsAsFiles({
          token,
          workdir,
          pastes: draft.largePastes,
        });
        text = buildTextFromComposerDraft(draft, imported.fileByPasteId).trim();
        uploadedFiles = mergePendingUploadedFiles(files, imported.files);
      } finally {
        isImportingPastedTextRef.current = false;
        setIsUploadingFiles(false);
      }
    }

    return { text, uploadedFiles };
  }

  function clearCurrentComposerDraftForQueuedTurn(conversationId: string) {
    const key = conversationId.trim();
    if (!key || getDisplayedConversationId() !== key) {
      return;
    }
    composerRef.current?.clear();
    setPendingUploadsForConversation(key, []);
    clearCachedComposerDraft(key);
  }

  async function submitCurrentComposerToGuiQueue(queuePolicy: "append" | "interrupt") {
    const conversationIdValue = getDisplayedConversationId();
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    let clearedComposer = false;
    if (!api || !conversationIdValue || !queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }

    const cachedRuntime = conversationRuntimeCacheRef.current.get(conversationIdValue);
    const workdirForTurn = (
      cachedRuntime?.workdir ??
      displayedConversationWorkdirRef.current ??
      activeWorkspaceProjectPath ??
      settings.system.workdir
    ).trim();
    try {
      const materialized = await materializeComposerDraftForSend(draft, uploadedFiles, workdirForTurn);
      if (!materialized.text && materialized.uploadedFiles.length === 0) {
        return false;
      }
      clearCurrentComposerDraftForQueuedTurn(conversationIdValue);
      clearedComposer = true;
      const gatewaySelectedModel = buildGatewaySelectedModel(settings.selectedModel, activeProviders);
      const gatewaySystemSettings = buildGatewaySystemSettings(settings, workdirForTurn);
      const stream = api.commandChat({
        type: "chat.submit",
        message: materialized.text,
        conversationId: isLocalDraftConversationId(conversationIdValue)
          ? undefined
          : conversationIdValue,
        selectedModel: gatewaySelectedModel,
        systemSettings: gatewaySystemSettings,
        uploadedFiles: materialized.uploadedFiles,
        runtimeControls: chatRuntimeControlsForCurrentProvider,
        queuePolicy,
      });
      for await (const event of stream) {
        if (event.type === "queued_in_gui" || ("state" in event && event.state === "desktop_queued")) {
          const queueConversationId = event.conversation_id?.trim() || conversationIdValue;
          void api
            .chatQueueGet(queueConversationId)
            .then((response) => applyChatQueueSnapshot(response.snapshot))
            .catch(() => undefined);
          return true;
        }
        if (event.type === "failed" || event.type === "error") {
          throw new Error("message" in event && typeof event.message === "string" ? event.message : "queue request failed");
        }
        if (event.type === "started" || ("state" in event && event.state === "running")) {
          return true;
        }
      }
      return true;
    } catch (error) {
      if (clearedComposer && getDisplayedConversationId() === conversationIdValue) {
        if (!composerRef.current?.hasContent()) {
          composerRef.current?.setDraft(draft);
        }
        if ((pendingUploadsByConversationRef.current.get(conversationIdValue) ?? []).length === 0) {
          setPendingUploadsForConversation(conversationIdValue, uploadedFiles);
        }
      }
      updateConversationRuntimeEntry(conversationIdValue, (current) => ({
        ...current,
        error: asErrorMessage(error, "queued chat request failed"),
      }));
      return false;
    }
  }

  async function commitQueuedChatEdit() {
    const session = queuedChatEditSessionRef.current;
    const conversationIdValue = getDisplayedConversationId();
    if (!session || !api || !conversationIdValue) return false;
    const draft = composerRef.current?.getDraft() ?? null;
    const uploadedFiles = pendingUploadedFiles.slice();
    if (!queuedChatTurnHasContent(draft, uploadedFiles)) {
      return false;
    }
    try {
      const response = await api.chatQueueEditCommit({
        conversationId: conversationIdValue,
        itemId: session.itemId,
        revision: session.revision,
        draftJson: JSON.stringify(draft),
        uploadedFilesJson: JSON.stringify(uploadedFiles),
      });
      if (!response.accepted) {
        updateConversationRuntimeEntry(conversationIdValue, (current) => ({
          ...current,
          error: response.message || "queued edit failed",
        }));
        return false;
      }
      queuedChatEditSessionRef.current = null;
      composerRef.current?.clear();
      setPendingUploadsForConversation(conversationIdValue, []);
      clearCachedComposerDraft(conversationIdValue);
      applyChatQueueSnapshot(response.snapshot);
      return true;
    } catch (error) {
      updateConversationRuntimeEntry(conversationIdValue, (current) => ({
        ...current,
        error: asErrorMessage(error, "queued edit failed"),
      }));
      return false;
    }
  }

  function reportChatQueueActionError(
    conversationId: string,
    error: unknown,
    fallback: string,
  ) {
    const key = conversationId.trim();
    if (!key) return;
    updateConversationRuntimeEntry(key, (current) => ({
      ...current,
      error: asErrorMessage(error, fallback),
    }));
  }

  function runQueuedTurnNow(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueRunNow(conversationIdValue, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
        for (const delayMs of [250, 1000]) {
          window.setTimeout(() => {
            void api
              .chatQueueGet(conversationIdValue)
              .then((nextResponse) => applyChatQueueSnapshot(nextResponse.snapshot))
              .catch(() => undefined);
          }, delayMs);
        }
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat run failed");
      });
  }

  function moveQueuedTurnUp(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueMove(conversationIdValue, id, "up")
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat move failed");
      });
  }

  function editQueuedTurn(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void (async () => {
      if (queuedChatEditSessionRef.current) {
        const committed = await commitQueuedChatEdit();
        if (!committed) return;
      } else {
        const currentDraft = composerRef.current?.getDraft() ?? null;
        const currentUploads = pendingUploadedFiles.slice();
        if (queuedChatTurnHasContent(currentDraft, currentUploads)) {
          const queued = await submitCurrentComposerToGuiQueue("append");
          if (!queued) return;
        }
      }

      const response = await api.chatQueueEditBegin(conversationIdValue, id);
      try {
        if (!response.accepted || !response.item) {
          if (!response.accepted) {
            updateConversationRuntimeEntry(conversationIdValue, (current) => ({
              ...current,
              error: response.message || "queued edit failed",
            }));
          }
          return;
        }
        const draft = JSON.parse(response.item.draftJson) as MentionComposerDraft;
        const uploadedFiles = JSON.parse(
          response.item.uploadedFilesJson,
        ) as PendingUploadedFile[];
        queuedChatEditSessionRef.current = {
          itemId: response.item.id,
          revision: response.snapshot?.revision ?? chatQueueRevisionRef.current,
        };
        composerRef.current?.setDraft(draft);
        setPendingUploadsForConversation(
          conversationIdValue,
          Array.isArray(uploadedFiles) ? uploadedFiles : [],
        );
        clearCachedComposerDraft(conversationIdValue);
        applyChatQueueSnapshot(response.snapshot);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      } catch (error) {
        throw new Error(asErrorMessage(error, "invalid queued edit payload"));
      }
    })().catch((error) => {
      reportChatQueueActionError(conversationIdValue, error, "queued chat edit failed");
    });
  }

  function removeQueuedTurn(id: string) {
    const conversationIdValue = getDisplayedConversationId();
    if (!api || !conversationIdValue) return;
    void api
      .chatQueueRemove(conversationIdValue, id)
      .then((response) => {
        applyChatQueueSnapshot(response.snapshot);
      })
      .catch((error) => {
        reportChatQueueActionError(conversationIdValue, error, "queued chat remove failed");
      });
  }

  function startNewConversation(options?: { workdir?: string }) {
    const currentConversationId = conversationIdRef.current.trim();
    if (currentConversationId) {
      cacheVisibleConversationRuntime(currentConversationId);
      optimisticTitleConversationIdsRef.current.delete(currentConversationId);
      stopConversationEventStreamSubscription(currentConversationId);
      clearCachedComposerDraft(currentConversationId);
    }
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    setHistorySwitchOverlay(null);
    setHistoryDetailLoading(false);
    const nextConversationId = createLocalDraftConversationId();
    draftConversationPinnedRef.current = true;
    protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    chatStartLocksRef.current.clear();
    submitInFlightRef.current = false;
    const pendingDraft = getPendingDraftId();
    const pendingDraftStillActive =
      pendingDraft !== "" &&
      (localRunningConversationIdsRef.current.has(pendingDraft) ||
        isHydrationBlocked(pendingDraft));
    if (!pendingDraftStillActive) {
      pendingDraftConversationMigrationRef.current = null;
    }
    composerRef.current?.clear();
    const nextRuntime = createConversationRuntimeEntry({
      workdir: options?.workdir?.trim() || undefined,
    });
    conversationRuntimeCacheRef.current.set(nextConversationId, nextRuntime);
    syncVisibleConversationRuntime(nextConversationId, nextRuntime);
    setSelectedHistory(null);
    setSelectedHistoryEntries([]);
    setPendingUploadsForConversation(nextConversationId, []);
  }

  const removeWorkspaceProjectFromSettings = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const path = project.path.trim();
      const pathKey = workspaceProjectPathKey(path);
      setActiveWorkspaceProjectId((current) => {
        const currentProject = workspaceProjects.find((item) => item.id === current);
        if (
          current === project.id ||
          (pathKey && currentProject && workspaceProjectPathKey(currentProject.path) === pathKey)
        ) {
          return DEFAULT_WORKSPACE_PROJECT_ID;
        }
        return current;
      });
      setSettings((prev) => {
        const nextHidden =
          pathKey &&
          prev.system.hiddenWorkspaceProjectPaths.some(
            (item) => workspaceProjectPathKey(item) === pathKey,
          )
            ? prev.system.hiddenWorkspaceProjectPaths
            : path
              ? [...prev.system.hiddenWorkspaceProjectPaths, path]
              : prev.system.hiddenWorkspaceProjectPaths;
        const nextSettings = {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects: prev.system.workspaceProjects.filter(
                (item) => item.id !== project.id && workspaceProjectPathKey(item.path) !== pathKey,
              ),
              hiddenWorkspaceProjectPaths: nextHidden,
              missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
                (item) => workspaceProjectPathKey(item) !== pathKey,
              ),
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
        return removeRightDockProjectState(nextSettings, pathKey);
      });
      setProjectRenamingId((current) => (current === project.id ? null : current));
      setProjectRenameDraft("");
    },
    [setSettings, workspaceProjects],
  );

  const handleRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;

      void (async () => {
        const currentApi = api;
        if (!currentApi) {
          setHistoryError("Gateway 未连接，暂时不能删除项目会话。");
          return;
        }

        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        const projectHasRunningConversation = () => {
          if (!pathKey) return false;
          const runningIds = new Set<string>();
          for (const id of localRunningConversationIdsRef.current) {
            const conversationId = id.trim();
            if (conversationId) runningIds.add(conversationId);
          }
          for (const id of remoteRunningConversationIdsRef.current) {
            const conversationId = id.trim();
            if (conversationId) runningIds.add(conversationId);
          }

          for (const conversationId of runningIds) {
            const runtimeWorkdir =
              conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
            const persistedWorkdir =
              historyItemsRef.current.find((item) => item.id === conversationId)?.cwd?.trim() || "";
            if (workspaceProjectPathKey(runtimeWorkdir || persistedWorkdir) === pathKey) {
              return true;
            }
          }
          return false;
        };

        if (projectHasRunningConversation()) {
          setHistoryError(runningMessage);
          return;
        }

        setHistoryError(null);
        setHistoryMutating(true);
        try {
          const conversationIds: string[] = [];
          const seenConversationIds = new Set<string>();
          if (path) {
            for (let pageNumber = 1; ; pageNumber += 1) {
              const page = await currentApi.listHistory(
                pageNumber,
                PROJECT_HISTORY_DELETE_PAGE_SIZE,
                { cwd: path },
              );
              for (const item of page.conversations) {
                const id = item.id.trim();
                if (!id || seenConversationIds.has(id)) continue;
                seenConversationIds.add(id);
                conversationIds.push(id);
              }

              if (
                page.conversations.length === 0 ||
                conversationIds.length >= page.total_count ||
                page.conversations.length < PROJECT_HISTORY_DELETE_PAGE_SIZE
              ) {
                break;
              }
            }
          }

          const runningConversationIdsInProject = conversationIds.filter(
            (id) =>
              localRunningConversationIdsRef.current.has(id) ||
              remoteRunningConversationIdsRef.current.has(id),
          );
          if (runningConversationIdsInProject.length > 0 || projectHasRunningConversation()) {
            setHistoryError(runningMessage);
            return;
          }

          let terminalSessionsToClose: TerminalSession[] = [];
          const pruneProjectTerminalSessions = () => {
            terminalSessionsVersionRef.current += 1;
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          };
          if (
            terminalClient &&
            (settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal) &&
            pathKey
          ) {
            terminalSessionsToClose = await terminalClient.list(pathKey);
            const runningTerminalCount = terminalSessionsToClose.filter(
              (session) => session.running,
            ).length;
            if (runningTerminalCount > 0) {
              const confirmed = await requestConfirmDialog({
                title: translate("chat.workspaceRemoveConfirm", settings.locale).replace(
                  "{name}",
                  project.name,
                ),
                subtitle: translate("chat.workspaceRemoveDescription", settings.locale),
                description: (
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                      <Terminal className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {translate("chat.exitConfirmRunningLabel", settings.locale)}
                        </span>
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                          {runningTerminalCount}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                        {translate("chat.workspaceRemoveTerminalDescription", settings.locale)}
                      </p>
                    </div>
                  </div>
                ),
                confirmLabel: translate("chat.workspaceRemoveConfirmContinue", settings.locale),
                cancelLabel: translate("chat.cancel", settings.locale),
                closeLabel: translate("chat.workspaceRemoveConfirmClose", settings.locale),
                tone: "warning",
              });
              if (!confirmed) {
                return;
              }
            }
          }

          const visibleConversationId = resolveVisibleConversationId(
            selectedHistoryIdRef.current,
            conversationIdRef.current,
          );
          const visibleRuntimeWorkdir =
            conversationRuntimeCacheRef.current.get(visibleConversationId)?.workdir?.trim() || "";
          const visiblePersistedWorkdir =
            historyItemsRef.current
              .find((item) => item.id === visibleConversationId)
              ?.cwd?.trim() || "";
          const visibleWorkdir =
            visiblePersistedWorkdir ||
            visibleRuntimeWorkdir ||
            (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");

          for (const conversationId of conversationIds) {
            await currentApi.deleteHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            updateHistoryItems((current) =>
              current.filter((item) => !deletedConversationIds.has(item.id)),
            );
            const nextSharedItems = sharedHistoryItemsRef.current.filter(
              (item) => !deletedConversationIds.has(item.id),
            );
            sharedHistoryItemsRef.current = nextSharedItems;
            setSharedHistoryItems(nextSharedItems);

            for (const conversationId of deletedConversationIds) {
              optimisticTitleConversationIdsRef.current.delete(conversationId);
              unlockHistoryTitlePosition(conversationId);
              conversationRuntimeCacheRef.current.delete(conversationId);
              conversationAbortControllersRef.current.delete(conversationId);
              blockedHistoryHydrationConversationIdsRef.current.delete(conversationId);
              clearConversationLiveStream(conversationId);
              clearCachedComposerDraft(conversationId);
              pendingUploadsByConversationRef.current.delete(conversationId);
            }
          }
          if (terminalSessionsToClose.length > 0 && terminalClient) {
            await terminalClient.closeProject(pathKey);
            pruneProjectTerminalSessions();
          }
          if (pathKey && workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
            setRightDockOpen(false);
            if (terminalSessionsToClose.length === 0) {
              pruneProjectTerminalSessions();
            }
          }

          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(visibleWorkdir) === pathKey);

          if (path) {
            await memoryDeleteProject({
              workdir: path,
              actor: "tool",
              reason: "workspace project removed",
            });
          }
          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversation({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
          void refreshHistoryWorkdirs(currentApi);
        } catch (error) {
          setHistoryError(asErrorMessage(error, "删除项目失败"));
        } finally {
          setHistoryMutating(false);
        }
      })();
    },
    [
      activeWorkspaceProjectPath,
      api,
      clearCachedComposerDraft,
      clearConversationLiveStream,
      isAgentMode,
      refreshHistoryWorkdirs,
      removeWorkspaceProjectFromSettings,
      requestConfirmDialog,
      settings.remote.enableWebSshTerminal,
      settings.remote.enableWebTerminal,
      settings.locale,
      settings.system,
      startNewConversation,
      terminalClient,
      unlockHistoryTitlePosition,
      updateHistoryItems,
    ],
  );

  function handleSidebarNewConversation() {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setActiveView("chat");
    const visibleConversationId = getVisibleComposerConversationId();
    if (
      activeView !== "chat" &&
      (visibleConversationId === "" || isLocalDraftConversationId(visibleConversationId))
    ) {
      return;
    }
    startNewConversation({
      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
    });
  }

  function handleSidebarSelectConversation(id: string) {
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    setActiveView("chat");

    const targetConversationId = id.trim();
    if (!targetConversationId) {
      return;
    }
    setHistorySwitchOverlay({
      conversationId: targetConversationId,
      startedAt: Date.now(),
    });

    const currentConversationId = conversationIdRef.current.trim();
    if (currentConversationId && currentConversationId !== targetConversationId) {
      cacheVisibleConversationRuntime(currentConversationId);
    }

    pendingDisplayedConversationAutoBottomRef.current = targetConversationId;

    const cachedRuntime = conversationRuntimeCacheRef.current.get(targetConversationId);
    if (cachedRuntime) {
      protectedConversationRef.current = targetConversationId;
      syncVisibleConversationRuntime(targetConversationId, cachedRuntime);
    }
    if (
      cachedRuntime &&
      (cachedRuntime.isSending || localRunningConversationIdsRef.current.has(targetConversationId))
    ) {
      invalidateHistoryLoad();
      markVisibleConversationRevision();
      setHistoryDetailLoading(false);
      setSelectedHistory(null);
      setSelectedHistoryEntries([]);
      return;
    }

    const isRemoteRunning = remoteRunningConversationIdsRef.current.has(targetConversationId);
    void selectHistory(targetConversationId, api, {
      syncChat: true,
      resetLiveStream: false,
      clearLiveStream: !isRemoteRunning,
      scrollToBottom: true,
    });
  }

  function handleSidebarOpenSkillsHub() {
    setRightDockOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("skills-hub");
  }

  function handleSidebarOpenMcpHub() {
    setRightDockOpen(false);
    if (isMobileSidebarLayout()) {
      setSidebarOpen(false);
    }
    cacheVisibleComposerDraft();
    setActiveView("mcp-hub");
  }

  function handleOpenShareModal(item: ChatHistorySummary) {
    setShareConversation(item);
    setShareStatus(null);
    setShareError(null);
    if (!api) {
      setShareError("Gateway 尚未连接，无法读取分享状态。");
      return;
    }

    setShareLoading(true);
    void api
      .getHistoryShare(item.id)
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, "读取分享状态失败"));
      })
      .finally(() => {
        setShareLoading(false);
      });
  }

  function handleCloseShareModal() {
    setShareConversation(null);
    setShareStatus(null);
    setShareError(null);
    setShareLoading(false);
    setShareUpdating(false);
  }

  function handleToggleHistoryShare(enabled: boolean, options?: { redactToolContent?: boolean }) {
    const item = shareConversation;
    if (!api || !item) {
      return;
    }

    setShareError(null);
    setShareUpdating(true);
    void api
      .setHistoryShare(item.id, enabled, options)
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, enabled ? "开启分享失败" : "关闭分享失败"));
      })
      .finally(() => {
        setShareUpdating(false);
      });
  }

  function handleSetShareRedactToolContent(redactToolContent: boolean) {
    const item = shareConversation;
    if (!api || !item) {
      return;
    }

    setShareError(null);
    setShareUpdating(true);
    void api
      .setHistoryShare(item.id, true, { redactToolContent })
      .then((status) => {
        setShareStatus(status);
        setSharedManagerStatuses((current) => ({ ...current, [item.id]: status }));
        markSharedConversation(item.id, status.enabled === true, item);
      })
      .catch((error) => {
        setShareError(asErrorMessage(error, "更新分享脱敏设置失败"));
      })
      .finally(() => {
        setShareUpdating(false);
      });
  }

  function updateSharedManagerIdSet(
    setter: (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
    id: string,
    enabled: boolean,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function setSharedManagerError(id: string, message: string | null) {
    setSharedManagerErrors((current) => {
      const next = { ...current };
      if (message) {
        next[id] = message;
      } else {
        delete next[id];
      }
      return next;
    });
  }

  const setSharedHistoryItemsState = useCallback((items: ChatHistorySummary[]) => {
    const nextItems = sortHistoryItems(items.map((item) => ({ ...item, isShared: true })));
    sharedHistoryItemsRef.current = nextItems;
    setSharedHistoryItems(nextItems);
  }, []);

  const refreshSharedHistoryItems = useCallback(
    async (currentApi = api) => {
      if (!currentApi) {
        setSharedHistoryItemsState([]);
        return [];
      }
      if (sharedHistoryListRequestRef.current) {
        return sharedHistoryListRequestRef.current;
      }

      const request = (async () => {
        const byId = new Map<string, ChatHistorySummary>();
        let totalCount = 0;
        for (let pageNumber = 1; ; pageNumber += 1) {
          const response = await currentApi.listSharedHistory(
            pageNumber,
            SHARED_HISTORY_LIST_PAGE_SIZE,
          );
          totalCount = Math.max(0, response.total_count);
          for (const conversation of response.conversations) {
            const item = toChatHistorySummary(conversation, settings.selectedModel);
            byId.set(item.id, { ...item, isShared: true });
          }
          if (response.conversations.length === 0 || byId.size >= totalCount) {
            break;
          }
        }

        const nextItems = Array.from(byId.values());
        setSharedHistoryItemsState(nextItems);
        return sortHistoryItems(nextItems);
      })();

      sharedHistoryListRequestRef.current = request;
      try {
        return await request;
      } catch (error) {
        setHistoryError(asErrorMessage(error, "读取已分享历史列表失败"));
        return sharedHistoryItemsRef.current;
      } finally {
        if (sharedHistoryListRequestRef.current === request) {
          sharedHistoryListRequestRef.current = null;
        }
      }
    },
    [api, settings.selectedModel, setSharedHistoryItemsState],
  );

  useEffect(() => {
    if (!api) {
      setSharedHistoryItemsState([]);
      return;
    }
    void refreshSharedHistoryItems(api);
  }, [api, refreshSharedHistoryItems, setSharedHistoryItemsState]);

  function markSharedConversation(
    id: string,
    isShared: boolean,
    source?: ChatHistorySummary | null,
  ) {
    updateHistoryItems((current) =>
      current.map((conversation) =>
        conversation.id === id ? { ...conversation, is_shared: isShared } : conversation,
      ),
    );
    if (!isShared) {
      setSharedHistoryItemsState(sharedHistoryItemsRef.current.filter((item) => item.id !== id));
      return;
    }

    const sourceSummary = historyItemsRef.current.find((item) => item.id === id);
    const conversation =
      source ??
      (sourceSummary ? toChatHistorySummary(sourceSummary, settings.selectedModel) : null) ??
      sharedHistoryItemsRef.current.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    setSharedHistoryItemsState([
      { ...conversation, isShared: true },
      ...sharedHistoryItemsRef.current.filter((item) => item.id !== id),
    ]);
  }

  function handleLoadSharedHistoryStatus(item: ChatHistorySummary) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法读取分享状态。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerLoadingIds, id, true);
    void api
      .getHistoryShare(id)
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "读取分享状态失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerLoadingIds, id, false);
      });
  }

  function handleRefreshSharedHistoryStatuses() {
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }

  function handleOpenSharedHistoryManager() {
    setSharedManagerOpen(true);
    void refreshSharedHistoryItems().then((items) => {
      items.forEach(handleLoadSharedHistoryStatus);
    });
  }

  function handleDisableSharedHistory(item: ChatHistorySummary) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法关闭分享。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
    void api
      .setHistoryShare(id, false)
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
        if (shareConversation?.id === id) {
          setShareStatus(status);
        }
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "关闭分享失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
      });
  }

  function handleSetSharedHistoryRedactToolContent(
    item: ChatHistorySummary,
    redactToolContent: boolean,
  ) {
    const id = item.id.trim();
    if (!id) {
      return;
    }
    if (!api) {
      setSharedManagerError(id, "Gateway 尚未连接，无法更新分享脱敏设置。");
      return;
    }

    setSharedManagerError(id, null);
    updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, true);
    void api
      .setHistoryShare(id, true, { redactToolContent })
      .then((status) => {
        setSharedManagerStatuses((current) => ({ ...current, [id]: status }));
        markSharedConversation(id, status.enabled === true, item);
        if (shareConversation?.id === id) {
          setShareStatus(status);
        }
      })
      .catch((error) => {
        setSharedManagerError(id, asErrorMessage(error, "更新分享脱敏设置失败"));
      })
      .finally(() => {
        updateSharedManagerIdSet(setSharedManagerUpdatingIds, id, false);
      });
  }

  const handleResendFromEdit = useCallback(
    async (messageRef: HistoryMessageRef, text: string, uploadedFiles: PendingUploadedFile[]) => {
      const activeConversationId = conversationIdRef.current.trim();
      if (
        !api ||
        chatBusyRef.current ||
        !activeConversationId ||
        isLocalDraftConversationId(activeConversationId)
      ) {
        return;
      }
      const normalized = text.trim();
      if (!normalized && uploadedFiles.length === 0) {
        return;
      }
      const optimisticEditUserEntryId = `edit-user-${crypto.randomUUID()}`;
      const optimisticEditUserEntry: ChatEntry = {
        id: optimisticEditUserEntryId,
        kind: "user",
        text: normalized,
        attachments: uploadedFiles,
      };
      const messageRefMatches = (candidate: HistoryMessageRef | undefined) =>
        Boolean(candidate) &&
        candidate?.segmentIndex === messageRef.segmentIndex &&
        candidate?.messageIndex === messageRef.messageIndex &&
        candidate?.segmentId === messageRef.segmentId &&
        candidate?.messageId === messageRef.messageId &&
        candidate?.role === messageRef.role &&
        candidate?.contentHash === messageRef.contentHash;
      const buildPreviewMessages = (messages: ChatEntry[]) => {
        const targetIndex = messages.findIndex(
          (entry) => entry.kind === "user" && messageRefMatches(entry.messageRef),
        );
        const prefix = targetIndex >= 0 ? messages.slice(0, targetIndex) : messages;
        return [...prefix, optimisticEditUserEntry];
      };
      const randomPart =
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const clientRequestId = `webui-chat.edit_resend-${activeConversationId}-${randomPart}`;
      const prevGen = activeEditResendTransactionsRef.current.get(activeConversationId)?.generation ?? 0;
      const generation = prevGen + 1;
      activeEditResendTransactionsRef.current.set(activeConversationId, {
        generation,
        clientRequestId,
      });
      const isCurrentEditTransaction = () => {
        const current = activeEditResendTransactionsRef.current.get(activeConversationId);
        return current?.generation === generation && current.clientRequestId === clientRequestId;
      };

      setHistoryError(null);
      setChatError(null);
      composerRef.current?.clear();
      setPendingUploadsForConversation(activeConversationId, []);
      blockedHistoryHydrationConversationIdsRef.current.add(activeConversationId);
      invalidateHistoryLoad();
      markVisibleConversationRevision();
      clearConversationLiveStream(activeConversationId);
      updateConversationRuntimeEntry(activeConversationId, (current) => ({
        ...current,
        error: null,
        toolStatus: null,
        toolStatusIsCompaction: false,
        messages: buildPreviewMessages(current.messages),
      }));

      const hydrateEditPrefix = async () => {
        const detail = await api.getHistoryPrefix(activeConversationId, messageRef, {
          maxMessages: HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
        });
        if (!isCurrentEditTransaction()) {
          return;
        }
        const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (!isCurrentEditTransaction()) {
          return;
        }

        setSelectedHistory(detail);
        setSelectedHistoryEntries(entries);
        updateConversationRuntimeEntry(activeConversationId, (current) => {
          if (
            !current.isSending &&
            !localRunningConversationIdsRef.current.has(activeConversationId)
          ) {
            return current;
          }
          return {
            ...current,
            messages: [...entries, optimisticEditUserEntry],
          };
        });

        const truncatedConversation = detail.conversation;
        if (truncatedConversation) {
          updateHistoryItems((current) =>
            upsertConversationSummary(current, truncatedConversation),
          );
        }
      };

      try {
        const resendPromise =
          sendChatRef.current?.(normalized, {
            conversationId: activeConversationId,
            uploadedFiles,
            editMessageRef: messageRef,
            clientRequestId,
            optimisticUserEntryId: optimisticEditUserEntryId,
            skipOptimisticUserEntry: true,
          }) ?? Promise.resolve();
        // Start prefix hydration AFTER sendChat so the chat.command WebSocket
        // message is queued before history.prefix.  The desktop agent processes
        // inbound gRPC envelopes sequentially — sending history.prefix first
        // would block the lightweight chat.edit_resend dispatch behind a heavy
        // DB read, adding unnecessary "Preparing request…" latency.
        void hydrateEditPrefix().catch((error) => {
          if (isCurrentEditTransaction()) {
            console.warn("edit resend history prefix hydration failed", error);
          }
        });
        await resendPromise;
        if (isCurrentEditTransaction()) {
          await refreshVisibleConversationHistorySnapshot(activeConversationId, api, {
            allowIdle: true,
            allowDuringEditTransaction: true,
          });
        }
      } catch (error) {
        const message = asErrorMessage(error, "编辑后重发失败");
        setChatError(message);
        updateConversationRuntimeEntry(activeConversationId, (current) => ({
          ...current,
          error: message,
          toolStatus: null,
          toolStatusIsCompaction: false,
          isSending: false,
          messages: current.messages.filter((entry) => entry.id !== optimisticEditUserEntryId),
        }));
        void refreshVisibleConversationHistorySnapshot(activeConversationId, api, {
          allowIdle: true,
          allowDuringEditTransaction: true,
        });
      } finally {
        if (isCurrentEditTransaction()) {
          activeEditResendTransactionsRef.current.delete(activeConversationId);
          blockedHistoryHydrationConversationIdsRef.current.delete(activeConversationId);
        }
      }
    },
    [
      api,
      clearConversationLiveStream,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      refreshVisibleConversationHistorySnapshot,
      updateHistoryItems,
      updateConversationRuntimeEntry,
    ],
  );

  const handleLoadUploadedImagePreview = useCallback(
    async (workspaceRoot: string, absolutePath: string) => {
      if (!api) {
        return null;
      }
      const result = await api.readUploadedImagePreview(workspaceRoot, absolutePath);
      if (!result.data.trim()) {
        return null;
      }
      return result;
    },
    [api],
  );

  const handleComposerBusyChange = useCallback((_isBusy: boolean) => {}, []);

  function openSettings(section: SectionId = "system") {
    setSettingsSection(section);
    setSettingsOpen(true);
    setOverlay("entering");
    requestAnimationFrame(() => requestAnimationFrame(() => setOverlay("open")));
  }

  function closeSettings() {
    setOverlay("leaving");
  }

  function handleSettingsTransitionEnd() {
    if (overlay === "leaving") {
      setSettingsOpen(false);
      setOverlay("closed");
    }
  }

  const handleLogout = useCallback(() => {
    invalidateHistoryLoad();
    markVisibleConversationRevision();
    clearSession();
    for (const controller of conversationAbortControllersRef.current.values()) {
      controller.abort();
    }
    conversationAbortControllersRef.current.clear();
    stopAllConversationEventStreamSubscriptions();
    clearAllCompletedLiveStreamMarkers();
    blockedHistoryHydrationConversationIdsRef.current.clear();
    conversationRuntimeCacheRef.current.clear();
    localRunningConversationIdsRef.current = new Set();
    remoteRunningConversationIdsRef.current = new Set();
    remoteRunningConversationRuntimeRef.current = new Map();
    composerDraftCacheRef.current.clear();
    composerRef.current?.clear();
    conversationIdRef.current = "";
    selectedHistoryIdRef.current = "";
    chatMessagesRef.current = [];
    chatBusyRef.current = false;
    chatErrorRef.current = null;
    chatToolStatusRef.current = null;
    chatToolStatusIsCompactionRef.current = false;
    selectedHistoryRef.current = null;
    historyItemsRef.current = [];
    historyTotalRef.current = 0;
    historyHasMoreRef.current = false;
    nextHistoryPageRef.current = 1;
    historyListPageLoadingRef.current = false;
    sharedHistoryItemsRef.current = [];
    sharedHistoryListRequestRef.current = null;
    clearPendingUploads();
    draftConversationPinnedRef.current = false;
    protectedConversationRef.current = "";
    chatStartLocksRef.current.clear();
    submitInFlightRef.current = false;
    pendingDraftConversationMigrationRef.current = null;
    setUserMenuOpen(false);
    setSettingsOpen(false);
    setOverlay("closed");
    setHistorySwitchOverlay(null);
    setStatus(null);
    setStatusError(null);
    setConversationId("");
    setChatBusy(false);
    setChatMessages([]);
    setChatError(null);
    applyChatToolStatus(null);
    optimisticTitleConversationIdsRef.current.clear();
    clearHistoryTitlePositionLocks();
    historyItemsRef.current = [];
    setHistoryItems([]);
    setSharedHistoryItems([]);
    setHistoryTotal(0);
    setHistoryHasMore(false);
    setHistoryError(null);
    setHistoryListLoading(false);
    setHistoryListLoadingMore(false);
    setHistoryDetailLoading(false);
    setHistoryMutating(false);
    queuedChatTurnsRef.current = [];
    chatQueueConversationIdRef.current = "";
    chatQueueRevisionRef.current = 0;
    queuedChatEditSessionRef.current = null;
    setQueuedChatTurns([]);
    setChatQueueRevision(0);
    setLocalRunningConversationIds(new Set());
    setRemoteRunningConversationIds(new Set());
    setRemoteRunningConversationRuntime(new Map());
    setProjectActivityUpdatedAtOverrides(new Map());
    resetProjectToolsRuntimeRef.current();
    clearAllConversationLiveStreams();
    setSelectedHistoryId("");
    setSelectedHistory(null);
    setSelectedHistoryEntries([]);
    setRenamingId(null);
    setRenameDraft("");
  }, [
    applyChatToolStatus,
    clearAllConversationLiveStreams,
    clearAllCompletedLiveStreamMarkers,
    clearHistoryTitlePositionLocks,
    clearPendingUploads,
    clearSession,
    invalidateHistoryLoad,
    markVisibleConversationRevision,
    stopAllConversationEventStreamSubscriptions,
  ]);

  const userMenuLabel = (status?.agent_id || "当前用户").trim() || "当前用户";
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();

  const localeContextValue = useMemo(
    () => ({
      locale: settings.locale,
      t: (key: string) => translate(key, settings.locale),
    }),
    [settings.locale],
  );

  const activeProviders = useMemo<ModelProviderSource[]>(
    // WebUI provider config should follow the synced settings payload directly.
    // Using a separately fetched provider summary here can leave the model list stale
    // after Settings has already synced in either direction.
    () => settings.customProviders,
    [settings.customProviders],
  );

  const currentModelLabel = useMemo(() => {
    if (!settings.selectedModel) {
      return "选择模型";
    }
    const provider = activeProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    return provider
      ? `${provider.name} / ${settings.selectedModel.model}`
      : settings.selectedModel.model;
  }, [activeProviders, settings.selectedModel]);
  const currentModelContextWindow = useMemo(() => {
    if (!settings.selectedModel) {
      return undefined;
    }
    const provider = settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
    if (!provider) {
      return undefined;
    }
    return findProviderModelConfig(provider, settings.selectedModel.model).contextWindow;
  }, [settings.customProviders, settings.selectedModel]);
  const currentChatProvider = useMemo(() => {
    if (!settings.selectedModel) {
      return undefined;
    }
    return settings.customProviders.find(
      (item) => item.id === settings.selectedModel?.customProviderId,
    );
  }, [settings.customProviders, settings.selectedModel]);
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
      }),
    [currentChatProvider?.requestFormat, currentChatProvider?.type, settings.chatRuntimeControls],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(prev.chatRuntimeControls, patch, {
          providerId: currentChatProvider?.type,
          requestFormat: currentChatProvider?.requestFormat,
        }),
      }));
    },
    [currentChatProvider?.requestFormat, currentChatProvider?.type, setSettings],
  );
  const isAgentDevExecutionMode = isAgentDevMode(settings.system.executionMode);

  const modelOptions = useMemo(() => buildModelOptions(settings), [settings]);
  const selectedValue = settings.selectedModel
    ? toModelValue(settings.selectedModel.customProviderId, settings.selectedModel.model)
    : undefined;

  const skillsEnabled = settings.skills.enabled && isAgentMode;
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? mergeAlwaysEnabledSkillNames(settings.skills.selected) : []),
    [skillsEnabled, settings.skills.selected],
  );
  const { availableSkills, skillsRootDir } = useChatSkills({
    skillsEnabled,
    selectedSkillNames,
    setSettings,
  });
  const enabledComposerSkills = useMemo(() => {
    if (!skillsEnabled || selectedSkillNames.length === 0 || availableSkills.length === 0) {
      return [];
    }
    const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
    return selectedSkillNames
      .map((name) => byName.get(name))
      .filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill));
  }, [availableSkills, selectedSkillNames, skillsEnabled]);

  const sidebarItems = useMemo<ChatHistorySummary[]>(
    () => historyItems.map((item) => toChatHistorySummary(item, settings.selectedModel)),
    [historyItems, settings.selectedModel],
  );
  const canShareHistory = Boolean(
    api &&
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() &&
      settings.remote.token.trim(),
  );
  const sidebarRunningConversationIds = useMemo(() => {
    const next = new Set(remoteRunningConversationIds);
    for (const conversationIdValue of localRunningConversationIds) {
      next.add(conversationIdValue);
    }
    return next;
  }, [localRunningConversationIds, remoteRunningConversationIds]);
  const runningProjectPathKeys = useMemo(() => {
    const next = new Set<string>();
    for (const conversationIdValue of sidebarRunningConversationIds) {
      const conversationId = conversationIdValue.trim();
      if (!conversationId) {
        continue;
      }

      const runtimeWorkdir =
        conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
      const remoteWorkdir =
        remoteRunningConversationRuntime.get(conversationId)?.workdir?.trim() || "";
      const persistedWorkdir =
        historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
      const resolvedWorkdir = runtimeWorkdir || remoteWorkdir || persistedWorkdir;
      if (resolvedWorkdir) {
        next.add(workspaceProjectPathKey(resolvedWorkdir));
      }
    }
    return next;
  }, [historyItems, remoteRunningConversationRuntime, sidebarRunningConversationIds]);

  const projectActivityUpdatedAts = useMemo(() => {
    const updatedAts = buildWorkspaceProjectActivityUpdatedAts([
      ...historyWorkdirs,
      ...Array.from(localRunningConversationIds).map((conversationId) => {
        const runtimeWorkdir =
          conversationRuntimeCacheRef.current.get(conversationId)?.workdir?.trim() || "";
        const persistedWorkdir =
          historyItems.find((item) => item.id === conversationId)?.cwd?.trim() || "";
        return {
          cwd: runtimeWorkdir || persistedWorkdir,
          updatedAt: Date.now(),
        };
      }),
      ...Array.from(remoteRunningConversationRuntime.values()).map((item) => ({
        cwd: item.workdir,
        updatedAt: item.updatedAt,
      })),
    ]);
    for (const [pathKey, updatedAt] of projectActivityUpdatedAtOverrides) {
      if (updatedAt > (updatedAts.get(pathKey) ?? 0)) {
        updatedAts.set(pathKey, updatedAt);
      }
    }
    return updatedAts;
  }, [
    historyItems,
    historyWorkdirs,
    localRunningConversationIds,
    projectActivityUpdatedAtOverrides,
    remoteRunningConversationRuntime,
  ]);
  const displayedConversationId = resolveVisibleConversationId(selectedHistoryId, conversationId);
  const currentConversationPersistedCwd =
    historyItems.find((item) => item.id === displayedConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationRuntimeCacheRef.current.get(displayedConversationId)?.workdir?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (isAgentMode ? activeWorkspaceProjectPath || settings.system.workdir.trim() : "");
  displayedConversationWorkdirRef.current = displayedConversationWorkdir;
  useEffect(() => {
    if (!api || !displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      return;
    }
    if (chatQueueConversationIdRef.current !== displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = displayedConversationId;
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
    }
    let cancelled = false;
    void api
      .chatQueueGet(displayedConversationId)
      .then((response) => {
        if (!cancelled) applyChatQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, applyChatQueueSnapshot, displayedConversationId]);
  const queuedChatTurnsForDisplayedConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      })),
    [displayedConversationId, queuedChatTurns],
  );
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const rightDockProjectState = getRightDockProjectState(
    settings.customSettings,
    terminalProjectPathKey,
  );
  const rightDockFileTreeOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "fileTree",
  );
  const rightDockTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "tunnel",
  );
  const rightDockSshTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "sshTunnel",
  );
  const associatedSshHostIds = getSshProjectHostIds(settings.ssh, terminalProjectPathKey);
  const projectToolsDisabledMessage = !settingsSyncReady
    ? "Syncing desktop settings..."
    : !isAgentMode
      ? "Project tools require Agent project mode."
      : !terminalProjectPath
        ? "Select a project to use project tools."
        : undefined;
  const terminalDisabledMessage =
    projectToolsDisabledMessage ??
    (!settings.remote.enableWebTerminal
      ? "Enable WebUI Terminal in desktop Remote settings."
      : undefined);
  const webTerminalSessionsEnabled =
    settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal;
  const {
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorCleanupPending,
    workspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
    terminalSessions,
    setTerminalSessions,
    terminalSessionsVersionRef,
    terminalStatusSessionIdRef,
    projectTerminalSessions,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    handleWorkspaceEditorHide,
    handleWorkspaceEditorClosed,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    handleProjectTerminalSessionsChange,
    resetTerminalSessions,
    hideWorkspaceSshTerminalOverlay,
  } = useProjectToolsRuntime({
    terminalClient,
    settingsSyncReady,
    isAgentMode,
    webTerminalSessionsEnabled,
    statusOnline: status?.online,
    statusSessionId: status?.session_id,
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
    rightDockSshTunnelOpen,
  });
  resetProjectToolsRuntimeRef.current = resetTerminalSessions;
  const gitDisabledMessage = !settings.remote.enableWebGit
    ? "WebUI Git is disabled in desktop Remote settings."
    : undefined;
  const tunnelEnabled =
    settingsSyncReady && settings.remote.enableWebTunnels === true && status?.online === true;
  const tunnelDisabledMessage = !settingsSyncReady
    ? translate("chat.runtime.tunnelSettingsSyncing", settings.locale)
    : !settings.remote.enableWebTunnels
      ? translate("projectTools.tunnelWebDisabled", settings.locale)
      : status?.online !== true
        ? translate("projectTools.tunnelRemoteOffline", settings.locale)
        : undefined;
  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const cachedDraft = composerDraftCacheRef.current.get(targetConversationId);
      const composer = composerRef.current;
      if (!cachedDraft || !composer || composer.hasContent()) {
        return;
      }
      composer.setDraft(cachedDraft);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, displayedConversationId]);

  const displayedConversationSummary = useMemo(() => {
    const displayedId = displayedConversationId.trim();
    if (!displayedId || isLocalDraftConversationId(displayedId)) {
      return null;
    }
    return pickConversationSummary(historyItems, displayedId);
  }, [displayedConversationId, historyItems]);
  const activeProjectBrowserTitle = isAgentMode ? (activeWorkspaceProject?.name.trim() ?? "") : "";
  const displayedConversationTitle = useMemo(
    () =>
      resolveConversationBrowserTitle({
        conversation: displayedConversationSummary,
        conversationId: displayedConversationId,
        projectName: activeProjectBrowserTitle,
        isLocalDraftConversation: isLocalDraftConversationId(displayedConversationId),
        newConversationTitle: NEW_CONVERSATION_BROWSER_TITLE,
      }),
    [activeProjectBrowserTitle, displayedConversationId, displayedConversationSummary],
  );
  const browserTitle = useMemo(() => {
    if (historyShareToken) {
      return SHARED_HISTORY_BROWSER_TITLE;
    }
    if (!token.trim()) {
      return DEFAULT_BROWSER_TITLE;
    }
    if (activeView === "skills-hub") {
      return SKILLS_HUB_BROWSER_TITLE;
    }
    if (activeView === "mcp-hub") {
      return MCP_HUB_BROWSER_TITLE;
    }
    return displayedConversationTitle || DEFAULT_BROWSER_TITLE;
  }, [activeView, displayedConversationTitle, historyShareToken, token]);
  const hasDetachedSelection = hasDetachedHistorySelection(selectedHistoryId, conversationId);
  const visibleTranscriptEntries = hasDetachedSelection ? selectedHistoryEntries : chatMessages;
  const historyDetailLoadingTitle = useMemo(() => {
    const selectedId = selectedHistoryId.trim();
    if (!selectedId) {
      return "";
    }
    const item = historyItems.find((candidate) => candidate.id === selectedId);
    return item ? resolveConversationTitle(item, item.id) : "";
  }, [historyItems, selectedHistoryId]);
  const transcriptHistoryLoading =
    historyDetailLoading && hasDetachedSelection && selectedHistoryEntries.length === 0;
  const selectedHistoryHasMore =
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistory.has_more === true;
  const loadingOlderHistory =
    historyDetailLoading &&
    selectedHistory?.conversation_id === displayedConversationId &&
    selectedHistoryEntries.length > 0;
  const handleLoadFullHistory = useCallback(() => {
    if (!api || !displayedConversationId) {
      return;
    }
    void selectHistory(displayedConversationId, api, {
      syncChat: !hasDetachedSelection,
      fullHistory: true,
    });
  }, [api, displayedConversationId, hasDetachedSelection]);
  const liveTranscriptStore =
    displayedConversationId !== "" ? getConversationLiveStreamStore(displayedConversationId) : null;
  const liveTranscriptSnapshot = liveTranscriptStore?.getSnapshot();
  const liveTranscriptHasStream = (liveTranscriptSnapshot?.entries.length ?? 0) > 0;
  const isLocallyStreamingDisplayedConversation =
    chatBusy && conversationId.trim() !== "" && displayedConversationId === conversationId.trim();
  const isObservingRemoteLiveConversation = Boolean(
    !isLocallyStreamingDisplayedConversation &&
      displayedConversationId !== "" &&
      remoteRunningConversationIds.has(displayedConversationId),
  );
  const observedRemoteRunKey = isObservingRemoteLiveConversation
    ? resolveRunningConversationRunKey(remoteRunningConversationRuntime.get(displayedConversationId))
    : "";
  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    for (const conversationIdValue of [
      ...conversationEventStreamsRef.current.keys(),
    ]) {
      if (conversationIdValue !== nextDisplayedConversationId) {
        stopConversationEventStreamSubscription(conversationIdValue);
      }
    }
    for (const conversationIdValue of [...liveConversationStreamStoresRef.current.keys()]) {
      if (
        conversationIdValue !== nextDisplayedConversationId &&
        !remoteRunningConversationIdsRef.current.has(conversationIdValue) &&
        !localRunningConversationIdsRef.current.has(conversationIdValue)
      ) {
        clearConversationLiveStream(conversationIdValue);
      }
    }

    if (api && isObservingRemoteLiveConversation && nextDisplayedConversationId !== "") {
      subscribeVisibleConversationEventStream(nextDisplayedConversationId, api);
    }
  }, [
    api,
    subscribeVisibleConversationEventStream,
    clearConversationLiveStream,
    displayedConversationId,
    isObservingRemoteLiveConversation,
    observedRemoteRunKey,
    stopConversationEventStreamSubscription,
  ]);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.title = browserTitle;
  }, [browserTitle]);
  const transcriptToolStatus = isObservingRemoteLiveConversation
    ? (liveTranscriptSnapshot?.toolStatus ?? null)
    : hasDetachedSelection
      ? null
      : chatToolStatus;
  const transcriptToolStatusIsCompaction = isObservingRemoteLiveConversation
    ? (liveTranscriptSnapshot?.toolStatusIsCompaction ?? false)
    : hasDetachedSelection
      ? false
      : chatToolStatusIsCompaction;
  const transcriptBusy = (!hasDetachedSelection && chatBusy) || isObservingRemoteLiveConversation;
  const composerIsSending = chatBusy || isObservingRemoteLiveConversation;
  const transcriptError = hasDetachedSelection || chatMessages.length === 0 ? null : chatError;
  const composerCompactionBlocked = transcriptToolStatusIsCompaction;
  const composerInputDisabled =
    !status?.online || historyDetailLoading || composerCompactionBlocked;
  const composerPlaceholder = composerCompactionBlocked
    ? translate("chat.compactingContextWait", settings.locale)
    : historyDetailLoading
      ? "正在加载会话历史，请稍候..."
      : enabledComposerSkills.length > 0
        ? translate("chat.inputHintWithSkills", settings.locale)
        : translate("chat.inputHint", settings.locale);
  const canDropUpload =
    status?.online === true &&
    isAgentMode &&
    Boolean(displayedConversationWorkdir.trim()) &&
    !isUploadingFiles &&
    !composerInputDisabled;
  const fileDropTitle = canDropUpload
    ? translate("chat.upload.dropReady", settings.locale)
    : status?.online !== true
      ? translate("chat.upload.dropBusy", settings.locale)
      : !isAgentMode
        ? translate("chat.upload.onlyInTools", settings.locale)
        : !displayedConversationWorkdir.trim()
          ? translate("chat.upload.requireWorkdir", settings.locale)
          : translate("chat.upload.dropBusy", settings.locale);
  const fileDropDescription = canDropUpload
    ? translate("chat.upload.dropHint", settings.locale)
    : translate("chat.upload.dropDisabledHint", settings.locale);
  const fileDropLimitHint = formatTranslation(translate("chat.upload.dropLimit", settings.locale), {
    max: MAX_UPLOAD_FILES,
  });

  const handleFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handlePendingFileDragOver(event, canDropUpload);
    },
    [canDropUpload, handlePendingFileDragOver],
  );

  const handleFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handlePendingFileDrop(event, {
        canDropUpload,
        disabledMessage: fileDropTitle,
      });
    },
    [canDropUpload, fileDropTitle, handlePendingFileDrop],
  );

  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    const previousDisplayedConversationId = previousDisplayedConversationIdRef.current.trim();
    previousDisplayedConversationIdRef.current = nextDisplayedConversationId;
    if (
      !nextDisplayedConversationId ||
      !previousDisplayedConversationId ||
      previousDisplayedConversationId === nextDisplayedConversationId
    ) {
      return;
    }
    pendingDisplayedConversationAutoBottomRef.current = nextDisplayedConversationId;
  }, [displayedConversationId]);

  useLayoutEffect(() => {
    const targetConversationId = pendingDisplayedConversationAutoBottomRef.current?.trim() ?? "";
    if (
      !targetConversationId ||
      historyDetailLoading ||
      displayedConversationId.trim() !== targetConversationId ||
      (visibleTranscriptEntries.length === 0 && !liveTranscriptHasStream)
    ) {
      return;
    }

    stickTranscriptToBottom();
    refreshTranscriptScrollState();
    pendingDisplayedConversationAutoBottomRef.current = null;
  }, [
    displayedConversationId,
    historyDetailLoading,
    liveTranscriptHasStream,
    refreshTranscriptScrollState,
    stickTranscriptToBottom,
    visibleTranscriptEntries.length,
  ]);

  useEffect(() => {
    if (!historySwitchOverlay) {
      return;
    }

    const targetConversationId = historySwitchOverlay.conversationId;
    const currentDisplayedConversationId = displayedConversationId.trim();
    const currentSelectedHistoryId = selectedHistoryId.trim();
    const isTargetVisible = currentDisplayedConversationId === targetConversationId;
    const isTargetSelected = isTargetVisible || currentSelectedHistoryId === targetConversationId;

    if (historyDetailLoading && isTargetSelected) {
      return;
    }

    let firstRafId: number | null = null;
    let secondRafId: number | null = null;
    const elapsed = Date.now() - historySwitchOverlay.startedAt;
    const delayMs = Math.max(0, HISTORY_SWITCH_OVERLAY_MIN_MS - elapsed);
    const timeoutId = window.setTimeout(() => {
      firstRafId = requestAnimationFrame(() => {
        if (isTargetVisible) {
          stickTranscriptToBottom();
        }
        secondRafId = requestAnimationFrame(() => {
          if (isTargetVisible) {
            stickTranscriptToBottom();
            refreshTranscriptScrollState();
          }
          setHistorySwitchOverlay((current) =>
            current?.conversationId === targetConversationId ? null : current,
          );
        });
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
      if (firstRafId !== null) {
        cancelAnimationFrame(firstRafId);
      }
      if (secondRafId !== null) {
        cancelAnimationFrame(secondRafId);
      }
    };
  }, [
    displayedConversationId,
    historyDetailLoading,
    historySwitchOverlay,
    refreshTranscriptScrollState,
    selectedHistoryId,
    stickTranscriptToBottom,
  ]);

  useLayoutEffect(() => {
    if (transcriptBusy || liveTranscriptHasStream) {
      syncTranscriptAutoScroll();
    }
    refreshTranscriptScrollState();
  }, [
    chatError,
    liveTranscriptHasStream,
    refreshTranscriptScrollState,
    syncTranscriptAutoScroll,
    transcriptBusy,
    visibleTranscriptEntries,
    transcriptToolStatus,
  ]);

  if (historyShareToken) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SharedHistoryPage token={historyShareToken} />
      </LocaleContext.Provider>
    );
  }

  if (!token) {
    return (
      <LoginPage
        token={loginToken}
        error={authError}
        isSubmitting={authSubmitting}
        onTokenChange={(nextToken) => {
          setLoginToken(nextToken);
          if (authError) {
            setAuthError(null);
          }
        }}
        onSubmit={handleLoginSubmit}
      />
    );
  }

  if (!api) {
    return null;
  }

  if (!settingsSyncReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <div className="gateway-shell">
          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            <div className="gateway-chat-frame flex items-center justify-center">
              <SettingsSyncLoading locale={settings.locale} />
            </div>
          </main>
        </div>
      </LocaleContext.Provider>
    );
  }

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <div className="gateway-shell">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="gateway-hidden-file-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            void handleImportReadableFiles(files);
            event.currentTarget.value = "";
          }}
        />

        <div className="gateway-editor-host">
          <ChatHistorySidebar
            items={sidebarItems}
            currentConversationId={displayedConversationId}
            isBusy={historyDetailLoading || historyMutating}
            runningConversationIds={sidebarRunningConversationIds}
            isLoading={historyListLoading && sidebarItems.length === 0}
            totalItems={historyTotal}
            hasMore={historyHasMore}
            isLoadingMore={historyListLoadingMore}
            errorMessage={historyError}
            renamingId={renamingId}
            renameDraft={renameDraft}
            isOpen={sidebarOpen}
            activeView={activeView}
            showProjects={isAgentMode}
            projects={workspaceProjects}
            activeProjectId={activeWorkspaceProject?.id}
            missingProjectPathKeys={missingWorkspaceProjectPathKeys}
            runningProjectPathKeys={runningProjectPathKeys}
            projectActivityUpdatedAts={projectActivityUpdatedAts}
            projectRenamingId={projectRenamingId}
            projectRenameDraft={projectRenameDraft}
            projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
            recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
            onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
            onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
            onCreateProject={handleOpenCreateWorkspaceProject}
            onSelectProject={handleSelectWorkspaceProject}
            onNewConversationForProject={handleNewConversationForProject}
            onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
            onStartRenamingProject={handleStartRenamingWorkspaceProject}
            onProjectRenameDraftChange={setProjectRenameDraft}
            onCommitProjectRename={handleCommitWorkspaceProjectRename}
            onCancelProjectRename={handleCancelWorkspaceProjectRename}
            onSetProjectPinned={handleSetWorkspaceProjectPinned}
            onRemoveProject={handleRemoveWorkspaceProject}
            onNewConversation={handleSidebarNewConversation}
            onSelectConversation={handleSidebarSelectConversation}
            onStartRenaming={(item) => {
              setRenamingId(item.id);
              setRenameDraft(item.title);
            }}
            onRenameDraftChange={setRenameDraft}
            onCommitRename={() => {
              if (!renamingId) {
                return;
              }
              const conversationIdValue = renamingId;
              const title = renameDraft.trim();
              setHistoryError(null);
              void (async () => {
                if (!title) {
                  setRenamingId(null);
                  setRenameDraft("");
                  return;
                }
                setHistoryMutating(true);
                try {
                  const summary = await api.renameHistory(conversationIdValue, title);
                  optimisticTitleConversationIdsRef.current.delete(conversationIdValue);
                  unlockHistoryTitlePosition(conversationIdValue);
                  updateHistoryItems((current) => upsertConversationSummary(current, summary));
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "修改历史对话标题失败"));
                } finally {
                  setHistoryMutating(false);
                  setRenamingId(null);
                  setRenameDraft("");
                }
              })();
            }}
            onCancelRename={() => {
              setRenamingId(null);
              setRenameDraft("");
            }}
            onSetPinned={(id, isPinned) => {
              setHistoryError(null);
              void (async () => {
                setHistoryMutating(true);
                try {
                  const summary = await api.pinHistory(id, isPinned);
                  updateHistoryItems((current) => upsertConversationSummary(current, summary));
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "更新历史对话置顶状态失败"));
                } finally {
                  setHistoryMutating(false);
                }
              })();
            }}
            canShareConversations={canShareHistory}
            sharedConversationCount={sharedHistoryItems.length}
            onShareConversation={handleOpenShareModal}
            onOpenSharedConversations={handleOpenSharedHistoryManager}
            onDeleteConversation={(id) => {
              setHistoryError(null);
              if (sidebarRunningConversationIds.has(id)) {
                setHistoryError("后台任务仍在运行，暂时不能删除该对话。");
                return;
              }
              if (isLocalDraftConversationId(id)) {
                optimisticTitleConversationIdsRef.current.delete(id);
                unlockHistoryTitlePosition(id);
                updateHistoryItems((current) => current.filter((item) => item.id !== id));
                if (conversationIdRef.current === id || selectedHistoryIdRef.current === id) {
                  startNewConversation({
                    workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
                  });
                }
                return;
              }
              void (async () => {
                setHistoryMutating(true);
                try {
                  await api.deleteHistory(id);
                  optimisticTitleConversationIdsRef.current.delete(id);
                  unlockHistoryTitlePosition(id);
                  updateHistoryItems((current) => current.filter((item) => item.id !== id));
                  setSharedHistoryItemsState(
                    sharedHistoryItemsRef.current.filter((item) => item.id !== id),
                  );
                  if (conversationIdRef.current === id || selectedHistoryIdRef.current === id) {
                    startNewConversation({
                      workdir: isAgentMode ? activeWorkspaceProjectPath || undefined : undefined,
                    });
                  }
                } catch (error) {
                  setHistoryError(asErrorMessage(error, "删除历史对话失败"));
                } finally {
                  setHistoryMutating(false);
                }
              })();
            }}
            onLoadMore={loadMoreHistory}
            onCloseSidebar={() => setSidebarOpen(false)}
            onOpenSkillsHub={handleSidebarOpenSkillsHub}
            onOpenMcpHub={handleSidebarOpenMcpHub}
          />

          {shareConversation ? (
            <HistoryShareModal
              conversation={shareConversation}
              share={shareStatus}
              isLoading={shareLoading}
              isUpdating={shareUpdating}
              errorMessage={shareError}
              onToggle={handleToggleHistoryShare}
              onRedactToolContentChange={handleSetShareRedactToolContent}
              onClose={handleCloseShareModal}
            />
          ) : null}

          {sharedManagerOpen ? (
            <SharedHistoryManagerModal
              conversations={sharedHistoryItems}
              statuses={sharedManagerStatuses}
              loadingIds={sharedManagerLoadingIds}
              updatingIds={sharedManagerUpdatingIds}
              errors={sharedManagerErrors}
              shareOrigin={settings.remote.gatewayUrl}
              onRefresh={handleRefreshSharedHistoryStatuses}
              onLoadStatus={handleLoadSharedHistoryStatus}
              onDisableShare={handleDisableSharedHistory}
              onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
              onClose={() => setSharedManagerOpen(false)}
            />
          ) : null}

          {projectPickerOpen ? (
            <WorkdirPickerModal
              initialWorkdir={activeWorkspaceProjectPath || settings.system.workdir.trim()}
              onClose={() => setProjectPickerOpen(false)}
              onSelect={handleWorkdirPickerSelect}
            />
          ) : null}

          {confirmDialog}

          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            {activeView === "skills-hub" ? (
              <SkillsHubPage
                settings={settings}
                setSettings={setSettings}
                initialSkills={availableSkills}
                initialRootDir={skillsRootDir}
                isAgentMode={isAgentMode}
                sidebarOpen={sidebarOpen}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            ) : activeView === "mcp-hub" ? (
              <McpHubPage
                settings={settings}
                setSettings={setSettings}
                isAgentMode={isAgentMode}
                sidebarOpen={sidebarOpen}
                onOpenSidebar={() => setSidebarOpen(true)}
              />
            ) : (
              <div
                className="gateway-chat-frame"
                onDragEnter={handleFileDragEnter}
                onDragOver={handleFileDragOver}
                onDragLeave={handleFileDragLeave}
                onDrop={handleFileDrop}
              >
                <ChatHeader
                  settings={settings}
                  hasModels={modelOptions.length > 0}
                  currentModelLabel={currentModelLabel}
                  modelOptions={modelOptions}
                  selectedValue={selectedValue}
                  sidebarOpen={sidebarOpen}
                  setSettings={setSettings}
                  onOpenSettings={openSettings}
                  onToggleTheme={() =>
                    setSettings((prev) => ({
                      ...prev,
                      theme: getNextTheme(prev.theme),
                    }))
                  }
                  onOpenSidebar={() => setSidebarOpen(true)}
                  preThemeActions={
                    <span
                      className={`gateway-online-pill${status?.online ? " gateway-online-pill-active" : ""}`}
                      title={status?.online ? "Online" : "Offline"}
                      aria-label={status?.online ? "Online" : "Offline"}
                    >
                      {status?.online ? "Online" : "Offline"}
                    </span>
                  }
                  trailingActions={
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setRightDockOpen((open) => !open)}
                        disabled={Boolean(projectToolsDisabledMessage) && !rightDockOpen}
                        aria-expanded={rightDockOpen}
                        title={
                          rightDockOpen
                            ? "Collapse project tools panel"
                            : (projectToolsDisabledMessage ?? "Expand project tools panel")
                        }
                        className={`gateway-project-tools-panel-toggle relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95 ${
                          rightDockOpen ? "bg-muted text-foreground" : ""
                        }`}
                      >
                        {rightDockOpen ? (
                          <PanelRightClose className="h-4.5 w-4.5" />
                        ) : (
                          <PanelRightOpen className="h-4.5 w-4.5" />
                        )}
                        {projectTerminalSessions.length > 0 ? (
                          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold leading-none text-white">
                            {projectTerminalSessions.length}
                          </span>
                        ) : null}
                      </Button>
                      <UserMenu
                        open={userMenuOpen}
                        onOpenChange={setUserMenuOpen}
                        userMenuLabel={userMenuLabel}
                        userAvatarLabel={userAvatarLabel}
                        sessionId={status?.session_id}
                        onLogout={handleLogout}
                      />
                    </>
                  }
                />

                {statusError ? <div className="gateway-banner-error">{statusError}</div> : null}
                {settingsSyncError ? (
                  <div className="gateway-banner-error">{settingsSyncError}</div>
                ) : null}
                {chatError && chatMessages.length === 0 && !hasDetachedSelection ? (
                  <div className="gateway-banner-error">{chatError}</div>
                ) : null}

                <section className="gateway-transcript-stage">
                  <div className="gateway-transcript-scroll-shell">
                    <ScrollArea ref={transcriptScrollAreaRef} className="gateway-transcript-scroll">
                      <GatewayTranscript
                        conversationId={displayedConversationId}
                        entries={visibleTranscriptEntries}
                        liveStore={liveTranscriptStore}
                        hasLiveStream={liveTranscriptHasStream}
                        error={transcriptError}
                        toolStatus={transcriptToolStatus}
                        toolStatusIsCompaction={transcriptToolStatusIsCompaction}
                        isStreaming={transcriptBusy}
                        isLoading={transcriptHistoryLoading}
                        loadingTitle={historyDetailLoadingTitle}
                        hasModels={modelOptions.length > 0}
                        onOpenSettings={openSettings}
                        hasMoreHistory={selectedHistoryHasMore}
                        isLoadingMoreHistory={loadingOlderHistory}
                        onLoadFullHistory={
                          selectedHistoryHasMore ? handleLoadFullHistory : undefined
                        }
                        isAgentMode={isAgentMode}
                        showUsage={isAgentDevExecutionMode}
                        usageContextWindow={currentModelContextWindow}
                        workspaceRoot={displayedConversationWorkdir}
                        gitClient={gitClient}
                        onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                        onResendFromEdit={hasDetachedSelection ? undefined : handleResendFromEdit}
                      />
                    </ScrollArea>
                    {historySwitchOverlay ? (
                      <HistorySwitchLoadingOverlay locale={settings.locale} />
                    ) : null}
                  </div>
                  {showTranscriptJumpToBottom ? (
                    <button
                      type="button"
                      className="gateway-scroll-to-bottom"
                      onClick={jumpTranscriptToBottom}
                      aria-label="滚动到底部"
                      title="滚动到底部"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  ) : null}
                  <ChatComposerBar
                    composerRef={composerRef}
                    isSending={composerIsSending}
                    isUploadingFiles={isUploadingFiles}
                    isInputDisabled={composerInputDisabled}
                    inputPlaceholder={composerPlaceholder}
                    workdir={displayedConversationWorkdir}
                    enabledSkills={enabledComposerSkills}
                    isAgentMode={isAgentMode}
                    chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                    reasoningOptions={chatRuntimeReasoningOptions}
                    gitClient={gitClient}
                    gitWriteEnabled={settings.remote.enableWebGit}
                    gitDisabledMessage={gitDisabledMessage}
                    onGitChanged={(gitWorkdir) =>
                      window.dispatchEvent(
                        new CustomEvent("liveagent:git-changed", {
                          detail: { workdir: gitWorkdir },
                        }),
                      )
                    }
                    onSend={() => {
                      if (
                        submitInFlightRef.current ||
                        isUploadingFiles ||
                        isImportingPastedTextRef.current ||
                        composerInputDisabled
                      ) {
                        return;
                      }
                      if (queuedChatEditSessionRef.current) {
                        submitInFlightRef.current = true;
                        void (async () => {
                          try {
                            await commitQueuedChatEdit();
                          } finally {
                            submitInFlightRef.current = false;
                          }
                        })();
                        return;
                      }
                      if (
                        chatBusyRef.current ||
                        isObservingRemoteLiveConversation ||
                        queuedChatTurnsForDisplayedConversation.length > 0
                      ) {
                        submitInFlightRef.current = true;
                        void (async () => {
                          try {
                            await submitCurrentComposerToGuiQueue("append");
                          } finally {
                            submitInFlightRef.current = false;
                          }
                        })();
                        return;
                      }
                      submitInFlightRef.current = true;
                      void (async () => {
                        try {
                          const draft = composerRef.current?.getDraft() ?? null;
                          let text = draft
                            ? (isAgentMode && draft.largePastes.length > 0
                                ? draft.textWithoutLargePastes
                                : buildTextFromComposerDraft(draft)
                              ).trim()
                            : "";
                          let files = pendingUploadedFiles;

                          if (isAgentMode && draft && draft.largePastes.length > 0) {
                            setChatError(null);
                            isImportingPastedTextRef.current = true;
                            setIsUploadingFiles(true);
                            try {
                              const imported = await importPastedTextsAsFiles({
                                token,
                                workdir: displayedConversationWorkdir,
                                pastes: draft.largePastes,
                              });
                              text = buildTextFromComposerDraft(
                                draft,
                                imported.fileByPasteId,
                              ).trim();
                              files = mergePendingUploadedFiles(files, imported.files);
                            } catch (error) {
                              setChatError(asErrorMessage(error, "大段粘贴内容导入失败"));
                              return;
                            } finally {
                              isImportingPastedTextRef.current = false;
                              setIsUploadingFiles(false);
                            }
                          }

                          if (!text && files.length === 0) {
                            return;
                          }
                          const uploadConversationId = getDisplayedConversationId();
                          const pendingDraft = getPendingDraftId();
                          if (
                            pendingDraft &&
                            pendingDraft !== uploadConversationId
                          ) {
                            const message =
                              "上一条新会话仍在创建，请等待它出现在历史记录后再发送新会话。";
                            if (uploadConversationId) {
                              updateConversationRuntimeEntry(uploadConversationId, (current) => ({
                                ...current,
                                error: message,
                              }));
                            } else {
                              setChatError(message);
                            }
                            return;
                          }
                          composerRef.current?.clear();
                          setPendingUploadsForConversation(uploadConversationId, []);
                          void sendChat(text, {
                            uploadedFiles: files,
                            runtimeControls: chatRuntimeControlsForCurrentProvider,
                          }).catch(() => {
                            updatePendingUploadsForConversation(uploadConversationId, (current) =>
                              mergePendingUploadedFiles(current, files),
                            );
                          });
                        } finally {
                          submitInFlightRef.current = false;
                        }
                      })();
                    }}
                    onStop={() => {
                      void cancelChat(
                        isObservingRemoteLiveConversation ? displayedConversationId : undefined,
                      );
                    }}
                    onPrepareChatRuntime={() => {
                      if (!api || historyShareToken) {
                        return;
                      }
                      void prepareChatRuntime(
                        "composer-focus",
                        api,
                        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
                      ).catch(() => undefined);
                    }}
                    onComposerBusyChange={handleComposerBusyChange}
                    onChatRuntimeControlsChange={handleChatRuntimeControlsChange}
                    onPickReadableFiles={() => fileInputRef.current?.click()}
                    onPasteFiles={handleImportReadableFiles}
                    pendingUploadedFiles={pendingUploadedFiles}
                    onRemovePendingUpload={(relativePath) => {
                      updatePendingUploadsForConversation(getDisplayedConversationId(), (current) =>
                        current.filter((file) => file.relativePath !== relativePath),
                      );
                    }}
                    queuedTurns={queuedChatTurnsForDisplayedConversation}
                    onRunQueuedTurnNow={runQueuedTurnNow}
                    onMoveQueuedTurnUp={moveQueuedTurnUp}
                    onEditQueuedTurn={editQueuedTurn}
                    onRemoveQueuedTurn={removeQueuedTurn}
                  />
                  {isFileDropActive ? (
                    <FileDropOverlay
                      canDropUpload={canDropUpload}
                      title={fileDropTitle}
                      description={fileDropDescription}
                      limitHint={fileDropLimitHint}
                    />
                  ) : null}
                </section>
              </div>
            )}
          </main>
          <WorkspaceOverlayHost
            locale={settings.locale}
            theme={effectiveTheme}
            workspaceEditorMounted={workspaceEditorMounted}
            workspaceEditorOpenRequest={workspaceEditorOpenRequest}
            workspaceEditorCloseRequestId={workspaceEditorCloseRequestId}
            workspaceEditorOpen={workspaceEditorOpen}
            workspaceEditorCleanupPending={workspaceEditorCleanupPending}
            onWorkspaceEditorPreviewFile={openWorkspaceFilePreview}
            onWorkspaceEditorHide={handleWorkspaceEditorHide}
            onWorkspaceEditorClose={handleWorkspaceEditorClosed}
            workspaceFilePreviewMounted={workspaceFilePreviewMounted}
            workspaceFilePreviewOpenRequest={workspaceFilePreviewOpenRequest}
            workspaceFilePreviewOpen={workspaceFilePreviewOpen}
            onWorkspaceFilePreviewOpenEditor={openWorkspaceEditorFile}
            onWorkspaceFilePreviewRequestClose={requestWorkspaceFilePreviewClose}
            onWorkspaceFilePreviewClose={handleWorkspaceFilePreviewClosed}
            workspaceSshTerminalMounted={workspaceSshTerminalMounted}
            workspaceSshTerminalOpenRequest={workspaceSshTerminalOpenRequest}
            workspaceSshTerminalOpen={workspaceSshTerminalOpen}
            terminalProjectPathKey={terminalProjectPathKey}
            terminalClient={terminalClient}
            sftpClient={sftpClient}
            terminalSessions={terminalSessions}
            onWorkspaceSshTerminalHide={hideWorkspaceSshTerminalOverlay}
          />
        </div>

        {terminalClient ? (
          <RightDockPanel
            isOpen={activeView === "chat" && rightDockOpen}
            collapseImmediately={activeView !== "chat"}
            projectPathKey={terminalProjectPathKey}
            cwd={terminalProjectPath}
            sessions={terminalSessions}
            width={settings.customSettings.rightDock.width}
            theme={effectiveTheme}
            disabledMessage={projectToolsDisabledMessage}
            terminalDisabledMessage={terminalDisabledMessage}
            projectState={rightDockProjectState}
            fileTreeState={getRightDockFileTreeState(
              settings.customSettings,
              terminalProjectPathKey,
            )}
            sshHosts={settings.ssh.hosts}
            associatedSshHostIds={associatedSshHostIds}
            client={terminalClient}
            gitClient={gitClient}
            gitWriteEnabled={settings.remote.enableWebGit}
            gitDisabledMessage={gitDisabledMessage}
            tunnelClient={isAgentMode ? api : null}
            tunnelEnabled={tunnelEnabled}
            tunnelDisabledMessage={tunnelDisabledMessage}
            tunnelRefreshToken={tunnelRefreshToken}
            onWidthChange={(nextWidth) =>
              setSettings((prev) => updateRightDockWidth(prev, nextWidth))
            }
            onProjectStateChange={(updater) =>
              setSettings((prev) => updateRightDockProjectState(prev, terminalProjectPathKey, updater))
            }
            onFileTreeStateChange={(patch) =>
              setSettings((prev) =>
                updateRightDockFileTreeState(prev, terminalProjectPathKey, patch),
              )
            }
            onSshProjectHostIdsChange={(hostIds) =>
              setSettings((prev) => updateSshProjectHostIds(prev, terminalProjectPathKey, hostIds))
            }
            onOpenSshSession={handleOpenSshTerminal}
            onSessionsChange={handleProjectTerminalSessionsChange}
            onInsertFileMention={(path, kind) => {
              composerRef.current?.insertFileMention(path, kind);
              composerRef.current?.focus();
            }}
            onOpenFile={handleOpenWorkspaceFile}
            onInsertCommitMention={(commit) => {
              composerRef.current?.insertCommitMention(commit);
              composerRef.current?.focus();
            }}
            onInsertGitFileMention={(file) => {
              composerRef.current?.insertGitFileMention(file);
              composerRef.current?.focus();
            }}
            onClose={() => setRightDockOpen(false)}
          />
        ) : null}

        {settingsOpen ? (
          <div
            className={`gateway-settings-overlay ${
              overlay === "open" ? "gateway-settings-overlay-open" : ""
            }`}
            onTransitionEnd={handleSettingsTransitionEnd}
          >
            <SettingsPage
              settings={settings}
              setSettings={setSettings}
              saveState={settingsSaveState}
              onBack={closeSettings}
              initialSection={settingsSection}
              hiddenSections={["remote"]}
            />
          </div>
        ) : null}
      </div>
    </LocaleContext.Provider>
  );
}
