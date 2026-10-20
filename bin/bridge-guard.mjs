#!/usr/bin/env node
// Claude Code PreToolUse hook that lark-channel-bridge installs on runs started
// by someone other than the bot owner. Two fences:
//
// 1. Owner-only areas (`rules`): the bridge CLI and launchd, the bridge's
//    source and private data, and writes into the agent's own instructions,
//    memory and skills.
// 2. File scope: inside the owner's home, only `allowedRoots` (the projects
//    opened to others, the run's workspace, skills, attachments) may be read
//    or written. Everything else under home is the owner's alone; paths
//    outside home (system dirs, /tmp) are not fenced. Read-only projects
//    (`access.guestReadOnlyRoots`) are allowed roots that also carry a
//    `write` rule: readable, but nothing may write into them.
//
// Config arrives in LARK_CHANNEL_GUARD as JSON:
//   { "home": "/Users/x",
//     "rules": [{ "path": "/abs", "bash": "any" | "write", "allow": ["regex"] }],
//     "allowedRoots": ["/abs", …], "allowPatterns": ["regex", …],
//     "deniedCommands": ["regex", …] }
// `deniedCommands` are owner-only commands of this deployment (GitHub CLI,
// Jira writes, device control …), from `access.guestDeniedCommands`.
//
// Exit 2 with a reason on stderr blocks the call; Claude shows the reason to
// the model. String matching, not a sandbox: it stops the plain ways of doing
// it, and the agent is told the same rules in its system prompt. Shell
// commands are read with their quoting (see parseList) so quoted arguments
// aren't taken for redirections; when the quoting can't be followed the
// raw text is matched as before.

