import { useMemo, useState } from "react";
import type { DesktopEnvironment } from "../lib/relay/desktopExecution";
import { ChevronDown, Loader2, Lock, MonitorSmartphone, X } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Props = {
  environments: DesktopEnvironment[];
  localDeviceId: string;
  selectedDeviceId: string;
  authorizedDeviceIds?: ReadonlySet<string>;
  onSwitch: (environment: DesktopEnvironment, password: string) => Promise<void>;
};

export function DesktopExecutionSwitcher({
  environments,
  localDeviceId,
  selectedDeviceId,
  authorizedDeviceIds = new Set(),
  onSwitch,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<DesktopEnvironment | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useMemo(() => {
    const environment =
      environments.find((item) => item.device_id === selectedDeviceId) ??
      environments.find((item) => item.device_id === localDeviceId);
    return environment;
  }, [environments, localDeviceId, selectedDeviceId]);

  async function confirm() {
    if (!pending || !password) return;
    setBusy(true);
    setError("");
    try {
      await onSwitch(pending, password);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="relative">
        <Button
          variant="outline"
          className="h-8 max-w-[min(260px,28vw)] gap-2 bg-background/95 px-3 shadow-sm max-[900px]:w-8 max-[900px]:px-0"
          title={current?.name ?? "此电脑"}
          onClick={() => setOpen((value) => !value)}
        >
          <MonitorSmartphone className="h-4 w-4" />
          <span className="truncate text-xs max-[900px]:hidden">
            {current?.device_id === localDeviceId ? "此电脑" : (current?.name ?? "此电脑")}
          </span>
          <ChevronDown className="h-3.5 w-3.5 max-[900px]:hidden" />
        </Button>
        {open && (
          <div className="absolute left-0 z-[70] mt-2 max-h-[60vh] w-[min(380px,90vw)] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border bg-popover p-1 shadow-xl">
            {environments.map((environment) => (
              <button
                type="button"
                key={environment.device_id}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (
                    environment.device_id === selectedDeviceId &&
                    (environment.device_id === localDeviceId ||
                      authorizedDeviceIds.has(environment.device_id))
                  ) {
                    setOpen(false);
                    return;
                  }
                  setOpen(false);
                  if (environment.device_id === localDeviceId) {
                    void onSwitch(environment, "");
                    return;
                  }
                  if (authorizedDeviceIds.has(environment.device_id)) {
                    void onSwitch(environment, "");
                    return;
                  }
                  if (!environment.online) {
                    void onSwitch(environment, "");
                    return;
                  }
                  setPending(environment);
                  setPassword("");
                  setError("");
                }}
              >
                <MonitorSmartphone className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate">
                  {environment.device_id === localDeviceId ? "此电脑" : environment.name}
                </span>
                <span className={environment.online ? "text-emerald-600" : "text-muted-foreground"}>
                  {environment.online ? "在线" : "离线"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {pending && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-[380px] rounded-md border bg-background p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                <Lock className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">验证账户密码</h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {pending.device_id === localDeviceId ? "此电脑" : pending.name}
                </p>
              </div>
              <button type="button" title="关闭" onClick={() => setPending(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <Input
              className="mt-5"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void confirm();
              }}
              autoFocus
            />
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button disabled={!password || busy} onClick={() => void confirm()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}验证并切换
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
