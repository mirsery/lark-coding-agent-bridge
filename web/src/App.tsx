import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import type { OnboardState, Status } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/views/Sidebar";
import { ProfileDetail } from "@/views/ProfileDetail";
import { OnboardWizard } from "@/views/OnboardWizard";
import { TASKS_VIEW, TasksView } from "@/views/TasksView";

export function App() {
  const [onboard, setOnboard] = useState<OnboardState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const os = await apiGet<OnboardState>("/api/onboard/state");
      setOnboard(os);
      if (os.hasConfig) {
        setStatus(await apiGet<Status>("/api/status").catch(() => null));
      }
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <CenteredShell><p className="text-destructive text-sm">加载失败：{error}</p></CenteredShell>;
  if (!onboard) return <CenteredShell><p className="text-muted-foreground text-sm">加载中…</p></CenteredShell>;

  if (!onboard.hasConfig) {
    return (
      <CenteredShell>
        <Card className="w-full max-w-lg">
          <CardHeader><CardTitle>初始化 AI 助手</CardTitle></CardHeader>
          <CardContent>
            <OnboardWizard onCreated={() => void refresh()} />
          </CardContent>
        </Card>
        <Toaster />
      </CenteredShell>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar selected={selected} onSelect={setSelected} refreshToken={refreshToken} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6 pb-16">
          {selected === TASKS_VIEW ? (
            <TasksView />
          ) : selected ? (
            <ProfileDetail
              profile={selected}
              onChanged={() => { void refresh(); setRefreshToken((t) => t + 1); }}
            />
          ) : (
            <EmptyState version={status?.version} online={status?.online} />
          )}
        </div>
      </main>
      <Toaster />
    </div>
  );
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {children}
    </div>
  );
}

function EmptyState({ version, online }: { version?: string; online?: number }) {
  return (
    <div className="flex h-[70vh] flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm text-muted-foreground">在左侧选择一个 profile 查看运行状态与配置</p>
      {version && (
        <p className="text-xs text-muted-foreground/70">
          单主进程托管所有 profile · v{version} · {online ?? 0} 个在线 · 改在线 profile 的配置即时生效
        </p>
      )}
    </div>
  );
}
