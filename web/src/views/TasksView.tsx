import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { HostMetricsInfo, MonitorBot, MonitorInfo, MonitorRun, QuotaWindowInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";

/** Sidebar selection sentinel for the status page. Profile names can never
 * contain ':' (rejected by the backend), so this cannot collide. */
export const TASKS_VIEW = "::tasks";

function elapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
const speed = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}M/s` : `${(n / 1024).toFixed(1)}K/s`);

/** Local reset time: `HH:MM` today, `MM-DD HH:MM` otherwise, the CLI's wording when unparsed. */
function resetText(w: QuotaWindowInfo, now: number): string {
  if (w.resetAt === undefined) return w.resets ?? "—";
  const d = new Date(w.resetAt);
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? clock : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** Where a session runs: 私聊, the group name, or a cloud-doc comment. */
function sessionPlace(r: MonitorRun): string {
  if (r.source === "comment") return "云文档评论";
  if (r.chatType === "p2p") return "私聊";
  return r.chatName || r.chatId || r.scope;
}

/** Solid bar matching the terminal: green, yellow from 70%, red from 90%; empty when unknown. */
function Meter({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const tone = value === null ? "" : pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-amber-500" : "bg-success";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Stat({ label, value, meter, detail }: { label: string; value: string; meter?: number | null; detail?: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-medium tabular-nums">{value}</span>
      </div>
      {meter !== undefined && <Meter value={meter} />}
      {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function HostCard({ info, metrics }: { info: MonitorInfo; metrics?: HostMetricsInfo }) {
  const ram = metrics && metrics.memoryTotal > 0 ? (metrics.memoryNonFree / metrics.memoryTotal) * 100 : null;
  const disk = metrics?.disk && metrics.disk.total > 0 ? (metrics.disk.used / metrics.disk.total) * 100 : null;
  const net = metrics?.io?.network;
  const temp = metrics?.temperatureC;
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 pt-5 sm:grid-cols-4">
        <Stat
          label="CPU"
          value={metrics?.cpuPercent == null ? "—" : `${metrics.cpuPercent.toFixed(1)}%`}
          meter={metrics?.cpuPercent ?? null}
          detail={`负载 ${info.load.toFixed(2)} · ${info.cores} 核${temp == null ? "" : ` · ${temp.toFixed(1)}°C`}`}
        />
        <Stat
          label="内存"
          value={ram === null ? "—" : `${ram.toFixed(1)}%`}
          meter={ram}
          detail={metrics ? `${gib(metrics.memoryNonFree)} / ${gib(metrics.memoryTotal)}G 含缓存` : undefined}
        />
        <Stat
          label="磁盘"
          value={disk === null ? "—" : `${disk.toFixed(1)}%`}
          meter={disk}
          detail={metrics?.disk ? `可用 ${gib(metrics.disk.available)}G / ${gib(metrics.disk.total)}G` : undefined}
        />
        <Stat
          label="网络"
          value={net ? `↓ ${speed(net.read)}` : "—"}
          detail={net ? `↑ ${speed(net.write)}` : undefined}
        />
      </CardContent>
    </Card>
  );
}

const QUOTA_WINDOWS = [
  ["5 小时窗口", "5 小时"],
  ["本周", "本周"],
] as const;

function QuotaRow({ short, window, now }: { short: string; window?: QuotaWindowInfo; now: number }) {
  const pct = window ? Math.round(window.usedPercent) : null;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{short}</span>
        <span className={cn("tabular-nums", pct !== null && pct >= 90 && "font-medium text-destructive")}>
          {pct === null ? "—" : `${pct}%`}
          <span className="text-muted-foreground"> · 重置 {window ? resetText(window, now) : "—"}</span>
        </span>
      </div>
      <Meter value={pct} />
    </div>
  );
}

function SessionRow({ run, bot, now, onStop }: { run: MonitorRun; bot: MonitorBot; now: number; onStop: (r: MonitorRun) => void }) {
  const orphan = run.status === "orphan";
  const meta = [
    sessionPlace(run),
    run.actorName ? `@${run.actorName}` : null,
    run.threadId ? "话题" : null,
    run.queueDepth ? `排队 ${run.queueDepth}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className={cn("truncate", orphan ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          ▸ {orphan ? "已中断 / 过期" : run.activity}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{elapsed(now - run.startedAt)}</span>
      </div>
      <p className="line-clamp-2 text-sm" title={run.promptPreview}>
        {run.promptPreview || "任务执行中"}
      </p>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground" title={run.chatId || run.scope}>
          {meta.join(" · ")}
        </p>
        {orphan ? (
          <span className="shrink-0 text-xs text-muted-foreground">残留，重启该 profile 清理</span>
        ) : bot.hosted ? (
          <Button variant="destructive" size="sm" className="h-7 shrink-0" onClick={() => onStop(run)}>
            Stop
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground" title="任务在另一个 bridge 进程里，这里只能查看">
            仅查看
          </span>
        )}
      </div>
    </div>
  );
}

