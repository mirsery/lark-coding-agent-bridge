import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bridgeRoot, guardHookEnv, ownerOnlyGuard, restrictedChatGuard } from '../../../src/policy/owner-guard';

type Input = Record<string, unknown>;
type Lookup = (input: Input) => Promise<Record<string, unknown> | undefined>;
interface Call {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  pinned?: boolean;
}
type Verdict = { refuse: string } | { command: string } | null;
const SCRIPT = join(bridgeRoot(), 'bin', 'codex-hook.mjs');
const hook = (await import(pathToFileURL(SCRIPT).href)) as {
  patchFiles: (patch: string) => Array<{ path: string; content: string }>;
  callArguments: (input: Input) => Promise<Record<string, unknown> | undefined>;
  claudeCalls: (input: Input, lookup?: Lookup) => Promise<Call[]>;
  review: (input: Input, cfg: unknown, lookup?: Lookup) => Promise<Verdict>;
  skillFiles: (command: string) => string[];
};

const scratch = mkdtempSync(join(tmpdir(), 'codex-hook-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const HOME = join(scratch, 'home');
const WS = join(HOME, 'ws');
const PRIVATE = join(HOME, 'private');
const RO = join(HOME, 'ro');
for (const dir of [WS, PRIVATE, RO]) mkdirSync(dir, { recursive: true });
const guard = ownerOnlyGuard({ larkChannelHome: join(HOME, '.lark-channel'), guestReadOnlyRoots: [RO], workspace: WS, home: HOME, root: bridgeRoot() });
const { LARK_CHANNEL_GUARD } = guardHookEnv(guard);
const cfg = JSON.parse(LARK_CHANNEL_GUARD) as unknown;

const at = (workdir?: string): Lookup => async () => (workdir === undefined ? {} : { workdir });
const bash = (command: string): Input => ({ tool_name: 'Bash', tool_input: { command }, cwd: WS, tool_use_id: 'call_1' });

describe('codex-hook: Codex calls read as the Claude calls the guard checks', () => {
  it('runs a shell call where its workdir says, a cd there first', async () => {
    expect(await hook.claudeCalls(bash('ls'), at())).toEqual([{ toolName: 'Bash', toolInput: { command: 'ls' }, cwd: WS }]);
    expect(await hook.claudeCalls(bash('ls'), at(WS))).toEqual([{ toolName: 'Bash', toolInput: { command: 'ls' }, cwd: WS }]);
    expect(await hook.claudeCalls(bash('cat x'), at("../it's"))).toEqual([
      { toolName: 'Bash', toolInput: { command: `cd '${HOME}/it'\\''s' && cat x` }, cwd: join(HOME, "it's") },
    ]);
    expect((await hook.claudeCalls(bash('ls'), at('~/d')))?.[0]?.cwd).toBe(join(homedir(), 'd'));
  });

  it('pins a shell call whose arguments it cannot find (a code-mode cell made it) to the session directory', async () => {
    expect(await hook.claudeCalls(bash('ls'), async () => undefined)).toEqual([
      { toolName: 'Bash', toolInput: { command: `cd '${WS}' && ls` }, cwd: WS, pinned: true },
    ]);
  });

  it('writes every file a patch adds, updates, deletes or moves to', async () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Update File: b.txt\n@@\n-x\n+y\n*** Move to: c.txt\n*** Delete File: d.txt\n*** End Patch\n';
    expect(hook.patchFiles(patch)).toEqual([
      { path: 'a.txt', content: 'one\ntwo\n' },
      { path: 'b.txt', content: 'y\n' },
      { path: 'c.txt', content: '' },
      { path: 'd.txt', content: '' },
    ]);
    const calls = await hook.claudeCalls({ tool_name: 'apply_patch', tool_input: { command: patch }, cwd: WS });
    expect(calls?.map((c) => [c.toolName, c.toolInput.file_path])).toEqual([
      ['Write', 'a.txt'],
      ['Write', 'b.txt'],
      ['Write', 'c.txt'],
      ['Write', 'd.txt'],
    ]);
  });

  it('reads an image view, and leaves other tools alone', async () => {
    expect(await hook.claudeCalls({ tool_name: 'view_image', tool_input: { path: '/p.png' }, cwd: WS })).toEqual([
      { toolName: 'Read', toolInput: { file_path: '/p.png' }, cwd: WS },
    ]);
    expect(await hook.claudeCalls({ tool_name: 'spawn_agent', tool_input: { message: 'x' }, cwd: WS })).toEqual([]);
  });
});

describe('codex-hook: the guest guard', () => {
  it('refuses the shell outside the open places, however it gets there', async () => {
    expect(await hook.review(bash('cat secret.txt'), cfg, at(PRIVATE))).toEqual({ refuse: expect.stringContaining(`未对外开放的位置 ${PRIVATE}`) });
    expect(await hook.review(bash(`cat ${PRIVATE}/secret.txt`), cfg, at())).toEqual({ refuse: expect.stringContaining('未对外开放') });
    expect(await hook.review(bash('echo hi > out.txt'), cfg, at())).toBeNull();
  });

  it('lets a call of unknown directory run only pinned to the session directory, and refuses it when that is closed too', async () => {
    const unknown = async () => undefined;
    expect(await hook.review(bash('cat secret.txt'), cfg, unknown)).toEqual({ command: `cd '${WS}' && cat secret.txt` });
    expect(await hook.review(bash(`cat ${PRIVATE}/secret.txt`), cfg, unknown)).toEqual({ refuse: expect.stringContaining('未对外开放') });
  });

  it('refuses patches into a read-only root and image views of closed places', async () => {
    const into = (dir: string): Input => ({
      tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n*** Add File: ${dir}/n.txt\n+x\n*** End Patch\n` },
      cwd: WS,
    });
    expect(await hook.review(into(RO), cfg)).toEqual({ refuse: expect.stringContaining(`只读目录不能改动：${RO}`) });
    expect(await hook.review(into(WS), cfg)).toBeNull();
    expect(await hook.review({ tool_name: 'view_image', tool_input: { path: `${PRIVATE}/a.png` }, cwd: WS }, cfg)).toEqual({ refuse: expect.stringContaining('未对外开放') });
    expect(await hook.review({ tool_name: 'view_image', tool_input: { path: `${RO}/a.png` }, cwd: WS }, cfg)).toBeNull();
  });

  it("applies a restricted chat's limits to everyone there, the owner included, with its one refusal", async () => {
    const chat = { deniedCommands: ['(^|[\\s;|&(/])kubectl(\\s|$)'], deniedPaths: [PRIVATE], refusal: '暂时不支持' };
    const owner = JSON.parse(guardHookEnv(restrictedChatGuard(undefined, chat, { home: HOME, root: bridgeRoot() })).LARK_CHANNEL_GUARD) as unknown;
    expect(await hook.review(bash('kubectl get pods'), owner, at())).toEqual({ refuse: expect.any(String) });
    expect(await hook.review(bash(`cat ${PRIVATE}/secret.txt`), owner, at())).toEqual({ refuse: expect.any(String) });
    expect(await hook.review(bash(`cat ${HOME}/notes.txt`), owner, at())).toBeNull();
    const patch: Input = {
      tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n*** Add File: run.sh\n+kubectl delete ns x\n*** End Patch\n` },
      cwd: WS,
    };
    expect(await hook.review(patch, owner)).toEqual({ refuse: expect.any(String) });
    const guest = JSON.parse(guardHookEnv(restrictedChatGuard(guard, chat)).LARK_CHANNEL_GUARD) as unknown;
    expect(await hook.review(bash(`cat ${HOME}/notes.txt`), guest, at())).toEqual({ refuse: expect.any(String) });
  });
});

describe('codex-hook: the transcript lookup', () => {
  const transcript = join(scratch, 'rollout.jsonl');
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_a', arguments: JSON.stringify({ cmd: 'ls', workdir: '/w' }) } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'local_shell_call', call_id: 'call_b', action: { working_directory: '/v' } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_a', output: 'x' } }),
      '',
    ].join('\n'),
  );

  it("finds a call's arguments by its id", async () => {
    expect(await hook.callArguments({ transcript_path: transcript, tool_use_id: 'call_a' })).toEqual({ cmd: 'ls', workdir: '/w' });
    expect(await hook.callArguments({ transcript_path: transcript, tool_use_id: 'call_b' })).toEqual({ workdir: '/v' });
  });

  it('gives up on a call that never shows up, or no transcript', async () => {
    expect(await hook.callArguments({ transcript_path: transcript, tool_use_id: 'call_z' })).toBeUndefined();
    expect(await hook.callArguments({ tool_use_id: 'call_a' })).toBeUndefined();
  });
});

