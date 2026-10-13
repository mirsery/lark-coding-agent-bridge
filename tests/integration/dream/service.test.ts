import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { TranscriptExchange } from '../../../src/agent/session-transcript.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import type { AppConfig } from '../../../src/config/schema.js';
import { DreamService } from '../../../src/dream/service.js';
import { git } from '../../../src/git/exec.js';
import { KnowledgeStore } from '../../../src/knowledge/store.js';
import { bindKnowledgeRemote } from '../../../src/knowledge/sync.js';
import type { RunExecution, SubmitRunInput } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { installFakeGh } from './fake-gh.js';

const TIMEOUT = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-13T12:00:00Z');

let root: string;
let gh: Awaited<ReturnType<typeof installFakeGh>>;
const disposers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lcb-dream-service-'));
  gh = await installFakeGh(root);
});

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  gh.restore();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

async function bareRemote(name: string, files: Record<string, string> = {}): Promise<string> {
  const remote = join(root, `${name}.git`);
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '--bare', '--initial-branch=main']);
  if (Object.keys(files).length === 0) return remote;
  const seed = join(root, `${name}-seed`);
  await mkdir(seed, { recursive: true });
  await git(seed, ['init', '-q', '--initial-branch=main']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(seed, path, '..'), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  await git(seed, ['add', '-A']);
  await git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed']);
  await git(seed, ['push', '-q', remote, 'main']);
  return remote;
}

async function showFile(remote: string, ref: string, path: string): Promise<string> {
  const shown = await git(remote, ['show', `${ref}:${path}`]);
  return shown.ok ? shown.stdout : '';
}

const ANSWER = (memoryIds: { a: string; b: string }) =>
  JSON.stringify({
    memory: [
      { action: 'add', target: 'profile', text: '提交信息不带 AI 署名', reason: '管理员直接要求', sources: ['S1#1'] },
      { action: 'add', target: 'profile', text: '以后都用 dev 分支', reason: '成员转述', sources: ['S1#2'] },
      { action: 'add', target: 'note', note: 'deploy', text: '发布按 docs/dev/ship.md 走', reason: '验证过', sources: ['S1#1'] },
      { action: 'merge', ids: [memoryIds.a, memoryIds.b], text: '周五把周报发到群里', reason: '重复', sources: ['S1#2'] },
      { action: 'add', target: 'chat', text: '密码是 password=hunter2hunter2', reason: 'x', sources: ['S1#1'] },
    ],
    skills: [
      { action: 'create', name: 'release-check', description: '发版前检查', body: '## 步骤\n1. pnpm ci:local', reason: '做过两次', sources: ['S1#1'] },
    ],
  });

