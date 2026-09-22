import { describe, expect, it } from 'vitest';
import { CronParseError, describeCron, nextCronTimeFor, parseCron } from '../../../src/scheduler/cron';

const at = (iso: string): Date => new Date(iso);

describe('cron parsing', () => {
  it('parses the five fields with lists, ranges and steps', () => {
    const fields = parseCron('0,30 9-17 * * 1-5');
    expect([...fields.minute]).toEqual([0, 30]);
    expect([...fields.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(fields.dowRestricted).toBe(true);
    expect(fields.domRestricted).toBe(false);
  });

  it('expands */n over the whole field', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
  });

  it('treats a bare value with a step as "from here on"', () => {
    expect([...parseCron('5/20 * * * *').minute]).toEqual([5, 25, 45]);
  });

  it('accepts month and weekday names, and 7 as Sunday', () => {
    expect([...parseCron('0 0 1 jan *').month]).toEqual([1]);
    expect([...parseCron('0 0 * * sun').dow]).toEqual([0]);
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
  });

  it('expands @aliases', () => {
    expect([...parseCron('@daily').hour]).toEqual([0]);
    expect([...parseCron('@hourly').minute]).toEqual([0]);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronParseError);
    expect(() => parseCron('61 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('0 9 * * 1-')).toThrow(CronParseError);
    expect(() => parseCron('*/0 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('9-5 * * * *')).toThrow(CronParseError);
  });
});

describe('next fire time', () => {
  it('finds the next minute match later the same day', () => {
    expect(nextCronTimeFor('30 9 * * *', at('2026-09-22T09:00:00'))).toEqual(at('2026-09-22T09:30:00'));
  });

  it('rolls into the next day when today is done', () => {
    expect(nextCronTimeFor('0 9 * * *', at('2026-09-22T10:00:00'))).toEqual(at('2026-09-23T09:00:00'));
  });

  it('is strictly after the reference time', () => {
    expect(nextCronTimeFor('0 9 * * *', at('2026-09-22T09:00:00'))).toEqual(at('2026-09-23T09:00:00'));
  });

  it('skips to the next weekday for a workday schedule', () => {
    // 2026-09-26 is a Saturday.
    expect(nextCronTimeFor('0 9 * * 1-5', at('2026-09-26T07:00:00'))).toEqual(at('2026-09-28T09:00:00'));
  });

  it('matches day-of-month OR day-of-week when both are restricted', () => {
    // 15th, or any Monday — the 2026-09-22 reference is a Tuesday.
    expect(nextCronTimeFor('0 0 15 * 1', at('2026-09-22T00:00:00'))).toEqual(at('2026-09-28T00:00:00'));
  });

  it('crosses a month boundary', () => {
    expect(nextCronTimeFor('0 0 1 * *', at('2026-09-22T00:00:00'))).toEqual(at('2026-10-01T00:00:00'));
  });

  it('returns undefined for a date that never exists', () => {
    expect(nextCronTimeFor('0 0 30 2 *', at('2026-09-22T00:00:00'))).toBeUndefined();
  });
});

describe('describeCron', () => {
  it('glosses the common shapes', () => {
    expect(describeCron('0 9 * * *')).toBe('每天 09:00');
    expect(describeCron('30 9 * * 1-5')).toBe('工作日 09:30');
    expect(describeCron('0 9 * * 1')).toBe('每周一 09:00');
    expect(describeCron('*/30 * * * *')).toBe('每 30 分钟');
    expect(describeCron('@daily')).toBe('每天 00:00');
  });

  it('falls back to the raw expression when it has no simple gloss', () => {
    expect(describeCron('0,30 9-17 * * 1-5')).toBe('0,30 9-17 * * 1-5');
  });
});
