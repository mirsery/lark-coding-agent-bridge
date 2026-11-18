import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, MessageSquare } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { CodingJob, CodingPhase, CodingTask, CodingWorktree, MonitorInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/** Sidebar selection sentinel for the coding board (profile names never contain ':'). */
export const CODING_VIEW = "::coding";

const PHASE_ORDER: CodingPhase[] = ["构建中", "构建排队", "门禁失败", "CI 失败", "编码中", "CI 中", "待合并", "等 review", "门禁通过"];

/** One tone per kind of state: running blue, queued amber, failing red, waiting on people violet, moving green. */
const PHASE_TONE: Record<CodingPhase, string> = {
  构建中: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  构建排队: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  门禁失败: "bg-red-500/15 text-red-700 dark:text-red-300",
  "CI 失败": "bg-red-500/15 text-red-700 dark:text-red-300",
  编码中: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "CI 中": "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  待合并: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "等 review": "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  门禁通过: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  闲置: "bg-muted text-muted-foreground",
  已关闭: "bg-muted text-muted-foreground",
  已合并: "bg-muted text-muted-foreground",
};

const JOB_TONE: Record<CodingJob["state"], string> = {
  running: "bg-sky-500 animate-pulse",
  waiting: "border-2 border-dashed border-amber-500",
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  interrupted: "bg-red-300",
};
const JOB_TEXT: Record<CodingJob["state"], string> = { running: "进行中", waiting: "排队", passed: "通过", failed: "失败", interrupted: "中断" };

const pad2 = (n: number) => String(n).padStart(2, "0");
function clock(ts: number, now: number): string {
  const d = new Date(ts);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
function ago(ts: number | undefined, now: number): string {
  if (!ts) return "—";
  const m = Math.max(0, Math.floor((now - ts) / 60_000));
  return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
}
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function PhaseBadge({ phase }: { phase: CodingPhase }) {
  return <span className={cn("whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium", PHASE_TONE[phase])}>{phase}</span>;
}

function JobDots({ jobs, now }: { jobs: CodingJob[]; now: number }) {
  if (!jobs.length) return <span className="text-muted-foreground">—</span>;
  const last = jobs[jobs.length - 1]!;
  return (
    <span className="flex items-center gap-1">
      {jobs.slice(-4).map((j) => <i key={j.id} title={`${clock(j.startedAt, now)} ${JOB_TEXT[j.state]}`} className={cn("inline-block size-3 rounded-[3px]", JOB_TONE[j.state])} />)}
      <span className="ml-1 text-muted-foreground">{last.state === "waiting" ? `第 ${last.position ?? "?"} 位` : clock(last.startedAt, now)}</span>
    </span>
  );
}

function PrCell({ w }: { w: CodingWorktree }) {
  const pr = w.pr;
  if (!pr) return <span className="text-muted-foreground">还没开 PR</span>;
  const state = pr.state === "merged" ? "已合并" : pr.state === "closed" ? "已关闭" : pr.review === "APPROVED" ? "已批准" : pr.review === "CHANGES_REQUESTED" ? "要修改" : "开着";
  const c = pr.state === "open" ? pr.checks : undefined;
  return (
    <span>
      {pr.url ? <a className="font-mono text-primary hover:underline" href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a> : <span className="font-mono">#{pr.number}</span>}
      {" "}{state}
      {c && <span className={cn("ml-1", c.failed ? "text-red-600" : "text-muted-foreground")}>· CI {c.failed ? `${c.failed} 失败` : c.pending ? `${c.passed}/${c.passed + c.pending}` : `${c.passed}/${c.passed + c.skipped}`}</span>}
    </span>
  );
}

function SessionCell({ w }: { w: CodingWorktree }) {
  if (w.sessions.some((s) => s.running)) return <span className="text-emerald-600 dark:text-emerald-400">● 会话运行中</span>;
  return <span className="text-muted-foreground">{w.sessions.length ? "会话已结束" : "—"}</span>;
}

function TaskRow({ task, now, selected, onSelect }: { task: CodingTask; now: number; selected: boolean; onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(); }}
      className={cn("cursor-pointer border-b border-border px-4 py-3 last:border-b-0", selected ? "bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-accent/40")}
    >
      <div className="flex items-center gap-3">
        <span className="w-36 shrink-0 truncate font-mono text-[13px] font-semibold" title={task.key}>{task.jira ?? task.key.split("/").pop()}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
        <PhaseBadge phase={task.phase} />
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{ago(task.activityAt, now)}</span>
      </div>
      <div className="mt-1.5 space-y-1">
        {task.worktrees.map((w) => (
          <div key={w.path || w.branch} className="grid grid-cols-[9rem_minmax(0,1fr)_9.5rem_11rem_7.5rem] items-center gap-3 text-[12.5px]">
            <span className="truncate text-muted-foreground">└ {w.name}</span>
            <span className="truncate font-mono text-xs">
              {w.branch ?? "(detached)"}
              {w.dirty ? <span className="text-amber-600"> · {w.dirty} 处改动</span> : null}
            </span>
            <JobDots jobs={w.jobs} now={now} />
            <PrCell w={w} />
            <SessionCell w={w} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Detail({ task, now }: { task: CodingTask; now: number }) {
  const sessions = task.worktrees.flatMap((w) => w.sessions);
  const chat = sessions.find((s) => s.running && s.chatUrl) ?? sessions.find((s) => s.chatUrl);
  const prUrl = task.worktrees.map((w) => w.pr?.url).find(Boolean);
  const logs = task.worktrees.flatMap((w) => w.jobs.filter((j) => j.logTail?.length).map((j) => ({ w, j })));
  const jobs = task.worktrees.flatMap((w) => w.jobs.map((j) => ({ w, j }))).sort((a, b) => a.j.startedAt - b.j.startedAt);
  const running = jobs.find(({ j }) => j.state === "running");
  return (
    <Card className="self-start">
      <CardContent className="space-y-4 p-4">
        <div>
          <p className="text-xs text-muted-foreground">{task.key} · {task.repo}</p>
          <h3 className="mt-0.5 font-semibold">
            {task.phase}
            {running ? `：持有构建锁 ${elapsed(now - running.j.startedAt)}` : ""}
          </h3>
          <p className="mt-1 text-sm">{task.title}</p>
        </div>
        {task.nextStep && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">下一步（任务台账）</p>
            <p className="text-sm">{task.nextStep}</p>
          </div>
        )}
        {task.worktrees.filter((w) => w.phase !== "已合并" && w.phase !== "已关闭").map((w) => (
          <dl key={w.path} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <dt className="text-muted-foreground">worktree</dt><dd className="break-all">{w.path}</dd>
            <dt className="text-muted-foreground">分支</dt><dd className="break-all font-mono">{w.branch ?? "(detached)"}</dd>
            {w.jobs.length > 0 && <><dt className="text-muted-foreground">命令</dt><dd className="break-all font-mono">{w.jobs[w.jobs.length - 1]!.cmd}</dd></>}
          </dl>
        ))}
        {logs.map(({ w, j }) => (
          <div key={j.id}>
            <p className="mb-1 text-xs text-muted-foreground">{w.name} 构建日志（{JOB_TEXT[j.state]}，最后 {j.logTail!.length} 行）</p>
            <pre className="whitespace-pre-wrap break-all rounded-lg bg-zinc-900 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
              {j.logTail!.map((line, i) => <div key={i} className={/ERROR|FAIL/.test(line) ? "text-red-400" : /WARN/.test(line) ? "text-yellow-300" : undefined}>{line}</div>)}
            </pre>
          </div>
        ))}
        {jobs.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">门禁记录</p>
            <div className="space-y-1 text-xs">
              {jobs.slice(-8).map(({ w, j }) => (
                <div key={j.id} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">{clock(j.startedAt, now)}</span>
                  <i className={cn("inline-block size-3 shrink-0 rounded-[3px]", JOB_TONE[j.state])} />
                  <span className="truncate">{w.name} · {JOB_TEXT[j.state]}{j.exitCode ? `（rc=${j.exitCode}）` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {chat?.chatUrl && (
            <a href={chat.chatUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground">
              <MessageSquare className="size-3.5" aria-hidden />打开飞书会话
            </a>
          )}
          {prUrl && (
            <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs">
              <ExternalLink className="size-3.5" aria-hidden />PR
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** 编码任务: discovered worktrees, builds, PRs and sessions, grouped by Jira key. */
export function CodingView() {
  const [info, setInfo] = useState<MonitorInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [phase, setPhase] = useState<CodingPhase | "">("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setInfo(await apiGet<MonitorInfo>("/api/monitor")); setError(null); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  }, []);
  useEffect(() => {
    void load();
    const poll = setInterval(load, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const board = info?.codingBoard;
  const tasks = useMemo(() => (board?.tasks ?? []).filter((t) =>
    (!phase || t.phase === phase)
    && `${t.key} ${t.title} ${t.worktrees.map((w) => `${w.branch ?? ""} ${w.name}`).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())), [board, phase, query]);
  const current = tasks.find((t) => t.key === selected) ?? tasks[0];
  const count = (...p: CodingPhase[]) => p.reduce((n, x) => n + (board?.counts[x] ?? 0), 0);
  const review = (board?.tasks ?? []).filter((t) => t.phase === "等 review");
  const oldest = review.length ? Math.max(...review.map((t) => now - (t.activityAt ?? now))) : 0;
  const running = board?.queue.filter((q) => q.state === "running").length ?? 0;
  const waiting = board?.queue.filter((q) => q.state === "waiting").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">编码任务</h2>
        <p className="text-xs text-muted-foreground">
          {board ? `${new Date(board.observedAt).toLocaleTimeString()} 更新 · 每 5 秒刷新` : ""}
        </p>
      </div>
      {error && <p className="text-sm text-destructive">加载失败：{error}</p>}
      {!info ? (
        <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
      ) : !board ? (
        <p className="py-8 text-center text-sm text-muted-foreground">这个 bridge 版本没有编码任务数据</p>
      ) : (
        <>
          {board.error && <p className="text-sm text-destructive">{board.error}</p>}
          {board.loading && <p className="text-sm text-muted-foreground">首次扫描仓库中，稍后自动刷新…</p>}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              { n: board.tasks.length, label: "进行中任务", tone: "" },
              { n: `${running} / ${waiting}`, label: "构建：持锁 / 排队", tone: "text-sky-600 dark:text-sky-400" },
              { n: count("门禁失败", "CI 失败"), label: "门禁或 CI 失败", tone: "text-red-600 dark:text-red-400" },
              { n: review.length, label: review.length ? `PR 等 review（最久 ${Math.floor(oldest / 86_400_000)} 天）` : "PR 等 review", tone: "text-violet-600 dark:text-violet-400" },
              { n: board.merged.length, label: "已合并、worktree 待清理", tone: "text-muted-foreground" },
            ].map((s) => (
              <Card key={s.label}><CardContent className="p-3">
                <p className={cn("text-2xl font-semibold", s.tone)}>{s.n}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </CardContent></Card>
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <button onClick={() => setPhase("")} className={cn("rounded-full border px-2.5 py-0.5 text-xs", !phase ? "border-foreground bg-foreground text-background" : "text-muted-foreground")}>全部 {board.tasks.length}</button>
                {PHASE_ORDER.filter((p) => board.counts[p]).map((p) => (
                  <button key={p} onClick={() => setPhase(p)} className={cn("rounded-full border px-2.5 py-0.5 text-xs", phase === p ? "border-foreground bg-foreground text-background" : "text-muted-foreground")}>{p} {board.counts[p]}</button>
                ))}
                <input aria-label="筛选编码任务" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜 Jira 号 / 分支 / 标题" className="ml-auto w-52 rounded-lg border bg-background px-2.5 py-1 text-xs" />
              </div>
              {board.queue.length > 0 && (
                <div className="space-y-1 border-b border-border bg-muted/40 px-4 py-2 text-xs">
                  {board.queue.map((q) => (
                    <div key={q.path} className="flex items-center gap-2">
                      <span className={q.state === "running" ? "text-sky-600" : "text-amber-600"}>{q.state === "running" ? "▶ 持锁" : `◌ 排队第 ${q.position ?? "?"} 位`}</span>
                      <span className="font-medium">{q.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{q.cmd}</span>
                      {q.state === "running" && q.startedAt && <span className="text-sky-600">{elapsed(now - q.startedAt)}</span>}
                    </div>
                  ))}
                </div>
              )}
              {tasks.map((t) => <TaskRow key={t.key} task={t} now={now} selected={current?.key === t.key} onSelect={() => setSelected(t.key)} />)}
              {!tasks.length && <p className="px-4 py-8 text-center text-sm text-muted-foreground">{board.tasks.length ? "没有符合筛选的任务" : "没有进行中的编码任务"}</p>}
              {board.merged.length > 0 && (
                <p className="border-t border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
                  ▸ 已合并 {board.merged.length} 个：{board.merged.map((m) => m.key.replace(/^[A-Z][A-Z0-9]+-(\d+)$/, "$1").replace(/^.*\//, "")).join(" · ")}，worktree 还在，可用 <code className="rounded bg-muted px-1 font-mono">worktree-clean</code> 清理
                  {board.idle ? `；另有 ${board.idle} 个闲置 worktree 未显示` : ""}
                </p>
              )}
            </Card>
            {current && <Detail task={current} now={now} />}
          </div>
        </>
      )}
    </div>
  );
}