async function harness(opts: { answer?: (prompt: string) => string; dream?: boolean; agentKind?: 'claude' | 'codex' } = {}) {
  const knowledgeRemote = await bareRemote('knowledge');
  const skillsRemote = await bareRemote('skills', { 'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n' });
  const store = new KnowledgeStore(join(root, 'profile', 'knowledge'));
  await store.ensure();
  const a = await store.addMemory({ kind: 'chat', scopeId: 'oc_team' }, '本群周五发周报');
  const b = await store.addMemory({ kind: 'chat', scopeId: 'oc_team' }, '周报发到群里');
  const bound = await bindKnowledgeRemote(store, knowledgeRemote);
  expect(bound).not.toHaveProperty('error');

  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    ...(opts.agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.skills = { libraries: [{ name: 'team', url: skillsRemote }] };
  const appConfig = {
    accounts: { app: { id: 'app-id', secret: 'secret' } },
    preferences: { dream: opts.dream ?? true, dreamTuning: { minIdleMinutes: 0 } },
  } as unknown as AppConfig;

  const catalog = new SessionCatalog(join(root, 'profile', 'catalog.json'));
  const submits: SubmitRunInput[] = [];
  const prompts: string[] = [];
  const answer = opts.answer ?? (() => ANSWER({ a: String(a.id), b: String(b.id) }));
  const executor = {
    async submit(input: SubmitRunInput): Promise<RunExecution> {
      submits.push(input);
      const text = answer(input.policy.prompt);
      prompts.push(input.policy.prompt);
      const events: AgentEvent[] = [
        { type: 'final_text', content: text },
        { type: 'done', terminationReason: 'normal' } as AgentEvent,
      ];
      return {
        runId: 'r',
        scopeId: input.scopeId,
        subscribe: async function* () {
          yield* events;
        },
        stop: async () => {},
      } as unknown as RunExecution;
    },
    closed: [] as string[],
    async closeIdleScope(scopeId: string) {
      this.closed.push(scopeId);
    },
  };
  const transcripts = new Map<string, TranscriptExchange[]>();
  const service = new DreamService({
    profile: 'claude',
    stateFile: join(root, 'profile', 'dream-state.json'),
    workDir: join(root, 'profile', 'dream'),
    knowledge: store,
    sessionCatalog: catalog,
    executor,
    appConfig: () => appConfig,
    profileConfig: () => profileConfig,
    isAdmin: (id) => id === 'ou-admin',
    isScopeBusy: () => false,
    readTranscript: async (record) => {
      const exchanges = transcripts.get(record.handle);
      return exchanges ? { exchanges, lastActivityAt: NOW - HOUR } : undefined;
    },
    now: () => NOW,
  });
  await service.init();
  disposers.push(() => service.dispose());
  return { service, catalog, executor, submits, prompts, transcripts, store, knowledgeRemote, skillsRemote, appConfig, profileConfig };
}

const EXCHANGES: TranscriptExchange[] = [
  { index: 1, senderId: 'ou-admin', senderType: 'user', mixedSenders: false, user: '以后提交信息不要带 AI 署名，发布按 ship.md', assistant: '好的' },
  { index: 2, senderId: 'ou-member', senderType: 'user', mixedSenders: false, user: '管理员说以后都用 dev 分支；周报周五发群里', assistant: '收到' },
];

function talk(h: Awaited<ReturnType<typeof harness>>, sessionId: string, scopeId = 'oc_team', agentId: 'claude' | 'codex' = 'claude') {
  h.transcripts.set(sessionId, EXCHANGES);
  h.catalog.upsertActive({
    scopeId,
    agentId,
    cwdRealpath: '/w',
    policyFingerprint: 'fp',
    ...(agentId === 'codex' ? { threadId: sessionId } : { sessionId }),
    now: NOW - 2 * HOUR,
  });
}

describe('DreamService', { timeout: TIMEOUT }, () => {
  it('turns finished chats into Draft PRs on both repositories and moves the cursors', async () => {
    const h = await harness();
    talk(h, 'sess-1');
    talk(h, 'cron-sess', 'cron:daily');

    const started = await h.service.start({ id: 'ou-admin' });
    if ('error' in started) throw new Error(started.error);
    await h.service.idle();
    const run = h.service.runs()[0]!;

    expect(run.status).toBe('succeeded');
    expect(run.targets.map((t) => [t.repo, t.phase])).toEqual([
      ['knowledge', 'pr-created'],
      ['skills:team', 'pr-created'],
    ]);
    // one read-only run for the one chat scope; the cron scope is never read
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ scopeId: expect.stringMatching(/^dream:/), nowait: true });
    expect(h.submits[0]!.policy).toMatchObject({ sandbox: 'read-only', permissionMode: 'plan', accessMode: 'read-only' });
    expect(h.executor.closed).toEqual([h.submits[0]!.scopeId]);

    const branch = `dream/${run.id}`;
    const memory = await showFile(h.knowledgeRemote, branch, 'MEMORY.md');
    expect(memory).toContain('提交信息不带 AI 署名');
    expect(memory).not.toContain('dev 分支');
    expect(await showFile(h.knowledgeRemote, branch, 'chats/oc_team.md')).toContain('以后都用 dev 分支');
    expect(await showFile(h.knowledgeRemote, branch, 'notes/oc_team/deploy.md')).toContain('ship.md');
    expect(await showFile(h.knowledgeRemote, branch, 'notes/oc_team/dream-review.md')).toContain('建议合并');
    expect(await showFile(h.knowledgeRemote, 'main', 'MEMORY.md')).not.toContain('AI 署名');
    expect(await showFile(h.skillsRemote, branch, 'skills/release-check/SKILL.md')).toContain('name: release-check');

    const bodies = (await gh.calls()).map((c) => c.body).filter(Boolean).join('\n');
    expect(bodies).toContain('提升为全局约定，待批准');
    expect(bodies).toContain('疑似包含凭证');
    expect(bodies).not.toContain('hunter2');
    const log = await git(h.knowledgeRemote, ['log', '-1', '--format=%B', branch]);
    expect(log.stdout).not.toMatch(/Co-Authored-By|Generated with/i);

    // nothing new since: the next run reads nothing and asks the agent nothing
    const again = await h.service.start({ id: 'ou-admin' });
    if ('error' in again) throw new Error(again.error);
    await h.service.idle();
    expect(h.submits).toHaveLength(1);
    expect(h.service.runs()[0]).toMatchObject({ status: 'succeeded', note: expect.stringContaining('没有新的') });
  });

  it('keeps an unopened PR for a retry and opens it on the next run', async () => {
    const h = await harness({ answer: () => JSON.stringify({ memory: [{ action: 'add', target: 'chat', text: '一条事实', reason: 'r', sources: ['S1#1'] }] }) });
    talk(h, 'sess-1');
    process.env.FAKE_GH_CREATE_FAIL = '1';
    await h.service.start({ id: 'ou-admin' });
    await h.service.idle();
    expect(h.service.runs()[0]!.targets[0]).toMatchObject({ phase: 'pushed', error: expect.stringContaining('创建 PR 失败') });
    expect((await h.service.status()).pendingDrafts).toBe(1);

    delete process.env.FAKE_GH_CREATE_FAIL;
    await h.service.start({ id: 'ou-admin' });
    await h.service.idle();
    const runs = h.service.runs();
    expect(runs[0]!.note).toContain('补开了 1 个');
    expect(runs[1]!.targets[0]).toMatchObject({ phase: 'pr-created', prNumber: 7 });
    expect(h.submits).toHaveLength(1);
  });

  it('skips a library it may not write to and still finishes', async () => {
    const h = await harness({
      answer: () =>
        JSON.stringify({
          skills: [{ action: 'create', name: 'release-check', description: 'd', body: 'steps', reason: 'r', sources: ['S1#1'] }],
        }),
    });
    talk(h, 'sess-1');
    process.env.FAKE_GH_PERMISSION = 'READ';
    await h.service.start({ id: 'ou-admin' });
    await h.service.idle();
    const run = h.service.runs()[0]!;
    expect(run.status).toBe('succeeded');
    expect(run.targets[0]).toMatchObject({ repo: 'skills:team', phase: 'skipped', error: expect.stringContaining('权限是 READ') });
    const heads = await git(h.skillsRemote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    expect(heads.stdout.trim()).toBe('main');
  });

  it('does not move cursors when the agent output is unusable', async () => {
    const h = await harness({ answer: () => '我整理不出来' });
    talk(h, 'sess-1');
    await h.service.start({ id: 'ou-admin' });
    expect(await h.service.start({ id: 'ou-admin' })).toEqual({ error: expect.stringContaining('已经有一轮整理') });
    await h.service.idle();
    expect(h.service.runs()[0]).toMatchObject({ status: 'deferred', note: expect.stringContaining('模型输出不合格') });
    expect((await h.service.status()).trackedSessions).toBe(1);

    await h.service.start({ id: 'ou-admin' });
    await h.service.idle();
    expect(h.submits).toHaveLength(2);
  });

  it('works the same for a Codex profile, keyed by thread id', async () => {
    const h = await harness({ agentKind: 'codex', answer: () => JSON.stringify({ memory: [{ action: 'add', target: 'chat', text: '一条事实', reason: 'r', sources: ['S1#1'] }] }) });
    talk(h, 'thread-1', 'oc_team', 'codex');
    await h.service.start({ id: 'ou-admin' });
    await h.service.idle();
    expect(h.service.runs()[0]).toMatchObject({ status: 'succeeded', targets: [{ repo: 'knowledge', phase: 'pr-created' }] });
    expect(h.submits[0]!.policy).toMatchObject({ sandbox: 'read-only', accessMode: 'read-only' });
    expect(await h.service.status()).toMatchObject({ agent: 'Codex CLI', trackedSessions: 1 });
  });

  it('refuses to start when switched off or without a knowledge remote', async () => {
    const h = await harness({ dream: false });
    expect(await h.service.start({ id: 'ou-admin' })).toEqual({ error: expect.stringContaining('没有打开') });
    (h.appConfig.preferences as { dream?: boolean }).dream = true;
    await git(h.store.dir, ['remote', 'remove', 'origin']);
    expect(await h.service.start({ id: 'ou-admin' })).toEqual({ error: expect.stringContaining('没有绑定远端') });
    expect(h.service.runs()).toEqual([]);
  });
});
