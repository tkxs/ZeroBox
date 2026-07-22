import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";
import type { AppSettings } from "../../lib/settings";
import type { WebSettingsSaveState } from "../../lib/webSettings";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "account"
  | "system"
  | "systemTools"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "remote";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: WebSettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  hiddenSections?: SectionId[];
  relayUser: RelayUser;
  relayStats: RelayDashboardStats | null;
  onRelayUserChange: (user: RelayUser) => void;
  onRelayStatsChange: (stats: RelayDashboardStats) => void;
  runtimeKind?: "web_chat" | "device_agent";
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
};
