import { describe, expect, it } from 'vitest';
import { parseCoffeeRequest } from '../../../src/commands/coffee-intent';

const SELF = 'ou_bot_self';

describe('parseCoffeeRequest', () => {
  it.each([
    ['来一杯咖啡'],
    ['整杯咖啡'],
    ['给我发杯咖啡'],
    ['要一杯咖啡，谢谢'],
  ])('answers a plain request: %s', (text) => {
    expect(parseCoffeeRequest(text, [], SELF)).toEqual({ recipients: [] });
  });

  it('does not treat this bot as a recipient', () => {
    expect(parseCoffeeRequest('@Occam 来杯咖啡', [{ openId: SELF, isBot: true }], SELF)).toEqual({
      recipients: [],
    });
  });

  it('serves a coffee aimed at people in this chat to them', () => {
    expect(
      parseCoffeeRequest('给 @李爽 发一杯咖啡', [{ openId: 'ou_lishuang', name: '李爽' }], SELF),
    ).toEqual({ recipients: [{ openId: 'ou_lishuang', name: '李爽' }] });
    expect(
      parseCoffeeRequest(
        '@Occam 给 @欧宇 @欧宇 发杯咖啡',
        [{ openId: SELF, isBot: true }, { openId: 'ou_ouyu' }, { openId: 'ou_ouyu' }],
        SELF,
      ),
    ).toEqual({ recipients: [{ openId: 'ou_ouyu' }] });
  });

  it('never @-mentions another bot from the card', () => {
    expect(
      parseCoffeeRequest('给 @Poki 来杯咖啡', [{ openId: 'ou_poki', name: 'Poki', isBot: true }], undefined),
    ).toEqual({ recipients: [] });
  });

  it('leaves a coffee for another chat to the agent', () => {
    expect(parseCoffeeRequest('在 AI-bot军团 群，给大家发一杯咖啡', [], SELF)).toBeNull();
    expect(parseCoffeeRequest('在 Talk 群，给 @欧宇 发杯咖啡', [{ openId: 'ou_ouyu' }], SELF)).toBeNull();
  });

  it('ignores messages that merely mention coffee', () => {
    expect(parseCoffeeRequest('喝咖啡吗', [], SELF)).toBeNull();
    expect(parseCoffeeRequest('咖啡因含量多少', [], SELF)).toBeNull();
  });
});
