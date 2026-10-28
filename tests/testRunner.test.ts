import assert from 'node:assert';
import { TestRunner } from '../src/services/testRunner.ts';

console.log('[Test] Running testRunner.test.ts...');

// 1. Test parsing from manifest
const manifest = JSON.stringify({
  packageVersion: 1,
  testCases: [
    { id: 'TC-1', command: 'npm test', isRequired: true },
    { id: 'TC-2', title: 'Lint check', command: 'npm run lint' }
  ]
});
const fromManifest = TestRunner.parseTestCases('# Empty md', manifest);
assert.strictEqual(fromManifest.length, 2);
assert.strictEqual(fromManifest[0].id, 'TC-1');
assert.strictEqual(fromManifest[0].command, 'npm test');
assert.strictEqual(fromManifest[1].id, 'TC-2');
assert.strictEqual(fromManifest[1].name, 'Lint check');

// 2. Test parsing from markdown with inline command
const mdWithInline = `
# Test Cases
- 命令: \`node -v\`
- 必需检查执行命令: \`git status\`
`;
const fromInline = TestRunner.parseTestCases(mdWithInline);
assert.strictEqual(fromInline.length, 2);
assert.strictEqual(fromInline[0].command, 'node -v');
assert.strictEqual(fromInline[1].command, 'git status');

// 3. Test parsing from code block
const mdWithBlock = `
### 自动化执行
\`\`\`bash
npm run test:unit
\`\`\`
`;
const fromBlock = TestRunner.parseTestCases(mdWithBlock);
assert.strictEqual(fromBlock.length, 1);
assert.strictEqual(fromBlock[0].command, 'npm run test:unit');

// 4. Test runSingleTest - Success
const successResult = await TestRunner.runSingleTest(
  { id: 'T-PASS', command: 'node -e "console.log(\'runner-ok\')"' },
  process.cwd(),
  5000
);
assert.strictEqual(successResult.passed, true);
assert.strictEqual(successResult.exitCode, 0);
assert.ok(successResult.stdout.includes('runner-ok'));

// 5. Test runSingleTest - Failure
const failResult = await TestRunner.runSingleTest(
  { id: 'T-FAIL', command: 'node -e "console.error(\'runner-fail\'); process.exit(2);"' },
  process.cwd(),
  5000
);
assert.strictEqual(failResult.passed, false);
assert.strictEqual(failResult.exitCode, 2);
assert.ok(failResult.stderr.includes('runner-fail'));

// 6. Test runSingleTest - Timeout
const timeoutResult = await TestRunner.runSingleTest(
  { id: 'T-TIMEOUT', command: 'node -e "setTimeout(() => {}, 5000);"' },
  process.cwd(),
  1000
);
assert.strictEqual(timeoutResult.passed, false);
assert.ok(timeoutResult.stderr.includes('timed out'));

// 7. Test runAllTests aggregate
const aggregate = await TestRunner.runAllTests(
  [
    { id: 'T1', command: 'node -e "console.log(1)"' },
    { id: 'T2', command: 'node -e "process.exit(1)"' }
  ],
  process.cwd(),
  5000
);
assert.strictEqual(aggregate.allPassed, false);
assert.strictEqual(aggregate.testRuns.length, 2);
assert.ok(aggregate.failureSummary);
assert.ok(aggregate.failureSummary.includes('T2'));

console.log('✅ testRunner.test.ts passed successfully!');
