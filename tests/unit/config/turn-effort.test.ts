import { describe, expect, it } from 'vitest';
import { isLightEffortTurn, pickTurnEffort, type EffortLevel } from '../../../src/config/schema';

describe('isLightEffortTurn', () => {
  it('matches a batch made only of the default panel commands', () => {
    expect(isLightEffortTurn(undefined, ['/show-status'])).toBe(true);
    expect(isLightEffortTurn({}, ['/show-tasks', '  /show-cron  '])).toBe(true);
  });

  it('needs every message to be light', () => {
    expect(isLightEffortTurn(undefined, ['/show-status', '顺便看下 CI 为什么挂了'])).toBe(false);
  });

  it('compares the first word only, not a prefix', () => {
    expect(isLightEffortTurn(undefined, ['/show-status-detail'])).toBe(false);
    expect(isLightEffortTurn(undefined, ['看下 /show-status'])).toBe(false);
  });

  it('follows the configured list, and an empty list turns the rule off', () => {
    expect(isLightEffortTurn({ lightEffortCommands: ['/ping'] }, ['/ping'])).toBe(true);
    expect(isLightEffortTurn({ lightEffortCommands: ['/ping'] }, ['/show-status'])).toBe(false);
    expect(isLightEffortTurn({ lightEffortCommands: [] }, ['/show-status'])).toBe(false);
  });

  it('never treats an empty batch as light', () => {
    expect(isLightEffortTurn(undefined, [])).toBe(false);
  });
});

describe('pickTurnEffort', () => {
  const prefs = { effort: 'high' as EffortLevel, chatEffort: { oc_vip: 'xhigh' as EffortLevel } };

  it('uses the chat / profile preference without an override', () => {
    expect(pickTurnEffort({ prefs, chatId: 'oc_x' })).toEqual({ level: 'high' });
    expect(pickTurnEffort({ prefs, chatId: 'oc_vip' })).toEqual({ level: 'xhigh' });
  });

  it('lets a session or job override win over the preference', () => {
    expect(pickTurnEffort({ prefs, chatId: 'oc_vip', override: { level: 'max', source: 'session' } })).toEqual({
      level: 'max',
      source: 'session',
    });
    expect(pickTurnEffort({ prefs, chatId: 'oc_x', override: { level: 'low', source: 'job' } })).toEqual({
      level: 'low',
      source: 'job',
    });
  });

  it('runs a light turn at low even over an override', () => {
    expect(
      pickTurnEffort({ prefs, chatId: 'oc_x', light: true, override: { level: 'max', source: 'session' } }),
    ).toEqual({ level: 'low', source: 'light' });
  });

  it('ignores a mistyped override', () => {
    expect(
      pickTurnEffort({ prefs, chatId: 'oc_x', override: { level: 'hgih' as EffortLevel, source: 'job' } }),
    ).toEqual({ level: 'high' });
  });
});

describe('pickTurnEffort — 自动切档', () => {
  const prefs = { effort: 'high' as EffortLevel };

  it('takes the level the agent asked for over the preference', () => {
    expect(pickTurnEffort({ prefs, chatId: 'oc_1', auto: 'xhigh' })).toEqual({ level: 'xhigh', source: 'auto' });
  });

  it('labels nothing when the asked-for level is the default anyway', () => {
    expect(pickTurnEffort({ prefs, chatId: 'oc_1', auto: 'high' })).toEqual({ level: 'high' });
  });

  it('yields to a light turn, /effort and a job', () => {
    expect(pickTurnEffort({ prefs, chatId: 'oc_1', auto: 'max', light: true }).source).toBe('light');
    expect(
      pickTurnEffort({ prefs, chatId: 'oc_1', auto: 'max', override: { level: 'medium', source: 'session' } }),
    ).toEqual({ level: 'medium', source: 'session' });
  });
});
