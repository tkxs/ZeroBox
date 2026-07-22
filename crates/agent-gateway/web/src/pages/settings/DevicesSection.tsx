import { useCallback, useEffect, useState } from "react";
import { Loader2, MonitorSmartphone, Pencil, RefreshCw, Trash2 } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  type ExecutionEnvironment,
  getExecutionEnvironments,
  renameExecutionDevice,
  revokeExecutionDevice,
} from "../../lib/executionTargets";

function formatLastSeen(value?: string) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "暂无记录"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function DevicesSection() {
  const [devices, setDevices] = useState<ExecutionEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState("");

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const environments = await getExecutionEnvironments();
      setDevices(environments.filter((item) => item.runtime_kind === "device_agent"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载设备失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  async function saveName(device: ExecutionEnvironment) {
    const name = draftName.trim();
    if (!device.device_id || !name) return;
    setBusyId(device.device_id);
    setError("");
    try {
      await renameExecutionDevice(device.device_id, name);
      setDevices((current) =>
        current.map((item) => (item.device_id === device.device_id ? { ...item, name } : item)),
      );
      setEditingId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重命名设备失败");
    } finally {
      setBusyId("");
    }
  }

  async function revoke(device: ExecutionEnvironment) {
    if (!device.device_id || !window.confirm(`确定撤销“${device.name}”吗？该设备会立即断开。`))
      return;
    setBusyId(device.device_id);
    setError("");
    try {
      await revokeExecutionDevice(device.device_id);
      setDevices((current) => current.filter((item) => item.device_id !== device.device_id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销设备失败");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="space-y-4 border-t border-border/70 pt-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">我的设备</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void loadDevices()}
          disabled={loading}
          title="刷新设备"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!loading && devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          尚未注册设备。登录 ZeroBox 桌面客户端后，设备会自动出现在这里。
        </p>
      ) : null}

      <div className="grid gap-2">
        {devices.map((device) => {
          const id = device.device_id ?? "";
          const editing = editingId === id;
          return (
            <div
              key={id}
              className="grid min-w-0 gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${device.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                  />
                  {editing ? (
                    <form
                      className="flex min-w-0 flex-1 gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveName(device);
                      }}
                    >
                      <Input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        maxLength={100}
                        autoFocus
                        className="h-8 min-w-0"
                      />
                      <Button type="submit" size="sm" disabled={!draftName.trim() || busyId === id}>
                        保存
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingId("")}
                      >
                        取消
                      </Button>
                    </form>
                  ) : (
                    <span className="truncate text-sm font-medium" title={device.name}>
                      {device.name}
                    </span>
                  )}
                </div>
                {!editing ? (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-4 text-xs text-muted-foreground">
                    <span>{device.online ? "在线" : "离线"}</span>
                    <span>
                      {[device.platform, device.version].filter(Boolean).join(" · ") || "未知平台"}
                    </span>
                    <span>最后活动：{formatLastSeen(device.last_seen_at)}</span>
                  </div>
                ) : null}
              </div>
              {!editing ? (
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="重命名设备"
                    disabled={Boolean(busyId)}
                    onClick={() => {
                      setEditingId(id);
                      setDraftName(device.name);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="撤销设备"
                    disabled={Boolean(busyId)}
                    onClick={() => void revoke(device)}
                    className="text-destructive hover:text-destructive"
                  >
                    {busyId === id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
