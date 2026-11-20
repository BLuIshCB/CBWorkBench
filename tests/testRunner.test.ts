import assert from 'node:assert';
import { TestRunner } from '../src/services/testRunner.ts';

console.log('[Test] Running testRunner.test.ts...');

// 1. Test empty explicit commands returns failure (no silent pass or markdown fallback)
const emptyRes = await TestRunner.runAllTests([], process.cwd(), 5000);
assert.strictEqual(emptyRes.allPassed, false);
assert.ok(emptyRes.failureSummary);

// 2. Test runSingleTest - Success
const successResult = await TestRunner.runSingleTest(
  { id: 'T-PASS', command: 'node -e "console.log(\'runner-ok\')"' },
  process.cwd(),
  5000
);
assert.strictEqual(successResult.passed, true);
assert.strictEqual(successResult.exitCode, 0);
assert.ok(successResult.stdout.includes('runner-ok'));

// 3. Test runSingleTest - Failure
const failResult = await TestRunner.runSingleTest(
  { id: 'T-FAIL', command: 'node -e "console.error(\'runner-fail\'); process.exit(2);"' },
  process.cwd(),
  5000
);
assert.strictEqual(failResult.passed, false);
assert.strictEqual(failResult.exitCode, 2);
assert.ok(failResult.stderr.includes('runner-fail'));

// 4. Test runSingleTest - Timeout
const timeoutResult = await TestRunner.runSingleTest(
  { id: 'T-TIMEOUT', command: 'node -e "setTimeout(() => {}, 5000);"' },
  process.cwd(),
  1000
);
assert.strictEqual(timeoutResult.passed, false);
assert.strictEqual(timeoutResult.terminationReason, 'EXECUTION_TIMEOUT');

// 5. Test runAllTests aggregate
const aggregate = await TestRunner.runAllTests(
  [
    { id: 'T1', command: 'node -e "console.log(1)"' },
    { id: 'T2', command: 'node -e "process.exit(1)"' },
  ],
  process.cwd(),
  5000
);
assert.strictEqual(aggregate.allPassed, false);
assert.strictEqual(aggregate.testRuns.length, 2);
assert.ok(aggregate.failureSummary);
assert.ok(aggregate.failureSummary.includes('T2'));

console.log('✅ testRunner.test.ts passed successfully!');
