import { randomBytes } from 'node:crypto';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { agentCapability } from '../agent/capability';
import { resolveEffortArg, resolveModelArg } from '../agent/models';
import { agentDescriptor, isAgentKind } from '../agent/registry';
import { readAgentTranscript, type AgentTranscript } from '../agent/session-transcript';
import type { ProfileConfig, SkillLibraryConfig } from '../config/profile-schema';
import { getDream, resolveDreamSettings, type AppConfig, type DreamSettings } from '../config/schema';
import { log } from '../core/logger';
import { maskUrlCredentials } from '../knowledge/libraries';
import type { KnowledgeStore, MemoryEntry, SkillSummary } from '../knowledge/store';
import { knowledgeRemoteUrl } from '../knowledge/sync';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { RunExecution, SubmitRunInput } from '../runtime/run-executor';
import type { SessionCatalog, SessionCatalogEntry } from '../session/catalog';
import { buildDreamScopePrompt } from './prompt';
import {
  parseDreamOutput,
  validateDreamProposals,
  type DreamRejection,
  type MemoryAddition,
  type MemoryFlag,
  type SkillProposal,
} from './proposal';
import {
  checkoutDiff,
  checkPullRequestAccess,
  commitDraft,
  dreamBranch,
  openDraftPullRequest,
  prepareCheckout,
  pullRequestDiff,
  pullRequestState,
  pushDraft,
  writeKnowledgeDraft,
  writeSkillDraft,
  type RepoSpec,
} from './publish';
import {
  commitMessage,
  flagLine,
  knowledgePrBody,
  knowledgePrTitle,
  sessionLegend,
  skillsPrBody,
  skillsPrTitle,
  type SessionLegend,
} from './report';
import { selectDreamInputs, type DreamScopeInput } from './select';
import { DreamStateStore, sessionKey, type DreamRun, type DreamSessionRecord, type DreamTarget } from './state';

/**
 * 梦境整理 (P1): an admin asks for it, the bridge reads the conversations it
 * ran since last time, has the agent draft memory / note / skill proposals
 * per scope in a read-only run, validates them, and opens Draft PRs against
 * the knowledge repo (its `origin`) and the profile's own skill library (from
 * `skills.libraries`). Nothing it produces takes effect until a human merges.
 *
 * One run per profile at a time. Off by default; turning the switch off stops
 * new runs, and a run re-checks the switch before it publishes.
 */

export interface DreamActor {
  id: string;
  name?: string;
}

/** The slice of {@link RunExecutor} a dream run needs. */
export interface DreamExecutor {
  submit(input: SubmitRunInput): Promise<RunExecution>;
  closeIdleScope?(scopeId: string): Promise<void>;
}

export interface DreamServiceDeps {
  profile: string;
  stateFile: string;
  /** Scratch space: checkouts per batch, the agent's empty cwd. */
  workDir: string;
  knowledge: KnowledgeStore;
  sessionCatalog?: SessionCatalog;
  executor: DreamExecutor;
  appConfig: () => AppConfig;
  profileConfig: () => ProfileConfig;
  /** An authenticated admin (owner or listed) — decides whose words can change shared rules. */
  isAdmin: (senderId: string) => boolean;
  /** A run is in flight for this chat scope right now. */
  isScopeBusy: (scopeId: string) => boolean;
  readTranscript?: (record: DreamSessionRecord) => Promise<AgentTranscript | undefined>;
  now?: () => number;
}

export interface DreamTargetsView {
  knowledge: { url?: string; problem?: string };
  skills: { library?: string; problem?: string };
}

export interface DreamStatusView {
  enabled: boolean;
  settings: DreamSettings;
  agent: string;
  targets: DreamTargetsView;
  running?: DreamRun;
  runs: DreamRun[];
  lastSucceededAt?: number;
  /** Draft PRs this profile opened in its recent runs. */
  openedPrs: number;
  /** Drafts kept locally (no push / PR yet), retried by the next run. */
  pendingDrafts: number;
  trackedSessions: number;
}

const KEEP_CHECKOUT_RUNS = 5;

