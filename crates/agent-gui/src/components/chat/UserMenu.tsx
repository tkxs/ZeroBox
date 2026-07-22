import {
  formatRelayBalance,
  formatRelayTokenCount,
  type RelayDashboardStats,
  type RelayUser,
} from "../../lib/relay/client";
import { ChevronUp, LogOut, Settings } from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type UserMenuProps = {
  user: RelayUser;
  stats: RelayDashboardStats | null;
  onOpenSettings: () => void;
  onLogout: () => void;
};

export function UserMenu({ user, stats, onOpenSettings, onLogout }: UserMenuProps) {
  const displayName = user.username?.trim() || user.email.split("@")[0] || `用户 ${user.id}`;
  const avatarLabel = displayName.slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2 text-foreground shadow-none hover:bg-foreground/[0.08]"
            title="用户菜单"
          />
        }
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-background">
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
          ) : (
            avatarLabel
          )}
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[calc(13px*var(--zone-font-scale,1))] font-medium">
            {displayName}
          </span>
          <span className="block truncate text-[calc(11px*var(--zone-font-scale,1))] font-normal text-muted-foreground">
            {user.email}
          </span>
        </span>
        <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[256px] rounded-lg border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-popover/90"
      >
        <DropdownMenuLabel className="px-2.5 py-2 font-normal">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground text-sm font-semibold text-background">
              {user.avatar_url ? (
                <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
              ) : (
                avatarLabel
              )}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{displayName}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</div>
            </div>
          </div>
        </DropdownMenuLabel>
        <div className="mx-1 mb-1 space-y-1 rounded-md bg-muted/55 px-2.5 py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">余额</span>
            <span className="font-medium text-foreground">{formatRelayBalance(user.balance)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">今日 Token</span>
            <span className="max-w-[150px] truncate font-medium text-foreground">
              {formatRelayTokenCount(stats?.today_tokens)}
            </span>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings} className="gap-2 rounded-md">
          <Settings className="h-4 w-4" />
          设置
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onLogout}
          className="gap-2 rounded-md text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          退出账户
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
