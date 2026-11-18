import { open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAlive } from '../runtime/registry';

/** One build-queue job: `~/.cache/build-queue.lock.jobs/<YYYYmmdd-HHMMSS>-<label>-<pid>/{meta,rc,pid,log}`. */
export interface BuildJob {
  id: string;
  label: string;
  cwd: string;
  cmd: string;
  /** Claude session id that started the build (`CLAUDE_CODE_SESSION_ID`). */
  session?: string;
  startedAt: number;
  /** Exit code once finished; missing while queued or running. */
  exitCode?: number;
  /** pid of the detached runner is gone without writing an exit code. */
  interrupted?: boolean;
  logFile: string;
}

export function jobsDir(): string {
  return `${process.env.BUILD_QUEUE_LOCK ?? join(homedir(), '.cache', 'build-queue.lock')}.jobs`;
}

function parseMeta(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return out;
}

function parseStarted(value: string | undefined, id: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[ -]?(\d{2}):?(\d{2}):?(\d{2})/.exec(value ?? id);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() : NaN;
}

/** Jobs started within `days`, oldest first. Read-only: never prunes the queue's own files. */
export async function readBuildJobs(now = Date.now(), days = 7, dir = jobsDir()): Promise<BuildJob[]> {
  let names: string[];
  try { names = (await readdir(dir)).filter(n => /^\d{8}-\d{6}-.+-\d+$/.test(n)).sort(); }
  catch { return []; }
  const out: BuildJob[] = [];
  for (const id of names) {
    const base = join(dir, id);
    const meta = parseMeta(await readFile(join(base, 'meta'), 'utf8').catch(() => ''));
    const startedAt = parseStarted(meta.started, id);
    if (!meta.cwd || !Number.isFinite(startedAt) || now - startedAt > days * 86_400_000) continue;
    const rc = (await readFile(join(base, 'rc'), 'utf8').catch(() => '')).trim();
    const pid = Number((await readFile(join(base, 'pid'), 'utf8').catch(() => '')).trim());
    const job: BuildJob = { id, label: meta.label ?? '', cwd: meta.cwd, cmd: meta.cmd ?? '', startedAt, logFile: join(base, 'log'), ...(meta.session ? { session: meta.session } : {}) };
    if (/^-?\d+$/.test(rc)) job.exitCode = Number(rc);
    else if (!(pid > 0 && isAlive(pid))) job.interrupted = true;
    out.push(job);
  }
  return out;
}

/** Last `lines` non-empty lines of a log, reading at most 16 KiB from the end. */
export async function tailLog(file: string, lines = 8): Promise<string[]> {
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - 16 * 1024);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      const text = buf.subarray(0, bytesRead).toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const rows = text.split(/\r?\n/).map(l => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd()).filter(Boolean);
      if (start) rows.shift();
      return rows.slice(-lines);
    } finally { await handle.close(); }
  } catch { return []; }
}
