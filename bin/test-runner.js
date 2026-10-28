#!/usr/bin/env node
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

const testArgs = process.argv.slice(2);
const testFile = testArgs[0] ? path.resolve(testArgs[0]) : path.join(rootDir, 'tests', 'run_all_tests.ts');

if (hasSqlite) {
  await import(testFile);
} else {
  const { resolveSupportedNode } = await import('../src/utils/nodeResolver.js');
  const targetNode = resolveSupportedNode();
  const args = ['--experimental-strip-types', testFile, ...testArgs.slice(1)];

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
