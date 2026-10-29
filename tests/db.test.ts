import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchDatabase } from '../src/storage/db.ts';
import { TaskStatus, RoundStage } from '../src/config/constants.ts';

const testDbPath = path.resolve('data/test_workbench.db');
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

console.log('[Test] Running db.test.ts...');
const testDb = new WorkbenchDatabase(testDbPath);

// 1. Create Task
const task = testDb.createTask({
  id: 'task-test-001',
  task_key: 'add-supplier-filter',
  revision: 1,
  title: 'Add supplier filter to order list',
  target_cwd: 'D:\\CODE\\AI\\CBWorkBench_TestSpace',
  git_root: 'D:\\CODE\\AI\\CBWorkBench_TestSpace',
  git_commit: 'abc1234',
  git_status: 'clean'
});

assert.strictEqual(task.id, 'task-test-001');
assert.strictEqual(task.status, TaskStatus.PENDING_CONFIRM);
assert.strictEqual(task.current_round, 0);

// 2. Save Revision & Prompts
testDb.saveRevision({
  task_id: 'task-test-001',
  revision: 1,
  manifest_json: JSON.stringify({ packageVersion: 1 }),
  task_md: '# Task Description',
  development_md: '# Dev Plan',
  tests_md: '# Tests',
  acceptance_md: '# Acceptance Criteria',
  verifier_prompt_md: '# Verifier Prompt'
});

const rev = testDb.getLatestRevision('task-test-001');
assert.ok(rev);
assert.strictEqual(rev.revision, 1);
assert.strictEqual(rev.task_md, '# Task Description');

testDb.saveWorkerPrompt({
  task_id: 'task-test-001',
  revision: 1,
  worker_id: 'worker-dev',
  role: 'developer',
  prompt_text: 'You are developer worker.'
});

const prompts = testDb.getWorkerPrompts('task-test-001', 1);
assert.strictEqual(prompts.length, 1);
assert.strictEqual(prompts[0].worker_id, 'worker-dev');

// 3. Update Status
testDb.updateTaskStatus('task-test-001', TaskStatus.RUNNING, {
  current_round: 1,
  current_stage: RoundStage.WORKER_DEV,
  active_worker_id: 'worker-dev'
});

const updatedTask = testDb.getTask('task-test-001');
assert.strictEqual(updatedTask?.status, TaskStatus.RUNNING);
assert.strictEqual(updatedTask?.current_round, 1);
assert.strictEqual(updatedTask?.current_stage, RoundStage.WORKER_DEV);

// 4. Test deleteTask
const deleteResult = testDb.deleteTask('task-test-001');
assert.strictEqual(deleteResult, true);
assert.strictEqual(testDb.getTask('task-test-001'), null);
assert.strictEqual(testDb.getLatestRevision('task-test-001'), null);
assert.strictEqual(testDb.getWorkerPrompts('task-test-001', 1).length, 0);

// 5. Test deleteAllTasks
testDb.createTask({
  id: 'task-test-002',
  task_key: 'test-2',
  revision: 1,
  title: 'Task 2',
  target_cwd: 'D:\\Test',
});
testDb.createTask({
  id: 'task-test-003',
  task_key: 'test-3',
  revision: 1,
  title: 'Task 3',
  target_cwd: 'D:\\Test',
});
const clearResult = testDb.deleteAllTasks();
assert.ok(clearResult.deletedCount >= 2);
assert.strictEqual(testDb.listTasks().length, 0);

// 6. Test native transaction & rollback
let caught = false;
try {
  testDb.transaction(() => {
    testDb.createTask({
      id: 'task-rollback-test',
      task_key: 'rollback',
      revision: 1,
      title: 'Rollback Test',
      target_cwd: 'D:\\Test',
    });
    // Throw error to trigger rollback
    throw new Error('Forced error inside transaction');
  });
} catch (e: any) {
  caught = true;
  assert.strictEqual(e.message, 'Forced error inside transaction');
}
assert.strictEqual(caught, true);
assert.strictEqual(testDb.getTask('task-rollback-test'), null, 'Transaction must rollback completely on error');

// 7. Test crash recovery
testDb.createTask({
  id: 'task-stuck-running',
  task_key: 'stuck-1',
  revision: 1,
  title: 'Stuck Running Task',
  target_cwd: 'D:\\Test',
  status: TaskStatus.RUNNING,
});
testDb.createTask({
  id: 'task-stuck-queued',
  task_key: 'stuck-2',
  revision: 1,
  title: 'Stuck Queued Task',
  target_cwd: 'D:\\Test',
  status: TaskStatus.QUEUED,
});
const recoveryResult = testDb.recoverPendingTasks();
assert.strictEqual(recoveryResult.recoveredCount, 2);
const rec1 = testDb.getTask('task-stuck-running');
const rec2 = testDb.getTask('task-stuck-queued');
assert.strictEqual(rec1?.status, TaskStatus.BLOCKED);
assert.strictEqual(rec2?.status, TaskStatus.BLOCKED);
assert.ok(rec1?.blocked_reason?.includes('服务意外终止或重启'));

// Clean up
testDb.deleteAllTasks();
try {
  fs.unlinkSync(testDbPath);
} catch {}

console.log('✅ db.test.ts passed successfully!');
