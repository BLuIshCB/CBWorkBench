import assert from 'node:assert';
import { db } from '../src/storage/db.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { TaskStatus, RoundStage } from '../src/config/constants.ts';

// Enable mock mode for fast deterministic testing
process.env.CB_MOCK_WORKBUDDY = 'true';
process.env.CB_MOCK_CODEX = 'true';

console.log('[Test] Running workflowEngine.test.ts...');

// 1. Confirm and start error checks
const notFoundResult = await workflowEngine.confirmAndStartTask('non-existent-task-id');
assert.strictEqual(notFoundResult.success, false);
assert.ok(notFoundResult.message.includes('not found'));

// 2. State restriction: Cannot start COMPLETED task
const dummyTaskId = `wf-dummy-${Date.now()}`;
db.createTask({
  id: dummyTaskId,
  task_key: 'dummy-task',
  revision: 1,
  title: 'Dummy Task',
  status: TaskStatus.COMPLETED,
  target_cwd: process.cwd(),
});
const invalidStateResult = await workflowEngine.confirmAndStartTask(dummyTaskId);
assert.strictEqual(invalidStateResult.success, false);
assert.ok(invalidStateResult.message.includes('Cannot start task'));

// 3. Stop task on pending/queued
const stopTaskId = `wf-stop-${Date.now()}`;
db.createTask({
  id: stopTaskId,
  task_key: 'stop-task',
  revision: 1,
  title: 'Stop Task',
  status: TaskStatus.PENDING_CONFIRM,
  target_cwd: process.cwd(),
});
const stopResult = workflowEngine.stopTask(stopTaskId);
assert.strictEqual(stopResult.success, true);
const stoppedTask = db.getTask(stopTaskId);
assert.strictEqual(stoppedTask?.status, TaskStatus.CANCELLED);

// 4. Human review decisions (Gate 3)
const reviewTaskId = `wf-review-${Date.now()}`;
db.createTask({
  id: reviewTaskId,
  task_key: 'review-task',
  revision: 1,
  title: 'Review Task',
  status: TaskStatus.HUMAN_REVIEW,
  target_cwd: process.cwd(),
});

// 4.1 Reject decision when not in HUMAN_REVIEW
const badReview = await workflowEngine.submitHumanDecision(stopTaskId, 'approve', 'ok');
assert.strictEqual(badReview.success, false);
assert.ok(badReview.message.includes('not in human review'));

// 4.2 Approve decision
const approveRes = await workflowEngine.submitHumanDecision(reviewTaskId, 'approve', 'Looks great, verified manually!');
assert.strictEqual(approveRes.success, true);
const approvedTask = db.getTask(reviewTaskId);
assert.strictEqual(approvedTask?.status, TaskStatus.COMPLETED);
assert.ok(approvedTask?.completed_at);

const decisions = db.getHumanDecisions(reviewTaskId);
assert.strictEqual(decisions.length, 1);
assert.strictEqual(decisions[0].action, 'approve');
assert.strictEqual(decisions[0].reason, 'Looks great, verified manually!');

// 5. Test complete loop execution: Confirm and Start -> Worker -> Tests -> Codex -> HUMAN_REVIEW
const loopTaskId = `wf-loop-${Date.now()}`;
db.createTask({
  id: loopTaskId,
  task_key: 'loop-task',
  revision: 1,
  title: 'Loop Execution Task',
  status: TaskStatus.PENDING_CONFIRM,
  target_cwd: process.cwd(),
  budget_max_rounds: 1, // Only 1 round budget
});

db.saveRevision({
  task_id: loopTaskId,
  revision: 1,
  manifest_json: JSON.stringify({ packageVersion: 1 }),
  task_md: '# Full Loop Task',
  development_md: '# Dev Plan',
  tests_md: '- 命令: `node -v`',
  acceptance_md: '# Acceptance Criteria',
  verifier_prompt_md: '# Verifier Prompt',
});

db.saveWorkerPrompt({
  task_id: loopTaskId,
  revision: 1,
  worker_id: 'worker-dev',
  role: 'developer',
  prompt_text: 'Develop the feature',
});

const startRes = await workflowEngine.confirmAndStartTask(loopTaskId);
assert.strictEqual(startRes.success, true);

// Wait for round 1 to complete and reach HUMAN_REVIEW
let pollCount = 0;
while (pollCount < 20) {
  await new Promise((r) => setTimeout(r, 200));
  const t = db.getTask(loopTaskId);
  if (t?.status === TaskStatus.HUMAN_REVIEW) {
    break;
  }
  pollCount++;
}

const humanReviewTask = db.getTask(loopTaskId);
assert.strictEqual(humanReviewTask?.status, TaskStatus.HUMAN_REVIEW);
assert.strictEqual(humanReviewTask?.current_round, 1);

// 6. Test Budget limit: Human requests rework, but max_rounds is 1 -> transitions to BLOCKED!
const reworkRes = await workflowEngine.submitHumanDecision(loopTaskId, 'reject', 'Need more polish');
assert.strictEqual(reworkRes.success, true);

pollCount = 0;
while (pollCount < 20) {
  await new Promise((r) => setTimeout(r, 200));
  const t = db.getTask(loopTaskId);
  if (t?.status === TaskStatus.BLOCKED) {
    break;
  }
  pollCount++;
}

const blockedTask = db.getTask(loopTaskId);
assert.strictEqual(blockedTask?.status, TaskStatus.BLOCKED);
assert.ok(blockedTask?.blocked_reason?.includes('budget exceeded'));

console.log('✅ workflowEngine.test.ts passed successfully!');
