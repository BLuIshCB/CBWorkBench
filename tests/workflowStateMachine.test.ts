import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../src/storage/db.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { packageService } from '../src/services/packageService.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { MANDATORY_CLI_POLICY } from '../src/adapters/types.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { computeWorkflowDefinitionSha256, type WorkflowNode } from '../src/services/workflowDefinition.ts';
import { runVerificationAgent } from './fixtures/verificationAgent.ts';

console.log('[Test] Running workflowStateMachine.test.ts...');

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
    const verification = await runVerificationAgent(context);
    if (verification) return verification;
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
            issues: [{ id: 'ISSUE-1', description: 'Bug in logic' }],
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

const smWfId = `sm-wf-${randomUUID().slice(0, 8)}`;
const smNodes: WorkflowNode[] = [
  { id: 'start', name: '开始', type: 'start', on_success: 'development' },
  { id: 'development', name: '开发实现', type: 'task', execution_mode: 'agent', executor: 'sm-fixture', on_success: 'test', on_failure: null },
  { id: 'test', name: '独立测试', type: 'task', execution_mode: 'agent', result_rule: 'verification', executor: 'sm-fixture', on_success: 'acceptance', on_failure: 'development' },
  { id: 'acceptance', name: '整体验收', type: 'task', execution_mode: 'agent', result_rule: 'acceptance', executor: 'sm-fixture', on_success: 'human_review', on_failure: 'development' },
  { id: 'human_review', name: '人工确认', type: 'task', execution_mode: 'manual', on_success: 'end', on_failure: 'development' },
  { id: 'end', name: '结束', type: 'end' },
];
const savedWf = db.saveWorkflowDefinition({ id: smWfId, name: 'State Machine Workflow', nodes_json: JSON.stringify(smNodes) });
const smWfSha = computeWorkflowDefinitionSha256({ id: savedWf.id, name: savedWf.name, description: savedWf.description, nodes: smNodes });

function createFixtureTask(options?: { budget_max_rounds?: number }) {
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sm-pkg-'));
  try {
    const taskKey = 'sm-' + randomUUID().slice(0, 8);
    fs.writeFileSync(path.join(pkgRoot, 'requirements.md'), '# Requirements\n', 'utf8');
    fs.writeFileSync(path.join(pkgRoot, 'development.md'), '# Development\n', 'utf8');
    for (const n of smNodes) {
      if (n.type !== 'task') continue;
      const nodeDir = path.join(pkgRoot, 'nodes', n.id);
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(path.join(nodeDir, `${n.id}.md`), `# ${n.name}\n`, 'utf8');
      fs.writeFileSync(path.join(nodeDir, 'prompt.md'), `Do ${n.id}\n`, 'utf8');
    }
    const manifest = {
      title: 'State Machine Test Task',
      workflow_id: smWfId,
      target_cwd: process.cwd(),
      task_key: taskKey,
      budget_max_rounds: options?.budget_max_rounds ?? 10,
    };
    fs.writeFileSync(path.join(pkgRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const res = packageService.submitTask({
      package_root: pkgRoot,
      budget_max_rounds: options?.budget_max_rounds ?? 10,
    });
    return res.task_id as string;
  } finally {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(predicate(), 'Condition not reached before timeout');
}

// Test 1: Full Happy Path
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
assert.ok(nodeRunsTask1[0].result_json, 'Unified result.json must be recorded');

const approveRes = await workflowEngine.submitHumanDecision(task1, 'approve', 'LGTM');
assert.strictEqual(approveRes.success, true);
assert.strictEqual(db.getTask(task1)?.status, TaskStatus.COMPLETED);
console.log('  ✓ Test 1: Full happy path completed to end node with unified result.json');

// Test 2: Acceptance failure loops back to development
devCallCount = 0;
acceptanceCallCount = 0;
acceptanceDecision = 'needs_changes';

const task2 = createFixtureTask();
await workflowEngine.confirmAndStartTask(task2, undefined, {
  workerExecutor: 'sm-fixture',
  reviewerExecutor: 'sm-fixture',
});

await waitFor(() => devCallCount === 2);
acceptanceDecision = 'passed';

await waitFor(() => db.getTask(task2)?.status === TaskStatus.HUMAN_REVIEW);
assert.strictEqual(devCallCount, 2);
assert.strictEqual(acceptanceCallCount, 2);

const wfRecord2 = db.getTaskWorkflow(task2);
assert.strictEqual(wfRecord2?.code_generation, 2);
assert.strictEqual(wfRecord2?.tests_passed_generation, 2);
assert.strictEqual(wfRecord2?.acceptance_passed_generation, 2);
console.log('  ✓ Test 2: Acceptance failure loops back to development and enforces fresh test evidence & acceptance generation');

// Test 3: Nodes have no artificial 3-run limit when max_executions=0
devCallCount = 0;
acceptanceCallCount = 0;
acceptanceDecision = 'needs_changes';

const task3 = createFixtureTask({ budget_max_rounds: 10 });
await workflowEngine.confirmAndStartTask(task3, undefined, {
  workerExecutor: 'sm-fixture',
  reviewerExecutor: 'sm-fixture',
});

await waitFor(() => devCallCount >= 4, 15000);
assert(devCallCount >= 4);
acceptanceDecision = 'passed';
await waitFor(() => db.getTask(task3)?.status === TaskStatus.HUMAN_REVIEW, 10000);
console.log('  ✓ Test 3: Unlimited node executions when max_executions=0');

// Test 4: Running fault pauses into BLOCKED
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
assert.strictEqual(devCallCount, 1);
console.log('  ✓ Test 4: Running fault pauses into BLOCKED');

for (const tid of [task1, task2, task3, task4]) {
  try { db.deleteTask(tid); } catch {}
}
try { db.deleteWorkflow(smWfId); } catch {}

console.log('✅ workflowStateMachine.test.ts passed successfully!');
