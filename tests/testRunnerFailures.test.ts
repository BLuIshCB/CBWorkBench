import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CliRunner, type CliRunResult } from '../src/services/cliRunner.ts';
import { TestRunner } from '../src/services/testRunner.ts';

const failures: unknown[] = [];

// 普通测试可以输出本地编码；同样的非法 UTF-8 仍须被 CLI 协议拒绝。
try {
  const script = 'process.stdout.write(Buffer.from([0xc4,0xe3,0xba,0xc3]));process.stderr.write(Buffer.from([0xc4,0xe3,0xba,0xc3]));';
  const command = '"' + process.execPath + '" -e "' + script + '"';
  const aggregate = await TestRunner.runAllTests([
    { id: 'local-encoding', command },
    { id: 'next-test', command: '"' + process.execPath + '" -e "console.log(123)"' },
  ], process.cwd(), 5000);
  assert.equal(aggregate.allPassed, true);
  assert.equal(aggregate.interrupted, undefined);
  assert.equal(aggregate.testRuns.length, 2);
  assert.equal(aggregate.testRuns[0].exitCode, 0);
  assert.ok(aggregate.testRuns[0].stdout.length > 0);
  assert.ok(aggregate.testRuns[0].stderr.length > 0);

  const protocol = await CliRunner.run({
    runId: randomUUID(), executable: process.execPath,
    args: ['-e', script], cwd: process.cwd(), timeoutMs: 5000,
  });
  assert.equal(protocol.errorCode, 'PROTOCOL');

  const assertionFailure = await TestRunner.runAllTests([
    { id: 'assertion-failed', command: '"' + process.execPath + '" -e "process.exit(2)"' },
    { id: 'after-assertion', command: '"' + process.execPath + '" -e "console.log(456)"' },
  ], process.cwd(), 5000);
  assert.equal(assertionFailure.allPassed, false);
  assert.equal(assertionFailure.interrupted, undefined);
  assert.equal(assertionFailure.testRuns.length, 2);
  assert.equal(assertionFailure.testRuns[0].terminationReason, undefined);
} catch (error) {
  failures.push(error);
}

// 基础设施终止可能带有非零退出码，不能据此当作普通断言失败。
const original = CliRunner.run;
try {
  for (const result of [
    { errorCode: 'EXECUTION', stopReason: 'PROCESS_FAILED', exitCode: 1, cleanupConfirmed: true },
    { errorCode: 'EXECUTION', stopReason: 'CLEANUP_FAILED', exitCode: 1, cleanupConfirmed: false },
    { errorCode: 'EXECUTION', stopReason: 'PROCESS_FAILED', exitCode: null, cleanupConfirmed: true },
    { errorCode: 'TIMEOUT', stopReason: 'EXECUTION_TIMEOUT', exitCode: 1, cleanupConfirmed: true },
    { errorCode: 'CANCELLED', stopReason: 'USER_CANCELLED', exitCode: 1, cleanupConfirmed: true },
  ] as const) {
    let calls = 0;
    CliRunner.run = async options => {
      calls++;
      return {
        runId: options.runId, signal: null, stdout: 'partial evidence', stderr: '',
        timedOut: result.errorCode === 'TIMEOUT', cancelled: result.errorCode === 'CANCELLED',
        durationMs: 1, error: 'infrastructure failure', ...result,
      } satisfies CliRunResult;
    };
    const aggregate = await TestRunner.runAllTests([
      { id: 'infrastructure-failure', command: 'fixture' },
      { id: 'must-not-run', command: 'fixture' },
    ], process.cwd());
    assert.equal(calls, 1, result.stopReason + ' must stop subsequent tests');
    assert.equal(aggregate.interrupted, true);
    assert.equal(aggregate.allPassed, false);
    assert.equal(aggregate.testRuns[0].terminationReason, result.stopReason);
  }
} catch (error) {
  failures.push(error);
} finally {
  CliRunner.run = original;
}

if (failures.length) throw new AggregateError(failures, 'Test runner failure handling regressions');
console.log('✅ testRunnerFailures.test.ts passed');
