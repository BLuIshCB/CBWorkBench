#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
// HTTP 回归包含清空任务操作，默认隔离测试库，避免误操作工作台数据。
process.env.CB_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'cb-workbench-tests-'));

let hasSqlite = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (DatabaseSync && Number(process.versions.node.split('.')[0])>=24) hasSqlite = true;
} catch {
  hasSqlite = false;
}

const testArgs = process.argv.slice(2);
const testFile = testArgs[0] ? path.resolve(testArgs[0]) : path.join(rootDir, 'tests', 'run_all_tests.ts');

if (hasSqlite) {
  await import(pathToFileURL(testFile).href);
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
