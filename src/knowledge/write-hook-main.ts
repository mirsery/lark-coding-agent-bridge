import { readFile } from 'node:fs/promises';
import { runWriteHook, type WriteHookConfig } from './write-guard';

/**
 * Git hook entry of a knowledge library's work clone, built to
 * `dist/knowledge-hook.js` and started by `bin/knowledge-hook.mjs`:
 * `knowledge-hook.mjs <hook> <config.json> [git's hook arguments…]`.
 * A refusal goes to stderr (git shows it to whoever ran the command) and
 * exits 1. A broken setup refuses too: the hooks exist to say no.
 */
async function main(): Promise<number> {
  const [hook = '', configFile = '', ...args] = process.argv.slice(2);
  let cfg: WriteHookConfig;
  try {
    cfg = JSON.parse(await readFile(configFile, 'utf8')) as WriteHookConfig;
  } catch {
    process.stderr.write(`[bridge] 读不到知识库写入配置 ${configFile}，拒绝 ${hook}。\n`);
    return 1;
  }
  const stdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  try {
    const refused = await runWriteHook(hook, cfg, args, stdin);
    if (!refused) return 0;
    process.stderr.write(`[bridge] ${cfg.library}：${refused}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`[bridge] ${cfg.library}：写入检查出错，拒绝 ${hook}：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

process.exitCode = await main();
