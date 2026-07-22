import type { AppUpdateController } from "../../lib/appUpdates";
import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";
import type { AppSettings } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "account"
  | "system"
  | "shortcuts"
  | "systemTools"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "remote"
  | "about";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  hiddenSections?: SectionId[];
  appUpdate: AppUpdateController;
  relayUser: RelayUser;
  relayStats: RelayDashboardStats | null;
  onRelayUserChange: (user: RelayUser) => void;
  onRelayStatsChange: (stats: RelayDashboardStats) => void;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
};
