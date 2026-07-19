import { type FormEvent, useState } from "react";
import { Copy, Loader2, Lock, X } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type RelayKeyCopyDialogProps = {
  keyName: string | null;
  onClose: () => void;
  onConfirm: (password: string) => Promise<void>;
};

export function RelayKeyCopyDialog({ keyName, onClose, onConfirm }: RelayKeyCopyDialogProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!keyName) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError("请输入当前 USA-零 账户密码。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密码验证失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" aria-label="关闭" onClick={onClose} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="relay-copy-title"
        className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-2xl"
        onSubmit={submit}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Lock className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 id="relay-copy-title" className="text-sm font-semibold">
                验证密码后复制
              </h2>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={keyName}>
                {keyName}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-5 space-y-2">
          <Label htmlFor="relay-copy-password">USA-零 账户密码</Label>
          <Input
            id="relay-copy-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="mt-3 text-xs leading-5 text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
            验证并复制
          </Button>
        </div>
      </form>
    </div>
  );
}
