/**
 * Stale-while-revalidate cache for slow probes (git, gh). A read never waits:
 * it returns the last value (or undefined) and schedules a bounded refresh,
 * so a slow repository or a hung `gh` cannot stall the dashboard.
 */
export function createRefresher<T>(load: (key: string) => Promise<T>, ttlMs: number, concurrency = 4) {
  const cache = new Map<string, { value: T; at: number }>();
  const pending = new Set<string>();
  const queue: string[] = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const key = queue.shift()!;
      active++;
      void load(key).then(value => { cache.set(key, { value, at: Date.now() }); })
        .catch(() => { /* keep the previous value; retried after the TTL */ cache.set(key, { value: cache.get(key)?.value as T, at: Date.now() }); })
        .finally(() => { active--; pending.delete(key); drain(); });
    }
  };
  return {
    get(key: string, now = Date.now()): T | undefined {
      const hit = cache.get(key);
      if ((!hit || now - hit.at >= ttlMs) && !pending.has(key)) { pending.add(key); queue.push(key); drain(); }
      return hit?.value;
    },
    /** Resolves once nothing is queued or running (tests and `--once`). */
    async settle(timeoutMs = 15_000): Promise<void> {
      const end = Date.now() + timeoutMs;
      while ((active || queue.length) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    },
  };
}
