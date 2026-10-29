import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkBuddyClient } from '../src/services/workbuddyClient.ts';
import { resolveWorkBuddyCliConfig, resolveAgentCliConfigs } from '../src/services/workbuddyConfig.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureScript = path.join(__dirname, 'fixtures', 'agent-cli.mjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-client-test-'));
const logFile = path.join(tempDir, 'cli-calls.jsonl');
const configFile = path.join(tempDir, 'agent-cli-config.json');

delete process.env.CB_MOCK_WORKBUDDY;
delete process.env.CB_MOCK_CODEX;
delete process.env.CB_WORKBUDDY_MCP_CONFIG;
delete process.env.CB_WORKBUDDY_BACKEND;

console.log('[Test] Running workbuddyClient.test.ts (Direct CLI Subprocess Protocol)...');

// 1. 测试废弃配置拦截
{
  process.env.CB_WORKBUDDY_MCP_CONFIG = 'dummy.json';
  assert.throws(
    () => resolveAgentCliConfigs(),
    /已废弃.*CB_WORKBUDDY_MCP_CONFIG/
  );
  delete process.env.CB_WORKBUDDY_MCP_CONFIG;

  process.env.CB_WORKBUDDY_BACKEND = 'desktop';
  assert.throws(
    () => resolveAgentCliConfigs(),
    /已废弃.*CB_WORKBUDDY_BACKEND/
  );
  delete process.env.CB_WORKBUDDY_BACKEND;
  console.log('  ✓ Deprecated MCP & Backend config explicitly rejected');
}

// 2. 测试 CB_AGENT_CLI_CONFIG 解析
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: {
          AGENT_CLI_SCENARIO: 'workbuddy-json-success',
          AGENT_CLI_LOG: logFile,
        },
      },
    })
  );
  process.env.CB_AGENT_CLI_CONFIG = configFile;

  const resolved = resolveWorkBuddyCliConfig();
  assert.equal(resolved.executable, process.execPath);
  assert.equal(resolved.script, fixtureScript);
  console.log('  ✓ CB_AGENT_CLI_CONFIG parsed successfully');
}

// 3. 测试标准成功响应与参数传递 (含 --no-session-persistence 校验)
{
  fs.writeFileSync(logFile, '');
  const prompt = '多行提示词\n中文 & | < > $ ` " %\n第二行代码实现';

  const res = await WorkBuddyClient.runTask({
    prompt,
    cwd: tempDir,
    model: 'deepseek-v4-flash',
    timeoutMs: 10000,
  });

  assert.equal(res.ok, true);
  assert.ok(res.output.includes('WorkBuddy executed successfully'));
  assert.equal(res.backend, 'direct-cli');

  // 验证 CLI 调用记录中的参数
  const logs = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(logs.length > 0);
  const lastLog = logs[logs.length - 1];
  assert.ok(lastLog.argv.includes('--no-session-persistence'), 'Must contain --no-session-persistence flag');
  assert.ok(lastLog.argv.includes('--output-format'));
  assert.ok(lastLog.argv.includes('json'));
  assert.equal(lastLog.stdinLength, Buffer.from(prompt, 'utf8').length);
  console.log('  ✓ Success run verified: --no-session-persistence present, UTF-8 stdin intact');
}

// 3.1 测试返回代码含大括号与嵌套对象时的 JSON 解析正确性
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'workbuddy-json-code' },
      },
    })
  );

  const res = await WorkBuddyClient.runTask({
    prompt: 'write code with braces',
    cwd: tempDir,
    timeoutMs: 10000,
  });

  assert.equal(res.ok, true);
  assert.ok(res.output.includes('function calculate(x: number) {'));
  assert.ok(res.output.includes('{ value: x * 2 }'));
  console.log('  ✓ Output containing braces & code blocks parsed successfully without PROTOCOL error');
}

// 3.2 测试输出混杂控制台前置/后置日志时的 JSON 解析容错
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'workbuddy-json-noisy' },
      },
    })
  );

  const res = await WorkBuddyClient.runTask({
    prompt: 'noisy test',
    cwd: tempDir,
    timeoutMs: 10000,
  });

  assert.equal(res.ok, true);
  assert.ok(res.output.includes('Success with nested object'));
  console.log('  ✓ JSON output with surrounding logs extracted and parsed cleanly');
}

// 4. 测试 WorkBuddy JSON 返回错误
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'workbuddy-json-error' },
      },
    })
  );

  const res = await WorkBuddyClient.runTask({
    prompt: 'test error',
    cwd: tempDir,
    timeoutMs: 5000,
  });

  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'EXECUTION');
  assert.ok(res.error?.includes('Internal tool error'));
  console.log('  ✓ is_error response caught and mapped to EXECUTION error');
}

// 5. 测试鉴权失败响应
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'auth-required' },
      },
    })
  );

  const res = await WorkBuddyClient.runTask({
    prompt: 'test auth',
    cwd: tempDir,
    timeoutMs: 5000,
  });

  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'AUTH_REQUIRED');
  console.log('  ✓ Auth failure detected and mapped to AUTH_REQUIRED error');
}

// 6. 测试残缺/非 JSON 响应协议错误
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'workbuddy-malformed-json' },
      },
    })
  );

  const res = await WorkBuddyClient.runTask({
    prompt: 'test malformed',
    cwd: tempDir,
    timeoutMs: 5000,
  });

  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'PROTOCOL');
  console.log('  ✓ Malformed JSON output mapped to PROTOCOL error');
}

// 7. 测试执行超时
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'hang' },
      },
    })
  );

  const res = await WorkBuddyClient.runTask({
    prompt: 'test timeout',
    cwd: tempDir,
    timeoutMs: 1200,
  });

  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.errorCode, 'TIMEOUT');
  console.log('  ✓ Hanging CLI task terminated and reported TIMEOUT');
}

// 8. 测试精准取消
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'hang' },
      },
    })
  );

  const runPromise = WorkBuddyClient.runTask({
    taskId: 'cancel-task-123',
    prompt: 'test cancel',
    cwd: tempDir,
    timeoutMs: 10000,
  });

  await new Promise(r => setTimeout(r, 200));
  WorkBuddyClient.requestStop('cancel-task-123');

  const res = await runPromise;
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'CANCELLED');
  console.log('  ✓ Targeted requestStop successfully cancelled running task');
}

// 9. 参数有效性校验 (CONFIG)
{
  const resRel = await WorkBuddyClient.runTask({ prompt: 'test', cwd: 'relative/dir' });
  assert.equal(resRel.errorCode, 'CONFIG');

  const resEmptyPrompt = await WorkBuddyClient.runTask({ prompt: '', cwd: tempDir });
  assert.equal(resEmptyPrompt.errorCode, 'CONFIG');
  console.log('  ✓ Invalid cwd and empty prompt properly rejected with CONFIG');
}

// 10. 健康检查测试
{
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workbuddy: {
        executable: process.execPath,
        script: fixtureScript,
        env: { AGENT_CLI_SCENARIO: 'echo' },
      },
    })
  );
  const health = await WorkBuddyClient.healthCheck();
  assert.equal(health.healthy, true);
  console.log('  ✓ WorkBuddyClient.healthCheck() passed');
}

delete process.env.CB_AGENT_CLI_CONFIG;
console.log('✅ workbuddyClient.test.ts passed successfully!');
