import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

let cachedSupportedNode = null;

/**
 * Checks whether the current Node process natively supports node:sqlite.
 */
export function hasNativeSqlite() {
  try {
    if(Number(process.versions.node.split('.')[0])<24)return false;
    const sqlite = nodeRequire('node:sqlite');
    return Boolean(sqlite && sqlite.DatabaseSync);
  } catch {
    return false;
  }
}

/**
 * Tests whether a specific node binary executable supports node:sqlite.
 */
export function testNodeExecutable(nodePath) {
  if (!nodePath || !fs.existsSync(nodePath)) return false;
  try {
    execFileSync(
      nodePath,
      ['-e', "if(Number(process.versions.node.split('.')[0])<24)process.exit(1); const { DatabaseSync } = require('node:sqlite'); if (!DatabaseSync) process.exit(1);"],
      { stdio: 'ignore', timeout: 5000, windowsHide: true }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Automatically resolves a Node.js binary (version 22+ or 24+) that supports node:sqlite.
 * Respects CB_NODE_PATH environment variable if defined.
 */
export function resolveSupportedNode() {
  if (cachedSupportedNode) {
    return cachedSupportedNode;
  }

  // 1. Explicit environment variable override
  if (process.env.CB_NODE_PATH) {
    const customPath = path.resolve(process.env.CB_NODE_PATH);
    if (testNodeExecutable(customPath)) {
      cachedSupportedNode = customPath;
      return customPath;
    }
    console.warn(`[NodeResolver] Specified CB_NODE_PATH (${customPath}) is invalid or does not support node:sqlite.`);
  }

  // 2. Current running Node process if valid (exclude SEA standalone binary)
  let isSea = false;
  try {
    const sea = nodeRequire('node:sea');
    if (sea && typeof sea.isSea === 'function') isSea = sea.isSea();
  } catch {}

  if (!isSea && hasNativeSqlite()) {
    cachedSupportedNode = process.execPath;
    return process.execPath;
  }

  // 3. Known candidate locations on Windows / user environment
  const candidates = [];
  const home = os.homedir();
  for(const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir,process.platform==='win32'?'node.exe':'node'));
  for(const dir of [process.env.NVM_SYMLINK,process.env.NODE_HOME]) if(dir)candidates.push(path.join(dir,'node.exe'));
  if(process.env.NVM_HOME) {
    try {for(const name of fs.readdirSync(process.env.NVM_HOME)) if(/^v24\./.test(name))candidates.push(path.join(process.env.NVM_HOME,name,'node.exe'));} catch {}
  }

  // Codex primary runtime node
  candidates.push(path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'));

  // Workbuddy bundled node versions
  const wbNodeVersions = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
  if (fs.existsSync(wbNodeVersions)) {
    try {
      const dirs = fs.readdirSync(wbNodeVersions);
      for (const d of dirs) {
        const candidate = path.join(wbNodeVersions, d, 'node.exe');
        if (fs.existsSync(candidate)) {
          candidates.push(candidate);
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // Common NVM / Program Files candidates
  candidates.push(
    'C:\\Program Files\\nodejs\\node.exe',
    path.join(home, 'AppData', 'Local', 'nvm', 'v24.22.1', 'node.exe'),
    path.join(home, 'AppData', 'Local', 'nvm', 'v22.22.2', 'node.exe')
  );

  for (const candidate of candidates) {
    if (testNodeExecutable(candidate)) {
      cachedSupportedNode = candidate;
      return candidate;
    }
  }

  throw new Error(
    '[NodeResolver] No Node.js runtime supporting `node:sqlite` (Node 24+) was found.\n' +
    'Please set the CB_NODE_PATH environment variable to a valid Node 24 executable path.'
  );
}

/** 源码入口统一提示依赖缺失，避免把运行时错误误报为 CLI 登录问题。 */
export function ensureWorkspaceDependencies() {
  try {nodeRequire.resolve('zod');nodeRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js');}
  catch {throw new Error('工作台依赖缺失，请在项目目录运行 npm install。');}
}
