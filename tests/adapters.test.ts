import assert from 'node:assert';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { WorkBuddyAdapter } from '../src/adapters/workbuddyAdapter.ts';

// Enable mock mode for fast deterministic unit tests
process.env.CB_MOCK_WORKBUDDY = 'true';

console.log('[Test] Running adapters.test.ts...');

// 1. Registry tests
const workerAdapter = adapterRegistry.getWorkerAdapter('workbuddy');
assert.ok(workerAdapter, 'Worker adapter should be resolved');
assert.strictEqual(workerAdapter.id, 'workbuddy');
assert.ok(workerAdapter.supportedRoles.includes('worker'));
assert.strictEqual(typeof workerAdapter.executeDevTask, 'function');

const reviewerAdapter = adapterRegistry.getReviewerAdapter('workbuddy');
assert.ok(reviewerAdapter, 'Reviewer adapter should be resolved');
assert.strictEqual(reviewerAdapter.id, 'workbuddy');
assert.ok(reviewerAdapter.supportedRoles.includes('reviewer'));
assert.strictEqual(typeof reviewerAdapter.executeReview, 'function');

// 2. Health check
const health = await workerAdapter.healthCheck();
assert.strictEqual(typeof health.healthy, 'boolean');

// 3. executeDevTask (Worker execution)
const devResult = await workerAdapter.executeDevTask({
  taskId: 'test-adapter-task',
  roundNumber: 1,
  workerId: 'worker-dev',
  model: 'deepseek-v4-flash',
  prompt: 'Write hello function',
  cwd: process.cwd(),
});

assert.strictEqual(devResult.ok, true);
assert.strictEqual(devResult.modelUsed, 'deepseek-v4-flash');
assert.ok(devResult.durationMs >= 0);
assert.ok(devResult.output.includes('MOCK WORKBUDDY RESULT'));

// 4. executeReview (Reviewer execution without sandbox)
const reviewResult = await reviewerAdapter.executeReview({
  taskId: 'test-adapter-task',
  roundNumber: 1,
  model: 'deepseek-v4-flash',
  revision: 1,
  confirmedCwd: process.cwd(),
  taskPackageDir: process.cwd(),
  testRunsSummary: 'Test T1: Exit code 0',
  gitDiff: 'diff --git a/file.js b/file.js',
  verifierPrompt: 'Verify strict requirements',
  definedWorkerIds: ['worker-dev'],
});

assert.strictEqual(reviewResult.decision, 'passed');
assert.strictEqual(reviewResult.modelUsed, 'deepseek-v4-flash');
assert.ok(reviewResult.criteriaResults.length > 0);
assert.strictEqual(reviewResult.criteriaResults[0].passed, true);
assert.strictEqual(reviewResult.issues.length, 0);

// 5. List metadata
const workers = adapterRegistry.listWorkers();
assert.ok(workers.length >= 1);
assert.ok(workers.some((w) => w.id === 'workbuddy' && w.supportedModels.includes('deepseek-v4-flash')));

const reviewers = adapterRegistry.listReviewers();
assert.ok(reviewers.length >= 1);
assert.ok(reviewers.some((r) => r.id === 'workbuddy' && r.supportedModels.includes('deepseek-v4-flash')));

console.log('✅ adapters.test.ts passed successfully!');
