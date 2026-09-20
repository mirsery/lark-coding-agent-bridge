import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { RunInfo } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";

/** Sidebar selection sentinel for the tasks panel. Profile names can never
 * contain ':' (rejected by the backend), so this cannot collide. */
export const TASKS_VIEW = "::tasks";

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** 会话 cell: chatName when resolvable, else chatId; comment runs get a label. */
function sessionLabel(r: RunInfo): string {
  if (r.source === "comment") return "云文档评论";
  return r.chatName || r.chatId || r.scope;
}

export function TasksView() {
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RunInfo | null>(null);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiGet<{ runs: RunInfo[] }>("/api/runs");
      setRuns(d.runs);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
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

  return (
    <div className="space-y-4">
      <div className="glass sticky -top-6 z-10 -mx-6 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-6 py-4">
        <h1 className="text-2xl font-semibold">任务</h1>
        {runs && runs.length > 0 && (
          <Badge variant="secondary">{runs.filter((r) => r.status === "running").length} 个运行中</Badge>
        )}
      </div>

      {error && <p className="text-sm text-destructive">加载失败：{error}</p>}

      <Card>
        <CardContent className="p-0">
          {runs === null ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</p>
          ) : runs.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">当前没有正在执行的任务</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                在群里 @ 机器人或私聊发消息，任务会出现在这里。
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>会话</TableHead>
                  <TableHead>任务预览</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>已运行</TableHead>
                  <TableHead>排队</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => {
                  const orphan = r.status === "orphan";
                  return (
                    <TableRow key={`${r.profile}:${r.scope}:${r.startedAt}`}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="max-w-48 truncate font-medium" title={r.chatId || r.scope}>
                            {sessionLabel(r)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {r.profile}
                            {r.threadId ? " · 话题" : ""}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-64 truncate text-muted-foreground" title={r.promptPreview}>
                          {r.promptPreview || "（无预览）"}
                        </p>
                      </TableCell>
                      <TableCell>
                        {orphan ? (
                          <Badge variant="outline" title="进程已不在，记录为残留">残留</Badge>
                        ) : (
                          <Badge variant="success">运行中</Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{elapsed(r.elapsedMs)}</TableCell>
                      <TableCell className="tabular-nums">
                        {r.queueDepth === null ? "—" : r.queueDepth}
                      </TableCell>
                      <TableCell className="text-right">
                        {orphan ? (
                          <span className="text-xs text-muted-foreground" title="残留记录：重启该 profile 后自动清理">
                            残留，重启该 profile 清理
                          </span>
                        ) : (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setConfirming(r)}
                          >
                            Stop
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停止这个任务？</DialogTitle>
            <DialogDescription>
              {confirming && (
                <>
                  将中断「{confirming.profile}」在 {sessionLabel(confirming)} 的当前任务
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
