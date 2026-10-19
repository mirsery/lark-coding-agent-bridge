import { describe, expect, it } from 'vitest';
import { helpCard } from '../../../src/card/templates';

type Section = {
  tag: string;
  columns?: Array<{ elements: Array<{ content?: string }> }>;
};

describe('helpCard', () => {
  it('pins the eli5 skill as the first section', () => {
    const card = helpCard('CC') as { body: { elements: Section[] } };
    const first = card.body.elements[0];
    expect(first?.tag).toBe('column_set');
    const text = first?.columns?.[0]?.elements.map((e) => e.content ?? '').join('\n') ?? '';
    expect(text).toContain('📌');
    expect(text).toContain('`/eli5 <话题>`');
  });
});
