import { describe, expect, it } from 'vitest';
import { usageCard, type UsageCardPeriod } from '../../../src/card/templates';
import { emptyTotals, type UsageTotals } from '../../../src/runtime/usage-ledger';

const totals = (t: Partial<UsageTotals>): UsageTotals => ({ ...emptyTotals(), ...t });

interface Table {
  tag: 'table';
  columns: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
}

const tables = (card: object): Table[] => {
  const found: Table[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if ((node as { tag?: string }).tag === 'table') found.push(node as Table);
      Object.values(node).forEach(walk);
    }
  };
  walk(card);
  return found;
};

describe('usageCard', () => {
  it('lists everyone in a table with their share of the cost', () => {
    const period: UsageCardPeriod = {
      label: '今天',
      total: totals({ turns: 3, inputTokens: 3_000_000, cachedInputTokens: 2_940_000, outputTokens: 12_000, costUsd: 4 }),
      people: 2,
      rows: [
        { name: 'Boss', self: true, total: totals({ turns: 2, inputTokens: 2_000_000, outputTokens: 8000, costUsd: 3 }) },
        { name: 'Colleague', self: false, total: totals({ turns: 1, inputTokens: 1_000_000, outputTokens: 4000, costUsd: 1 }) },
      ],
    };
    const card = usageCard({ periods: [period], everyone: true, notes: [] });
    const [table] = tables(card);
    expect(table?.columns.map((c) => c.name)).toEqual(['who', 'turns', 'input', 'output', 'cost', 'share']);
    expect(table?.rows[0]).toMatchObject({ who: '1. Boss（你）', input: '2.00M', cost: 3, share: '75%' });
    expect(JSON.stringify(card)).toContain('缓存 98%');
  });

  it('drops the cost column for Codex and weighs shares by tokens instead', () => {
    const period: UsageCardPeriod = {
      label: '今天',
      total: totals({ turns: 2, inputTokens: 900, outputTokens: 100 }),
      people: 2,
      rows: [
        { name: 'A', self: false, total: totals({ turns: 1, inputTokens: 700, outputTokens: 100 }) },
        { name: 'B', self: false, total: totals({ turns: 1, inputTokens: 200 }) },
      ],
    };
    const card = usageCard({ periods: [period], everyone: true, notes: [] });
    const [table] = tables(card);
    expect(table?.columns.map((c) => c.name)).not.toContain('cost');
    expect(table?.rows.map((r) => r.share)).toEqual(['80%', '20%']);
    expect(JSON.stringify(card)).not.toContain('估算费用');
  });

  it('says so when a period has nothing, and shows no table to people who only see their own', () => {
    const card = usageCard({
      periods: [
        { label: '今天', total: emptyTotals(), people: 0 },
        { label: '近 7 天', total: totals({ turns: 1, inputTokens: 10, costUsd: 0.4 }), people: 1 },
      ],
      everyone: false,
      notes: ['只显示你自己的用量'],
    });
    const json = JSON.stringify(card);
    expect(json).toContain('暂无用量记录');
    expect(json).toContain('$0.40');
    expect(tables(card)).toHaveLength(0);
  });
});
