import { execFileSync } from "node:child_process";
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAppPaths } from "../../src/config/app-paths";
import { loadRootConfig } from "../../src/config/profile-store";
import {
  bridgeRoot,
  claudeGuardArgs,
  guardRefusal,
  ownerOnlyGuard,
} from "../../src/policy/owner-guard";

/**
 * Replays every guarded tool call in this machine's Claude transcripts through
 * the guest guard hook — the base ref's and this checkout's — under the real
 * guest config, and reports what the change refuses or lets through anew.
 * Opt-in (reads local transcripts and config); steps in docs/dev/guard-replay.md:
 *
 *   GUARD_REPLAY=1 npx vitest run tests/replay
 */

type Decide = (
  tool: string,
  input: unknown,
  cfg: unknown,
  cwd: string,
) => string | null;

interface Call {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  count: number;
  /** The guard refused it in a real guest run. */
  refused: boolean;
}

interface Verdict {
  tool: string;
  call: string;
  cwd: string;
  refusedInGuestRun: boolean;
  base: string | null;
  current: string | null;
}

const env = process.env;
const SHOWN = 30;

describe.skipIf(!env.GUARD_REPLAY)(
  "guard replay over local transcripts",
  () => {
    it(
      "refuses nothing new and never throws",
      { timeout: 30 * 60_000 },
      async () => {
        const repo = bridgeRoot();
        const base = env.GUARD_REPLAY_BASE ?? "main";
        const cfg = await guestConfig();
        const calls = await collectCalls(
          env.GUARD_REPLAY_TRANSCRIPTS ??
            join(homedir(), ".claude", "projects"),
          cfg.tools,
        );

        const scratch = mkdtempSync(join(tmpdir(), "guard-replay-"));
        let decideBase: Decide;
        try {
          const file = join(scratch, "bridge-guard.base.mjs");
          writeFileSync(
            file,
            execFileSync("git", ["show", `${base}:bin/bridge-guard.mjs`], {
              cwd: repo,
              encoding: "utf8",
            }),
          );
          decideBase = (
            (await import(pathToFileURL(file).href)) as { decide: Decide }
          ).decide;
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
        const decideCurrent = (
          (await import(
            pathToFileURL(join(repo, "bin", "bridge-guard.mjs")).href
          )) as { decide: Decide }
        ).decide;

        let slowest = { ms: 0, call: "" };
        const verdicts: Verdict[] = calls.map((call) => {
          const started = performance.now();
          const current = judge(decideCurrent, call, cfg.guard);
          const ms = performance.now() - started;
          const text = describeCall(call);
          if (ms > slowest.ms) slowest = { ms, call: text };
          return {
            tool: call.tool,
            call: text,
            cwd: call.cwd,
            refusedInGuestRun: call.refused,
            base: judge(decideBase, call, cfg.guard),
            current,
          };
        });

        const newlyRefused = verdicts.filter((v) => v.current && !v.base);
        const newlyAllowed = verdicts.filter((v) => v.base && !v.current);
        const report = {
          base,
          profile: cfg.profile,
          calls: calls.reduce((n, c) => n + c.count, 0),
          unique: calls.length,
          refusedInGuestRuns: verdicts.filter((v) => v.refusedInGuestRun)
            .length,
          refusedByBase: verdicts.filter((v) => v.base).length,
          refusedByCurrent: verdicts.filter((v) => v.current).length,
          slowestMs: Math.round(slowest.ms),
          slowestCall: slowest.call.slice(0, 200),
          throws: verdicts.filter((v) => v.current?.startsWith("THROW ")),
          newlyRefused,
          newlyAllowed: {
            refusedInGuestRuns: newlyAllowed.filter((v) => v.refusedInGuestRun),
            others: newlyAllowed.filter((v) => !v.refusedInGuestRun),
          },
          // Real refusals the guard still makes: where the remaining misjudgments hide.
          stillRefusedInGuestRuns: verdicts.filter(
            (v) => v.refusedInGuestRun && v.current,
          ),
        };
        const out = env.GUARD_REPLAY_OUT ?? join(tmpdir(), "guard-replay.json");
        writeFileSync(out, JSON.stringify(report, null, 2));

        const line = (v: Verdict) =>
          `  [${v.tool}] ${v.call.replace(/\s+/g, " ").slice(0, 200)}\n      → ${v.current ?? v.base}`;
        console.log(
          [
            `guard replay vs ${base}: ${report.unique} unique calls (${report.calls} total) from profile ${cfg.profile}'s view`,
            `refused: base ${report.refusedByBase}, current ${report.refusedByCurrent}; ${report.refusedInGuestRuns} were refused in real guest runs`,
            `newly refused: ${newlyRefused.length}; newly allowed: ${newlyAllowed.length} (${report.newlyAllowed.refusedInGuestRuns.length} of them refused in real guest runs)`,
            `slowest decision ${report.slowestMs} ms; full report: ${out}`,
            ...(newlyRefused.length
              ? ["newly refused:", ...newlyRefused.slice(0, SHOWN).map(line)]
              : []),
            ...(newlyAllowed.length
              ? ["newly allowed:", ...newlyAllowed.slice(0, SHOWN).map(line)]
              : []),
          ].join("\n"),
        );

        expect(report.throws).toEqual([]);
        // Every new refusal must be one the change means to make; once each is
        // checked, rerun with GUARD_REPLAY_ACCEPT=1 and name them in the commit.
        if (!env.GUARD_REPLAY_ACCEPT)
          expect(newlyRefused.map((v) => v.call)).toEqual([]);
      },
    );
  },
);

/** The guest guard config the bridge hands the hook, for the real profile. */
async function guestConfig(): Promise<{
  profile: string;
  guard: unknown;
  tools: RegExp;
}> {
  const rootDir = env.GUARD_REPLAY_HOME ?? join(homedir(), ".lark-channel");
  const root = await loadRootConfig(join(rootDir, "config.json"));
  if (!root) throw new Error(`no bridge config under ${rootDir}`);
  const profile = env.GUARD_REPLAY_PROFILE ?? root.activeProfile;
  const config = root.profiles[profile];
  if (!config) throw new Error(`no profile ${profile}`);
  const { access } = config;
  const guard = ownerOnlyGuard({
    larkChannelHome: rootDir,
    guestRoots: access.guestRoots ?? [],
    guestReadOnlyRoots: access.guestReadOnlyRoots ?? [],
    deniedTools: access.guestDeniedTools ?? [],
    deniedCommands: access.guestDeniedCommands ?? [],
    workspace:
      config.workspaces.default ??
      resolveAppPaths({ rootDir, profile }).defaultWorkspaceDir,
    // The daemon runs from the main checkout, not this worktree.
    root: dirname(
      execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        {
          cwd: bridgeRoot(),
          encoding: "utf8",
        },
      ).trim(),
    ),
  });
  const { env: hookEnv, settings } = claudeGuardArgs(guard);
  // Only the tools Claude hands the hook.
  const { matcher } = settings.hooks.PreToolUse[0] as { matcher: string };
  return {
    profile,
    guard: JSON.parse(hookEnv.LARK_CHANNEL_GUARD!) as unknown,
    tools: new RegExp(`^(?:${matcher})$`),
  };
}

