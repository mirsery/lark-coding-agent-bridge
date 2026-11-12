import { homedir } from 'node:os';
import { runCapture } from '../git/exec';

export interface BoardPr {
  repository: string; number: number; observedAt?: number;
  state: 'loading' | 'unavailable' | 'open' | 'closed' | 'merged';
  head?: string; url?: string; review?: string;
  checks?: { passed: number; failed: number; pending: number; skipped: number };
}
type PrRef = { repository: string; number: number };
type Query = (ref: PrRef, now: number) => Promise<BoardPr>;

export async function queryBoardPr(ref: PrRef, now: number): Promise<BoardPr> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(ref.repository) || !Number.isSafeInteger(ref.number) || ref.number < 1) return { ...ref, state: 'unavailable', observedAt: now };
  const result = await runCapture('gh', homedir(), ['pr', 'view', String(ref.number), '--repo', ref.repository, '--json', 'state,headRefOid,url,reviewDecision,statusCheckRollup'], { timeoutMs: 8000, maxBytes: 512 * 1024 });
  if (!result.ok || result.truncated) return { ...ref, state: 'unavailable', observedAt: now };
  try {
    const data = JSON.parse(result.stdout) as { state?: string; headRefOid?: string; url?: string; reviewDecision?: string; statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }> };
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(data.state ?? '') || !data.headRefOid) throw new Error('invalid response');
    const checks = data.statusCheckRollup === undefined ? undefined : countChecks(data.statusCheckRollup);
    return { ...ref, state: data.state!.toLowerCase() as 'open' | 'closed' | 'merged', head: data.headRefOid, url: data.url, review: data.reviewDecision, checks, observedAt: now };
  } catch { return { ...ref, state: 'unavailable', observedAt: now }; }
}

export function countChecks(items: Array<{ status?: string; conclusion?: string; state?: string }>) {
  const checks = { passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const c of items) {
    const conclusion = c.conclusion ?? c.state;
    if (conclusion === 'SUCCESS') checks.passed++;
    else if (conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') checks.skipped++;
    else if (conclusion && ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE'].includes(conclusion)) checks.failed++;
    else checks.pending++;
  }
  return checks;
}

/** Nonblocking, bounded refresh. Cached entries retain their observation time. */
export function createPrReader(query: Query = queryBoardPr, ttl = 60_000) {
  const cache = new Map<string, BoardPr>();
  const pending = new Set<string>();
  const jobs: Array<{ key: string; ref: PrRef; now: number }> = [];
  let active = 0;
  const drain = () => {
    while (active < 4 && jobs.length) {
      const { key, ref, now } = jobs.shift()!;
      active++;
      void query(ref, now).then(result => cache.set(key, result)).catch(() => cache.set(key, { ...ref, state: 'unavailable', observedAt: now })).finally(() => { pending.delete(key); active--; drain(); });
    }
  };
  return (refs: PrRef[], now: number): BoardPr[] => refs.map(ref => {
    const key = `${ref.repository}#${ref.number}`;
    const value = cache.get(key);
    if ((!value || now - (value.observedAt ?? 0) >= ttl) && !pending.has(key)) {
      pending.add(key); jobs.push({ key, ref, now }); drain();
    }
    return value ?? { ...ref, state: 'loading' };
  });
}
