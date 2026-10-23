import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_HOOK_MATCHER, CodexHookTrustError, codexHookSetup, ensureCodexHookTrusted } from '../../../src/agent/codex/hooks';
import { bridgeRoot, guardHookEnv, ownerOnlyGuard } from '../../../src/policy/owner-guard';

const HOME = '/Users/someone';
const guard = ownerOnlyGuard({
  larkChannelHome: `${HOME}/.lark-channel`,
  workspace: `${HOME}/.lark-channel-workspaces/codex/default`,
  home: HOME,
  root: bridgeRoot(),
});
const NODE = '/opt/node/bin/node';
const COMMAND = `"${NODE}" "${join(bridgeRoot(), 'bin', 'codex-hook.mjs')}"`;

describe('codexHookSetup', () => {
  it('gives a run that needs neither the guard nor the skill Read hook no hook', () => {
    expect(codexHookSetup({})).toBeUndefined();
  });

  it('hooks a guest run with the guard, and leaves it no terminal to type into', () => {
    const setup = codexHookSetup({ guard, nodeBinary: NODE });
    expect(setup?.command).toBe(COMMAND);
    expect(setup?.config).toEqual([
      '-c',
      `hooks.PreToolUse=[{matcher=${JSON.stringify(CODEX_HOOK_MATCHER)},hooks=[{type="command",command=${JSON.stringify(COMMAND)},timeout=120}]}]`,
      '-c',
      'features.unified_exec_tty=false',
    ]);
    expect(setup?.env).toEqual(guardHookEnv(guard));
    expect(codexHookSetup({ guard, refusalLog: '/t/refusals.jsonl' })?.env).toEqual({ ...guardHookEnv(guard), LARK_CHANNEL_HOOK_REFUSALS: '/t/refusals.jsonl' });
  });

  it("hooks the owner's run with the skill Read hook only, through the same command", () => {
    const setup = codexHookSetup({ readHook: "'node' 'hook.js' skill-read '/a b'", nodeBinary: NODE });
    // One command for every run: Codex trusts it once.
    expect(setup?.command).toBe(COMMAND);
    expect(setup?.config.join(' ')).not.toContain('unified_exec_tty');
    expect(setup?.env).toEqual({ LARK_CHANNEL_READ_HOOK: "'node' 'hook.js' skill-read '/a b'" });
  });

  it('matches the shell, patches and image views as Codex names them for hooks', () => {
    const matcher = new RegExp(CODEX_HOOK_MATCHER);
    for (const tool of ['Bash', 'apply_patch', 'view_image']) expect(matcher.test(tool)).toBe(true);
    for (const tool of ['spawn_agent', 'mcp__github__x', 'BashOutput']) expect(matcher.test(tool)).toBe(false);
  });
});

type Hook = Record<string, unknown>;

/** A fake app-server answering hooks/list with `hooks`, recording every request. */
function fakeServer(hooks: Hook[], trustOnWrite = true) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const request = async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, ...(params ? { params } : {}) });
    if (method === 'hooks/list') return { data: [{ cwd: '/w', hooks: hooks.map((h) => ({ ...h })) }] };
    if (method === 'config/value/write' && trustOnWrite) for (const h of hooks) if (h.source === 'sessionFlags') h.trustStatus = 'trusted';
    return {};
  };
  return { request, calls };
}

const ours = (trustStatus: string): Hook => ({
  key: '/<session-flags>/config.toml:pre_tool_use:0:0',
  source: 'sessionFlags',
  eventName: 'preToolUse',
  handlerType: 'command',
  command: COMMAND,
  currentHash: 'sha256:abc',
  trustStatus,
});

describe('ensureCodexHookTrusted', () => {
  it('leaves a trusted hook alone', async () => {
    const server = fakeServer([ours('trusted')]);
    await ensureCodexHookTrusted(server.request, '/w', COMMAND);
    expect(server.calls.map((c) => c.method)).toEqual(['hooks/list']);
  });

  it("trusts the bridge's hook by its current hash, then checks it took", async () => {
    const server = fakeServer([ours('untrusted')]);
    await ensureCodexHookTrusted(server.request, '/w', COMMAND);
    expect(server.calls).toEqual([
      { method: 'hooks/list', params: { cwds: ['/w'] } },
      {
        method: 'config/value/write',
        params: {
          keyPath: 'hooks.state',
          value: { '/<session-flags>/config.toml:pre_tool_use:0:0': { trusted_hash: 'sha256:abc' } },
          mergeStrategy: 'upsert',
        },
      },
      { method: 'hooks/list', params: { cwds: ['/w'] } },
    ]);
  });

  it('refuses to start when Codex did not load the hook, or a same command from elsewhere is all there is', async () => {
    await expect(ensureCodexHookTrusted(fakeServer([]).request, '/w', COMMAND)).rejects.toBeInstanceOf(CodexHookTrustError);
    const elsewhere = fakeServer([{ ...ours('untrusted'), source: 'user' }]);
    await expect(ensureCodexHookTrusted(elsewhere.request, '/w', COMMAND)).rejects.toBeInstanceOf(CodexHookTrustError);
    expect(elsewhere.calls.map((c) => c.method)).toEqual(['hooks/list']);
  });

  it('refuses to start when trusting did not take', async () => {
    const server = fakeServer([ours('modified')], false);
    await expect(ensureCodexHookTrusted(server.request, '/w', COMMAND)).rejects.toThrow(/still modified/);
  });
});
