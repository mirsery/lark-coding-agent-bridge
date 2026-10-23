import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionReader } from '../../../src/terminal/subscription';
import type { ProfileConfig } from '../../../src/config/profile-schema';

const config = { agentKind: 'codex', codex: { binaryPath: 'codex', codexHome: '/account-one' } } as ProfileConfig;
describe('monitor subscription cache', () => {
  it('does not block sampling, deduplicates in-flight reads and refreshes each profile independently', async () => {
    let finish!: (value: { sponsor: string }) => void;
    const fetch = vi.fn(() => new Promise<{ sponsor: string }>(resolve => { finish = resolve; }));
    const read = createSubscriptionReader(fetch, 60_000);
    expect(await read('one', config, '/state/one', 0)).toMatchObject({ loading: true });
    await read('one', config, '/state/one', 10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish({ sponsor: 'alice' });
    await Promise.resolve();
    expect(await read('one', config, '/state/one', 20_000, true)).toMatchObject({ sponsor: 'alice', loading: false });
    await read('two', config, '/state/two', 20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await read('one', config, '/state/one', 60_001);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('waits for one-shot output, handles failures and invalidates changed account config', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ sponsor: 'alice' }).mockRejectedValueOnce(new Error('unavailable'));
    const read = createSubscriptionReader(fetch);
    expect(await read('one', config, '/state/one', 0, true)).toMatchObject({ sponsor: 'alice', loading: false });
    const changed = { ...config, codex: { binaryPath: 'codex', codexHome: '/account-two' } };
    expect(await read('one', changed, '/state/one', 1000, true)).toEqual({ loading: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
