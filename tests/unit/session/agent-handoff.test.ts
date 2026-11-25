import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentHandoffStore } from '../../../src/session/agent-handoff';
import { createTmpProfile } from '../../helpers/tmp-profile';

it('persists recent context, honors audience and scope, and does not replay it after it was seen', async () => {
  const temp = await createTmpProfile('agent-handoff-');
  const file = join(temp.profile, 'agent-handoff.json');
  const first = new AgentHandoffStore(file);
  const scope = 'oc_chat:omt_a';
  try {
    first.begin(scope, {
      runId: 'a', agent: 'claude', audience: 'owner-cwd-a', messageIds: ['om_a'], request: '准备测试环境',
    });
    first.update(scope, 'a', { status: 'done', handle: 'claude-a', answer: '测试环境已就绪' });
    await first.flush();

    const store = new AgentHandoffStore(file);
    await store.load();
    expect(store.prompt(scope, 'owner-cwd-a', 'agy', undefined)).toContain('测试环境已就绪');
    expect(store.prompt('oc_chat:omt_b', 'owner-cwd-a', 'agy', undefined)).toBeUndefined();
    expect(store.prompt(scope, 'guest-cwd-a', 'agy', undefined)).toBeUndefined();
    expect(store.prompt(scope, 'owner-cwd-b', 'agy', undefined)).toBeUndefined();

    store.begin(scope, {
      runId: 'b', agent: 'agy', audience: 'owner-cwd-a', messageIds: ['om_b'], request: '继续测试',
    });
    store.update(scope, 'b', { status: 'done', handle: 'agy-b', answer: '测试通过' });
    store.update(scope, 'b', { backgroundReply: '后台也已核对' });
    expect(store.prompt(scope, 'owner-cwd-a', 'agy', 'agy-b')).toBeUndefined();
    expect(store.prompt(scope, 'owner-cwd-a', 'claude', 'claude-a')).toContain('测试通过');
    expect(store.prompt(scope, 'owner-cwd-a', 'claude', 'claude-a')).toContain('后台也已核对');
    expect(store.prompt(scope, 'owner-cwd-a', 'claude', 'claude-a')).not.toContain('测试环境已就绪');

    store.recall('om_b');
    expect(store.prompt(scope, 'owner-cwd-a', 'claude', 'claude-a')).toBeUndefined();
    store.clear(scope);
    store.update(scope, 'a', { status: 'done', answer: '迟到的回答' });
    expect(store.prompt(scope, 'owner-cwd-a', 'agy', undefined)).toBeUndefined();
    expect(store.hasScope(scope)).toBe(true);
    await store.flush();
  } finally {
    await temp.cleanup();
  }
});