function BotCard({ bot, now, onStop }: { bot: MonitorBot; now: number; onStop: (r: MonitorRun) => void }) {
  const working = bot.runs.filter((r) => r.status === "running").length;
  const windows = bot.quota?.windows ?? [];
  return (
    <Card>
      <CardHeader className="gap-3 pb-4">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", bot.online ? "bg-success" : "bg-muted-foreground/40")} />
          <span className="min-w-0 truncate font-semibold">{bot.name}</span>
          <span className="shrink-0 text-sm text-muted-foreground">/ {bot.agent}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {bot.quota?.blocked && <Badge variant="destructive">额度已用尽</Badge>}
            {!bot.online ? (
              <Badge variant="outline">离线</Badge>
            ) : working ? (
              <Badge variant="success">工作中 · {working} 个会话</Badge>
            ) : (
              <Badge variant="secondary">空闲</Badge>
            )}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Sponsor：{bot.sponsor ?? (bot.quotaLoading ? "读取中…" : "—")}
        </p>
        {bot.quotaLoading ? (
          <p className="text-xs text-muted-foreground">额度读取中…</p>
        ) : (
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {QUOTA_WINDOWS.map(([label, short]) => (
              <QuotaRow key={label} short={short} window={windows.find((w) => w.label === label)} now={now} />
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="divide-y border-t pt-3">
          {bot.runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{bot.online ? "等待新任务" : "未运行"}</p>
          ) : (
            bot.runs.map((r) => (
              <SessionRow key={`${r.scope}:${r.startedAt}`} run={r} bot={bot} now={now} onStop={onStop} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** 运行概览: host metrics, then one card per bot with its Sponsor, quota and sessions. */
export function TasksView() {
  const [info, setInfo] = useState<MonitorInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<MonitorRun | null>(null);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await apiGet<MonitorInfo>("/api/monitor"));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(load, 5000);
    // Elapsed times tick every second between polls.
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  async function confirmStop() {
    if (!confirming) return;
    setStopping(true);
    try {
      const res = await apiPost<{ interrupted: boolean }>("/api/runs/stop", {
        profile: confirming.profile,
        scope: confirming.scope,
      });
      if (res.interrupted) toast.success("已请求停止该任务");
      else toast.info("任务已不在运行（可能刚结束）");
      setConfirming(null);
      void load();
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setStopping(false);
    }
  }

  const running = info?.bots.flatMap((b) => b.runs).filter((r) => r.status === "running").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="glass sticky -top-6 z-10 -mx-6 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-6 py-4">
        <h1 className="text-2xl font-semibold">运行概览</h1>
        {running > 0 && <Badge variant="secondary">{running} 个运行中</Badge>}
        {info && (
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {info.host}
            {info.metrics ? ` · 已运行 ${elapsed(info.metrics.uptimeSeconds * 1000)}` : ""}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-destructive">加载失败：{error}</p>}

      {info === null ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</p>
      ) : (
        <>
          <HostCard info={info} metrics={info.metrics} />
          {info.bots.length === 0 ? (
            <Card>
              <CardContent className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">还没有 bot 上线</p>
                <p className="mt-1 text-xs text-muted-foreground/70">启动一个 profile 后，它的额度和会话会出现在这里。</p>
              </CardContent>
            </Card>
          ) : (
            info.bots.map((b) => <BotCard key={b.profile} bot={b} now={now} onStop={setConfirming} />)
          )}
        </>
      )}

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止这个任务？</DialogTitle>
            <DialogDescription>
              {confirming && (
                <>
                  将中断「{confirming.profile}」在 {sessionPlace(confirming)} 的当前任务
                  {confirming.promptPreview ? `：${confirming.promptPreview}` : ""}。
                  与聊天里的 /stop 效果相同，已产生的输出不会回滚。
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={stopping}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmStop} disabled={stopping}>
              {stopping ? "停止中…" : "确认停止"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
