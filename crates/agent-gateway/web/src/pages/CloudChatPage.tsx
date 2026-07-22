import {
  type ChangeEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildTextFromComposerDraft } from "@/app/chatDraft";
import { UserMenu } from "@/app/UserMenu";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import {
  ChatHistorySidebar,
  type ChatHistorySidebarMutationKind,
} from "@/components/chat/ChatHistorySidebar";
import type { MentionComposerHandle } from "@/components/chat/MentionComposer";
import { ExecutionEnvironmentSwitcher } from "@/components/ExecutionEnvironmentSwitcher";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildModelOptions } from "@/lib/chat/chatPageHelpers";
import type { TranscriptRow } from "@/lib/chat/transcript/types";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type {
  ExecutionEnvironment,
  ExecutionSelection,
  ExecutionWorkspace,
} from "@/lib/executionTargets";
import type { ModelOption } from "@/lib/providers/llm";
import { toModelValue } from "@/lib/providers/llm";
import {
  getRelayDashboardStats,
  type RelayDashboardStats,
  type RelayUser,
} from "@/lib/relay/client";
import {
  type AppSettings,
  type ChatRuntimeControls,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  getNextTheme,
  type ReasoningLevel,
} from "@/lib/settings";
import type { SidebarConversation } from "@/lib/sidebar/types";
import type { WebSettingsSaveState } from "@/lib/webSettings";
import { ChatComposerBar } from "@/pages/chat/ChatComposerBar";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { SettingsPage } from "@/pages/SettingsPage";

type Conversation = {
  id: string;
  title: string;
  model: string;
  created_at?: string;
  updated_at: string;
};
type Message = { id: string; role: "user" | "assistant"; content: unknown };
type Attachment = { id: string; name: string; type: string; size: number; data: string };
type WebSettings = { model: string; reasoning_effort: "low" | "medium" | "high" };
type DeviceConversation = {
  conversation_id: string;
  device_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  updated_at: string;
  device_name?: string;
  device_online: boolean;
};

type Props = {
  user: RelayUser;
  onUserChange: (user: RelayUser) => void;
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection | null;
  settings: AppSettings;
  setSettings: (updater: (previous: AppSettings) => AppSettings) => void;
  settingsSaveState: WebSettingsSaveState;
  onSwitch: (
    environment: ExecutionEnvironment,
    workspace: ExecutionWorkspace,
    password: string,
  ) => Promise<unknown>;
  onLogout: () => void;
};

const EMPTY_MUTATIONS = new Map<string, ChatHistorySidebarMutationKind>();
const EMPTY_PATHS = new Set<string>();
const DEVICE_ROUTE_PREFIX = "device-route:";

