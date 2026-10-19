import { describe, expect, it } from 'vitest';
import {
  checkAddedContent,
  checkCommitMessage,
  checkPaths,
  findSensitive,
  type WriteHookConfig,
} from '../../../src/knowledge/write-guard';

const cfg: WriteHookConfig = { library: 'dept', self: 'bots/cc', windowFile: '/nonexistent', defaultBranch: 'main' };

describe('knowledge library write guard', () => {
  it.each([
    ['an SN', '设备 ALB002024100077 搜不到'],
    ['an IP', '连到 10.2.3.4 的网关'],
    ['an e-mail address', '联系 someone.name@alpha-ess.com'],
    ['a ticket', '见 ANTELOPE-7593'],
    ['an internal host', '访问 efk.prod.internal 查日志'],
    ['a credential', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123'],
  ])('flags %s', (_label, text) => {
    expect(findSensitive(text)).toBeDefined();
  });

  it.each([
    ['plain prose', '按区查日报日志判断设备注册在哪个区'],
    ['a git remote', 'git@github.com:org/repo.git'],
    ['standards', '时间用 ISO-8601，摘要用 SHA-256，编码 UTF-8'],
    ['localhost', '本地调试连 127.0.0.1 或 0.0.0.0'],
    ['a config file name', '改 settings.local.json'],
    ['a date', '2026-10-19 验证'],
  ])('lets %s through', (_label, text) => {
    expect(findSensitive(text)).toBeUndefined();
  });

  it('only lets the default branch take the bot its own directory', () => {
    expect(checkPaths(['bots/cc/weekly/2026-10-24.md', 'bots/cc/notes/a.md'], 'main', cfg)).toBeUndefined();
    expect(checkPaths(['bots/cc2/a.md'], 'main', cfg)).toContain('bots/cc2/a.md');
    expect(checkPaths(['shared/experience/a.md'], 'main', cfg)).toContain('Draft PR');
    // A branch is a proposal; the pull request is where it gets reviewed.
    expect(checkPaths(['shared/experience/a.md'], 'distill/2026-10-24', cfg)).toBeUndefined();
  });

  it('checks only the lines a diff adds and names the file, not the match', () => {
    const diff = [
      'diff --git a/bots/cc/a.md b/bots/cc/a.md',
      '--- a/bots/cc/a.md',
      '+++ b/bots/cc/a.md',
      '-旧内容 ALB002024100077',
      '+新内容 ALB002024100078',
    ].join('\n');
    const refused = checkAddedContent(diff);
    expect(refused).toContain('bots/cc/a.md');
    expect(refused).toContain('SN');
    expect(refused).not.toContain('ALB002024100078');
    expect(checkAddedContent(diff.replace('+新内容 ALB002024100078', '+新内容'))).toBeUndefined();
  });

  it('refuses AI attribution in commit messages', () => {
    expect(checkCommitMessage('cc: 周报\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>')).toContain('署名');
    expect(checkCommitMessage('cc: 周报\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')).toContain('署名');
    expect(checkCommitMessage('cc: 补充抓包排障笔记')).toBeUndefined();
    expect(checkCommitMessage('cc: 记录 ALB002024100077 的问题')).toContain('SN');
  });
});
