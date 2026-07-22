import { ChevronUp, LogOut, Settings, User } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelayBalance, formatRelayTokenCount } from "@/lib/relay/client";

type UserMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userMenuLabel: string;
  userAvatarLabel: string;
  email: string;
  balance?: number;
  todayTokens?: number;
  avatarUrl?: string;
  online: boolean;
  onOpenSettings: () => void;
  onLogout: () => void;
};

export function UserMenu(props: UserMenuProps) {
  const {
    open,
    onOpenChange,
    userMenuLabel,
    userAvatarLabel,
    email,
    balance,
    todayTokens,
    avatarUrl,
    online,
    onOpenSettings,
    onLogout,
  } = props;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2 text-foreground shadow-none hover:bg-foreground/[0.08]"
          title="用户菜单"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-background">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              userAvatarLabel || <User className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[calc(13px*var(--zone-font-scale,1))] font-medium">
              {userMenuLabel}
            </span>
            <span className="block truncate text-[calc(11px*var(--zone-font-scale,1))] font-normal text-muted-foreground">
              {email}
            </span>
          </span>
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
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
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                userAvatarLabel || <User className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{userMenuLabel}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{email}</div>
            </div>
          </div>
        </DropdownMenuLabel>
        <div className="mx-1 mb-1 space-y-1 rounded-md bg-muted/55 px-2.5 py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">余额</span>
            <span className="max-w-[150px] truncate font-medium text-foreground">
              {formatRelayBalance(balance)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">今日 Token</span>
            <span className="max-w-[150px] truncate font-medium text-foreground">
              {formatRelayTokenCount(todayTokens)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">状态</span>
            <span className="font-medium text-foreground">{online ? "在线" : "离线"}</span>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings} className="gap-2 rounded-md">
          <Settings className="h-4 w-4" />
          设置
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onLogout}
          className="gap-2 rounded-md text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          退出账户
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
