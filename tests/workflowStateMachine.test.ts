import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../src/storage/db.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { MANDATORY_CLI_POLICY, type AgentExecutionContext } from '../src/adapters/types.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { DEFAULT_WORKFLOW_ID } from '../src/services/workflowDefinition.ts';

console.log('[Test] Running workflowStateMachine.test.ts...');

// Register a mock test adapter that simulates custom behaviors (failures, loops, passes)
let devCallCount = 0;
let acceptanceCallCount = 0;
let acceptanceDecision: 'passed' | 'needs_changes' | 'blocked' = 'passed';
let devFailWithCrash = false;

adapterRegistry.register({
  id: 'sm-fixture',
  name: 'State Machine Fixture',
  description: 'Deterministic state machine testing',
  defaultModel: 'default',
  supportedModels: ['default'],
  connectionType: 'fixture',
  executionPolicy: MANDATORY_CLI_POLICY,
  async healthCheck() {
    return { healthy: true };
  },
  async abort() {},
  async execute(context) {
    if (context.kind === 'reviewer') {
      acceptanceCallCount++;
      if (acceptanceDecision === 'needs_changes') {
        return {
          ok: true,
          output: JSON.stringify({
            decision: 'needs_changes',
            revision: 1,
            summary: 'Need bugfix on round ' + acceptanceCallCount,
            criteriaResults: [{ id: 'C1', passed: false, evidence: 'Bug found' }],
            issues: [{ id: 'ISSUE-1', description: 'Bug in logic', targetWorkerId: 'worker-dev' }],
            manualChecksPending: [],
          }),
          durationMs: 5,
          modelUsed: 'default',
        };
      }
      return {
        ok: true,
        output: JSON.stringify({
          decision: 'passed',
          revision: 1,
          summary: 'All checks passed',
          criteriaResults: [{ id: 'C1', passed: true, evidence: 'Verified' }],
          issues: [],
          manualChecksPending: [],
        }),
        durationMs: 5,
        modelUsed: 'default',
      };
    } else {
      devCallCount++;
      if (devFailWithCrash) {
        return {
          ok: false,
          output: 'Process exited with signal SIGSEGV',
          error: 'Process crashed with segmentation fault',
          errorCode: 'EXECUTION',
          durationMs: 5,
          modelUsed: 'default',
        };
      }
      return {
        ok: true,
        output: 'Developer finished implementation for round ' + devCallCount,
        durationMs: 5,
        modelUsed: 'default',
      };
    }
  },
});

function createFixtureTask(options?: { testsMd?: string }) {
  const id = 'sm-' + randomUUID();
  db.createTask({
    id,
    task_key: id,
    title: 'State Machine Test Task',
    target_cwd: process.cwd(),
    budget_max_rounds: 10,
  });
  db.saveRevision({
    task_id: id,
    revision: 1,
    manifest_json: JSON.stringify({ packageVersion: 1 }),
    task_md: '# SM Task',
    development_md: '# Dev',
    tests_md: options?.testsMd || '- 命令: `node -e "process.exit(0)"`',
    acceptance_md: '# Criteria',
    verifier_prompt_md: '# Verifier',
  });
  db.saveWorkerPrompt({
    task_id: id,
    revision: 1,
    worker_id: 'worker-dev',
    role: 'developer',
    prompt_text: 'Fix the code',
  });
  return id;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(predicate(), 'Condition not reached before timeout');
}

// -------------------------------------------------------------
// Test 1: Full Happy Path
// start -> development -> test -> acceptance -> human_review -> (approve) -> end
// -------------------------------------------------------------
devCallCount = 0;
acceptanceCallCount = 0;
acceptanceDecision = 'passed';
devFailWithCrash = false;

const task1 = createFixtureTask();
const start1 = await workflowEngine.confirmAndStartTask(task1, undefined, {
  workerExecutor: 'sm-fixture',
  reviewerExecutor: 'sm-fixture',
});
assert.strictEqual(start1.success, true);

await waitFor(() => db.getTask(task1)?.status === TaskStatus.HUMAN_REVIEW);
assert.strictEqual(devCallCount, 1);
assert.strictEqual(acceptanceCallCount, 1);

const nodeRunsTask1 = db.getNodeRuns(task1);
assert.strictEqual(nodeRunsTask1.filter((r) => r.node_id === 'development').length, 1);
assert.strictEqual(nodeRunsTask1.filter((r) => r.node_id === 'test').length, 1);
assert.strictEqual(nodeRunsTask1.filter((r) => r.node_id === 'acceptance').length, 1);
assert.strictEqual(nodeRunsTask1.filter((r) => r.node_id === 'human_review').length, 1);

