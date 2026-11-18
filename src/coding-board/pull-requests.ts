/** GitHub check rollup → counts; skipped and unfinished checks never count as passing. */
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
