#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSupportedNode } from '../src/utils/nodeResolver.js';

const child = spawn(resolveSupportedNode(), ['--experimental-strip-types', fileURLToPath(new URL('../src/cli/workbuddy.ts', import.meta.url)), ...process.argv.slice(2)], {
  stdio: 'inherit', shell: false, env: process.env, windowsHide: process.argv[2] !== 'login',
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
