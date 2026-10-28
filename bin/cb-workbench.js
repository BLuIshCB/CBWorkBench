#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Check if current process already has native node:sqlite
let hasSqlite = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (DatabaseSync) hasSqlite = true;
} catch {
  hasSqlite = false;
}

if (hasSqlite) {
  // Current process is sufficient. Run server directly.
  const { startServer } = await import('../src/server/httpServer.ts');
  startServer().catch((err) => {
    console.error('[CBWorkBench] Fatal error starting server:', err);
    process.exit(1);
  });
} else {
  // Needs supported Node runtime (Node 22+ or Node 24).
  const { resolveSupportedNode } = await import('../src/utils/nodeResolver.js');
  let targetNode;
  try {
    targetNode = resolveSupportedNode();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Forward to target node with native strip-types
  const args = ['--experimental-strip-types', __filename, ...process.argv.slice(2)];

  const child = spawn(targetNode, args, {
    stdio: 'inherit',
    cwd: rootDir,
    env: process.env,
    windowsHide: false
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}
