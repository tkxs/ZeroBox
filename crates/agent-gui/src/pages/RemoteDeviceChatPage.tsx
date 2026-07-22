import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Bot, Edit3, Loader2, MessageSquare, Pin, Square, Trash2 } from "../components/icons";
import type { AppSettings } from "../lib/settings";
import { ConfirmDeletePopover } from "../components/ui/confirm-action-popover";
import {
  desktopGatewayOrigin,
  type DesktopConversationRoute,
  type DesktopEnvironment,
  type DesktopWorkspace,
  encodeDesktopSelectionCredential,
  getDesktopConversationRoutes,
} from "../lib/relay/desktopExecution";
import {
  remoteConversationStorageKey,
  remoteProjectStorageKey,
} from "../lib/relay/remoteDeviceState";
import { getRelayAccessToken } from "../lib/relay/client";
import { cn } from "../lib/shared/utils";
import { Textarea } from "../components/ui/textarea";
import { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { ConversationSummary, ChatQueueSnapshot } from "@/lib/gatewayTypes";
import type {
  ConversationStreamEvent,
  ConversationSubscribeResult,
} from "@/lib/chat/stream/streamTypes";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import type { ChatEntry } from "@/lib/chatUi";

type Props = {
  settings: AppSettings;
  environment: DesktopEnvironment;
  selectionLease: string;
  headerLeadingActions?: ReactNode;
};

type RemoteConversation = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  isPinned: boolean;
  summary?: string;
};

function toConversation(item: ConversationSummary): RemoteConversation {
  return {
    id: item.id,
    title: item.title || "新对话",
    cwd: item.cwd?.trim() ?? "",
    updatedAt: item.updated_at,
    isPinned: item.is_pinned === true,
  };
}

function routeToConversation(item: DesktopConversationRoute): RemoteConversation {
  return {
    id: item.conversation_id,
    title: item.title || "新对话",
    cwd: "",
    updatedAt: Date.parse(item.updated_at) || 0,
    isPinned: false,
    summary: item.summary,
  };
}

function parseSnapshotEntries(raw: string): ChatEntry[] {
  if (!raw.trim()) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as ChatEntry[]) : [];
  } catch {
    return [];
  }
}

function appendStreamEvent(entries: ChatEntry[], event: ConversationStreamEvent): ChatEntry[] {
  if (event.type === "snapshot") {
    return parseSnapshotEntries(event.entries_json ?? "");
  }
  if (event.type === "user_message") {
    const text = event.message?.trim() ?? "";
    const last = entries.at(-1);
    if (text && last?.kind === "user" && last.text === text) {
      return entries;
    }
    return text
      ? [
          ...entries,
          {
            id: `remote-user-${event.seq ?? crypto.randomUUID()}`,
            kind: "user",
            text,
            attachments: [],
          },
        ]
      : entries;
  }
  if (event.type === "token") {
    const last = entries.at(-1);
    if (last?.kind === "assistant") {
      return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
    }
    return [
      ...entries,
      {
        id: `remote-assistant-${event.run_id ?? ""}-${event.seq ?? crypto.randomUUID()}`,
        kind: "assistant",
        text: event.text,
      },
    ];
  }
  if (event.type === "thinking" && event.text.trim()) {
    return [
      ...entries,
      {
        id: `remote-thinking-${event.run_id ?? ""}-${event.seq ?? crypto.randomUUID()}`,
        kind: "thinking",
        text: event.text,
      },
    ];
  }
  if (event.type === "error") {
    return [
      ...entries,
      {
        id: `remote-error-${event.run_id ?? ""}-${event.seq ?? crypto.randomUUID()}`,
        kind: "error",
        text: event.message,
      },
    ];
  }
  return entries;
}

function applySync(entries: ChatEntry[], sync: ConversationSubscribeResult) {
  let next = sync.reset ? [] : entries;
  if (sync.snapshot?.entriesJson) {
    next = parseSnapshotEntries(sync.snapshot.entriesJson);
  }
  for (const event of sync.events) {
    next = appendStreamEvent(next, event);
  }
  return next;
}