/** Unique guarded tool calls in the transcripts, marking the ones the guard refused in guest runs. */
async function collectCalls(dir: string, tools: RegExp): Promise<Call[]> {
  const calls = new Map<string, Call>();
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".jsonl"),
  );
  for (const file of files) {
    const byId = new Map<string, Call>();
    const lines = createInterface({
      input: createReadStream(join(dir, file), "utf8"),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.includes('"tool_use"') && !line.includes('"tool_result"'))
        continue;
      let entry: { cwd?: unknown; message?: { content?: unknown } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          tools.test(block.name)
        ) {
          if (!block.input || typeof block.input !== "object") continue;
          const cwd = typeof entry.cwd === "string" ? entry.cwd : homedir();
          const key = JSON.stringify([block.name, block.input, cwd]);
          let call = calls.get(key);
          if (!call) {
            call = {
              tool: block.name,
              input: block.input as Record<string, unknown>,
              cwd,
              count: 0,
              refused: false,
            };
            calls.set(key, call);
          }
          call.count++;
          byId.set(String(block.id), call);
        } else if (block.type === "tool_result" && block.is_error === true) {
          const call = byId.get(String(block.tool_use_id));
          const output =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          if (call && guardRefusal(output)) call.refused = true;
        }
      }
    }
  }
  return [...calls.values()];
}

function judge(decide: Decide, call: Call, cfg: unknown): string | null {
  try {
    return decide(call.tool, call.input, cfg, call.cwd) || null;
  } catch (err) {
    return `THROW ${(err as Error).message}`;
  }
}

function describeCall(call: Call): string {
  const { command, file_path, notebook_path, path, pattern } = call.input;
  if (typeof command === "string") return command;
  const target = [file_path, notebook_path, path, pattern]
    .filter((v) => typeof v === "string")
    .join(" ");
  return target || JSON.stringify(call.input);
}
