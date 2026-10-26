#!/usr/bin/env node
// Claude Code PreToolUse hook that lark-channel-bridge installs on runs started
// by someone other than the bot owner (Codex runs reach the same `decide`
// through bin/codex-hook.mjs). Two fences:
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
// A restricted chat (`access.restrictedChats`) adds its own commands and
// paths for every run there, the owner's included. Its path rules carry
// `"hidden": true` (file tools may not open them either), plus two keys:
//   "deniedContent": ["regex", …]  — also refused in what file tools write
//                                     and in the paths they touch
//   "refusal": "…"                  — the only answer to give when refused
//
// Exit 2 with a reason on stderr blocks the call; Claude shows the reason to
// the model. String matching, not a sandbox: it stops the plain ways of doing
// it, and the agent is told the same rules in its system prompt. Shell
// commands are read with their quoting (see parseList) so quoted arguments
// aren't taken for redirections; when the quoting can't be followed the
// raw text is matched as before. Code handed to an interpreter inline is
// scanned for writing calls (CODE_WRITES). Before changing this file, replay
// the local transcripts through it: docs/dev/guard-replay.md.

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
// Code an interpreter runs inline (`python3 - <<'EOF'`, `python3 -c …`,
// `node -e …`) writes files the shell never sees: a writing call in it, or a
// writing command it runs, makes it a write.
const INTERPRETER = /^(?:.*\/)?(?:python[\d.]*|node|perl|ruby|php|deno|bun)$/;
const CODE_WRITES = new RegExp(
  [
    String.raw`\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]`,
    String.raw`\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\+?>`,
    String.raw`\.(?:write_text|write_bytes|touch|unlink|rmdir|mkdir|rename|symlink_to|hardlink_to)\s*\(`,
    String.raw`\bos\.(?:remove|unlink|rename|renames|replace|makedirs|mkdir|rmdir|removedirs|truncate|symlink|link|chmod|chown)\b`,
    String.raw`\bshutil\.(?:copy\w*|move|rmtree|make_archive|unpack_archive|chown)\b`,
    String.raw`\b(?:writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|mkdir|truncate|symlink|createWriteStream)(?:Sync)?\s*\(`,
    String.raw`\bFile\.(?:write|delete|rename|unlink)\b|\bFileUtils\b|\bfile_put_contents\b`,
  ].join('|'),
);
const CODE_RUNS = /\b(?:subprocess|os\.(?:system|popen|exec\w*|spawn\w*)|child_process|(?:exec|execFile|spawn)Sync)\b/;
const CODE_RUNS_WRITE =
  /['"[,\s](?:rm|mv|cp|rmdir|ln|chmod|chown|touch|mkdir|truncate|rsync|unlink|tee|patch|dd)['"\s]|\bsed['"]?(?:\s*,\s*['"]|\s+)-i|['"\s]git['"]?(?:\s*,\s*['"]|\s+)(?:checkout|switch|commit|reset|pull|fetch|merge|rebase|push|clean|stash|branch|tag|apply|am|cherry-pick|revert|restore|rm|mv|add|worktree|init|clone|gc|prune|update-ref|config)\b/;

const codeWrites = (code) => CODE_WRITES.test(code) || (CODE_RUNS.test(code) && CODE_RUNS_WRITE.test(code));
const OPEN_FOR_WRITE = /\bopen\s*\(\s*([^,()]+?)\s*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]/g;

/**
 * Does inline code write only outside `rule`? Only when its sole writing calls
 * are `open(…, 'w')` on absolute paths — written out, or a variable set once
 * to one (`p = '/tmp/x'`): `cd <read-only> && python3 …` writing results to /tmp.
 */
function writesElsewhere(code, rule) {
  if (codeWrites(code.replace(OPEN_FOR_WRITE, ''))) return false;
  const targets = [...code.matchAll(OPEN_FOR_WRITE)].map(([, arg]) => {
    const literal = /^f?(['"])([^'"]*)\1$/.exec(arg);
    if (literal) return literal[2];
    if (!/^\w+$/.test(arg)) return null;
    const sets = [...code.matchAll(new RegExp(`(?:^|[\\s;])${arg}\\s*=\\s*f?(['"])([^'"]*)\\1`, 'gm'))];
    return sets.length === 1 ? sets[0][2] : null;
  });
  return (
    targets.length > 0 &&
    targets.every((t) => t?.startsWith('/') && t !== rule.path && !t.startsWith(`${rule.path}/`))
  );
}
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
// Claude's claude.ai Artifact tools. Publishing (the default action) uploads
// local files under the owner's claude.ai account and the rest manage the
// owner's artifacts, so a guest run may only read one somebody shared.
const ARTIFACT_TOOLS = new Set(['Artifact', 'ArtifactData', 'ArtifactComments']);

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

// A name going on past a fenced path (`~/.lark-channel-workspaces` after
// `~/.lark-channel`) is another place; the scope check still covers it.
const NAME_GOES_ON = /^[\w.-]/;
const namesPlaceIn = (text, path) => text.startsWith(path) && !NAME_GOES_ON.test(text.slice(path.length));

/** Does `segment` mention `rule.path` outside its allowed sub-paths? */
function mentions(segment, rule) {
  let from = 0;
  for (;;) {
    const at = segment.indexOf(rule.path, from);
    if (at === -1) return false;
    from = at + rule.path.length;
    if (NAME_GOES_ON.test(segment.slice(from))) continue;
    const rest = segment.slice(at);
    const allowed = (rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(rest));
    if (!allowed) return true;
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

/** An interpreter given its code inline: `-c` / `-e` / `-`, or no script file (stdin). */
function runsInlineCode(seg) {
  const args = seg.args ?? seg.command.split(/\s+/);
  const at = args.findIndex((a) => !/^\w+=/.test(a) && a !== 'sudo' && a !== 'env');
  if (at === -1 || !INTERPRETER.test(args[at])) return false;
  const rest = args.slice(at + 1);
  return rest.some((a) => /^(?:-[a-zA-Z]*[ce]|--eval|-p|-)$/.test(a)) || rest.every((a) => a.startsWith('-'));
}

function writesInto(seg, rule, verb = isWriteVerb(seg)) {
  if (verb) return true;
  if (seg.targets?.some((target) => namesPlaceIn(target, rule.path))) return true;
  return new RegExp(`>{1,2}\\s*['"]?${escapeRe(rule.path)}(?![\\w.-])`).test(seg.text);
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

/**
 * Scripts a command hands on: `sh -c '…'` to another shell, `eval …` to the
 * current one (`here`), where a `cd` outlives the script.
 */
function innerScripts(values) {
  const scripts = [];
  values.forEach((value, k) => {
    if (value === 'eval') scripts.push({ script: values.slice(k + 1).join(' '), here: true });
    if (SHELL.test(value) || value === 'su') {
      const flag = values.findIndex((v, n) => n > k && SHELL_SCRIPT_FLAG.test(v));
      if (flag !== -1 && flag + 1 < values.length) scripts.push({ script: values[flag + 1], here: false });
    }
  });
  return scripts;
}

// Each segment records the shell it runs in: `0`, and `0.1`, `0.1.2`… for
// subshells (`$( … )`, backticks, process substitution, `sh -c`, heredoc
// bodies). A subshell inherits the directory, but its own `cd` ends with it.
let shellSeq = 0;
const subshell = (scope) => `${scope}.${++shellSeq}`;
const runsIn = (scope, shell) => scope === shell || scope.startsWith(`${shell}.`);

/** The old reading: split the raw text at every `;` `|` `&&` `||` and newline. */
function plainSegments(text, scope = '0') {
  return text.split(/&&|\|\||;|\||\n/).map((part) => ({
    text: part,
    command: part.trim(),
    relative: RELATIVE_REDIRECT.test(part.trim()),
    args: null,
    targets: null,
    words: null,
    scope,
  }));
}

function scriptSegments(script, out, depth, scope) {
  const segments = [];
  try {
    parseList(script, 0, '', segments, depth + 1, scope);
  } catch (err) {
    if (!(err instanceof Unparsed)) throw err;
    out.push(...plainSegments(script, scope));
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
function parseList(src, start, closer, out, depth, scope) {
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
      heredocs.push({ delim: value, strip: redirect.heredoc, owner: null });
    } else if (writesFile(redirect.op, value)) {
      targets.push(value);
    }
    redirect = null;
  };
  const endSegment = (end) => {
    endWord();
    if (redirect) throw new Unparsed();
    if (words.length) {
      const seg = {
        text: src.slice(segStart, end),
        command: argv.join(' '),
        relative: targets.some((t) => !/^[/$~]/.test(t)),
        args: values,
        targets,
        words,
        scope,
        // What its heredocs feed it, filled in once the bodies are read.
        input: '',
      };
      out.push(seg);
      for (const heredoc of heredocs) heredoc.owner ??= seg;
      for (const { script, here } of innerScripts(values)) {
        scriptSegments(script, out, depth, here ? scope : subshell(scope));
      }
    }
    argv = [];
    values = [];
    words = [];
    targets = [];
  };
  // Heredoc bodies start on the line after their `<<`; each runs to its delimiter line.
  const readHeredocs = (pos) => {
    for (const { delim, strip, owner } of heredocs.splice(0)) {
      let at = pos;
      const body = (text) => {
        if (owner) owner.input += text;
        scriptSegments(text, out, depth, subshell(scope));
      };
      for (;;) {
        if (at >= src.length) {
          body(src.slice(pos));
          pos = src.length;
          break;
        }
        const nl = src.indexOf('\n', at);
        const end = nl === -1 ? src.length : nl;
        const line = src.slice(at, end);
        if ((strip ? line.replace(/^\t+/, '') : line) === delim) {
          body(src.slice(pos, at));
          pos = end + 1;
          break;
        }
        at = end + 1;
      }
    }
    return Math.min(pos, src.length);
  };
  const nested = (from, close) => parseList(src, from, close, out, depth + 1, subshell(scope));

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
  shellSeq = 0;
  try {
    parseList(cmd, 0, '', out, 0, '0');
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
  const cds = [];
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    // Inline code is the `-c` argument or the heredoc fed to it; with the
    // quoting lost, anything in the command.
    const code = runsInlineCode(seg) ? (seg.words ? `${seg.text}\n${seg.input}` : cmd) : null;
    const inline = code !== null && codeWrites(code);
    const verb = inline || isWriteVerb(seg);
    // `cd <protected> && echo x > file` writes there without naming it again;
    // `$(cd <protected> && git tag) > file` does not.
    const cdInto = cds.findLast((cd) => runsIn(seg.scope, cd.scope))?.rule;
    if (cdInto && (isWriteVerb(seg) || seg.relative || (inline && !writesElsewhere(code, cdInto)))) {
      return changes(cdInto, cfg);
    }
    const text = inline ? code : seg.text;
    for (const rule of cfg.rules ?? []) {
      if (!mentions(text, rule)) continue;
      if (rule.bash === 'any') return `这条命令会读取或改动 ${rule.path}`;
      if (/^(?:cd|pushd)\s/.test(seg.command)) cds.push({ scope: seg.scope, rule });
      else if (writesInto(seg, rule, verb)) return changes(rule, cfg);
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

/** Is `path` inside `rule.path` and not one of its allowed sub-paths? */
function fenced(path, rule) {
  if (!within(path, rule.path)) return false;
  return !(rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(path));
}

/** The text a file tool is about to write. */
function writtenText(input) {
  const parts = [input?.content, input?.new_string, input?.new_source];
  for (const edit of Array.isArray(input?.edits) ? input.edits : []) parts.push(edit?.new_string);
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function decideFile(toolName, input, cfg, cwd) {
  if (WRITING_TOOLS.has(toolName) && (cfg.deniedContent ?? []).length > 0) {
    const text = writtenText(input);
    for (const re of cfg.deniedContent) {
      if (new RegExp(re).test(text)) return '要写入的内容涉及受限操作';
    }
  }
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
    for (const re of cfg.deniedContent ?? []) {
      if (new RegExp(re).test(path)) return `访问的位置未对外开放：${path}`;
    }
    for (const rule of cfg.rules ?? []) {
      if (rule.hidden && fenced(path, rule)) return `访问的位置未对外开放：${rule.path}`;
    }
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
  if (ARTIFACT_TOOLS.has(toolName) && config.readOnlyArtifacts) {
    if (toolName === 'Artifact' && input?.action === 'read') return null;
    return '发布或管理 claude.ai artifact 属于仅限主人的操作（访客任务只能读别人分享的 artifact）';
  }
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
  process.stderr.write(refusal(reason, cfg));
  return 2;
}

/** What the agent is told (on stderr, with exit 2) when `reason` refuses a call. */
export function refusal(reason, cfg) {
  if (cfg.refusal) {
    // A restricted chat: one fixed answer, the reason and the rules unsaid.
    return `${reason}。这一步在当前会话不可用：请停止这一步，不要换个写法再试；只回复用户「${cfg.refusal}」这一句，不要解释原因，也不要提及拦截、权限或规则。\n`;
  }
  // A read-only place stays open for reading: say so, or the agent tells the
  // user it is closed to them altogether.
  const tail = reason.includes('只读目录')
    ? '本次任务不是 bot 主人发起的，这个目录只开放查看、搜索和用 git 查历史，改动仅限主人本人。请停止这一步，并告诉用户这个目录只能读、不能改。'
    : '本次任务不是 bot 主人发起的，这部分仅限主人本人。请停止这一步，并告诉用户这部分内容不对外开放。';
  return `${reason}。${tail}\n`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}

