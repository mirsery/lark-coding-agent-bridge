import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coffeeLogoPath } from '../../../src/card/coffee-logo';
import { COFFEE_BRANDS, coffeeCard, pickCoffeeBrand } from '../../../src/card/templates';

type Card = {
  header: { title: { content: string }; template: string };
  body: { elements: Array<{ tag: string; content?: string; img_key?: string }> };
};

describe('coffeeCard', () => {
  it('rotates through every brand with its own colour', () => {
    COFFEE_BRANDS.forEach((brand, i) => {
      expect(pickCoffeeBrand(() => (i + 0.5) / COFFEE_BRANDS.length)).toBe(brand);
      const card = coffeeCard(brand) as Card;
      expect(card.header.title.content).toBe(`${brand.name} 电子咖啡`);
      expect(card.header.template).toBe(brand.template);
    });
  });

  it('stays in range when random returns 1', () => {
    expect(pickCoffeeBrand(() => 1)).toBe(COFFEE_BRANDS[0]);
  });

  it('names brands in English only and never carries the Antelope branding', () => {
    for (const brand of COFFEE_BRANDS) {
      expect(brand.name).not.toMatch(/\p{Script=Han}/u);
      expect(JSON.stringify(coffeeCard(brand))).not.toMatch(/antelope/i);
    }
  });

  it('ships a logo for every brand', () => {
    for (const brand of COFFEE_BRANDS) expect(existsSync(coffeeLogoPath(brand.slug))).toBe(true);
  });

  it('shows the brand logo when one was uploaded, nothing otherwise', () => {
    const brand = COFFEE_BRANDS[0]!;
    const withLogo = JSON.stringify(coffeeCard(brand, { logoKey: 'img_v3_logo' }));
    expect(withLogo).toContain('"tag":"img","img_key":"img_v3_logo"');
    expect(withLogo).toContain('"horizontal_align":"center"');
    expect(JSON.stringify(coffeeCard(brand))).not.toContain('"tag":"img"');
  });

  it('@-mentions the recipients on behalf of the payer', () => {
    const brand = COFFEE_BRANDS[0]!;
    const one = coffeeCard(brand, { recipients: [{ openId: 'ou_a' }], payer: '王仕龙' }) as Card;
    expect(one.body.elements[0]!.content).toBe('<at id=ou_a></at> 王仕龙请你喝一杯');
    const two = coffeeCard(brand, { recipients: [{ openId: 'ou_a' }, { openId: 'ou_b' }] }) as Card;
    expect(two.body.elements[0]!.content).toContain('<at id=ou_a></at> <at id=ou_b></at>');
    expect(two.body.elements[0]!.content).toContain('请你们喝一杯');
    const plain = coffeeCard(brand) as Card;
    expect(JSON.stringify(plain)).not.toContain('<at ');
  });

  it('carries no coffee-cup emoji', () => {
    const card = coffeeCard(COFFEE_BRANDS[0]!, { recipients: [{ openId: 'ou_a' }], payer: 'A', logoKey: 'k' });
    expect(JSON.stringify(card)).not.toContain('☕');
  });
});
