import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  bridgeRoot,
  claudeGuardArgs,
  grantedToolsFor,
  guardRefusal,
  isOwnerBatch,
  ownerOnlyGuard,
} from '../../../src/policy/owner-guard';

const HOME = '/Users/someone';
const LC = `${HOME}/.lark-channel`;
const WORKSPACE = `${HOME}/.lark-channel-workspaces/claude/default`;
const OPEN = `${HOME}/Desktop/coding/lark/alphaess`;
const READ_ONLY = `${HOME}/Desktop/coding/alphaess/platform_EMS3.6`;
const ROOT = bridgeRoot();
const guard = ownerOnlyGuard({
  larkChannelHome: LC,
  guestRoots: ['~/Desktop/coding/lark/alphaess'],
  guestReadOnlyRoots: ['~/Desktop/coding/alphaess/platform_EMS3.6'],
  workspace: WORKSPACE,
  home: HOME,
  root: ROOT,
  deniedTools: ['mcp__github', 'mcp__jira__jira_create_issue'],
  deniedCommands: [
    '(^|[\\s;|&(])gh(\\s|$)',
    '\\bgit\\s+push\\b',
    'alphaq-tool\\b[\\s\\S]*--tool[=\\s]+[\'"]?(restart_device|set_site_work_mode)\\b',
  ],
});
const { env } = claudeGuardArgs(guard);

/** Run the hook the way Claude does: the tool call on stdin, config in env. */
function hook(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd = WORKSPACE,
): { code: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [guard.hookScript], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr };
}
const bash = (command: string, cwd?: string) => hook('Bash', { command }, cwd);

describe('guest runs: owner-only areas', () => {
  it.each([
    ['restarting the bridge', 'node ~/x/bin/lark-channel-bridge.mjs restart --profile claude'],
    ['launchd', 'launchctl kickstart -k gui/501/com.bridge'],
    ['the restart helper', '~/.local/bin/bridge-restart-when-idle'],
    ['the bridge source', `git -C ${ROOT} log -1`],
    ['bridge secrets', 'cat ~/.lark-channel/config.json'],
    ['bridge logs', 'tail $HOME/.lark-channel/profiles/claude/logs/bridge.jsonl'],
    ['in-place edits of the agent instructions', 'sed -i "" s/a/b/ ~/.claude/CLAUDE.md'],
    ['appending to the agent instructions', 'echo rule >> ~/.claude/CLAUDE.md'],
    ['writing a skill', 'tee ~/.claude/skills/x/SKILL.md < /tmp/a'],
    ['deleting memory', 'rm -rf ~/.claude/projects/p/memory'],
    ['cd then write', 'cd ~/.claude/skills/x && echo hi > SKILL.md'],
    ['writing into a skill library', 'echo x >> ~/.lark-channel/profiles/claude/skill-libraries/lib/skills/x/SKILL.md'],
    ['deleting a skill library', 'rm -rf ~/.lark-channel/profiles/claude/skill-libraries/lib'],
    ['writing into a knowledge library mirror', 'echo x >> ~/.lark-channel/profiles/claude/knowledge-libraries/dept/shared/a.md'],
    ['committing in a knowledge library mirror', 'git -C ~/.lark-channel/profiles/claude/knowledge-libraries/dept commit -am x'],
    ['reading a knowledge library work clone', 'cat ~/.lark-channel/profiles/claude/knowledge-libraries/dept.work/bots/cc/a.md'],
    ['pushing from a knowledge library work clone', 'cd ~/.lark-channel/profiles/claude/knowledge-libraries/dept.work && git push'],
    ['opening a write window by hand', 'echo {} > ~/.lark-channel/profiles/claude/knowledge-libraries/dept.window.json'],
    ['reading other bridge data', 'cat ~/.lark-channel/profiles/claude/sessions.json'],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('仅限主人本人');
  });

  it('refuses editing a skill with a file tool', () => {
    expect(hook('Edit', { file_path: `${HOME}/.claude/skills/x/SKILL.md` }).code).toBe(2);
    expect(hook('Write', { file_path: `${LC}/profiles/claude/skill-libraries/lib/skills/x/SKILL.md` }).code).toBe(2);
    expect(hook('Read', { file_path: `${LC}/profiles/claude/skill-libraries/lib/skills/x/SKILL.md` }).code).toBe(0);
  });

  it('lets a knowledge library mirror be read but not edited, and keeps the work clone out of reach', () => {
    const mirror = `${LC}/profiles/claude/knowledge-libraries/dept/shared/experience/a.md`;
    expect(hook('Read', { file_path: mirror }).code).toBe(0);
    expect(hook('Grep', { path: `${LC}/profiles/claude/knowledge-libraries/dept/shared` }).code).toBe(0);
    expect(hook('Edit', { file_path: mirror }).code).toBe(2);
    expect(hook('Read', { file_path: `${LC}/profiles/claude/knowledge-libraries/dept.work/bots/cc/a.md` }).code).toBe(2);
    expect(hook('Write', { file_path: `${LC}/profiles/claude/knowledge-libraries/dept.window.json` }).code).toBe(2);
  });
});

