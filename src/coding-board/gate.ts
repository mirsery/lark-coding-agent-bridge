import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { git } from '../git/exec';
import { updateTask, type GateRecord } from './store';

/** Called explicitly by an operator or agent. No command text or environment is stored. */
export async function runRecordedGate(file: string, taskId: string, worktree: string, command: string[]): Promise<number> {
  if (!command.length || !command[0]) throw new Error('Gate command required');
  const [head, status] = await Promise.all([git(worktree, ['rev-parse', 'HEAD']), git(worktree, ['status', '--porcelain', '--untracked-files=normal'])]);
  if (!head.ok || !/^[a-f0-9]{40,64}$/i.test(head.stdout.trim()) || !status.ok) throw new Error('Cannot inspect worktree');
  const record: GateRecord = { id: randomUUID(), worktree, head: head.stdout.trim(), dirty: Boolean(status.stdout.trim()), startedAt: Date.now() };
  await updateTask(file, taskId, task => {
    if (!task.worktrees.includes(worktree)) throw new Error('Worktree is not linked to this task');
    (task.gates ??= []).push(record);
  });
  const result = await new Promise<{ code: number | null; signal?: string }>(resolve => {
    const child = spawn(command[0]!, command.slice(1), { cwd: worktree, stdio: 'inherit', shell: false });
    child.once('error', () => resolve({ code: null }));
    child.once('exit', (code, signal) => resolve({ code, ...(signal ? { signal } : {}) }));
  });
  const [endHead, endStatus] = await Promise.all([git(worktree, ['rev-parse', 'HEAD']), git(worktree, ['status', '--porcelain', '--untracked-files=normal'])]);
  await updateTask(file, taskId, task => {
    const gate = task.gates?.find(g => g.id === record.id);
    if (!gate) throw new Error('Gate record disappeared');
    gate.finishedAt = Date.now(); gate.exitCode = result.code;
    if (result.signal) gate.signal = result.signal;
    if (endHead.ok && /^[a-f0-9]{40,64}$/i.test(endHead.stdout.trim())) gate.endHead = endHead.stdout.trim();
    if (endStatus.ok) gate.endDirty = Boolean(endStatus.stdout.trim());
  });
  return result.code ?? 1;
}