async function webChatRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `请求失败 (HTTP ${response.status})`);
  }
  return payload;
}

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: string } =>
      Boolean(part && typeof part === "object"),
    )
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function toEpoch(value: string | undefined) {
  const timestamp = value ? new Date(value).getTime() : Date.now();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function attachmentKind(attachment: Attachment): PendingUploadedFile["kind"] {
  return attachment.type.startsWith("image/") ? "image" : "text";
}

export function CloudChatPage({
  user,
  onUserChange,
  environments,
  selection,
  settings,
  setSettings,
  settingsSaveState,
  onSwitch,
  onLogout,
}: Props) {
  const [accountStats, setAccountStats] = useState<RelayDashboardStats | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [deviceConversations, setDeviceConversations] = useState<DeviceConversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState("gpt-5.1");
  const [reasoning, setReasoning] = useState<ReasoningLevel>("medium");
  const [runtimeControls, setRuntimeControls] = useState<ChatRuntimeControls>(() => ({
    ...DEFAULT_CHAT_RUNTIME_CONTROLS,
    reasoning: "medium",
  }));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 821px)").matches,
  );
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pinnedConversationIds, setPinnedConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<MentionComposerHandle | null>(null);

  const refreshConversations = useCallback(async () => {
    const response = await webChatRequest<{ conversations: Conversation[] }>(
      "/api/web-chat/conversations",
    );
    setConversations(response.conversations);
    return response.conversations;
  }, []);

  async function saveWebSettings(nextModel: string, nextReasoning: ReasoningLevel) {
    const normalizedModel = nextModel.trim();
    if (!normalizedModel) return;
    await webChatRequest<{ settings: WebSettings }>("/api/web-settings", {
      method: "PATCH",
      body: JSON.stringify({ model: normalizedModel, reasoning_effort: nextReasoning }),
    });
  }

  useEffect(() => {
    setHistoryLoading(true);
    void Promise.all([
      refreshConversations(),
      webChatRequest<{ conversations: DeviceConversation[] }>("/api/conversation-routes").then(
        (response) => setDeviceConversations(response.conversations),
      ),
      getRelayDashboardStats().then(setAccountStats),
      webChatRequest<{ settings: WebSettings }>("/api/web-settings").then((response) => {
        setModel(response.settings.model);
        setReasoning(response.settings.reasoning_effort);
        setRuntimeControls((current) => ({
          ...current,
          reasoning: response.settings.reasoning_effort,
        }));
      }),
    ])
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setHistoryLoading(false));
  }, [refreshConversations]);

  useEffect(() => {
    if (!transcriptViewport) return;
    if (messages.length === 0) {
      transcriptViewport.scrollTop = 0;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      transcriptViewport.scrollTop = transcriptViewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, transcriptViewport]);

  async function createConversation() {
    if (streaming) return "";
    const response = await webChatRequest<{ conversation: Conversation }>(
      "/api/web-chat/conversations",
      { method: "POST", body: JSON.stringify({ model }) },
    );
    setConversations((current) => [response.conversation, ...current]);
    setConversationId(response.conversation.id);
    setMessages([]);
    setSidebarOpen(window.matchMedia("(min-width: 821px)").matches);
    return response.conversation.id;
  }

  async function openConversation(id: string) {
    if (streaming) return;
    if (id.startsWith(DEVICE_ROUTE_PREFIX)) {
      const routeId = id.slice(DEVICE_ROUTE_PREFIX.length);
      const route = deviceConversations.find((item) => item.conversation_id === routeId);
      setError(
        route?.device_online
          ? `请先切换到 ${route.device_name || "对应设备"} 的工作区，再打开完整对话。`
          : `${route?.device_name || "对应设备"} 当前离线，只能查看历史摘要。`,
      );
      return;
    }
    setConversationId(id);
    setHistoryLoading(true);
    try {
      const response = await webChatRequest<{ messages: Message[] }>(
        `/api/web-chat/conversations/${id}/messages`,
      );
      setMessages(response.messages);
      if (window.matchMedia("(max-width: 820px)").matches) setSidebarOpen(false);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function removeConversation(id: string) {
    if (streaming || id.startsWith(DEVICE_ROUTE_PREFIX)) return;
    await webChatRequest<void>(`/api/web-chat/conversations/${id}`, { method: "DELETE" });
    setConversations((current) => current.filter((item) => item.id !== id));
    if (conversationId === id) {
      setConversationId("");
      setMessages([]);
    }
  }

  async function renameConversation() {
    const id = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    if (!id || !title || id.startsWith(DEVICE_ROUTE_PREFIX)) return;
    try {
      const response = await webChatRequest<{ conversation: Conversation }>(
        `/api/web-chat/conversations/${id}`,
        { method: "PATCH", body: JSON.stringify({ title }) },
      );
      setConversations((current) =>
        current.map((item) => (item.id === id ? response.conversation : item)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function attachFileList(files: File[]) {
    const next: Attachment[] = [];
    for (const file of files.slice(0, 8)) {
      if (file.size > 8 * 1024 * 1024) {
        setError(`${file.name} 超过 8MB`);
        continue;
      }
      if (file.type.startsWith("image/")) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          data,
        });
      } else {
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type || "text/plain",
          size: file.size,
          data: await file.text(),
        });
      }
    }
    setAttachments((current) => [...current, ...next].slice(0, 8));
  }

  async function attachFiles(event: ChangeEvent<HTMLInputElement>) {
    await attachFileList(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  async function send() {
    const draft = composerRef.current?.getDraft();
    const text = draft ? buildTextFromComposerDraft(draft).trim() : "";
    if (streaming || (!text && attachments.length === 0)) return;
    setError("");
    const id = conversationId || (await createConversation());
    if (!id) return;
    const content: unknown = attachments.length
      ? [
          ...(text ? [{ type: "text", text }] : []),
          ...attachments.map((attachment) =>
            attachment.type.startsWith("image/")
              ? { type: "image_url", image_url: { url: attachment.data } }
              : { type: "text", text: `\n[${attachment.name}]\n${attachment.data}` },
          ),
        ]
      : text;
    const optimisticUser: Message = { id: crypto.randomUUID(), role: "user", content };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      optimisticUser,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    composerRef.current?.clear();
    setAttachments([]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/web-chat/completions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          conversation_id: id,
          model,
          reasoning_effort: reasoning,
          content,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.error?.message || payload?.error || `模型请求失败 (HTTP ${response.status})`,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            answer += delta;
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId ? { ...message, content: answer } : message,
              ),
            );
          }
        }
        if (done) break;
      }
      await refreshConversations();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "模型请求失败");
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  const transcriptRows = useMemo<TranscriptRow[]>(
    () =>
      messages.map((message) => {
        const text = messageText(message.content);
        if (message.role === "user") {
          return {
            key: message.id,
            origin: "history",
            kind: "user",
            text,
            attachments: [],
          };
        }
        return {
          key: message.id,
          origin: streaming && message.id === messages.at(-1)?.id ? "stream" : "history",
          kind: "assistant",
          turnKey: message.id,
          rounds: [
            {
              key: `${message.id}:round:1`,
              round: 1,
              runningToolCallIds: [],
              blocks: text ? [{ kind: "text", id: `${message.id}:text`, text }] : [],
            },
          ],
        };
      }),
    [messages, streaming],
  );

  const sidebarItems = useMemo<SidebarConversation[]>(() => {
    const cloud: SidebarConversation[] = conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      providerId: "web-chat",
      model: conversation.model,
      createdAt: toEpoch(conversation.created_at),
      updatedAt: toEpoch(conversation.updated_at),
      isPinned: pinnedConversationIds.has(conversation.id),
    }));
    const routes: SidebarConversation[] = deviceConversations.map((conversation) => ({
      id: `${DEVICE_ROUTE_PREFIX}${conversation.conversation_id}`,
      title: conversation.title,
      providerId: conversation.device_id,
      model: conversation.device_name || "设备历史",
      cwd: conversation.workspace_id,
      createdAt: toEpoch(conversation.updated_at),
      updatedAt: toEpoch(conversation.updated_at),
      isPending: true,
    }));
    return [...cloud, ...routes].sort(
      (left, right) =>
        Number(right.isPinned === true) - Number(left.isPinned === true) ||
        right.updatedAt - left.updatedAt,
    );
  }, [conversations, deviceConversations, pinnedConversationIds]);

  const runningConversationIds = useMemo(
    () => (streaming && conversationId ? new Set([conversationId]) : new Set<string>()),
    [conversationId, streaming],
  );
  const pendingUploadedFiles = useMemo<PendingUploadedFile[]>(
    () =>
      attachments.map((attachment) => ({
        relativePath: attachment.id,
        fileName: attachment.name,
        kind: attachmentKind(attachment),
        sizeBytes: attachment.size,
      })),
    [attachments],
  );
  const modelOption = useMemo<ModelOption>(
    () => ({
      value: toModelValue("web-chat", model),
      label: model,
      providerId: "web-chat",
      providerName: "USA-零",
      providerType: "codex",
      model,
    }),
    [model],
  );
  const modelOptions = useMemo(() => {
    const configured = buildModelOptions(settings, { floatSelectedFirst: false }).filter(
      (option) => option.providerType === "codex",
    );
    return configured.some((option) => option.model === model)
      ? configured
      : [modelOption, ...configured];
  }, [model, modelOption, settings]);
  const selectedModelValue =
    modelOptions.find((option) => option.model === model)?.value ?? modelOption.value;
  const userMenuLabel = user.username || user.email;
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();

  return (
    <AppErrorBoundary>
      <div className="gateway-shell">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="gateway-hidden-file-input"
          aria-label="选择附件"
          onChange={(event) => void attachFiles(event)}
        />
        <div className="gateway-editor-host">
          <ChatHistorySidebar
            items={sidebarItems}
            currentConversationId={conversationId}
            busyConversationIds={EMPTY_MUTATIONS}
            runningConversationIds={runningConversationIds}
            listStatus={historyLoading ? "loading" : "ready"}
            scopeKey="web-chat"
            totalItems={sidebarItems.length}
            hasMore={false}
            isLoadingMore={false}
            errorMessage={null}
            actionErrorMessage={error || null}
            renamingId={renamingId}
            renameDraft={renameDraft}
            isOpen={sidebarOpen}
            fontScale={settings.customSettings.fontScale.sidebar}
            activeView="chat"
            showProjects={false}
            showAgentHubs={false}
            missingProjectPathKeys={EMPTY_PATHS}
            runningProjectPathKeys={EMPTY_PATHS}
            onNewConversation={() => void createConversation()}
            onSelectConversation={(id) => void openConversation(id)}
            onStartRenaming={(item) => {
              setRenamingId(item.id);
              setRenameDraft(item.title);
            }}
            onRenameDraftChange={setRenameDraft}
            onCommitRename={() => void renameConversation()}
            onCancelRename={() => {
              setRenamingId(null);
              setRenameDraft("");
            }}
            onSetPinned={(id, pinned) =>
              setPinnedConversationIds((current) => {
                const next = new Set(current);
                if (pinned) next.add(id);
                else next.delete(id);
                return next;
              })
            }
            canShareConversations={false}
            sharedConversationCount={0}
            onShareConversation={() => undefined}
            onOpenSharedConversations={() => undefined}
            onDeleteConversation={(id) => void removeConversation(id)}
            onLoadMore={() => undefined}
            onCloseSidebar={() => setSidebarOpen(false)}
            accountMenu={
              <UserMenu
                open={userMenuOpen}
                onOpenChange={setUserMenuOpen}
                userMenuLabel={userMenuLabel}
                userAvatarLabel={userAvatarLabel}
                email={user.email}
                balance={user.balance}
                todayTokens={accountStats?.today_tokens}
                avatarUrl={user.avatar_url}
                online
                onOpenSettings={() => setAccountSettingsOpen(true)}
                onLogout={onLogout}
              />
            }
          />

          <main className="gateway-main-shell">
            <div className="gateway-main-backdrop" />
            <div
              className="gateway-chat-frame zone-font-scale"
              style={
                { "--zone-font-scale": settings.customSettings.fontScale.chat } as CSSProperties
              }
            >
              <ChatHeader
                settings={settings}
                hasModels
                currentModelLabel={model}
                modelOptions={modelOptions}
                selectedValue={selectedModelValue}
                sidebarOpen={sidebarOpen}
                onSelectModel={(next) => {
                  setModel(next.model);
                  void saveWebSettings(next.model, reasoning).catch((cause) =>
                    setError(String(cause)),
                  );
                }}
                onOpenSettings={() => setAccountSettingsOpen(true)}
                onToggleTheme={() =>
                  setSettings((current) => ({ ...current, theme: getNextTheme(current.theme) }))
                }
                onOpenSidebar={() => setSidebarOpen(true)}
                preThemeActions={
                  <ExecutionEnvironmentSwitcher
                    environments={environments}
                    selection={selection}
                    disabled={streaming}
                    onSwitch={onSwitch}
                  />
                }
              />
              {error && transcriptRows.length === 0 ? (
                <div className="gateway-banner-error">{error}</div>
              ) : null}
              <section className="gateway-transcript-stage">
                <div className="gateway-transcript-scroll-shell">
                  <ScrollArea
                    viewportRef={setTranscriptViewport}
                    className="gateway-transcript-scroll"
                  >
                    <GatewayTranscript
                      conversationId={conversationId}
                      rows={transcriptRows}
                      liveStartIndex={streaming ? Math.max(0, transcriptRows.length - 1) : -1}
                      activeTurnKey={streaming ? messages.at(-1)?.id : null}
                      error={error || null}
                      toolStatus={streaming ? "Vibing..." : null}
                      isStreaming={streaming}
                      isLoading={historyLoading}
                      hasModels
                      isAgentMode={false}
                      onOpenSettings={() => setAccountSettingsOpen(true)}
                      onSuggestionSelect={(text) => {
                        composerRef.current?.setText(text);
                        composerRef.current?.focus();
                      }}
                    />
                  </ScrollArea>
                </div>
                <ChatComposerBar
                  composerRef={composerRef}
                  isSending={streaming}
                  isUploadingFiles={false}
                  isInputDisabled={historyLoading}
                  allowUploadsWithoutWorkspace
                  inputPlaceholder="发送消息"
                  workdir=""
                  enabledSkills={[]}
                  isAgentMode={false}
                  chatRuntimeControls={runtimeControls}
                  reasoningOptions={["low", "medium", "high"]}
                  thinkingAlwaysOn={false}
                  onSend={() => void send()}
                  onStop={() => abortRef.current?.abort()}
                  onComposerBusyChange={() => undefined}
                  onChatRuntimeControlsChange={(patch) => {
                    setRuntimeControls((current) => ({ ...current, ...patch }));
                    if (patch.reasoning) {
                      setReasoning(patch.reasoning);
                      void saveWebSettings(model, patch.reasoning).catch((cause) =>
                        setError(String(cause)),
                      );
                    }
                  }}
                  onPickReadableFiles={() => fileRef.current?.click()}
                  onPasteFiles={(files) => void attachFileList(files)}
                  loadHistoryPrompts={() =>
                    messages
                      .filter((message) => message.role === "user")
                      .map((message) => messageText(message.content))
                      .filter(Boolean)
                  }
                  pendingUploadedFiles={pendingUploadedFiles}
                  onRemovePendingUpload={(id) =>
                    setAttachments((current) => current.filter((item) => item.id !== id))
                  }
                  queuedTurns={[]}
                  onRunQueuedTurnNow={() => undefined}
                  onMoveQueuedTurnUp={() => undefined}
                  onEditQueuedTurn={() => undefined}
                  onRemoveQueuedTurn={() => undefined}
                />
              </section>
            </div>
          </main>
        </div>

        {accountSettingsOpen ? (
          <div className="gateway-settings-overlay gateway-settings-overlay-open">
            <SettingsPage
              settings={settings}
              setSettings={setSettings}
              saveState={settingsSaveState}
              onBack={() => setAccountSettingsOpen(false)}
              initialSection="account"
              hiddenSections={["systemTools", "agents", "ssh", "memory", "hooks", "cron", "remote"]}
              relayUser={user}
              relayStats={accountStats}
              onRelayUserChange={onUserChange}
              onRelayStatsChange={setAccountStats}
              runtimeKind="web_chat"
            />
          </div>
        ) : null}
      </div>
    </AppErrorBoundary>
  );
}
