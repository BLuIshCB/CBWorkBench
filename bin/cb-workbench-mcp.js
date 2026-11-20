#!/usr/bin/env node
process.env.MCP_MODE = 'true';
// In MCP stdio mode, ensure stdout is strictly reserved for JSON-RPC messages.
console.log = (...args) => console.error(...args);

import { spawn } from 'node:child_process';
import { ensureWorkspaceDependencies } from '../src/utils/nodeResolver.js';
try { ensureWorkspaceDependencies(); } catch (error) { console.error(error.message); process.exit(1); }
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let hasSqlite = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (DatabaseSync && Number(process.versions.node.split('.')[0]) >= 24) hasSqlite = true;
} catch {
  hasSqlite = false;
}

if (hasSqlite) {
  const {
    parseCliRuntimeArgs,
    fetchRemoteInstanceInfo,
    assertServerMatchesLocalInstance,
    DataDirConfigError,
  } = await import('../src/config/dataDir.ts');

  try {
    const cliArgs = parseCliRuntimeArgs(process.argv.slice(2));
    const serverUrl = (cliArgs.serverUrl || process.env.CB_SERVER_URL || '').trim();
    const hasExplicitDir = Boolean(cliArgs.dataDir || process.env.CB_DATA_DIR?.trim());

    if (serverUrl) {
      if (cliArgs.portable) {
        throw new DataDirConfigError('DATA_DIR_CONFLICT', '源码 MCP 入口不支持 --portable');
      }
      if (!hasExplicitDir) {
        const remote = await fetchRemoteInstanceInfo(serverUrl);
        if (!remote) {
          throw new DataDirConfigError('SERVER_UNREACHABLE', `无法连接到指定工作台后台服务: ${serverUrl}`);
        }
        process.env.CB_DATA_DIR = remote.data_dir;
      }
      process.env.CB_SERVER_URL = serverUrl.replace(/\/+$/, '');
    }

    const { DATA_DIR, INSTANCE_ID } = await import('../src/config/constants.ts');
    if (serverUrl) {
      await assertServerMatchesLocalInstance(serverUrl, DATA_DIR, INSTANCE_ID);
    }

    const { startMcpServer } = await import('../src/server/mcpServer.ts');
    await startMcpServer();
  } catch (err) {
    console.error('[CBWorkBench MCP] Fatal error starting MCP server:', err?.message || err);
    process.exit(1);
  }
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
    windowsHide: true,
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}
