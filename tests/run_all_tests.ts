import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testSuites = [
  'nodeResolver.test.ts',
  'db.test.ts',
  'gitService.test.ts',
  'testRunner.test.ts',
  'adapters.test.ts',
  'workbuddyRegression.test.ts',
  'workbuddyClient.test.ts',
  'runtimeService.test.ts',
  'httpServer.test.ts',
  'mcpServer.test.ts',
  'workflowEngine.test.ts',
];

console.log('============================================================');
console.log('🧪 Starting CBWorkBench Comprehensive Test Suite');
console.log(`Total test suites: ${testSuites.length}`);
console.log('============================================================\n');

let passedCount = 0;
let failedCount = 0;
const startTotal = Date.now();

for (const suite of testSuites) {
  const fullPath = path.join(__dirname, suite);
  const suiteStart = Date.now();
  console.log(`\n------------------------------------------------------------`);
  console.log(`▶ Running: ${suite}`);
  console.log(`------------------------------------------------------------`);

  try {
    // Convert to file:// URL for Windows ESM dynamic import
    await import(pathToFileURL(fullPath).href);
    const duration = Date.now() - suiteStart;
    console.log(`[PASS] ${suite} (${duration}ms)`);
    passedCount++;
  } catch (err: any) {
    const duration = Date.now() - suiteStart;
    console.error(`[FAIL] ${suite} (${duration}ms):`, err?.stack || err?.message || err);
    failedCount++;
  }
}

const totalDuration = Date.now() - startTotal;
console.log('\n============================================================');
console.log('📊 Test Execution Summary:');
console.log(`Total: ${testSuites.length}`);
console.log(`Passed: ${passedCount}`);
console.log(`Failed: ${failedCount}`);
console.log(`Duration: ${(totalDuration / 1000).toFixed(2)}s`);
console.log('============================================================');

if (failedCount > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 ALL TESTS PASSED! CBWorkBench is fully verified.');
  process.exit(0);
}