describe('codex-hook: run as Codex runs it', () => {
  const transcript = join(scratch, 'run.jsonl');
  const run = (input: Input, env: Record<string, string>) =>
    spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ transcript_path: transcript, cwd: WS, ...input }),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  const shellCall = (id: string, args: Record<string, unknown>) =>
    `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify(args) } })}\n`;
  writeFileSync(transcript, shellCall('call_p', { cmd: 'cat secret.txt', workdir: PRIVATE }) + shellCall('call_w', { cmd: 'ls' }));

  it('refuses with exit 2, tells the agent why on stderr, and logs the call for the card', () => {
    const log = join(scratch, 'refusals.jsonl');
    const res = run({ tool_name: 'Bash', tool_input: { command: 'cat secret.txt' }, tool_use_id: 'call_p' }, { LARK_CHANNEL_GUARD, LARK_CHANNEL_HOOK_REFUSALS: log });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('仅限主人本人');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ id: 'call_p', tool: 'Bash', input: { command: 'cat secret.txt' } });

    const allowed = run({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call_w' }, { LARK_CHANNEL_GUARD });
    expect([allowed.status, allowed.stdout]).toEqual([0, '']);
  });

  it("pins a code-mode cell's shell call through updatedInput", () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'cat secret.txt' }, tool_use_id: 'exec-1' }, { LARK_CHANNEL_GUARD });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: `cd '${WS}' && cat secret.txt` } },
    });
  });

  it('hands every SKILL.md a shell command reads to the skill Read hook, never blocking', () => {
    const seen = join(scratch, 'seen.jsonl');
    const readHook = join(scratch, 'read-hook.mjs');
    writeFileSync(
      readHook,
      `import { appendFileSync } from 'node:fs';\nlet s = '';\nfor await (const c of process.stdin) s += c;\nappendFileSync(${JSON.stringify(seen)}, s + '\\n');\n`,
    );
    writeFileSync(transcript, shellCall('call_s', { cmd: 'cat demo/SKILL.md', workdir: join(WS, 'skills') }), { flag: 'a' });
    const res = run(
      { tool_name: 'Bash', tool_input: { command: 'cat demo/SKILL.md && sed -n 1p ~/x/SKILL.md' }, tool_use_id: 'call_s' },
      { LARK_CHANNEL_READ_HOOK: `"${process.execPath}" "${readHook}"` },
    );
    expect(res.status).toBe(0);
    const reads = readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Input);
    expect(reads.map((r) => [r.tool_name, (r.tool_input as { file_path: string }).file_path])).toEqual([
      ['Read', join(WS, 'skills', 'demo', 'SKILL.md')],
      ['Read', join(homedir(), 'x', 'SKILL.md')],
    ]);
  });

  it('names the SKILL.md files in a command', () => {
    expect(hook.skillFiles("cat 'a/SKILL.md' b.md; head ~/s/SKILL.md|wc")).toEqual(['a/SKILL.md', join(homedir(), 's', 'SKILL.md')]);
    expect(hook.skillFiles('cat NOTSKILL.md')).toEqual([]);
  });
});
