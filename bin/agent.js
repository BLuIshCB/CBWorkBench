#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSupportedNode, ensureWorkspaceDependencies } from '../src/utils/nodeResolver.js';

try {ensureWorkspaceDependencies();} catch(error) {console.error(error.message);process.exit(1);}
const child = spawn(resolveSupportedNode(), [fileURLToPath(new URL('../src/cli/agent.ts', import.meta.url)), ...process.argv.slice(2)], {
  stdio: 'inherit', shell: false, env: process.env, windowsHide: process.argv[2] !== 'login',
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
