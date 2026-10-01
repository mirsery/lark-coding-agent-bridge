import { describe, expect, it } from 'vitest';
import {
  ApprovalBroker,
  callNeedsApproval,
  isReadOnlyCommand,
  needsApproval,
  summarizeToolCall,
  type ApprovalNotifier,
  type ApprovalOutcome,
  type GateContext,
  type PendingApproval,
} from '../../../src/runtime/approvals';

const ctx = (actor = 'ou_colleague'): GateContext => ({
  actor: { id: actor, name: 'Colleague' },
  source: 'im',
  scopeId: 'oc_group',
  chatId: 'oc_group',
  originMessageId: 'om_1',
  where: '研发群',
  agent: 'claude',
});

function harness(opts: { timeoutMs?: number; failAnnounce?: boolean } = {}) {
  const announced: PendingApproval[] = [];
  const settled: Array<{ id: string; outcome: ApprovalOutcome }> = [];
  const audit: Array<Record<string, unknown>> = [];
  const notifier: ApprovalNotifier = {
    async announce(p) {
      if (opts.failAnnounce) throw new Error('no approver');
      announced.push(p);
    },
    async settled(p, outcome) {
      settled.push({ id: p.id, outcome });
    },
  };
  const broker = new ApprovalBroker({
    notifier,
    audit: { append: (e) => audit.push(e) },
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { broker, announced, settled, audit };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('ApprovalBroker', () => {
  it('lets read-only tools through without asking anyone', async () => {
    const h = harness();
    const gate = h.broker.openGate(ctx());
    expect(await gate.decide({ tool: 'Read', summary: 'Read /etc/hosts' })).toEqual({ decision: 'allow', reason: 'read-only' });
    expect(h.announced).toEqual([]);
  });

  it('holds a side-effecting step until an admin allows it', async () => {
    const h = harness();
    const gate = h.broker.openGate(ctx());
    const answer = gate.decide({ tool: 'Bash', summary: 'rm -rf build' });
    await waitFor(() => h.announced.length === 1);
    const id = h.announced[0]!.id;

    // The requester cannot allow their own step; nobody else but an admin can either.
    expect(h.broker.decide(id, 'ou_colleague', 'allow', false)).toBe('forbidden');
    expect(h.broker.decide(id, 'ou_stranger', 'deny', false)).toBe('forbidden');
    expect(h.broker.decide(id, 'ou_boss', 'allow', true)).toBe('ok');

    expect(await answer).toMatchObject({ decision: 'allow' });
    expect(h.broker.decide(id, 'ou_boss', 'deny', true)).toBe('not-found');
    await waitFor(() => h.settled.length === 1);
    expect(h.settled[0]?.outcome).toEqual({ kind: 'allowed', by: 'ou_boss', allowTurn: false });
    expect(h.audit.map((e) => e.event)).toEqual(['requested', 'allowed']);
    expect(h.audit[1]).toMatchObject({ actorId: 'ou_colleague', tool: 'Bash', summary: 'rm -rf build', decidedBy: 'ou_boss' });
  });

  it('lets the requester cancel their own step', async () => {
    const h = harness();
    const gate = h.broker.openGate(ctx());
    const answer = gate.decide({ tool: 'Write', summary: 'Write /tmp/x' });
    await waitFor(() => h.announced.length === 1);
    expect(h.broker.decide(h.announced[0]!.id, 'ou_colleague', 'deny', false)).toBe('ok');
    expect(await answer).toEqual({ decision: 'deny', reason: '发起人取消了这个操作。' });
  });

  it('allows the rest of the turn in one click, until the next turn', async () => {
    const h = harness();
    const gate = h.broker.openGate(ctx());
    const first = gate.decide({ tool: 'Bash', summary: 'npm test' });
    await waitFor(() => h.announced.length === 1);
    h.broker.decide(h.announced[0]!.id, 'ou_boss', 'allow-turn', true);
    await first;

    expect(await gate.decide({ tool: 'Bash', summary: 'npm run build' })).toMatchObject({ decision: 'allow' });
    expect(h.announced).toHaveLength(1);
    expect(h.audit.map((e) => e.event)).toContain('auto-allowed');

    h.broker.updateGate(gate.token, ctx());
    void gate.decide({ tool: 'Bash', summary: 'git push' });
    await waitFor(() => h.announced.length === 2);
  });

  it('denies a step nobody answers in time', async () => {
    const h = harness({ timeoutMs: 30 });
    const gate = h.broker.openGate(ctx());
    expect(await gate.decide({ tool: 'Bash', summary: 'deploy' })).toMatchObject({ decision: 'deny' });
    await waitFor(() => h.settled.length === 1);
    expect(h.settled[0]?.outcome).toEqual({ kind: 'timeout' });
  });

  it('denies straight away when the prompt reaches no approver', async () => {
    const h = harness({ failAnnounce: true });
    const gate = h.broker.openGate(ctx());
    expect(await gate.decide({ tool: 'Bash', summary: 'x' })).toMatchObject({ decision: 'deny' });
  });

  it('denies what a finished run was still waiting on, and anything on an unknown gate', async () => {
    const h = harness();
    const gate = h.broker.openGate(ctx());
    const answer = gate.decide({ tool: 'Bash', summary: 'x' });
    await waitFor(() => h.announced.length === 1);
    h.broker.closeGate(gate.token);
    expect(await answer).toMatchObject({ decision: 'deny' });
    expect(await h.broker.request('bogus', { tool: 'Bash', summary: 'x' })).toMatchObject({ decision: 'deny' });
  });
});

describe('tool classification', () => {
  it('asks for shell, file writes and external tools, not for reading', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__jira__create', 'command_execution', 'file_change', 'Monitor']) {
      expect(needsApproval(tool), tool).toBe(true);
    }
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task']) {
      expect(needsApproval(tool), tool).toBe(false);
    }
  });

  it('summarises tool calls for people', () => {
    expect(summarizeToolCall('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(summarizeToolCall('Edit', { file_path: '/repo/a.ts', old_string: 'x' })).toBe('Edit /repo/a.ts');
    expect(summarizeToolCall('mcp__x__y', { a: 1 })).toBe('mcp__x__y {"a":1}');
  });

  it('lets plainly read-only shell commands through', () => {
    for (const command of [
      'ls -la',
      'git status',
      'git -C /repo log --oneline -5',
      'cd /repo && git diff HEAD~1 | head -50',
      'grep -rn foo src | wc -l',
      "sed -n '1,80p' src/a.ts",
      'find . -name "*.ts"',
      'git branch -a',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });

  it('asks for anything that can write, run or hide a command', () => {
    for (const command of [
      'rm -rf build',
      'echo x > a.txt',
      'cat a; rm a',
      'ls || rm a',
      'sleep 9 & rm a',
      'echo $(rm a)',
      'echo `rm a`',
      'find . -delete',
      'find . -exec rm {} ;',
      "sed -i '' s/a/b/ f",
      "sed -n 's/a/b/w out' f",
      'sed s/a/b/ f',
      'sort -o out in',
      'git -c core.pager=sh log',
      'git branch new-branch',
      'git branch -D old',
      'git diff --output=x',
      'git commit -m x',
      'git push',
      'npm install',
      'FOO=1 ls',
      'ls\nrm a',
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it('only waives approval for read-only shell, never for writes', () => {
    expect(callNeedsApproval('Bash', { command: 'git log -3' })).toBe(false);
    expect(callNeedsApproval('Bash', { command: 'git push' })).toBe(true);
    expect(callNeedsApproval('Write', { file_path: '/a', content: '' })).toBe(true);
    expect(callNeedsApproval('Read', { file_path: '/a' })).toBe(false);
  });
});
