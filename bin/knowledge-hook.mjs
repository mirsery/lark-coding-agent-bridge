#!/usr/bin/env node
// Git hook of a knowledge library's writable clone (`knowledge-libraries/<name>.work/`),
// installed by lark-channel-bridge when a write window opens. The checks live
// in src/knowledge/write-guard.ts. Usage: knowledge-hook.mjs <hook> <config.json> [args…]
import '../dist/knowledge-hook.js';