describe('guest runs: file scope', () => {
  it.each([
    ['the owner-only project', 'cat ~/Desktop/coding/lark/thing-hub/CLAUDE.md'],
    ['other desktop files', 'ls ~/Desktop/coding/alphaess/antelope'],
    ['personal files', 'head ~/Documents/notes.txt'],
    ['the home directory itself', 'ls ~'],
    ['a bare cd home', 'cd && ls'],
    ['the whole disk', 'find / -name "*.pem"'],
    ['a relative escape from the workspace', 'cat ../../../Desktop/coding/lark/thing-hub/README.md'],
    ['a private dir put on PATH', 'export PATH=~/Documents/bin:$PATH && ls'],
    ['a script reading private files', `python3 -c "print(open('${HOME}/.ssh/id_rsa').read())"`],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('不对外开放');
  });

  it.each([
    ['reading an opened project', 'cat ~/Desktop/coding/lark/alphaess/antelope/README.md'],
    ['working in an opened project', `cd ${OPEN}/antelope && git status && mvn -q test`],
    ['running a skill script', 'python3 ~/.claude/skills/alphaess-tcpdump/scripts/capture.py --sn AL1 > /tmp/out.txt'],
    ['reading an attachment', 'file ~/.lark-channel/profiles/claude/media/abc.jpg'],
    ['reading a shared skill library', 'cat ~/.lark-channel/profiles/claude/skill-libraries/lib/skills/x/SKILL.md'],
    ['reading a knowledge library mirror', 'cat ~/.lark-channel/profiles/claude/knowledge-libraries/dept/shared/pitfalls/a.md'],
    ['browsing a knowledge library mirror with git', 'git -C ~/.lark-channel/profiles/claude/knowledge-libraries/dept log -3'],
    ['running a library skill script', 'python3 ~/.lark-channel/profiles/claude/skill-libraries/lib/skills/x/scripts/run.py AL1 > /tmp/out.json'],
    ['copying an attachment out', 'cp ~/.lark-channel/profiles/claude/media/abc.jpg /tmp/abc.jpg'],
    ['a tool on PATH dir', '~/.local/bin/alphaq-tool diagnose AL1'],
    ['putting the tool dir on PATH', 'export PATH=$HOME/.local/bin:$PATH; alphaq-tool --json --list'],
    ['ordinary work in tmp', 'grep -r foo /tmp/repo > /tmp/hits.txt && wc -l /tmp/hits.txt'],
    ['relative paths in the workspace', 'mkdir -p out/logs && ls ./out'],
    ['querying EFK', 'curl -s -u elastic:x "http://efk-prod-aus.alphaess.com:5601/api/console/proxy?path=logs-*/_search&method=POST"'],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it('reads a quoted heredoc written to a file as data, not paths', () => {
    const doc = "cat > draft.md <<'EOF'\n三个中心（SEA / EUR / AUS）\n见 ~/Documents/notes.txt\nEOF\nlark-cli docs +create --content @draft.md";
    expect(bash(doc).code).toBe(0);
    expect(bash(`mkdir -p /tmp/d && cd /tmp/d && ${doc}`).code).toBe(0);
    expect(bash("cat <<\"EOF\" > /tmp/a.md\nA / B\nEOF").code).toBe(0);
  });

  it.each([
    ['a heredoc run by a shell', "bash <<'EOF'\ncat ~/Documents/notes.txt\nEOF"],
    ['a heredoc piped to a shell', "cat <<'EOF' | sh\nls ~\nEOF"],
    ['an unquoted heredoc that expands commands', 'cat > /tmp/a <<EOF\n$(cat ~/.ssh/id_rsa)\nEOF'],
    ['a heredoc written into a private place', "cat > ~/Documents/x.md <<'EOF'\nhi\nEOF"],
  ])('still checks %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });

  it('reads a lone / inside quoted code as an operator, but not as a word of its own', () => {
    expect(bash("jq -r '.a // .b | (.x / 1000)' /tmp/a.json").code).toBe(0);
    expect(bash(`python3 -c "print('/'.join(['a', 'b']))"`).code).toBe(0);
    expect(bash("find '/' -name '*.pem'").code).toBe(2);
    expect(bash('ls //').code).toBe(2);
  });

  it('applies the same scope to file tools', () => {
    expect(hook('Read', { file_path: `${HOME}/Desktop/coding/lark/thing-hub/CLAUDE.md` }).code).toBe(2);
    expect(hook('Grep', { pattern: 'x', path: `${HOME}/Desktop` }).code).toBe(2);
    expect(hook('Glob', { pattern: `${HOME}/Documents/**/*.md` }).code).toBe(2);
    expect(hook('Read', { file_path: `${OPEN}/antelope/pom.xml` }).code).toBe(0);
    expect(hook('Edit', { file_path: `${OPEN}/antelope/pom.xml` }).code).toBe(0);
    expect(hook('Read', { file_path: 'notes.md' }).code).toBe(0);
    expect(hook('Glob', { pattern: '**/*.java' }).code).toBe(0);
    expect(hook('Read', { file_path: '/tmp/x.log' }).code).toBe(0);
  });

  it('ignores tools that touch no files', () => {
    expect(hook('WebSearch', { query: 'rm -rf ~' }).code).toBe(0);
  });
});

describe('guest runs: read-only roots', () => {
  it.each([
    ['reading a file', `cat ${READ_ONLY}/logic/dispatch.c`],
    ['searching', `grep -rn Dispatch ${READ_ONLY}/logic | head -20`],
    ['git history', `git -C ${READ_ONLY} log -5 --oneline`],
    ['read-only git inside the project', `cd ${READ_ONLY} && git show HEAD --stat && git blame logic/a.c`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['writing a file', `echo x > ${READ_ONLY}/a.txt`],
    ['deleting', `rm -rf ${READ_ONLY}/logic`],
    ['pulling', `git -C ${READ_ONLY} pull`],
    ['switching branches inside it', `cd ${READ_ONLY} && git checkout -b x`],
    ['cd then write', `cd ${READ_ONLY} && echo x > a.txt`],
    ['an in-place edit', `sed -i '' s/a/b/ ${READ_ONLY}/a.c`],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(`会改动只读目录 ${READ_ONLY}`);
    // Reading stays open, so the agent must not tell the user it is closed to them.
    expect(res.stderr).not.toContain('不对外开放');
  });

  // Quoted text is an argument, not shell syntax: `>` in a format string or
  // `|` in a grep pattern neither redirects nor starts another command.
  it.each([
    ['a git format with an email in angle brackets', `cd ${READ_ONLY} && F=logic/a.c; git log --format='%h %an <%ae> %s' -- $F | head -20`],
    ['generics in a grep pattern', `cd ${READ_ONLY} && grep -rn 'List<Device>' --include='*.java' . | head`],
    ['an alternation naming a write verb', `cd ${READ_ONLY} && grep -rE 'import|cp' . | head`],
    ['an awk comparison', `cd ${READ_ONLY} && awk -F, '$3 > 100' a.csv`],
    ['git status and ref listings', `cd ${READ_ONLY} && git status -sb && git branch -av && git remote -v && git tag -l 'v1.*'`],
    ['git reads inside a command substitution', `cd ${READ_ONLY} && echo "tags: $(git tag --contains 6de9 --sort=creatordate | head -1)"`],
    ['fd redirections to /dev/null and stdout', `cd ${READ_ONLY} && ls 2>/dev/null; git log -1 2>&1 | head`],
    ['a quoted heredoc with an apostrophe before reading', `cat > /tmp/x.md <<'EOF'\nit's > fine\nEOF\ncd ${READ_ONLY} && git log -1`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['stderr to a file', `cd ${READ_ONLY} && ls 2> err.log`],
    ['stdout and stderr to a file', `cd ${READ_ONLY} && ls &> out.log`],
    ['a write inside sh -c', `cd ${READ_ONLY} && bash -c 'echo x > f'`],
    ['cd and write inside sh -c', `bash -c 'cd ${READ_ONLY} && echo x > f'`],
    ['a write inside a command substitution', `cd ${READ_ONLY} && x=$(echo > f)`],
    ['a write inside a quoted command substitution', `cd ${READ_ONLY} && echo "$(echo hi > f)"`],
    ['a write through eval', `cd ${READ_ONLY} && eval 'echo hi > f'`],
    ['a quoted absolute target', `echo x > '${READ_ONLY}/a.txt'`],
    ['creating a branch', `cd ${READ_ONLY} && git branch -v newb`],
    ['tagging', `cd ${READ_ONLY} && git tag -a v1 -m 'x'`],
    ['stashing', `cd ${READ_ONLY} && git stash`],
    ['moving a symbolic ref', `cd ${READ_ONLY} && git symbolic-ref HEAD refs/heads/x`],
    ['an apostrophe in a heredoc pairing with a later quote', `cat <<EOF\nit's\nEOF\ncd ${READ_ONLY} && echo hi > f #'`],
    ['an unterminated quote', `cd ${READ_ONLY}; echo 'x > a.txt`],
  ])('still refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });

  it('lets file tools read but not edit', () => {
    expect(hook('Read', { file_path: `${READ_ONLY}/logic/a.c` }).code).toBe(0);
    expect(hook('Grep', { pattern: 'Dispatch', path: READ_ONLY }).code).toBe(0);
    expect(hook('Edit', { file_path: `${READ_ONLY}/logic/a.c` }).code).toBe(2);
    expect(hook('Write', { file_path: `${READ_ONLY}/new.c` }).code).toBe(2);
  });

  it('opens them for reading and denies edits through the Claude flags', () => {
    expect(guard.allowedRoots).toContain(READ_ONLY);
    expect(claudeGuardArgs(guard).args).toContain(`Edit(/${READ_ONLY}/**)`);
  });
});

describe('guest runs: owner-only commands of this deployment', () => {
  it.each([
    ['the GitHub CLI', 'gh pr create --fill'],
    ['pushing code', `cd ${OPEN}/antelope && git push origin dev`],
    ['controlling a device', '~/.local/bin/alphaq-tool --region aus --json --tool restart_device --sn AL1'],
  ])('refuses %s', (_label, command) => {
    const res = bash(command);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('仅限主人的操作');
  });

  it('still allows read-only diagnosis and local git', () => {
    expect(bash('~/.local/bin/alphaq-tool --region aus --json --tool ess_running_data --sn AL1').code).toBe(0);
    expect(bash(`cd ${OPEN}/antelope && git log -3`).code).toBe(0);
  });

  it('denies the configured tools outright', () => {
    const { args } = claudeGuardArgs(guard);
    expect(args).toContain('mcp__github');
    expect(args).toContain('mcp__jira__jira_create_issue');
  });
});

describe('guest runs: Claude flags', () => {
  it('denies edits to owner-only areas, reads of bridge secrets, and hooks every file tool', () => {
    const { args, settings } = claudeGuardArgs(guard, '/usr/local/bin/node');
    expect(args[0]).toBe('--disallowedTools');
    expect(args).not.toContain('--settings');
    expect(args).toContain(`Edit(/${join(HOME, '.claude', 'CLAUDE.md')})`);
    expect(args).toContain(`Edit(/${ROOT}/**)`);
    expect(args).toContain(`Read(/${LC}/config.json*)`);
    const [hook] = settings.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[];
    expect(hook!.matcher).toBe(
      'Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep',
    );
    expect(hook!.hooks[0]!.command).toBe(
      `"/usr/local/bin/node" "${guard.hookScript}"`,
    );
  });

  it('opens the guest roots and the workspace, expanding ~', () => {
    expect(guard.allowedRoots).toContain(OPEN);
    expect(guard.allowedRoots).toContain(WORKSPACE);
    expect(guard.hookScript).toBe(join(ROOT, 'bin', 'bridge-guard.mjs'));
  });
});

describe('guardRefusal', () => {
  /** The tool result Claude reports when the hook blocks a call. */
  const reported = (tool: string, stderr: string) =>
    `PreToolUse:${tool} hook error: ["${process.execPath}" "${guard.hookScript}"]: ${stderr}`;

  it("reads the hook's reason back from the tool result Claude reports", () => {
    const refused = bash(`cat ${LC}/config.json`);
    expect(refused.code).toBe(2);
    expect(guardRefusal(reported('Bash', refused.stderr))).toBe(`这条命令会读取或改动 ${LC}`);

    const edit = hook('Edit', { file_path: `${READ_ONLY}/src/Main.java`, old_string: 'a', new_string: 'b' });
    expect(guardRefusal(reported('Edit', edit.stderr))).toContain(READ_ONLY);
  });

  it('ignores other failures', () => {
    expect(guardRefusal('Exit code 1\nfatal: not a git repository')).toBeUndefined();
    expect(guardRefusal('PreToolUse:Bash hook error: ["node" "/x/other-hook.mjs"]: no')).toBeUndefined();
  });
});

describe('isOwnerBatch', () => {
  const controls = { botOwnerId: 'ou_owner', ownerRefreshState: 'ok' as const };
  const msg = (senderId: string): NormalizedMessage => ({ senderId }) as NormalizedMessage;
  const notBot = (): boolean => false;

  it('is true only when every message is from the owner', () => {
    expect(isOwnerBatch(controls, [msg('ou_owner')], notBot)).toBe(true);
    expect(isOwnerBatch(controls, [msg('ou_owner'), msg('ou_other')], notBot)).toBe(false);
    expect(isOwnerBatch(controls, [msg('ou_other')], notBot)).toBe(false);
    expect(isOwnerBatch(controls, [], notBot)).toBe(false);
  });

  it('never trusts a bot, or an owner not yet known', () => {
    expect(isOwnerBatch(controls, [msg('ou_owner')], () => true)).toBe(false);
    expect(
      isOwnerBatch({ ...controls, ownerRefreshState: 'unknown' }, [msg('ou_owner')], notBot),
    ).toBe(false);
  });
});

describe('guest tool grants', () => {
  const msg = (senderId: string): NormalizedMessage => ({ senderId }) as NormalizedMessage;
  const notBot = (): boolean => false;
  const grants = {
    ou_a: ['mcp__jira__jira_create_issue', 'mcp__jira__jira_create_issue_link'],
    ou_b: ['mcp__jira__jira_create_issue'],
  };

  it('gives a run only the tools every sender was granted', () => {
    expect(grantedToolsFor(grants, [msg('ou_a')], notBot)).toEqual([
      'mcp__jira__jira_create_issue',
      'mcp__jira__jira_create_issue_link',
    ]);
    expect(grantedToolsFor(grants, [msg('ou_a'), msg('ou_b')], notBot)).toEqual([
      'mcp__jira__jira_create_issue',
    ]);
    expect(grantedToolsFor(grants, [msg('ou_a'), msg('ou_c')], notBot)).toEqual([]);
    expect(grantedToolsFor(undefined, [msg('ou_a')], notBot)).toEqual([]);
    expect(grantedToolsFor(grants, [], notBot)).toEqual([]);
  });

  it('never grants anything when a bot is in the batch', () => {
    expect(grantedToolsFor(grants, [msg('ou_a')], () => true)).toEqual([]);
  });

  it('lifts only the granted entries from the denied tools', () => {
    const granted = ownerOnlyGuard({
      larkChannelHome: LC,
      home: HOME,
      root: ROOT,
      deniedTools: ['mcp__github', 'mcp__jira__jira_create_issue', 'mcp__jira__jira_delete_issue'],
      grantedTools: ['mcp__jira__jira_create_issue', 'mcp__not_denied'],
    });
    expect(granted.deniedTools).toEqual(['mcp__github', 'mcp__jira__jira_delete_issue']);
    expect(claudeGuardArgs(granted).args).not.toContain('mcp__jira__jira_create_issue');
  });

  it('lifts a granted command regex and keeps the rest', () => {
    const push = '\\bgit\\s+push\\b';
    const gh = '(^|[\\s;|&(])gh(\\s|$)';
    const granted = ownerOnlyGuard({
      larkChannelHome: LC,
      home: HOME,
      root: ROOT,
      deniedCommands: [gh, push],
      grantedTools: [push],
    });
    expect(granted.deniedCommands).toEqual([gh]);
    const res = spawnSync(process.execPath, [granted.hookScript], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin dev' }, cwd: WORKSPACE }),
      env: { ...process.env, ...claudeGuardArgs(granted).env },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
  });
});
