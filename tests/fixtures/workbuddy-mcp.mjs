import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'workbuddy-fixture', version: '1.0.0' });
const scenario = process.env.WB_TEST_SCENARIO;
const log = (name, args) => fs.appendFileSync(process.env.WB_TEST_LOG, JSON.stringify({ name, args, cwd: process.cwd() }) + '\n');
const json = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
let cancelled = false;
let waiting;
server.tool('workbuddy_status', {}, async () => {
  log('status', {});
  return json({ ok: true, connected: scenario !== 'disconnected' });
});
server.tool('workbuddy_start', {
  prompt: z.string(), cwd: z.string(), model: z.string(), reasoning_effort: z.string(), timeout_seconds: z.number(),
}, async args => {
  log('start', args);
  return scenario === 'start-error' ? json({ ok: false, error: 'start rejected' }) : json({ ok: true, task_id: 'wb-test' });
});
server.tool('workbuddy_wait', { task_id: z.string(), timeout_seconds: z.number() }, async args => {
  log('wait', args);
  if (scenario === 'hang' && !cancelled) await new Promise(resolve => { waiting = resolve; });
  if (cancelled) return json({ ok: true, task_id: 'wb-test', state: 'cancelled' });
  if (scenario === 'failed') return json({ ok: true, task_id: 'wb-test', state: 'failed', error: 'Authentication required' });
  if (scenario === 'bad-state') return json({ ok: true, task_id: 'wb-test', state: 'unknown' });
  if (scenario === 'malformed') return { content: [{ type: 'text', text: '{oops' }] };
  return json({ ok: true, task_id: 'wb-test', state: 'completed', session_id: 'session-test', answer: 'FIXTURE_OK' });
});
server.tool('workbuddy_cancel', { task_id: z.string() }, async args => {
  log('cancel', args); cancelled = true; waiting?.();
  return json({ ok: true });
});
server.tool('run_workbuddy_task', { prompt: z.string(), cwd: z.string(), model: z.string(), timeoutMs: z.number() }, async args => {
  log('cli', { ...args, configDir: process.env.CODEBUDDY_CONFIG_DIR, proxy: process.env.HTTPS_PROXY });
  const text = scenario === 'auth' ? '\u001b[31mAuthentication required. Please use /login command\u001b[0m'
    : scenario === 'permission' ? "EPERM: operation not permitted, open 'session.jsonl'"
    : scenario === 'cli-error' ? 'CLI execution error'
    : scenario === 'module-error' ? "Error: Cannot find module '../dist/codebuddy'\n请确认：codebuddy 已登录" : 'FIXTURE_CLI_OK';
  return { content: [{ type: 'text', text }], isError: ['cli-error', 'module-error'].includes(scenario) };
});
await server.connect(new StdioServerTransport());
