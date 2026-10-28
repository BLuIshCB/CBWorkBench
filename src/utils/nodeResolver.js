import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

let cachedSupportedNode = null;

/**
 * Checks whether the current Node process natively supports node:sqlite.
 */
export function hasNativeSqlite() {
  try {
    const sqlite = nodeRequire()('node:sqlite');
    return Boolean(sqlite && sqlite.DatabaseSync);
  } catch {
    return false;
  }
}

/**
 * Helper to require in ESM if needed
 */
function nodeRequire() {
  // @ts-ignore
  if (typeof require === 'function') {
    // @ts-ignore
    return require;
  }
  const { createRequire } = nodeRequireFromUrl();
  return createRequire(import.meta.url);
}

function nodeRequireFromUrl() {
  // @ts-ignore
  return require('node:module');
}

/**
 * Tests whether a specific node binary executable supports node:sqlite.
 */
export function testNodeExecutable(nodePath) {
  if (!nodePath || !fs.existsSync(nodePath)) return false;
  try {
    execFileSync(
      nodePath,
      ['-e', "const { DatabaseSync } = require('node:sqlite'); if (!DatabaseSync) process.exit(1);"],
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

  // 2. Current running Node process if valid
  if (hasNativeSqlite()) {
    cachedSupportedNode = process.execPath;
    return process.execPath;
  }

  // 3. Known candidate locations on Windows / user environment
  const candidates = [];
  const home = os.homedir();

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
    '[NodeResolver] No Node.js runtime supporting `node:sqlite` (Node >= 22.12 or Node 24) was found.\n' +
    'Please set the CB_NODE_PATH environment variable to a valid Node 24 executable path.'
  );
}
