import { useMemo, useState } from "react";
import { ChevronDown, Cloud, Loader2, Lock, MonitorSmartphone, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ExecutionEnvironment,
  type ExecutionSelection,
  type ExecutionWorkspace,
  resolveExecutionTarget,
} from "@/lib/executionTargets";

type Props = {
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection | null;
  disabled?: boolean;
  onSwitch: (
    environment: ExecutionEnvironment,
    workspace: ExecutionWorkspace,
    password: string,
  ) => Promise<unknown>;
};

export function ExecutionEnvironmentSwitcher({
  environments,
  selection,
  disabled,
  onSwitch,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{
    environment: ExecutionEnvironment;
    workspace: ExecutionWorkspace;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const current = useMemo(
    () => resolveExecutionTarget(environments, selection),
    [environments, selection],
  );

  function choose(environment: ExecutionEnvironment, workspace: ExecutionWorkspace) {
    if (!environment.online || disabled) return;
    if (
      environment.runtime_kind === selection?.runtime_kind &&
      (environment.device_id ?? "") === (selection.device_id ?? "") &&
      workspace.id === selection.workspace_id
    ) {
      setOpen(false);
      return;
    }
    setPending({ environment, workspace });
    setPassword("");
    setError("");
    setOpen(false);
  }

  async function confirm() {
    if (!pending || !password) return;
    setSubmitting(true);
    setError("");
    try {
      await onSwitch(pending.environment, pending.workspace, password);
      setPending(null);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "身份验证失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="relative">
        <Button
          type="button"
          variant="ghost"
          className="h-8 max-w-[min(18rem,42vw)] gap-1.5 rounded-lg px-2 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          {current.environment?.runtime_kind === "web_chat" ? (
            <Cloud className="h-4 w-4 shrink-0" />
          ) : (
            <MonitorSmartphone className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate text-xs font-medium">
            {current.environment?.name ?? "选择执行环境"}
            {current.workspace ? ` / ${current.workspace.name}` : ""}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>

        {open && (
          <div className="absolute left-0 z-[70] mt-2 max-h-[min(520px,70vh)] w-[min(380px,92vw)] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border bg-popover p-1 shadow-xl">
            {environments.map((environment) => (
              <div key={`${environment.runtime_kind}:${environment.device_id ?? "web"}`}>
                <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-xs font-medium">
                  {environment.runtime_kind === "web_chat" ? (
                    <Cloud className="h-3.5 w-3.5" />
                  ) : (
                    <MonitorSmartphone className="h-3.5 w-3.5" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                  <span
                    className={environment.online ? "text-emerald-600" : "text-muted-foreground"}
                  >
                    {environment.online ? "在线" : "离线"}
                  </span>
                </div>
                {environment.workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    disabled={!environment.online}
                    className="flex w-full items-center gap-2 rounded-sm px-7 py-2 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => choose(environment, workspace)}
                  >
                    <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                    {workspace.path && (
                      <span className="max-w-[160px] truncate text-muted-foreground">
                        {workspace.path}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-[380px] rounded-md border bg-background p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <Lock className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">验证账户密码</h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {pending.environment.name} / {pending.workspace.name}
                </p>
              </div>
              <button
                type="button"
                title="关闭"
                className="text-muted-foreground"
                onClick={() => setPending(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <Input
              className="mt-5"
              type="password"
              autoComplete="current-password"
              value={password}
              placeholder="当前密码"
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
              <Button disabled={!password || submitting} onClick={() => void confirm()}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                验证并切换
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
