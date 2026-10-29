import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkBuddyClient } from '../src/services/workbuddyClient.ts';
import { parseWorkBuddyToml, resolveWorkBuddyConfigs } from '../src/services/workbuddyConfig.ts';

const savedEnv = { ...process.env };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-client-'));
const logFile = path.join(temp, 'calls.jsonl');
const configFile = path.join(temp, 'config.json');
const fixture = fileURLToPath(new URL('./fixtures/workbuddy-mcp.mjs', import.meta.url));
delete process.env.CB_MOCK_WORKBUDDY;
delete process.env.CB_MOCK_CODEX;
delete process.env.WB_TEST_SCENARIO;
process.env.CB_WORKBUDDY_MCP_CONFIG = configFile;
process.env.CB_WORKBUDDY_BACKEND = 'auto';
process.env.HTTPS_PROXY = 'http://example.invalid:1234';
const configure = (scenario: string, desktop = true, cli = true) => {
  fs.writeFileSync(logFile, '');
  const server = { command: process.execPath, args: [fixture], cwd: temp, env: { WB_TEST_SCENARIO: scenario, WB_TEST_LOG: logFile, CODEBUDDY_CONFIG_DIR: temp } };
  fs.writeFileSync(configFile, JSON.stringify({ ...(desktop ? { desktop: server } : {}), ...(cli ? { cli: server } : {}) }));
};
const calls = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const params = { prompt: 'multiline\n中文 & | < > $ ` " %', cwd: temp, model: 'model & literal', timeoutMs: 10000 };

try {
  const parsed = parseWorkBuddyToml(`
[mcp_servers.unrelated]
command = "wrong"
args = ["wrong/server.js"]
[mcp_servers."workbuddy-cli"]
command = 'C:\\Node\\node.exe'
args = [
  "C:\\\\tools\\\\server.js", # comment
]
cwd = 'C:\\tasks'
[mcp_servers.workbuddy-cli.env]
CODEBUDDY_CONFIG_DIR = 'C:\\profile#name'
[mcp_servers.workbuddy-desktop]
enabled = false
command = "disabled"
`);
  assert.equal(parsed.cli?.command, 'C:\\Node\\node.exe');
  assert.deepEqual(parsed.cli?.args, ['C:\\tools\\server.js']);
  assert.equal(parsed.cli?.env.CODEBUDDY_CONFIG_DIR, 'C:\\profile#name');
  assert.equal(parsed.desktop, undefined);
  assert.throws(() => parseWorkBuddyToml('[mcp_servers.workbuddy-cli]\ncommand="bad\\q"'));

  configure('success');
  const success = await WorkBuddyClient.runTask(params);
  assert.equal(success.ok, true);
  assert.equal(success.backend, 'desktop');
  assert.equal(success.sessionId, 'session-test');
  assert.equal(calls().find(call => call.name === 'start').args.prompt, params.prompt);
  assert.equal(calls().find(call => call.name === 'start').args.model, params.model);
  assert.ok(calls().every(call => call.cwd === temp), 'MCP startup cwd must be forwarded');
  assert.ok(!calls().some(call => call.name === 'cli'));

  configure('disconnected');
  const fallback = await WorkBuddyClient.runTask(params);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.backend, 'cli');
  assert.equal(calls().find(call => call.name === 'cli').args.configDir, temp);
  assert.equal(calls().find(call => call.name === 'cli').args.proxy, process.env.HTTPS_PROXY);
  assert.ok(!calls().some(call => call.name === 'start'));

  for (const scenario of ['failed', 'start-error', 'bad-state', 'malformed']) {
    configure(scenario);
    const failure = await WorkBuddyClient.runTask(params);
    assert.equal(failure.ok, false, scenario);
    if (scenario === 'failed') assert.equal(failure.errorCode, 'AUTH_REQUIRED');
    assert.ok(!calls().some(call => call.name === 'cli'), 'Never retry a dispatched task on another backend');
  }
  for (const [scenario, code] of [['auth', 'AUTH_REQUIRED'], ['permission', 'EXECUTION'], ['cli-error', 'EXECUTION'], ['module-error', 'EXECUTION']]) {
    configure(scenario, false);
    const failure = await WorkBuddyClient.runTask(params);
    assert.equal(failure.ok, false);
    assert.equal(failure.errorCode, code, scenario);
  }

  configure('hang');
  const timeout = await WorkBuddyClient.runTask({ ...params, timeoutMs: 1600 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.errorCode, 'TIMEOUT');
  assert.ok(calls().some(call => call.name === 'cancel'), 'Deadline must cancel the remote task');

  configure('hang');
  const running = WorkBuddyClient.runTask({ ...params, taskId: 'cancel-me' });
  for (let i = 0; i < 100 && !calls().some(call => call.name === 'wait'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  WorkBuddyClient.requestStop('another-task');
  WorkBuddyClient.requestStop('cancel-me');
  assert.equal((await running).errorCode, 'CANCELLED');
  assert.ok(calls().some(call => call.name === 'cancel'));

  configure('success');
  assert.equal((await WorkBuddyClient.healthCheck()).healthy, true);
  assert.ok(!calls().some(call => call.name === 'start'), 'Health check must not dispatch a model task');
  assert.equal((await WorkBuddyClient.runTask({ ...params, cwd: 'relative' })).errorCode, 'CONFIG');
  assert.equal((await WorkBuddyClient.runTask({ ...params, timeoutMs: -1 })).errorCode, 'CONFIG');
  process.env.CB_WORKBUDDY_BACKEND = 'invalid';
  assert.equal((await WorkBuddyClient.runTask(params)).errorCode, 'CONFIG');
  process.env.CB_WORKBUDDY_BACKEND = 'desktop';
  configure('success', false);
  assert.equal((await WorkBuddyClient.runTask(params)).ok, false, 'Explicit desktop mode must not fall back to CLI');
  fs.writeFileSync(configFile, JSON.stringify({ cli: { command: process.execPath, args: ['literal.js'], env: { CODEBUDDY_CONFIG_DIR: 'configured' } } }));
  process.env.CODEBUDDY_CONFIG_DIR = 'override';
  assert.equal(resolveWorkBuddyConfigs().cli?.env.CODEBUDDY_CONFIG_DIR, 'override');
  console.log('✅ workbuddyClient.test.ts passed (real MCP subprocess protocol)');
} finally {
  process.env = savedEnv;
  fs.rmSync(temp, { recursive: true, force: true });
}
