import { readRepoStatus, type GitRepoStatus } from '../git/status';

export interface BoardGit { path: string; observedAt?: number; status?: GitRepoStatus; error?: string }
type Probe = (path: string) => Promise<GitRepoStatus | undefined>;

/** Cache bounded, non-blocking probes so slow repositories cannot stall the dashboard. */
export function createGitReader(probe: Probe = readRepoStatus, ttl = 10_000) {
  const cache = new Map<string, BoardGit>();
  const pending = new Set<string>();
  const jobs: Array<{ path: string; now: number }> = [];
  let active = 0;
  const drain = () => {
    while (active < 4 && jobs.length) {
      const { path, now } = jobs.shift()!;
      active++;
      void probe(path).then(status => cache.set(path, { path, observedAt: now, ...(status ? { status } : { error: '无法读取 Git 状态' }) }))
        .catch(() => cache.set(path, { path, observedAt: now, error: '无法读取 Git 状态' }))
        .finally(() => { active--; pending.delete(path); drain(); });
    }
  };
  return (paths: string[], now: number): BoardGit[] => paths.map(path => {
    const value = cache.get(path);
    if ((!value || now - (value.observedAt ?? 0) >= ttl) && !pending.has(path)) {
      pending.add(path); jobs.push({ path, now }); drain();
    }
    return value ?? { path };
  });
}
