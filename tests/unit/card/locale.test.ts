import { describe, expect, it } from 'vitest';
import { detectLocale } from '../../../src/card/locale';

describe('detectLocale', () => {
  it('is Chinese whenever the caller wrote any Chinese, and by default', () => {
    expect(detectLocale(['帮我看下这个 bug'])).toBe('zh');
    expect(detectLocale(['check this', '另外这个也看下'])).toBe('zh');
    expect(detectLocale([''])).toBe('zh');
    expect(detectLocale(['👍 123'])).toBe('zh');
  });

  it('follows a caller who wrote only in another language', () => {
    expect(detectLocale(['Please check the build'])).toBe('en');
    expect(detectLocale(['Bitte prüfe den Build'])).toBe('en');
    expect(detectLocale(['Hi team, AL7002223030609 shows Fault on home page'])).toBe('en');
  });

  it('stays Chinese when a short reply says nothing about the language', () => {
    // A pick from a list of options, an ack, or an ID is not a language.
    expect(detectLocale(['b'])).toBe('zh');
    expect(detectLocale(['ok'])).toBe('zh');
    expect(detectLocale(['go on'])).toBe('zh');
    expect(detectLocale(['ANTELOPE-7707'])).toBe('zh');
    expect(detectLocale(['AL7002223030609 v1.3.2'])).toBe('zh');
    expect(detectLocale(['/new-topic jira ANTELOPE-7707'])).toBe('zh');
    expect(detectLocale(['https://alphaess.atlassian.net/browse/ANTELOPE-7673'])).toBe('zh');
  });
});