function entryText(entry: ChatEntry) {
  switch (entry.kind) {
    case "user":
    case "assistant":
    case "thinking":
    case "error":
      return entry.text;
    case "checkpoint":
      return entry.content;
    case "tool_call":
    case "tool_result":
      return entry.summary || entry.text;
    case "hosted_search":
      return entry.hostedSearch.queries?.join(", ") || "联网搜索";
  }
}

export function RemoteDeviceChatPage({
  settings,
  environment,
  selectionLease,
  headerLeadingActions,
}: Props) {
  const orderedProjects = useMemo(
    () =>
      [...environment.workspaces].sort(
        (left, right) =>
          Number(right.is_pinned === true) - Number(left.is_pinned === true) ||
          (right.pinned_at ?? 0) - (left.pinned_at ?? 0) ||
          (right.updated_at ?? 0) - (left.updated_at ?? 0) ||
          left.name.localeCompare(right.name),
      ),
    [environment.workspaces],
  );
  const projects = useMemo(
    () => orderedProjects.filter((project) => !project.archived),
    [orderedProjects],
  );
  const archivedProjects = useMemo(
    () => orderedProjects.filter((project) => project.archived),
    [orderedProjects],
  );
  const projectStorageKey = remoteProjectStorageKey(environment.device_id);
  const [projectId, setProjectId] = useState<string | null>(
    () => localStorage.getItem(projectStorageKey) || null,
  );
  const activeProject =
    projects.find((project) => project.id === projectId && !project.missing) ?? null;
  const [conversations, setConversations] = useState<RemoteConversation[]>([]);
  const [conversationId, setConversationId] = useState<string>(() => {
    const key = remoteConversationStorageKey(environment.device_id, projectId);
    return localStorage.getItem(key) || crypto.randomUUID();
  });
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [queues, setQueues] = useState<Map<string, ChatQueueSnapshot>>(() => new Map());
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem(
      remoteConversationStorageKey(environment.device_id, projectId),
      conversationId,
    );
  }, [conversationId, environment.device_id, projectId]);

  const api = useMemo(() => {
    if (!environment.online || !selectionLease) return null;
    return new GatewayWebSocketClient(
      encodeDesktopSelectionCredential(selectionLease, environment.device_id),
      {
        origin: desktopGatewayOrigin(settings),
        desktopAccessToken: getRelayAccessToken(),
        clientName: "desktop-controller",
      },
    );
  }, [
    environment.device_id,
    environment.online,
    selectionLease,
    settings.remote.gatewayUrl,
    settings.remote.grpcPort,
  ]);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (api) {
        const response = await api.listHistory(
          1,
          200,
          activeProject?.path ? { cwd: activeProject.path } : { cwdEmpty: true },
        );
        setConversations(
          response.conversations
            .map(toConversation)
            .sort(
              (left, right) =>
                Number(right.isPinned) - Number(left.isPinned) || right.updatedAt - left.updatedAt,
            ),
        );
        setRunningIds(
          new Set(
            (response.running_conversations ?? []).map((item) => item.conversation_id.trim()),
          ),
        );
      } else {
        const routes = await getDesktopConversationRoutes(settings, environment.device_id);
        setConversations(
          routes
            .filter((item) =>
              activeProject
                ? item.workspace_id === activeProject.id
                : item.workspace_id === "unknown",
            )
            .map(routeToConversation),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载远程会话失败");
    } finally {
      setLoading(false);
    }
  }, [activeProject?.id, activeProject?.path, api, environment.device_id, settings]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!api) {
      setConnected(false);
      return;
    }
    const cleanups = [
      api.subscribeConnection(setConnected),
      api.subscribeHistory(() => void loadConversations()),
      api.subscribeChatActivity((activity) => {
        setRunningIds((current) => {
          const next = new Set(current);
          if (activity.running) next.add(activity.conversationId);
          else next.delete(activity.conversationId);
          return next;
        });
      }),
      api.subscribeChatQueue((snapshot) => {
        setQueues((current) => new Map(current).set(snapshot.conversationId, snapshot));
      }),
    ];
    void api.getStatus().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "连接远程设备失败");
    });
    return () => {
      for (const cleanup of cleanups) cleanup();
      api.dispose();
    };
  }, [api, loadConversations]);

  useEffect(() => {
    if (!api || !conversationId) return;
    return api.subscribeConversationStream(conversationId, {
      onSync(sync) {
        setEntries((current) => applySync(current, sync));
        setRunningIds((current) => {
          const next = new Set(current);
          if (sync.activity) next.add(conversationId);
          else next.delete(conversationId);
          return next;
        });
      },
      onEvent(event) {
        setEntries((current) => appendStreamEvent(current, event));
        if (event.type === "run_started" || event.type === "run_queued") {
          setRunningIds((current) => new Set(current).add(conversationId));
        }
        if (event.type === "run_finished") {
          setRunningIds((current) => {
            const next = new Set(current);
            next.delete(conversationId);
            return next;
          });
          void loadConversations();
        }
      },
    });
  }, [api, conversationId, loadConversations]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  async function openConversation(id: string) {
    if (!api) return;
    setConversationId(id);
    setEntries([]);
    setError("");
    try {
      const detail = await api.getHistory(id);
      setEntries(await parseHistoryMessagesJsonAsync(detail.messages_json));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载会话内容失败");
    }
  }

  function selectProject(project: DesktopWorkspace | null) {
    const nextId = project?.id ?? null;
    setProjectId(nextId);
    if (nextId) localStorage.setItem(projectStorageKey, nextId);
    else localStorage.removeItem(projectStorageKey);
    const conversationKey = remoteConversationStorageKey(environment.device_id, nextId);
    const nextConversationId = localStorage.getItem(conversationKey) || crypto.randomUUID();
    localStorage.setItem(conversationKey, nextConversationId);
    setConversationId(nextConversationId);
    setEntries([]);
  }

  function selectConversation(id: string) {
    localStorage.setItem(remoteConversationStorageKey(environment.device_id, projectId), id);
    void openConversation(id);
  }

  function startConversation() {
    const id = crypto.randomUUID();
    localStorage.setItem(remoteConversationStorageKey(environment.device_id, projectId), id);
    setConversationId(id);
    setEntries([]);
  }

  async function renameConversation() {
    const title = renaming?.title.trim();
    if (!api || !renaming || !title) return;
    try {
      await api.renameHistory(renaming.id, title);
      setRenaming(null);
      await loadConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重命名失败");
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !api || !connected) return;
    const wasRunning = runningIds.has(conversationId);
    setDraft("");
    setEntries((current) => [
      ...current,
      { id: `local-${crypto.randomUUID()}`, kind: "user", text, attachments: [] },
    ]);
    try {
      await api.chatCommand({
        type: "chat.submit",
        message: text,
        conversationId,
        systemSettings: {
          executionMode: activeProject ? "tools" : "text",
          workdir: activeProject?.path ?? "",
          selectedSystemTools: [],
        },
        queuePolicy: wasRunning ? "append" : "auto",
      });
      setRunningIds((current) => new Set(current).add(conversationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    }
  }

  const running = runningIds.has(conversationId);
  const queueCount = queues.get(conversationId)?.items.length ?? 0;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="flex w-[min(280px,42vw)] min-w-[180px] shrink-0 flex-col border-r border-border/60 bg-muted/20">
        <div className="flex h-12 items-center gap-2 border-b border-border/60 px-3">
          {headerLeadingActions}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{environment.name}</span>
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
        </div>
        <div className="border-b border-border/60 p-2">
          <button
            type="button"
            onClick={() => selectProject(null)}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
              !activeProject ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <MessageSquare className="h-4 w-4" />
            聊天
          </button>
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              disabled={project.missing}
              title={project.path}
              onClick={() => selectProject(project)}
              className={cn(
                "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm disabled:opacity-40",
                activeProject?.id === project.id ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <Bot className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {project.is_pinned ? <Pin className="h-3 w-3" /> : null}
            </button>
          ))}
          {archivedProjects.map((project) => (
            <div
              key={project.id}
              title={project.path}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground/55"
            >
              <Bot className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">会话</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={startConversation}
            title="新对话"
          >
            <MessageSquare className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading ? (
            <div className="flex justify-center p-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          {conversations.map((item) => (
            <div
              key={item.id}
              className={cn(
                "group flex items-center rounded-md",
                item.id === conversationId ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <button
                type="button"
                disabled={!api}
                onClick={() => selectConversation(item.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
              >
                {runningIds.has(item.id) ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.title}</span>
                  {item.summary ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.summary}
                    </span>
                  ) : null}
                </span>
              </button>
              {api ? (
                <div className="hidden items-center pr-1 group-hover:flex">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="重命名"
                    onClick={() => setRenaming({ id: item.id, title: item.title })}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title={item.isPinned ? "取消置顶" : "置顶"}
                    onClick={() =>
                      void api.pinHistory(item.id, !item.isPinned).then(loadConversations)
                    }
                  >
                    <Pin className="h-3.5 w-3.5" />
                  </Button>
                  <ConfirmDeletePopover
                    name={item.title}
                    onConfirm={() => void api.deleteHistory(item.id).then(loadConversations)}
                  >
                    {() => (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </ConfirmDeletePopover>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-border/60 px-4">
          <span className="truncate text-sm font-medium">
            {activeProject ? activeProject.name : "聊天"}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {activeProject?.path ?? "不使用文件、Shell、Git 和终端能力"}
          </span>
          {queueCount > 0 ? (
            <span className="rounded bg-muted px-2 py-1 text-xs">队列 {queueCount}</span>
          ) : null}
          {!environment.online ? (
            <span className="text-xs text-muted-foreground">设备离线，仅显示摘要</span>
          ) : !selectionLease ? (
            <span className="text-xs text-muted-foreground">控制权限已过期，请重新验证</span>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8">
            {entries.length === 0 ? (
              <div className="py-24 text-center text-sm text-muted-foreground">
                {api
                  ? "开始一个新对话"
                  : environment.online
                    ? "重新选择此设备并验证后可继续"
                    : "设备上线后可读取完整会话内容"}
              </div>
            ) : null}
            {entries.map((entry) => {
              const text = entryText(entry);
              if (!text) return null;
              const user = entry.kind === "user";
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "max-w-[90%]",
                    user
                      ? "ml-auto rounded-md bg-muted px-4 py-3"
                      : entry.kind === "error"
                        ? "rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive"
                        : "mr-auto w-full",
                  )}
                >
                  {user ? (
                    <p className="whitespace-pre-wrap text-sm">{text}</p>
                  ) : (
                    <Markdown
                      content={text}
                      renderMode={running ? "streaming" : "static"}
                      showCaret={running && entry === entries.at(-1)}
                      readOnly
                    />
                  )}
                </div>
              );
            })}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        <div className="border-t border-border/60 p-4">
          {error ? (
            <p className="mx-auto mb-2 max-w-3xl text-xs text-destructive">{error}</p>
          ) : null}
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              value={draft}
              disabled={!api || !connected}
              placeholder={
                !environment.online
                  ? "设备离线"
                  : activeProject
                    ? `在 ${activeProject.name} 中提问`
                    : "发送消息"
              }
              className="max-h-40 min-h-10 flex-1 resize-none"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {running ? (
              <Button
                size="icon"
                variant="outline"
                title="停止"
                onClick={() => void api?.cancelChat(conversationId)}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : null}
            <Button disabled={!draft.trim() || !api || !connected} onClick={() => void send()}>
              {running ? "加入队列" : "发送"}
            </Button>
          </div>
        </div>
      </main>
      {renaming ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4">
          <form
            className="w-full max-w-sm rounded-md border bg-background p-5 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              void renameConversation();
            }}
          >
            <h2 className="text-sm font-semibold">重命名会话</h2>
            <Input
              className="mt-4"
              value={renaming.title}
              onChange={(event) =>
                setRenaming((current) =>
                  current ? { ...current, title: event.target.value } : current,
                )
              }
              autoFocus
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                取消
              </Button>
              <Button type="submit" disabled={!renaming.title.trim()}>
                保存
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
