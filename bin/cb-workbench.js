#!/usr/bin/env node
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
  const { parseCliRuntimeArgs } = await import('../src/config/dataDir.ts');
  let cliArgs;
  try {
    cliArgs = parseCliRuntimeArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[CBWorkBench] 启动参数错误: ${err?.message || err}`);
    process.exit(1);
  }
  if (cliArgs.help) {
    console.log(`
用法: cb-workbench [options]
  --port <port>              指定服务监听端口 (默认: 3721)
  --host <host>              指定服务绑定主机 (默认: 127.0.0.1)
  --data-dir <absolute_path> 显式指定绝对数据目录
  --help, -h                 显示此帮助信息
`);
    process.exit(0);
  }
  const [{ startServer }, { DEFAULT_PORT, DEFAULT_HOST }] = await Promise.all([
    import('../src/server/httpServer.ts'),
    import('../src/config/constants.ts'),
  ]);
  const port = cliArgs.port || Number(process.env.CB_PORT) || DEFAULT_PORT;
  const host = cliArgs.host || process.env.CB_HOST || DEFAULT_HOST;
  startServer(port, host).catch((err) => {
    console.error('[CBWorkBench] Fatal error starting server:', err);
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
    windowsHide: false,
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}
