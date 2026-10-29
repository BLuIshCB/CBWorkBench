#!/usr/bin/env node
process.env.MCP_MODE = 'true';
// In MCP stdio mode, ensure stdout is strictly reserved for JSON-RPC messages.
console.log = (...args) => console.error(...args);

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let hasSqlite = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (DatabaseSync) hasSqlite = true;
} catch {
  hasSqlite = false;
}

if (hasSqlite) {
  const { startMcpServer } = await import('../src/server/mcpServer.ts');
  startMcpServer().catch((err) => {
    console.error('[CBWorkBench MCP] Fatal error starting MCP server:', err);
    process.exit(1);
  });
} else {
  const { resolveSupportedNode } = await import('../src/utils/nodeResolver.js');
  let targetNode;
  try {
    targetNode = resolveSupportedNode();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const args = ['--experimental-strip-types', __filename, ...process.argv.slice(2)];

  const child = spawn(targetNode, args, {
    stdio: 'inherit',
    cwd: rootDir,
    env: process.env,
    windowsHide: true
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}