import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const CONTROL = /\blark-channel-bridge\b|\blaunchctl\b|bridge-restart-when-idle|bridge_watchdog/;
const WRITE_VERB =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*(?:cp|mv|rm|rmdir|ln|chmod|chown|touch|mkdir|install|truncate|rsync|unlink|tee|patch|git|dd)\b/;
// Git subcommands that only read the repository, so read-only projects
// (`access.guestReadOnlyRoots`) can still be browsed with git.
const GIT_READ =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*git\s+(?:(?:-C|-c)\s+\S+\s+|--no-pager\s+|--(?:git-dir|work-tree)=\S+\s+)*(?:(?:log|show|diff|grep|blame|ls-files|ls-tree|cat-file|rev-parse|rev-list|describe|shortlog|merge-base|name-rev|status|for-each-ref|ls-remote|whatchanged|range-diff|cherry|check-ignore|check-attr|count-objects|version)\b|(?:stash\s+(?:list|show)|worktree\s+list|config\s+(?:--get(?:-all|-regexp)?|--list|-l))\b|remote(?:\s+(?:-v|--verbose|show|get-url)\b.*)?\s*$|symbolic-ref(?:\s+(?:-q|--quiet|--short|--(?:no-)?recurse))*\s+[^-\s]\S*\s*$)/;
// `git branch` / `git tag` list refs when given no name, or when a list
// option turns the names into patterns; any other option (`-d`, `-m`, `-a` on
// a tag …) creates, moves or deletes one.
const REF_LIST_OPTION = {
  branch: /^(?:-[arlv]+|--(?:all|remotes|list|verbose|show-current|(?:no-)?contains|(?:no-)?merged|points-at|sort|format|(?:no-)?column|ignore-case|abbrev)(?:=.*)?)$/,
  tag: /^(?:-l|-n\d*|--(?:list|(?:no-)?contains|(?:no-)?merged|points-at|sort|format|(?:no-)?column|ignore-case)(?:=.*)?)$/,
};
const REF_LIST_MODE = {
  branch: /^(?:-[a-z]*[arl][a-z]*|--(?:all|remotes|list|(?:no-)?contains|(?:no-)?merged|points-at)(?:=.*)?)$/,
  tag: /^(?:-l|-n\d*|--(?:list|(?:no-)?contains|(?:no-)?merged|points-at)(?:=.*)?)$/,
};
const IN_PLACE = /\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i/;
const RELATIVE_REDIRECT = /(?:^|[^<>&\d])>{1,2}\s*(?!\/|&|\$|~)\S/;
const BARE_CD = /(?:^|[;&|]\s*)cd\s*(?:$|[;&|])/;
const ROOT_ONLY = /^\/+$/;
const FILE_TOOLS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'glob'],
};
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(command, home) {
  return command
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s'"=:(])~(?=\/|$|\s)/g, `$1${home}`);
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Is `path` (absolute, resolved) open to a run the owner didn't start? */
function inScope(path, cfg) {
  const home = cfg.home;
  // Outside home: system dirs, /tmp, mounted volumes — not the owner's files.
  // Home itself and its ancestors ("/", "/Users") would expose all of it.
  if (!within(path, home) && !within(home, path)) return true;
  if ((cfg.allowedRoots ?? []).some((root) => within(path, root))) return true;
  return (cfg.allowPatterns ?? []).some((re) => new RegExp(`^${re}`).test(path));
}

/**
 * Path-like words of a shell command, resolved against `cwd`. With `skipRoot`
 * a bare `/` or `//` is left out: the caller has read the command and checks
 * the ones that stand as a word of their own.
 */
function commandPaths(cmd, cwd, skipRoot = false) {
  const out = [];
  for (const raw of cmd.split(/[\s;|&<>()'"`=,]+/)) {
    const word = raw.replace(/^[{[]+|[}\],:]+$/g, '');
    if (!word || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue;
    // `PATH=~/.local/bin:$PATH` lists several paths in one word.
    for (const token of word.split(':')) {
      if (!(token.startsWith('/') || token.startsWith('.') || token.includes('/'))) continue;
      if (token.startsWith('-')) continue;
      if (skipRoot && ROOT_ONLY.test(token)) continue;
      out.push(isAbsolute(token) ? resolve(token) : resolve(cwd, token));
    }
  }
  return out;
}

/** Does `segment` mention `rule.path` outside its allowed sub-paths? */
function mentions(segment, rule) {
  let from = 0;
  for (;;) {
    const at = segment.indexOf(rule.path, from);
    if (at === -1) return false;
    const rest = segment.slice(at);
    const allowed = (rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(rest));
    if (!allowed) return true;
    from = at + rule.path.length;
  }
}

/** Does `git branch …` / `git tag …` (as words) only list refs? */
function listsRefs(args) {
  let k = args[0] === 'sudo' ? 1 : 0;
  while (/^\w+=/.test(args[k] ?? '')) k++;
  if (args[k++] !== 'git') return false;
  while (args[k]?.startsWith('-')) k += args[k] === '-C' || args[k] === '-c' ? 2 : 1;
  const sub = args[k];
  if (sub !== 'branch' && sub !== 'tag') return false;
  const rest = args.slice(k + 1);
  const options = rest.filter((a) => a.startsWith('-'));
  if (!options.every((o) => REF_LIST_OPTION[sub].test(o))) return false;
  return options.length === rest.length || options.some((o) => REF_LIST_MODE[sub].test(o));
}

function isWriteVerb(seg) {
  const cmd = seg.command;
  if (IN_PLACE.test(cmd)) return true;
  return WRITE_VERB.test(cmd) && !GIT_READ.test(cmd) && !listsRefs(seg.args ?? cmd.split(/\s+/));
}

function writesInto(seg, rule) {
  if (isWriteVerb(seg)) return true;
  if (seg.targets?.some((target) => target.startsWith(rule.path))) return true;
  return new RegExp(`>{1,2}\\s*['"]?${escapeRe(rule.path)}`).test(seg.text);
}

/** Refusal for writing under `rule`, saying so when the place is still readable. */
function changes(rule, cfg) {
  return inScope(rule.path, cfg) ? `这条命令会改动只读目录 ${rule.path}` : `这条命令会改动 ${rule.path}`;
}

// `cat > notes.md <<'EOF' … EOF` only writes its body to a file: the quoted
// delimiter turns off expansion and nothing runs it, so prose such as
// "SEA / EUR" in there is not a path. Bodies fed to anything else
// (`bash <<'EOF'`, `cat <<'EOF' | sh`) or left unquoted (`$(…)` expands) stay checked.
const HEREDOC = /^([^\n]*<<-?[ \t]*(['"])([A-Za-z_][\w-]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*$/gm;

function isDataSink(header) {
  const segment = header.split(/&&|\|\||;/).find((s) => s.includes('<<')) ?? '';
  return /^\s*(?:cat|tee)\b/.test(segment) && !segment.includes('|');
}

function stripDataHeredocs(cmd) {
  return cmd.replace(HEREDOC, (whole, header) => (isDataSink(header) ? header : whole));
}

// Reading a command the way the shell does, as far as the checks need it.
// Quoted and escaped text stays inside its word: `git log --format='%an <%ae>'`
// is one argument, `grep 'a|rm' f` one command — neither a redirection nor a
// second command, which plain text matching took them for.

class Unparsed extends Error {}

const SHELL = /^(?:.*\/)?(?:ba|da|k|z)?sh$/;
const SHELL_SCRIPT_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
// What a `$( … )` reads as inside its word; the command itself is checked on its own.
const SUBST = '$(…)';
const REDIRECT_OP = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/;

/** Does redirection `op` with target `word` write a file (not just dup an fd)? */
function writesFile(op, word) {
  if (op === '>&') return !/^(?:\d+|-)$/.test(word);
  return ['>', '>>', '>|', '&>', '&>>', '<>'].includes(op);
}

/** Scripts a command hands to another shell: `sh -c '…'`, `eval …`. */
function innerScripts(values) {
  const scripts = [];
  values.forEach((value, k) => {
    if (value === 'eval') scripts.push(values.slice(k + 1).join(' '));
    if (SHELL.test(value) || value === 'su') {
      const flag = values.findIndex((v, n) => n > k && SHELL_SCRIPT_FLAG.test(v));
      if (flag !== -1 && flag + 1 < values.length) scripts.push(values[flag + 1]);
    }
  });
  return scripts;
}

/** The old reading: split the raw text at every `;` `|` `&&` `||` and newline. */
function plainSegments(text) {
  return text.split(/&&|\|\||;|\||\n/).map((part) => ({
    text: part,
    command: part.trim(),
    relative: RELATIVE_REDIRECT.test(part.trim()),
    args: null,
    targets: null,
    words: null,
  }));
}

function scriptSegments(script, out, depth) {
  const segments = [];
  try {
    parseList(script, 0, '', segments, depth + 1);
  } catch (err) {
    if (!(err instanceof Unparsed)) throw err;
    out.push(...plainSegments(script));
    return;
  }
  out.push(...segments);
}

/**
 * Simple commands of `src` from `start` up to `closer` (`)` or a backtick, or
 * the end), appended to `out`: split at unquoted `;` `&` `|` `(` `)` and
 * newlines, each with its words and the files it redirects output to.
 * Command substitutions, heredoc bodies and `sh -c` / `eval` scripts become
 * commands of their own. Returns the index after `closer`; throws Unparsed
 * when the quoting can't be followed.
 */
function parseList(src, start, closer, out, depth) {
  if (depth > 8) throw new Unparsed();
  let i = start;
  let segStart = start;
  let parens = 0;
  let argv = [];
  let values = [];
  let words = [];
  let targets = [];
  let word = null;
  let redirect = null;
  const heredocs = [];

  const add = (raw, value = raw) => {
    word ??= { raw: '', value: '' };
    word.raw += raw;
    word.value += value;
  };
  const endWord = () => {
    if (!word) return;
    const { raw, value } = word;
    word = null;
    words.push(value);
    if (!redirect) {
      argv.push(raw);
      values.push(value);
    } else if (redirect.heredoc !== undefined) {
      heredocs.push({ delim: value, strip: redirect.heredoc });
    } else if (writesFile(redirect.op, value)) {
      targets.push(value);
    }
    redirect = null;
  };
  const endSegment = (end) => {
    endWord();
    if (redirect) throw new Unparsed();
    if (words.length) {
      out.push({
        text: src.slice(segStart, end),
        command: argv.join(' '),
        relative: targets.some((t) => !/^[/$~]/.test(t)),
        args: values,
        targets,
        words,
      });
      for (const script of innerScripts(values)) scriptSegments(script, out, depth);
    }
    argv = [];
    values = [];
    words = [];
    targets = [];
  };
  // Heredoc bodies start on the line after their `<<`; each runs to its delimiter line.
  const readHeredocs = (pos) => {
    for (const { delim, strip } of heredocs.splice(0)) {
      let at = pos;
      for (;;) {
        if (at >= src.length) {
          scriptSegments(src.slice(pos), out, depth);
          pos = src.length;
          break;
        }
        const nl = src.indexOf('\n', at);
        const end = nl === -1 ? src.length : nl;
        const line = src.slice(at, end);
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) {
          scriptSegments(src.slice(pos, at), out, depth);
          pos = end + 1;
          break;
        }
        at = end + 1;
      }
    }
    return Math.min(pos, src.length);
  };
  const nested = (from, close) => parseList(src, from, close, out, depth + 1);

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (closer && c === closer && parens === 0) {
      endSegment(i);
      return i + 1;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '\n') {
      endSegment(i);
      i = readHeredocs(i + 1);
      segStart = i;
    } else if (c === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '&' && next === '>') {
      endWord();
      if (redirect) throw new Unparsed();
      const op = src[i + 2] === '>' ? '&>>' : '&>';
      redirect = { op };
      i += op.length;
    } else if (c === ';' || c === '&' || c === '|') {
      endSegment(i);
      i += next === c || (c === '|' && next === '&') || (c === ';' && next === '&') ? 2 : 1;
      segStart = i;
    } else if (c === '(' || c === ')') {
      if (c === '(') parens++;
      else if (parens > 0) parens--;
      endSegment(i);
      segStart = ++i;
    } else if (c === '\\') {
      if (next === '\n') i += 2;
      else {
        add(src.slice(i, i + 2), next ?? '');
        i += 2;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new Unparsed();
      add(src.slice(i, end + 1), src.slice(i + 1, end));
      i = end + 1;
    } else if (c === '$' && next === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new Unparsed();
      add(src.slice(i, j + 1), src.slice(i + 2, j));
      i = j + 1;
    } else if (c === '$' && next === '(') {
      i = nested(i + 2, ')');
      add(SUBST);
    } else if (c === '`') {
      i = nested(i + 1, '`');
      add(SUBST);
    } else if (c === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new Unparsed();
        const d = src[j];
        if (d === '"') break;
        if (d === '\\') {
          const e = src[j + 1] ?? '';
          value += '$`"\\\n'.includes(e) ? (e === '\n' ? '' : e) : d + e;
          j += 2;
        } else if (d === '$' && src[j + 1] === '(') {
          j = nested(j + 2, ')');
          value += SUBST;
        } else if (d === '`') {
          j = nested(j + 1, '`');
          value += SUBST;
        } else {
          value += d;
          j++;
        }
      }
      add(src.slice(i, j + 1), value);
      i = j + 1;
    } else if ((c === '<' || c === '>') && next === '(') {
      // Process substitution `<( … )` / `>( … )`: a command of its own.
      i = nested(i + 2, ')');
      add(SUBST);
    } else if (c === '<' || c === '>') {
      // `2>`: digits right before the operator name the fd, not a word.
      if (word && /^\d+$/.test(word.raw)) word = null;
      else endWord();
      if (redirect) throw new Unparsed();
      const op = REDIRECT_OP.exec(src.slice(i, i + 3))[0];
      redirect = op === '<<' || op === '<<-' ? { heredoc: op === '<<-' } : { op };
      i += op.length;
    } else {
      add(c);
      i++;
    }
  }
  if (closer) throw new Unparsed();
  endSegment(i);
  return i;
}

/** Simple commands of `cmd`, or null when its quoting can't be followed. */
function parseShell(cmd) {
  const out = [];
  try {
    parseList(cmd, 0, '', out, 0);
  } catch (err) {
    if (err instanceof Unparsed) return null;
    throw err;
  }
  return out;
}

function decideBash(command, cfg, cwd) {
  const full = normalize(String(command ?? ''), cfg.home);
  if (CONTROL.test(full)) return '这条命令会控制 bridge 进程（启停、重启或 launchd）';
  for (const re of cfg.deniedCommands ?? []) {
    if (new RegExp(re).test(full)) return '这条命令属于仅限主人的操作';
  }
  const cmd = stripDataHeredocs(full);
  const segments = parseShell(cmd) ?? plainSegments(cmd);
  let cdInto = null;
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    // `cd <protected> && echo x > file` writes there without naming it again.
    if (cdInto && (isWriteVerb(seg) || seg.relative)) return changes(cdInto, cfg);
    for (const rule of cfg.rules ?? []) {
      if (!mentions(seg.text, rule)) continue;
      if (rule.bash === 'any') return `这条命令会读取或改动 ${rule.path}`;
      if (/^(?:cd|pushd)\s/.test(seg.command)) cdInto = rule;
      else if (writesInto(seg, rule)) return changes(rule, cfg);
    }
  }
  if (BARE_CD.test(cmd)) return '这条命令会进入主人的主目录';
  // Inside quoted code a lone `/` is jq's `//`, a division or a separator;
  // only as a word of its own is it the disk root.
  const parsed = segments.every((seg) => seg.words);
  for (const path of commandPaths(cmd, cwd, parsed)) {
    if (!inScope(path, cfg)) return `这条命令会访问未对外开放的位置 ${path}`;
  }
  if (parsed && segments.some((seg) => seg.words.some((w) => ROOT_ONLY.test(w)))) {
    return '这条命令会访问未对外开放的位置 /';
  }
  return null;
}

function decideFile(toolName, input, cfg, cwd) {
  for (const key of FILE_TOOLS[toolName] ?? []) {
    const value = input?.[key];
    if (typeof value !== 'string' || !value) continue;
    const expanded = normalize(value, cfg.home);
    // A glob pattern is only a location when it is absolute.
    if (key === 'pattern' || key === 'glob') {
      if (!isAbsolute(expanded)) continue;
    }
    const path = resolve(cwd, expanded);
    if (!inScope(path, cfg)) return `访问的位置未对外开放：${path}`;
    if (WRITING_TOOLS.has(toolName)) {
      for (const rule of cfg.rules ?? []) {
        if (within(path, rule.path)) {
          return inScope(rule.path, cfg) ? `只读目录不能改动：${rule.path}` : `这个位置不能改动：${rule.path}`;
        }
      }
    }
  }
  return null;
}

/** Why the tool call is refused, or null when it may run. */
export function decide(toolName, input, cfg, cwd = process.cwd()) {
  const config = { ...cfg, home: cfg.home ?? homedir() };
  if (toolName === 'Bash') return decideBash(input?.command, config, cwd);
  if (toolName in FILE_TOOLS) return decideFile(toolName, input, config, cwd);
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 0;
  }
  let cfg = {};
  try {
    cfg = JSON.parse(process.env.LARK_CHANNEL_GUARD ?? '{}');
  } catch {
    cfg = {};
  }
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const reason = decide(input?.tool_name, input?.tool_input, cfg, cwd);
  if (!reason) return 0;
  // A read-only place stays open for reading: say so, or the agent tells the
  // user it is closed to them altogether.
  const tail = reason.includes('只读目录')
    ? '本次任务不是 bot 主人发起的，这个目录只开放查看、搜索和用 git 查历史，改动仅限主人本人。请停止这一步，并告诉用户这个目录只能读、不能改。'
    : '本次任务不是 bot 主人发起的，这部分仅限主人本人。请停止这一步，并告诉用户这部分内容不对外开放。';
  process.stderr.write(`${reason}。${tail}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}