export class DreamService {
  private readonly state: DreamStateStore;
  private readonly now: () => number;
  private current: { id: string; abort: AbortController; done: Promise<void>; execution?: RunExecution } | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: DreamServiceDeps) {
    this.state = new DreamStateStore(deps.stateFile);
    this.now = deps.now ?? Date.now;
  }

  async init(): Promise<void> {
    await this.state.load(this.now());
    this.unsubscribe = this.deps.sessionCatalog?.onUpsert((entry) => {
      if (this.enabled()) this.noteEntry(entry, entry.updatedAt);
    });
    if (this.enabled()) this.noteCatalog();
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancel();
    await this.current?.done.catch(() => undefined);
    await this.state.flush();
  }

  enabled(): boolean {
    return getDream(this.deps.appConfig()) !== undefined;
  }

  async status(): Promise<DreamStatusView> {
    return composeDreamStatus({
      state: this.state,
      running: this.current ? this.state.run(this.current.id) : undefined,
      appConfig: this.deps.appConfig(),
      profileConfig: this.deps.profileConfig(),
      knowledge: this.deps.knowledge,
    });
  }

  runs(): DreamRun[] {
    return this.state.runs().reverse();
  }

  /**
   * Start a run in the background. `onFinish` hears the outcome once — the
   * only message a run ever sends, and only because someone asked for it.
   */
  async start(actor: DreamActor, onFinish?: (run: DreamRun) => void): Promise<{ run: DreamRun } | { error: string }> {
    if (!this.enabled()) return { error: '梦境整理没有打开（/config 里打开「梦境整理」）。' };
    const busy = () => (this.current ? { error: `已经有一轮整理在进行（批次 \`${this.current.id}\`）。` } : undefined);
    const already = busy();
    if (already) return already;
    // Without a remote there is nowhere to put a draft, and reading the input
    // anyway would only consume it.
    if (!(await knowledgeRemoteUrl(this.deps.knowledge).catch(() => undefined))) {
      return { error: '知识库还没有绑定远端仓库，草稿无处提交。先用 `/knowledge bind <git 仓库地址>` 绑定。' };
    }
    const raced = busy();
    if (raced) return raced;
    const id = batchId(this.now());
    const run: DreamRun = {
      id,
      status: 'queued',
      actorId: actor.id,
      startedAt: this.now(),
      sessions: 0,
      scopes: 0,
      exchanges: 0,
      memoryItems: 0,
      skillItems: 0,
      rejected: 0,
      deferred: [],
      targets: [],
    };
    this.state.addRun(run);
    const abort = new AbortController();
    const current: NonNullable<DreamService['current']> = { id, abort, done: Promise.resolve() };
    this.current = current;
    current.done = this.execute(run, actor, abort.signal)
      .catch((err: unknown) => {
        log.fail('dream', err, { step: 'run', batch: id });
        this.finish(id, 'failed', `整理出错：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.current === current) this.current = undefined;
        const final = this.state.run(id);
        if (final && onFinish) {
          try {
            onFinish(final);
          } catch (err) {
            log.fail('dream', err, { step: 'on-finish' });
          }
        }
      });
    return { run: this.state.run(id)! };
  }

  /** Stop the running batch: no new agent turn, no further publishing step. */
  cancel(): boolean {
    if (!this.current) return false;
    this.current.abort.abort();
    void this.current.execution?.stop().catch(() => undefined);
    return true;
  }

  /** Wait for the running batch, if any (tests, shutdown). */
  async idle(): Promise<void> {
    await this.current?.done.catch(() => undefined);
  }

  /** PRs of recent runs, newest first, each with its live state from `gh` when it answers. */
  async pullRequests(limit = 10): Promise<Array<{ run: DreamRun; target: DreamTarget; state?: string }>> {
    const entries = this.runs()
      .flatMap((run) => run.targets.filter((target) => target.prUrl).map((target) => ({ run, target })))
      .slice(0, limit);
    return Promise.all(
      entries.map(async (entry) => {
        const state = await pullRequestState(this.deps.workDir, entry.target.prUrl!);
        return state ? { ...entry, state } : entry;
      }),
    );
  }

  /** Diff of one batch (default: the latest that produced something). */
  async diff(id?: string): Promise<{ id: string; parts: Array<{ label: string; diff: string }> } | { error: string }> {
    const run = id
      ? this.state.run(id)
      : this.runs().find((item) => item.targets.some((target) => target.commit || target.prUrl));
    if (!run) return { error: id ? `没有批次 \`${id}\`。` : '还没有生成过草稿。' };
    const parts: Array<{ label: string; diff: string }> = [];
    for (const target of run.targets) {
      if (target.checkoutDir) {
        const local = await checkoutDiff(target.checkoutDir);
        if (local) {
          parts.push({ label: target.label, diff: local });
          continue;
        }
      }
      if (target.prUrl) {
        const remote = await pullRequestDiff(this.deps.workDir, target.prUrl);
        parts.push({ label: target.label, diff: typeof remote === 'string' ? remote : `（读不到差异：${remote.error}）` });
      }
    }
    if (parts.length === 0) return { error: `批次 \`${run.id}\` 没有可看的差异。` };
    return { id: run.id, parts };
  }

  // ---------------------------------------------------------------------------

  private async execute(run: DreamRun, actor: DreamActor, signal: AbortSignal): Promise<void> {
    const settings = getDream(this.deps.appConfig());
    if (!settings) return this.finish(run.id, 'cancelled', '梦境整理已关闭');
    this.state.updateRun(run.id, { status: 'running' });
    await mkdir(this.deps.workDir, { recursive: true, mode: 0o700 });

    // Drafts an earlier run could not push / open a PR for come first: they
    // are retried from the phase they stopped at, never re-committed.
    const resumed = await this.resumePendingTargets(signal);

    this.noteCatalog();
    const selection = await selectDreamInputs({
      records: this.state.sessions(),
      settings,
      now: this.now(),
      isBusy: this.deps.isScopeBusy,
      read: this.deps.readTranscript ?? ((record) => readAgentTranscript(record.agentId, this.deps.profileConfig(), record.handle, record.cwd)),
    });
    for (const record of selection.idle) this.state.advance(record.key, record.consumed, record.consumedHash, this.now());
    const deferred = [...selection.deferred];
    const sessionsTotal = selection.scopes.reduce((sum, scope) => sum + scope.sessions.length, 0);
    this.state.updateRun(run.id, {
      sessions: sessionsTotal,
      scopes: selection.scopes.length,
      exchanges: selection.scopes.reduce(
        (sum, scope) => sum + scope.sessions.reduce((inner, session) => inner + session.exchanges.length, 0),
        0,
      ),
      deferred,
    });
    if (selection.scopes.length === 0) {
      const note = [resumed, deferred.length > 0 ? `${deferred.length} 个会话延后` : '没有新的已结束会话可整理']
        .filter(Boolean)
        .join('；');
      return this.finish(run.id, deferred.length > 0 && !resumed ? 'deferred' : 'succeeded', note);
    }

    const [profileMemory, skills] = await Promise.all([
      this.deps.knowledge.listMemories({ kind: 'profile' }),
      this.deps.knowledge.listSkills(),
    ]);
    const deadline = this.now() + settings.maxRunMinutes * 60_000;
    const additions: MemoryAddition[] = [];
    const flags: MemoryFlag[] = [];
    const skillProposals: SkillProposal[] = [];
    const rejected: DreamRejection[] = [];
    const done: DreamScopeInput[] = [];

    for (const scope of selection.scopes) {
      if (signal.aborted) return this.finish(run.id, 'cancelled', '已取消，游标未移动');
      if (!this.enabled()) return this.finish(run.id, 'cancelled', '梦境整理已关闭，游标未移动');
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        for (const session of scope.sessions) deferred.push({ key: session.record.key, reason: '超出本轮运行时间' });
        continue;
      }
      const chatMemory = await this.deps.knowledge.listMemories({ kind: 'chat', scopeId: scope.scopeId });
      const outcome = await this.proposeForScope(run.id, done.length, scope, {
        actor,
        profileMemory,
        chatMemory,
        skills,
        remainingMs: remaining,
        signal,
      });
      if (signal.aborted) return this.finish(run.id, 'cancelled', '已取消，游标未移动');
      if ('error' in outcome) {
        for (const session of scope.sessions) deferred.push({ key: session.record.key, reason: outcome.error });
        continue;
      }
      additions.push(...outcome.additions);
      flags.push(...outcome.flags);
      skillProposals.push(...outcome.skills);
      rejected.push(...outcome.rejected);
      done.push(scope);
    }
    this.state.updateRun(run.id, {
      deferred,
      memoryItems: additions.length + flags.length,
      skillItems: skillProposals.length,
      rejected: rejected.length,
    });
    if (done.length === 0) {
      return this.finish(run.id, 'deferred', `${deferred.length} 个会话延后：${deferred[0]?.reason ?? ''}`);
    }

    // Publishing changes shared repositories: the switch is checked once more.
    if (!this.enabled()) return this.finish(run.id, 'cancelled', '梦境整理已关闭，草稿未发布');
    const legend = done.flatMap((scope) => scope.sessions.map(sessionLegend));
    const published: string[] = [];
    let blocked = false;

    if (additions.length > 0 || flags.length > 0) {
      const target = await this.publishKnowledge(run.id, { additions, flags, rejected, legend }, signal);
      if (target.phase === 'failed') blocked = true;
      if (target.commit) published.push(...additions.map((item) => item.hash), ...flags.map((item) => item.hash));
    }
    if (skillProposals.length > 0 && !signal.aborted) {
      const outcome = await this.publishSkills(run.id, skillProposals, rejected, legend, signal);
      if (outcome.blocked) blocked = true;
      published.push(...outcome.published);
    }
    if (signal.aborted) return this.finish(run.id, 'cancelled', '已取消；已生成的草稿保留，游标未移动');

    if (blocked) {
      return this.finish(run.id, 'failed', '有仓库没能生成草稿，游标未移动，下次整理会重试');
    }
    // The draft is safely in a commit (pushed or kept locally for a retry):
    // these exchanges are consumed.
    this.state.markPublished(published);
    for (const scope of done) {
      for (const session of scope.sessions) {
        this.state.advance(session.record.key, session.nextConsumed, session.nextHash, this.now());
      }
    }
    await this.pruneCheckouts();
    const targets = this.state.run(run.id)?.targets ?? [];
    const problems = targets.filter((target) => target.error);
    const summary = [
      resumed,
      `${done.length} 个范围、${legend.length} 个会话`,
      `记忆 / 笔记 ${additions.length + flags.length} 条，skill ${skillProposals.length} 个，未采纳 ${rejected.length} 条`,
      targets.length === 0 ? '没有值得提交的内容' : undefined,
      deferred.length > 0 ? `${deferred.length} 个会话延后` : undefined,
      problems.length > 0 ? problems.map((target) => `${target.label}：${target.error}`).join('；') : undefined,
    ]
      .filter(Boolean)
      .join('；');
    return this.finish(run.id, 'succeeded', summary);
  }

  private async proposeForScope(
    batch: string,
    ordinal: number,
    scope: DreamScopeInput,
    ctx: {
      actor: DreamActor;
      profileMemory: MemoryEntry[];
      chatMemory: MemoryEntry[];
      skills: SkillSummary[];
      remainingMs: number;
      signal: AbortSignal;
    },
  ): Promise<ReturnType<typeof validateDreamProposals> | { error: string }> {
    const built = buildDreamScopePrompt({
      scope,
      profileMemory: ctx.profileMemory,
      chatMemory: ctx.chatMemory,
      skills: ctx.skills,
      isAdmin: this.deps.isAdmin,
    });
    const answer = await this.runAgent(`dream:${batch}:${ordinal + 1}`, built.prompt, ctx.actor, ctx.remainingMs, ctx.signal);
    if ('error' in answer) return answer;
    const parsed = parseDreamOutput(answer.text);
    if ('error' in parsed) return { error: `模型输出不合格：${parsed.error}` };
    return validateDreamProposals(parsed, {
      scopeId: scope.scopeId,
      refs: built.refs,
      profileMemory: ctx.profileMemory,
      chatMemory: ctx.chatMemory,
      skills: ctx.skills,
      isPublished: (hash) => this.state.isPublished(hash),
    });
  }

  /**
   * One read-only agent turn in a fresh conversation of its own, in an empty
   * scratch directory. The policy is forced to read-only whatever the chat
   * agent is allowed; if the result is not read-only the run is refused.
   */
  private async runAgent(
    scopeId: string,
    prompt: string,
    actor: DreamActor,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ text: string } | { error: string }> {
    const profileConfig = this.deps.profileConfig();
    const scratch = join(this.deps.workDir, 'scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const cwdRealpath = await realpath(scratch);
    const readOnly: ProfileConfig = {
      ...profileConfig,
      permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' },
    };
    const capability = agentCapability(readOnly);
    const policy = evaluateRunPolicy({
      scope: { source: 'dream', actorId: actor.id },
      attachments: [],
      prompt,
      requestedCwd: cwdRealpath,
      cwdRealpath,
      access: { ok: true, reason: 'allowed-admin' },
      capability,
      profileConfig: readOnly,
      now: this.now(),
      codexHome: profileConfig.codex?.codexHome,
      inheritCodexHome: profileConfig.codex?.inheritCodexHome,
    });
    if (!policy.ok || policy.accessMode !== 'read-only' || policy.sandbox !== 'read-only' || policy.permissionMode !== 'plan') {
      return { error: '无法保证只读执行，已跳过' };
    }
    let execution: RunExecution;
    try {
      execution = await this.deps.executor.submit({
        scopeId,
        policy,
        model: resolveModelArg(profileConfig.agentKind, profileConfig.preferences.model),
        effort: resolveEffortArg(profileConfig.agentKind, profileConfig.preferences.effort),
        nowait: true,
        actor,
        observability: { profile: this.deps.profile, agent: capability.agentId, source: 'dream', stage: 'submit' },
      });
    } catch (err) {
      return { error: `整理 agent 没能启动（${err instanceof Error ? err.message : String(err)}）` };
    }
    if (this.current) this.current.execution = execution;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void execution.stop().catch(() => undefined);
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => void execution.stop().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    let finalText: string | undefined;
    let streamed = '';
    let failure: string | undefined;
    try {
      for await (const event of execution.subscribe()) {
        if (event.type === 'final_text') finalText = event.content;
        else if (event.type === 'text') streamed += event.delta;
        else if (event.type === 'error') failure = event.message;
        else if (event.type === 'done' && event.terminationReason !== 'normal') failure = event.terminationReason;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.current) this.current.execution = undefined;
      await this.deps.executor.closeIdleScope?.(scopeId).catch(() => undefined);
    }
    if (timedOut) return { error: '超出本轮运行时间' };
    if (signal.aborted) return { error: '已取消' };
    const text = finalText ?? streamed;
    if (failure && !text.trim()) return { error: `整理 agent 运行失败：${failure.slice(0, 200)}` };
    return { text };
  }

  private async publishKnowledge(
    id: string,
    input: { additions: MemoryAddition[]; flags: MemoryFlag[]; rejected: DreamRejection[]; legend: SessionLegend[] },
    signal: AbortSignal,
  ): Promise<DreamTarget> {
    const target: DreamTarget = { repo: 'knowledge', label: '知识库', branch: dreamBranch(id), phase: 'failed', items: 0 };
    const url = await knowledgeRemoteUrl(this.deps.knowledge);
    if (!url) return this.saveTarget(id, { ...target, error: '知识库没有绑定远端（/knowledge bind），草稿未生成' });
    const dir = join(this.deps.workDir, 'batches', id, 'knowledge');
    const prepared = await prepareCheckout({ repo: 'knowledge', label: '知识库', url }, dir, target.branch);
    if ('error' in prepared) return this.saveTarget(id, { ...target, error: prepared.error });
    if (signal.aborted) return this.saveTarget(id, { ...target, error: '已取消' });
    // Merge / conflict / stale flags go into a per-scope review note, so they
    // show up in the diff and survive the merge as a record; the original
    // entries are never touched.
    const reviewEntries: MemoryAddition[] = input.flags.map((flag) => ({
      kind: 'add',
      scopeId: flag.scopeId,
      target: 'note',
      note: 'dream-review',
      text: `${flagLine(flag)}（理由：${flag.reason}；来源：${flag.sources.map((ref) => ref.ref).join('、')}；批次 ${id}）`,
      reason: flag.reason,
      sources: flag.sources,
      hash: flag.hash,
    }));
    const draft = await writeKnowledgeDraft(dir, [...input.additions, ...reviewEntries]);
    const written = draft.written.filter((item) => !reviewEntries.includes(item));
    const writtenFlags = input.flags.filter((flag) => draft.written.some((item) => item.hash === flag.hash && reviewEntries.includes(item)));
    if (draft.files.length === 0) {
      return this.saveTarget(id, {
        ...target,
        base: prepared.base,
        phase: 'skipped',
        error: draft.errors[0] ?? '提案都已在最新基线里，没有改动',
        checkoutDir: dir,
      });
    }
    const title = knowledgePrTitle(id, written.length + writtenFlags.length);
    const body = knowledgePrBody({
      batchId: id,
      profile: this.deps.profile,
      written,
      flags: writtenFlags,
      duplicates: draft.duplicates.length,
      rejected: input.rejected.filter((item) => item.kind !== 'skill'),
      legend: input.legend,
    });
    return this.commitAndPublish(id, {
      ...target,
      base: prepared.base,
      items: written.length + writtenFlags.length,
      checkoutDir: dir,
      title,
      body,
    }, draft.files, `记忆 / 笔记 ${written.length} 条，待确认标记 ${writtenFlags.length} 条`, signal);
  }

  private async publishSkills(
    id: string,
    proposals: SkillProposal[],
    rejected: DreamRejection[],
    legend: SessionLegend[],
    signal: AbortSignal,
  ): Promise<{ blocked: boolean; published: string[] }> {
    const profileConfig = this.deps.profileConfig();
    const libraries = profileConfig.skills?.libraries ?? [];
    const settings = resolveDreamSettings(this.deps.appConfig().preferences?.dreamTuning);
    const fallback = defaultSkillLibrary(libraries, settings.skillLibrary);
    const groups = new Map<string, { library?: SkillLibraryConfig; problem?: string; items: SkillProposal[] }>();
    for (const proposal of proposals) {
      const library =
        proposal.action === 'update'
          ? libraries.find((item) => item.name === proposal.source)
          : 'library' in fallback
            ? fallback.library
            : undefined;
      const key = library?.name ?? '';
      const group = groups.get(key) ?? {
        ...(library ? { library } : {}),
        ...(!library ? { problem: 'problem' in fallback ? fallback.problem : '找不到 skill 所在的库' } : {}),
        items: [],
      };
      group.items.push(proposal);
      groups.set(key, group);
    }
    let blocked = false;
    const published: string[] = [];
    for (const [name, group] of groups) {
      const repo = `skills:${name || '-'}`;
      const label = name ? `skill 库 ${name}` : 'skill 库';
      const target: DreamTarget = { repo, label, branch: dreamBranch(id), phase: 'failed', items: 0 };
      if (!group.library) {
        this.saveTarget(id, { ...target, phase: 'skipped', error: `${group.problem}，${group.items.length} 个 skill 提案未提交` });
        continue;
      }
      const dir = join(this.deps.workDir, 'batches', id, `skills-${group.library.name}`);
      const spec: RepoSpec = { repo, label, url: group.library.url, ...(group.library.ref ? { ref: group.library.ref } : {}) };
      const prepared = await prepareCheckout(spec, dir, target.branch);
      if ('error' in prepared) {
        // Pinned to a tag / commit is a configuration fact, not a hiccup: skip
        // rather than retry forever.
        const permanent = /不能作为写入目标|不合法/.test(prepared.error);
        if (!permanent) blocked = true;
        this.saveTarget(id, { ...target, phase: permanent ? 'skipped' : 'failed', error: prepared.error });
        continue;
      }
      const draft = await writeSkillDraft(dir, group.library, group.items);
      const skillRejected = [
        ...rejected.filter((item) => item.kind === 'skill'),
        ...draft.rejected.map((item) => ({ scopeId: item.proposal.scopeId, kind: 'skill' as const, reason: item.reason })),
      ];
      if (draft.files.length === 0) {
        this.saveTarget(id, {
          ...target,
          base: prepared.base,
          phase: 'skipped',
          error: draft.rejected[0]?.reason ?? '没有改动',
          checkoutDir: dir,
        });
        continue;
      }
      const result = await this.commitAndPublish(
        id,
        {
          ...target,
          base: prepared.base,
          items: draft.written.length,
          checkoutDir: dir,
          title: skillsPrTitle(id, draft.written.length),
          body: skillsPrBody({
            batchId: id,
            profile: this.deps.profile,
            library: group.library.name,
            written: draft.written,
            rejected: skillRejected,
            legend,
          }),
        },
        draft.files,
        `skill 提案 ${draft.written.length} 个`,
        signal,
      );
      if (result.phase === 'failed') blocked = true;
      if (result.commit) published.push(...draft.written.map((item) => item.hash));
    }
    return { blocked, published };
  }

  /** Commit, then push and open the PR as far as access allows; the phase records how far it got. */
  private async commitAndPublish(
    id: string,
    target: DreamTarget,
    files: string[],
    summary: string,
    signal: AbortSignal,
  ): Promise<DreamTarget> {
    const dir = target.checkoutDir!;
    const committed = await commitDraft(dir, files, commitMessage(id, summary), this.hooksDir());
    if ('error' in committed) return this.saveTarget(id, { ...target, phase: 'failed', error: committed.error });
    const saved = this.saveTarget(id, { ...target, commit: committed.commit, phase: 'committed' });
    if (signal.aborted) return this.saveTarget(id, { ...saved, error: '已取消，草稿保留在本地' });
    return this.pushAndOpen(id, saved);
  }

  private async pushAndOpen(id: string, target: DreamTarget): Promise<DreamTarget> {
    const dir = target.checkoutDir!;
    let current = target;
    if (current.phase === 'committed') {
      const access = await checkPullRequestAccess(dir);
      if ('error' in access) {
        // No write access is permanent for this repo (third-party / read-only
        // library); a missing or logged-out gh is not — keep the commit for a retry.
        const permanent = /权限是/.test(access.error);
        return this.saveTarget(id, { ...current, ...(permanent ? { phase: 'skipped' as const } : {}), error: access.error });
      }
      const pushed = await pushDraft(dir, current.branch, this.hooksDir());
      if ('error' in pushed) return this.saveTarget(id, { ...current, error: pushed.error });
      current = this.saveTarget(id, { ...current, phase: 'pushed', error: undefined });
    }
    if (current.phase === 'pushed') {
      const pr = await openDraftPullRequest(dir, {
        branch: current.branch,
        base: current.base ?? 'main',
        title: current.title ?? `梦境整理 ${id}`,
        body: current.body ?? '',
      });
      if ('error' in pr) return this.saveTarget(id, { ...current, error: pr.error });
      current = this.saveTarget(id, {
        ...current,
        phase: 'pr-created',
        prUrl: pr.url,
        ...(pr.number ? { prNumber: pr.number } : {}),
        error: undefined,
      });
    }
    return current;
  }

  /** Retry every earlier draft stuck at `committed` / `pushed`. Returns a summary or ''. */
  private async resumePendingTargets(signal: AbortSignal): Promise<string> {
    let opened = 0;
    let still = 0;
    for (const run of this.state.runs()) {
      for (const target of run.targets) {
        if (target.phase !== 'committed' && target.phase !== 'pushed') continue;
        if (signal.aborted) return '';
        if (!target.checkoutDir) continue;
        const result = await this.pushAndOpen(run.id, target);
        if (result.phase === 'pr-created') opened++;
        else still++;
      }
    }
    if (opened === 0 && still === 0) return '';
    return `补开了 ${opened} 个之前没开成的 PR${still > 0 ? `，还有 ${still} 个仍在等待` : ''}`;
  }

  private saveTarget(id: string, target: DreamTarget): DreamTarget {
    const clean = { ...target };
    if (clean.error === undefined) delete clean.error;
    this.state.saveTarget(id, clean);
    return clean;
  }

  private finish(id: string, status: DreamRun['status'], note: string): void {
    this.state.updateRun(id, { status, endedAt: this.now(), note });
    log.info('dream', 'run-finished', { batch: id, status });
  }

  private hooksDir(): string {
    return join(this.deps.workDir, 'no-hooks');
  }

  private noteCatalog(): void {
    for (const entry of this.deps.sessionCatalog?.entries() ?? []) this.noteEntry(entry, entry.updatedAt);
  }

  private noteEntry(entry: SessionCatalogEntry, at: number): void {
    if (!isAgentKind(entry.agentId)) return;
    const handle = entry[agentDescriptor(entry.agentId).sessionHandle];
    if (!handle) return;
    this.state.noteSession({ agentId: entry.agentId, handle, scopeId: entry.scopeId, cwd: entry.cwdRealpath, at });
  }

  /** Keep the checkouts of the latest runs and of drafts still waiting for a retry. */
  private async pruneCheckouts(): Promise<void> {
    const root = join(this.deps.workDir, 'batches');
    const runs = this.state.runs();
    const keep = new Set(runs.slice(-KEEP_CHECKOUT_RUNS).map((run) => run.id));
    for (const run of runs) {
      if (run.targets.some((target) => target.phase === 'committed' || target.phase === 'pushed')) keep.add(run.id);
    }
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
      const run = runs.find((item) => item.id === name);
      for (const target of run?.targets ?? []) {
        if (target.checkoutDir) this.state.saveTarget(name, { ...target, checkoutDir: undefined });
      }
    }
  }
}

