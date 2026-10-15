import { describe, expect, it } from 'vitest';
import { COFFEE_BRANDS, coffeeCard } from '../../../src/card/templates';

describe('coffeeCard', () => {
  it('rotates through every brand with its own colour', () => {
    COFFEE_BRANDS.forEach((brand, i) => {
      const card = coffeeCard(() => (i + 0.5) / COFFEE_BRANDS.length) as {
        header: { title: { content: string }; template: string };
      };
      expect(card.header.title.content).toBe(`☕ ${brand.name} 电子咖啡`);
      expect(card.header.template).toBe(brand.template);
      expect(JSON.stringify(card)).toContain(brand.background);
    });
  });

  it('never carries the Antelope branding', () => {
    for (const r of [0, 0.3, 0.99]) {
      expect(JSON.stringify(coffeeCard(() => r))).not.toMatch(/antelope/i);
    }
  });

  it('stays in range when random returns 1', () => {
    const card = coffeeCard(() => 1) as { header: { template: string } };
    expect(card.header.template).toBe(COFFEE_BRANDS[0]!.template);
  });
});