// Approve human review
const approveRes = await workflowEngine.submitHumanDecision(task1, 'approve', 'LGTM');
assert.strictEqual(approveRes.success, true);
assert.strictEqual(db.getTask(task1)?.status, TaskStatus.COMPLETED);
console.log('  ✓ Test 1: Full happy path completed to end node');

// -------------------------------------------------------------
// Test 2: Acceptance failure loops back to development
// acceptance fails -> development (run 2) -> test -> acceptance (passes) -> human_review
// -------------------------------------------------------------
devCallCount = 0;
acceptanceCallCount = 0;
acceptanceDecision = 'needs_changes'; // first acceptance will fail

const task2 = createFixtureTask();
await workflowEngine.confirmAndStartTask(task2, undefined, {
  workerExecutor: 'sm-fixture',
  reviewerExecutor: 'sm-fixture',
});

// Wait until acceptance fails and loops back to development
await waitFor(() => devCallCount === 2);
// Now let acceptance pass on round 2
acceptanceDecision = 'passed';

await waitFor(() => db.getTask(task2)?.status === TaskStatus.HUMAN_REVIEW);
assert.strictEqual(devCallCount, 2);
assert.strictEqual(acceptanceCallCount, 2);

const nodeRunsTask2 = db.getNodeRuns(task2);
const devRuns = nodeRunsTask2.filter((r) => r.node_id === 'development');
assert.strictEqual(devRuns.length, 2);
assert.strictEqual(devRuns[0].execution_index, 1);
assert.strictEqual(devRuns[1].execution_index, 2);

// Check code generation incremented
const wfRecord2 = db.getTaskWorkflow(task2);
assert.strictEqual(wfRecord2?.code_generation, 2);
assert.strictEqual(wfRecord2?.tests_passed_generation, 2);
assert.strictEqual(wfRecord2?.acceptance_passed_generation, 2);
console.log('  ✓ Test 2: Acceptance failure loops back to development and advances to human review');

// -------------------------------------------------------------
// Test 3: Nodes have no execution count limit ("每个节点不做次数限制")
// Development and acceptance can execute 4 or more times without being blocked at 3
// -------------------------------------------------------------
devCallCount = 0;
acceptanceCallCount = 0;
acceptanceDecision = 'needs_changes'; // first fail multiple times to exceed 3 loops

const task3 = createFixtureTask({ budget_max_rounds: 10 });
await workflowEngine.confirmAndStartTask(task3, undefined, {
  workerExecutor: 'sm-fixture',
  reviewerExecutor: 'sm-fixture',
});

// Wait until development has executed at least 4 times (previously blocked on 4th)
await waitFor(() => devCallCount >= 4, 15000);
assert(devCallCount >= 4, `Expected development to execute at least 4 times, got ${devCallCount}`);

// Now let acceptance pass and reach human review
acceptanceDecision = 'passed';
await waitFor(() => db.getTask(task3)?.status === TaskStatus.HUMAN_REVIEW, 10000);
assert.strictEqual(db.getTask(task3)?.status, TaskStatus.HUMAN_REVIEW);
console.log('  ✓ Test 3: Nodes have no execution limit (development executed 4+ times successfully)');

// -------------------------------------------------------------
// Test 4: Running fault (CLI crash) pauses into BLOCKED, does NOT take failure edge
// -------------------------------------------------------------
devCallCount = 0;
devFailWithCrash = true;

const task4 = createFixtureTask();
await workflowEngine.confirmAndStartTask(task4, undefined, {
  workerExecutor: 'sm-fixture',
  reviewerExecutor: 'sm-fixture',
});

await waitFor(() => db.getTask(task4)?.status === TaskStatus.BLOCKED);
const task4Record = db.getTask(task4);
assert.strictEqual(task4Record?.status, TaskStatus.BLOCKED);
assert(task4Record?.blocked_reason?.includes('segmentation fault') || task4Record?.blocked_reason?.includes('crashed'));
assert.strictEqual(devCallCount, 1, 'Crashed worker must not loop back or continue');
console.log('  ✓ Test 4: Running fault pauses into BLOCKED and does not take failure edge');

console.log('✅ workflowStateMachine.test.ts passed successfully!');
