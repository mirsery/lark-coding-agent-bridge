import { useEffect, useState, type ReactNode } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { DreamRun, DreamView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";

const errorText = (e: unknown) => String((e as Error).message ?? e);

const STATUS: Record<DreamRun["status"], string> = {
  queued: "排队中",
  running: "整理中",
  deferred: "已延后",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
};

const PHASE: Record<string, string> = {
  skipped: "未提交",
  failed: "失败",
  committed: "草稿已生成（未推送）",
  pushed: "已推送（PR 未开）",
  "pr-created": "Draft PR 已开",
};

function when(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 梦境整理 (`/dream`): the bot reads finished conversations and opens Draft PRs
 * with memory / note / skill proposals. The switch is in 基本设置; this card
 * shows where drafts go and how recent runs went, and runs one on demand.
 */
export function DreamCard({ profile, refreshKey }: { profile: string; refreshKey: number }) {
  const [view, setView] = useState<DreamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const url = `/api/dream?profile=${encodeURIComponent(profile)}`;
  const load = () =>
    apiGet<DreamView>(url)
      .then((next) => {
        setView(next);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    setView(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, refreshKey]);

  // A run takes minutes: follow it while one is in flight.
  const running = view?.running;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id, profile]);

  async function act(action: "run" | "cancel") {
    setBusy(true);
    try {
      const next = await apiPost<DreamView>(url, { action });
      setView(next);
      if (next.message) toast.success(next.message);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>梦境整理</CardTitle>
        {view?.live && view.enabled && (
          running ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act("cancel")}>取消整理</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act("run")}>
              {busy ? "启动中…" : "立即整理"}
            </Button>
          )
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          读取已结束的会话，以只读方式整理出记忆、笔记和 skill 提案，在知识库和 skill 库各开一个 Draft PR；合并前不生效，从不自动合并。只在手动触发时运行，开关在上方「基本设置」。
        </p>
        {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
        {!error && !view && <p className="text-sm text-muted-foreground">加载中…</p>}
        {view && (
          <>
            {!view.live && (
              <p className="text-xs text-primary">该 profile 不在本控制台进程里运行：这里只显示状态，整理请在飞书里私聊 bot 发送 /dream run。</p>
            )}
            <div className="space-y-1.5 rounded-xl border px-3 py-2">
              <Row label="状态">
                <span className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant={view.enabled ? "secondary" : "outline"}>{view.enabled ? "已开启" : "未开启"}</Badge>
                  {running && <Badge>{STATUS[running.status]} · {running.id}</Badge>}
                  {view.lastSucceededAt && <span className="text-muted-foreground">上次完成 {when(view.lastSucceededAt)}</span>}
                </span>
              </Row>
              <Row label="知识库">
                <Target value={view.targets.knowledge.url} problem={view.targets.knowledge.problem} />
              </Row>
              <Row label="skill 库">
                <Target value={view.targets.skills.library} problem={view.targets.skills.problem} />
              </Row>
              <Row label="每轮上限">
                <span className="text-xs">
                  {view.settings.maxSessions} 个会话 · {view.settings.maxInputChars} 字符 · {view.settings.maxRunMinutes} 分钟；会话空闲 {view.settings.minIdleMinutes} 分钟后才读（{view.agent} 只读运行）
                </span>
              </Row>
              <Row label="记录">
                <span className="text-xs">
                  已登记会话 {view.trackedSessions} 个 · 已开 Draft PR {view.openedPrs} 个
                  {view.pendingDrafts > 0 && ` · 待重试草稿 ${view.pendingDrafts} 个`}
                </span>
              </Row>
            </div>
            {view.runs.length > 0 && (
              <div className="space-y-2">
                {view.runs.map((run) => <RunRow key={run.id} run={run} />)}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RunRow({ run }: { run: DreamRun }) {
  return (
    <div className="space-y-1 rounded-xl border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono">{run.id}</span>
        <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{STATUS[run.status]}</Badge>
        <span className="text-muted-foreground">{when(run.endedAt ?? run.startedAt)}</span>
      </div>
      {run.note && <p className="text-muted-foreground">{run.note}</p>}
      {run.targets.map((target) => (
        <p key={target.label}>
          {target.label}：{PHASE[target.phase] ?? target.phase}
          {target.items > 0 && `，${target.items} 项`}
          {target.prUrl && (
            <>
              {" "}
              <a className="underline" href={target.prUrl} target="_blank" rel="noreferrer">#{target.prNumber ?? "PR"}</a>
            </>
          )}
          {target.error && <span className="text-muted-foreground">（{target.error}）</span>}
        </p>
      ))}
    </div>
  );
}

function Target({ value, problem }: { value?: string; problem?: string }) {
  if (value) return <span className="break-all font-mono text-xs">{value}</span>;
  return <span className="text-xs text-destructive">{problem ?? "未配置"}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