/**
 * The status of a profile's 梦境整理 from its state file and config. The
 * service passes its own running batch; a viewer in another process (the web
 * console looking at a daemon-run profile) takes the stored one.
 */
export async function composeDreamStatus(input: {
  state: DreamStateStore;
  running?: DreamRun;
  appConfig: AppConfig;
  profileConfig: ProfileConfig;
  knowledge: KnowledgeStore;
}): Promise<DreamStatusView> {
  const runs = input.state.runs();
  const targets = runs.slice(-10).flatMap((run) => run.targets);
  const lastSucceeded = [...runs].reverse().find((run) => run.status === 'succeeded');
  const running =
    input.running ?? [...runs].reverse().find((run) => run.status === 'queued' || run.status === 'running');
  const settings = resolveDreamSettings(input.appConfig.preferences?.dreamTuning);
  const url = await knowledgeRemoteUrl(input.knowledge).catch(() => undefined);
  const library = defaultSkillLibrary(input.profileConfig.skills?.libraries ?? [], settings.skillLibrary);
  return {
    enabled: getDream(input.appConfig) !== undefined,
    settings,
    agent: agentDescriptor(input.profileConfig.agentKind).displayName,
    targets: {
      knowledge: url ? { url: maskUrlCredentials(url) } : { problem: '知识库没有绑定远端（/knowledge bind）' },
      skills: 'library' in library ? { library: library.library.name } : { problem: library.problem },
    },
    ...(running ? { running } : {}),
    runs: runs.slice(-5).reverse(),
    ...(lastSucceeded?.endedAt ? { lastSucceededAt: lastSucceeded.endedAt } : {}),
    openedPrs: targets.filter((target) => target.phase === 'pr-created').length,
    pendingDrafts: targets.filter((target) => target.phase === 'committed' || target.phase === 'pushed').length,
    trackedSessions: input.state.sessions().length,
  };
}

/**
 * The library new skills go to: the configured `dreamTuning.skillLibrary`,
 * else the only library there is. More than one and none chosen is ambiguous.
 */
export function defaultSkillLibrary(
  libraries: readonly SkillLibraryConfig[],
  chosen: string | undefined,
): { library: SkillLibraryConfig } | { problem: string } {
  if (chosen) {
    const library = libraries.find((item) => item.name === chosen);
    return library ? { library } : { problem: `配置的 skill 库 ${chosen} 不存在` };
  }
  if (libraries.length === 0) return { problem: '没有配置 skill 库（/skills lib add）' };
  if (libraries.length > 1) return { problem: '配置了多个 skill 库，需要在 preferences.dreamTuning.skillLibrary 里指定一个' };
  return { library: libraries[0]! };
}

function batchId(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`;
}

export { sessionKey };
