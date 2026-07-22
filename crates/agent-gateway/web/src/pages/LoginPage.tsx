import { ArrowRight, Key, Lock } from "../components/icons";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

type LoginPageProps = {
  token: string;
  error: string | null;
  isSubmitting: boolean;
  onTokenChange: (token: string) => void;
  onSubmit: () => void;
};

export function LoginPage({ token, error, isSubmitting, onTokenChange, onSubmit }: LoginPageProps) {
  return (
    <main className="login-shell">
      <div className="login-container login-entrance !grid-cols-1">
        <div className="login-form-card mx-auto w-full max-w-[420px]">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
              <Lock className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold">Gateway 运维状态</h1>
              <p className="text-xs text-muted-foreground">使用 operator token 访问内部诊断</p>
            </div>
          </div>
          <label
            htmlFor="operator-token"
            className="mb-2 flex items-center gap-1.5 text-xs font-medium"
          >
            <Key className="h-3.5 w-3.5" />
            Operator token
          </label>
          <Textarea
            id="operator-token"
            rows={3}
            value={token}
            disabled={isSubmitting}
            onChange={(event) => onTokenChange(event.target.value)}
          />
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <Button
            className="mt-5 w-full"
            disabled={!token.trim() || isSubmitting}
            onClick={onSubmit}
          >
            <ArrowRight className="h-4 w-4" />
            进入状态页
          </Button>
        </div>
      </div>
    </main>
  );
}
