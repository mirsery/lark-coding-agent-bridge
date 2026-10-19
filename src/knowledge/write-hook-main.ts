import { readFile } from 'node:fs/promises';
import { openForSkillRead, type SkillWindowArm } from './knowledge-libraries';
import { runWriteHook, type WriteHookConfig } from './write-guard';

/**
 * Git hook entry of a knowledge library's work clone, built to
 * `dist/knowledge-hook.js` and started by `bin/knowledge-hook.mjs`:
 * `knowledge-hook.mjs <hook> <config.json> [git's hook arguments…]`.
 * A refusal goes to stderr (git shows it to whoever ran the command) and
 * exits 1. A broken setup refuses too: the hooks exist to say no.
 *
 * `skill-read <arm.json>` is different: Claude's PreToolUse hook on Read,
 * opening the write window when the agent reads a bound skill. It never
 * blocks the read, so it always exits 0.
 */
async function main(): Promise<number> {
  const [hook = '', configFile = '', ...args] = process.argv.slice(2);
  if (hook === 'skill-read') return skillRead(configFile);
  let cfg: WriteHookConfig;
  try {
    cfg = JSON.parse(await readFile(configFile, 'utf8')) as WriteHookConfig;
  } catch {
    process.stderr.write(`[bridge] 读不到知识库写入配置 ${configFile}，拒绝 ${hook}。\n`);
    return 1;
  }
  try {
    const refused = await runWriteHook(hook, cfg, args, readStdin);
    if (!refused) return 0;
    process.stderr.write(`[bridge] ${cfg.library}：${refused}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`[bridge] ${cfg.library}：写入检查出错，拒绝 ${hook}：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function skillRead(armFile: string): Promise<number> {
  // Claude reads a PreToolUse hook's stdout as its answer: keep it empty.
  const toStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = toStderr as typeof process.stdout.write;
  try {
    const input = JSON.parse(await readStdin()) as { tool_name?: string; tool_input?: { file_path?: unknown } };
    const filePath = input.tool_input?.file_path;
    if (input.tool_name !== 'Read' || typeof filePath !== 'string') return 0;
    const arm = JSON.parse(await readFile(armFile, 'utf8')) as SkillWindowArm;
    const opened = await openForSkillRead(arm, filePath);
    if (opened.length > 0) toStderr(`[bridge] 已打开写入窗口：${opened.join('、')}\n`);
  } catch (err) {
    toStderr(`[bridge] 打开写入窗口失败：${err instanceof Error ? err.message : String(err)}\n`);
  }
  return 0;
}

process.exitCode = await main();
