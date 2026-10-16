import { describe, expect, it } from 'vitest';
import type { SkillLibraryConfig } from '../../../src/config/profile-schema';
import { defaultSkillLibrary } from '../../../src/dream/service';

const mine: SkillLibraryConfig = { name: 'mine', owner: 'self', url: 'git@github.com:me/skills.git' };
const legacy: SkillLibraryConfig = { name: 'legacy', url: 'git@github.com:me/old.git' };
const dept: SkillLibraryConfig = { name: 'dept', owner: 'external', url: 'git@github.com:dept/skills.git' };
const market: SkillLibraryConfig = { name: 'market', owner: 'external', url: 'git@github.com:m/skills.git' };

describe('defaultSkillLibrary', () => {
  it('picks the only self library however many external ones there are', () => {
    expect(defaultSkillLibrary([dept, mine, market], undefined)).toEqual({ library: mine });
    // An entry without `owner` predates the field and is the owner's own.
    expect(defaultSkillLibrary([dept, legacy], undefined)).toEqual({ library: legacy });
  });

  it('never targets an external library', () => {
    expect(defaultSkillLibrary([dept, market], undefined)).toMatchObject({ problem: expect.stringContaining('只有第三方') });
    expect(defaultSkillLibrary([mine, dept], 'dept')).toMatchObject({ problem: expect.stringContaining('第三方库') });
  });

  it('needs a choice only between several self libraries', () => {
    expect(defaultSkillLibrary([mine, legacy, dept], undefined)).toMatchObject({
      problem: expect.stringContaining('dreamTuning.skillLibrary'),
    });
    expect(defaultSkillLibrary([mine, legacy, dept], 'legacy')).toEqual({ library: legacy });
    expect(defaultSkillLibrary([], undefined)).toMatchObject({ problem: expect.stringContaining('没有配置') });
  });
});
