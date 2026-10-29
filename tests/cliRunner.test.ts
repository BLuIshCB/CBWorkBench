import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliRunner } from '../src/services/cliRunner.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureScript = path.join(__dirname, 'fixtures', 'agent-cli.mjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-clirunner-test-'));

console.log('[Test] Running cliRunner.test.ts...');

// 1. T01 & T02: 中文多行、特殊字符、emoji、反斜杠、CRLF/LF 等完整 UTF-8 管道测试
{
  const complexPrompt = `Line 1: 中文测试𠮷😀
Line 2: 引号 "double" 与 'single' 以及反引号 \`code\`
Line 3: 特殊命令字符 $() & | < > ^ % !
Line 4: 路径 C:\\Program Files\\Test\\
Line 5: CRLF\r\nEnd of test`;

  const res = await CliRunner.run({
    runId: 't01-test',
    executable: process.execPath,
    args: [fixtureScript, 'echo'],
    cwd: tempDir,
    stdin: complexPrompt,
    timeoutMs: 10000,
  });

  assert.equal(res.errorCode, undefined);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, complexPrompt);
  console.log('  ✓ T01/T02: Complex UTF-8 stdin passed through cleanly');
}

// 2. T03: 128 KiB 大输入测试 (远超 Windows 8191 命令行限制)
{
  const bigChunk = '测试超长UTF-8输入内容ABCDEF123456\n'.repeat(3000); // ~120KB+
  const sentSha256 = crypto.createHash('sha256').update(Buffer.from(bigChunk, 'utf8')).digest('hex');

  const res = await CliRunner.run({
    runId: 't03-test',
    executable: process.execPath,
    args: [fixtureScript, 'echo'],
    cwd: tempDir,
    stdin: bigChunk,
    timeoutMs: 15000,
  });

  assert.equal(res.exitCode, 0);
  const recvSha256 = crypto.createHash('sha256').update(Buffer.from(res.stdout, 'utf8')).digest('hex');
  assert.equal(recvSha256, sentSha256);
  console.log('  ✓ T03: 128KiB+ long stdin transferred without truncation');
}

// 3. T04: 字节级分包输出测试 (验证跨 chunk 多字节不会产生乱码或 U+FFFD)
{
  const res = await CliRunner.run({
    runId: 't04-test',
    executable: process.execPath,
    args: [fixtureScript, 'chunked-utf8'],
    cwd: tempDir,
    stdin: '',
    timeoutMs: 10000,
  });

  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, '你好世界😀🌍Hello\n');
  assert.ok(!res.stdout.includes('\uFFFD'), 'Decoded text must not contain replacement character U+FFFD');
  console.log('  ✓ T04: Chunked multi-byte UTF-8 stdout decoded seamlessly');
}

// 4. T05: 包含空格与中文的目录和参数测试
{
  const subDir = path.join(tempDir, '测试 目录 with space');
  fs.mkdirSync(subDir, { recursive: true });

  const res = await CliRunner.run({
    runId: 't05-test',
    executable: process.execPath,
    args: [fixtureScript, 'inspect-argv', '--no-session-persistence', 'arg with space'],
    cwd: subDir,
    stdin: '',
    timeoutMs: 10000,
  });

  assert.equal(res.exitCode, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.cwd, subDir);
  assert.ok(parsed.argv.includes('arg with space'));
  assert.equal(parsed.hasNoSessionPersistence, true);
  console.log('  ✓ T05: Directory and arguments with spaces & unicode handled correctly');
}

// 5. T07: 异常配置拒绝测试
{
  const invalidCwdRes = await CliRunner.run({
    runId: 't07-cwd',
    executable: process.execPath,
    cwd: 'relative/path',
  });
  assert.equal(invalidCwdRes.errorCode, 'CONFIG');

  const invalidTimeoutRes = await CliRunner.run({
    runId: 't07-timeout',
    executable: process.execPath,
    cwd: tempDir,
    timeoutMs: -5,
  });
  assert.equal(invalidTimeoutRes.errorCode, 'CONFIG');
  console.log('  ✓ T07: Invalid parameters rejected with CONFIG error');
}

// 6. T10: 超时处理与子进程回收测试
{
  const start = Date.now();
  const res = await CliRunner.run({
    runId: 't10-hang',
    executable: process.execPath,
    args: [fixtureScript, 'hang'],
    cwd: tempDir,
    timeoutMs: 1000,
  });

  assert.equal(res.timedOut, true);
  assert.equal(res.errorCode, 'TIMEOUT');
  assert.ok(Date.now() - start >= 900, 'Must wait until timeout');
  console.log('  ✓ T10: Hanging process terminated and marked TIMEOUT');
}

// 7. T11: 精准取消测试 (两个并发任务，仅取消其中一个)
{
  const p1 = CliRunner.run({
    runId: 'run-to-cancel',
    taskId: 'task-cancel',
    executable: process.execPath,
    args: [fixtureScript, 'hang'],
    cwd: tempDir,
    timeoutMs: 10000,
  });

  const p2 = CliRunner.run({
    runId: 'run-to-keep',
    taskId: 'task-keep',
    executable: process.execPath,
    args: [fixtureScript, 'echo'],
    cwd: tempDir,
    stdin: 'keep alive',
    timeoutMs: 10000,
  });

  // 等待进程启动后中断 task-cancel
  await new Promise(r => setTimeout(r, 200));
  await CliRunner.abort('task-cancel');

  const [res1, res2] = await Promise.all([p1, p2]);

  assert.equal(res1.cancelled, true);
  assert.equal(res1.errorCode, 'CANCELLED');

  assert.equal(res2.cancelled, false);
  assert.equal(res2.exitCode, 0);
  assert.equal(res2.stdout, 'keep alive');
  console.log('  ✓ T11: Targeted cancel stops only the specified task without affecting others');
}

// 8. T13: 输出超限测试
{
  const res = await CliRunner.run({
    runId: 't13-limit',
    executable: process.execPath,
    args: [fixtureScript, 'large-output'],
    cwd: tempDir,
    maxOutputBytes: 1024 * 1024, // 1MB limit
    timeoutMs: 10000,
  });

  assert.equal(res.errorCode, 'OUTPUT_LIMIT');
  console.log('  ✓ T13: Output exceeding limit terminated and reported OUTPUT_LIMIT');
}

console.log('✅ cliRunner.test.ts passed successfully!');
