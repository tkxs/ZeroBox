// Conversation summary shape shared with the gateway's history.list /
// history.event payloads. The webui only consumes summaries — transcript
// content arrives as messages_json parsed by lib/chatUi. The full history
// store (persistence, wire records, Tauri commands) lives in agent-gui.
export type ChatHistorySummary = {
  id: string;
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
  isPinned?: boolean;
  pinnedAt?: number | null;
  isShared?: boolean;
  isPending?: boolean;
};
