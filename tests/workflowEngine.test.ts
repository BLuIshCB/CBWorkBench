import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { db } from '../src/storage/db.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { packageService } from '../src/services/packageService.ts';
import { computeWorkflowDefinitionSha256, type WorkflowNode } from '../src/services/workflowDefinition.ts';
import { TaskStatus, VERIFIER_DEFAULT_MODEL } from '../src/config/constants.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { MANDATORY_CLI_POLICY } from '../src/adapters/types.ts';
import { runVerificationAgent } from './fixtures/verificationAgent.ts';

process.env.CB_MOCK_WORKBUDDY = 'true';
process.env.CB_MOCK_CODEX = 'true';

console.log('[Test] Running workflowEngine.test.ts...');

adapterRegistry.register({
  id: 'engine-fixture', name: 'Engine fixture', description: 'Offline node execution',
  defaultModel: 'default', supportedModels: ['default'], connectionType: 'fixture', executionPolicy: MANDATORY_CLI_POLICY,
  async healthCheck() { return { healthy: true }; }, async abort() {},
  async execute(context) { return await runVerificationAgent(context) || { ok: true, output: context.prompt, durationMs: 0, modelUsed: 'default' }; },
});

function createCustomWorkflow(wfId: string) {
  const nodes: WorkflowNode[] = [
    { id: 'start', name: '开始', type: 'start', on_success: 'development' },
    { id: 'development', name: '开发实现', type: 'task', execution_mode: 'agent', executor: 'codex', prompt: '保留编排时的开发约束。', on_success: 'test', on_failure: null },
    { id: 'test', name: '独立测试', type: 'task', execution_mode: 'agent', result_rule: 'verification', on_success: 'acceptance', on_failure: 'development' },
    { id: 'acceptance', name: '整体验收', type: 'task', execution_mode: 'agent', result_rule: 'acceptance', executor: 'codex', on_success: 'human_review', on_failure: 'development' },
    { id: 'human_review', name: '人工确认', type: 'task', execution_mode: 'manual', on_success: 'end', on_failure: 'development' },
    { id: 'end', name: '结束', type: 'end' },
  ];
  const saved = db.saveWorkflowDefinition({ id: wfId, name: wfId, nodes_json: JSON.stringify(nodes) });
  return { wfId, sha: computeWorkflowDefinitionSha256({ id: saved.id, name: saved.name, description: saved.description, nodes }), nodes };
}

function submitV2Package(opts: { taskKey: string; wfId: string; wfSha: string; nodes: WorkflowNode[]; budgetMaxRounds?: number }) {
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-wfe-pkg-'));
  try {
    fs.writeFileSync(path.join(pkgRoot, 'requirements.md'), '# Requirements\n', 'utf8');
    fs.writeFileSync(path.join(pkgRoot, 'development.md'), '# Development\n', 'utf8');
    for (const n of opts.nodes) {
      if (n.type !== 'task') continue;
      const nodeDir = path.join(pkgRoot, 'nodes', n.id);
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(path.join(nodeDir, `${n.id}.md`), `# ${n.name}\n`, 'utf8');
      if (n.id !== 'development') {
        fs.writeFileSync(path.join(nodeDir, 'prompt.md'), `Execute ${n.id}\n`, 'utf8');
      }
    }
    const manifest = {
      title: opts.taskKey,
      workflow_id: opts.wfId,
      target_cwd: process.cwd(),
      task_key: opts.taskKey,
      budget_max_rounds: opts.budgetMaxRounds,
    };
    fs.writeFileSync(path.join(pkgRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const res = packageService.submitTask({
      package_root: pkgRoot,
      budget_max_rounds: opts.budgetMaxRounds,
    });
    return res.task_id as string;
  } finally {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  }
}

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

const wfInfo = createCustomWorkflow(`wf-eng-${Date.now()}`);
const unknownCliTaskId = submitV2Package({ taskKey: 'unknown-cli-task', wfId: wfInfo.wfId, wfSha: wfInfo.sha, nodes: wfInfo.nodes });
const unknownCliResult = await workflowEngine.confirmAndStartTask(unknownCliTaskId, undefined, { workerExecutor: 'unknown-cli' });
assert.equal(unknownCliResult.success, false);
assert.equal(db.getTask(unknownCliTaskId)?.status, TaskStatus.PENDING_CONFIRM);

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
assert.strictEqual(db.getTask(stopTaskId)?.status, TaskStatus.CANCELLED);

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
const badReview = await workflowEngine.submitHumanDecision(stopTaskId, 'approve', 'ok');
assert.strictEqual(badReview.success, false);
assert.ok(badReview.message.includes('not in human review'));

const approveRes = await workflowEngine.submitHumanDecision(reviewTaskId, 'approve', 'Looks great, verified manually!');
assert.strictEqual(approveRes.success, true);
const approvedTask = db.getTask(reviewTaskId);
assert.strictEqual(approvedTask?.status, TaskStatus.COMPLETED);
assert.ok(approvedTask?.completed_at);

// 5. Complete loop execution -> HUMAN_REVIEW -> reject -> budget exceeded BLOCKED
const loopTaskId = submitV2Package({ taskKey: 'loop-task-v2', wfId: wfInfo.wfId, wfSha: wfInfo.sha, nodes: wfInfo.nodes, budgetMaxRounds: 1 });
const startRes = await workflowEngine.confirmAndStartTask(loopTaskId, undefined, {
  workerExecutor: 'engine-fixture',
  reviewerExecutor: 'codex',
});
assert.strictEqual(startRes.success, true);

const competingTaskId = submitV2Package({ taskKey: 'competing-task-v2', wfId: wfInfo.wfId, wfSha: wfInfo.sha, nodes: wfInfo.nodes });
const competingStart = await workflowEngine.confirmAndStartTask(competingTaskId);
assert.strictEqual(competingStart.success, false, 'The execution slot must be reserved before asynchronous dispatch');
assert.strictEqual(db.getTask(competingTaskId)?.status, TaskStatus.PENDING_CONFIRM);
assert.equal(db.getTask(loopTaskId)?.worker_model, VERIFIER_DEFAULT_MODEL);
assert.equal(db.getTask(loopTaskId)?.reviewer_model, VERIFIER_DEFAULT_MODEL);

let pollCount = 0;
while (pollCount < 30) {
  await new Promise((r) => setTimeout(r, 150));
  if (db.getTask(loopTaskId)?.status === TaskStatus.HUMAN_REVIEW) break;
  pollCount++;
}

const humanReviewTask = db.getTask(loopTaskId);
assert.strictEqual(humanReviewTask?.status, TaskStatus.HUMAN_REVIEW);
assert.strictEqual(humanReviewTask?.current_round, 1);

const devRound = db.getRounds(loopTaskId).find((r) => r.worker_id === 'development');
assert.ok(devRound?.input_prompt?.includes('保留编排时的开发约束。'), '无 prompt.md 时回退使用工作流编排提示词');
assert.ok(devRound?.input_prompt?.includes('# 开发实现'), '<node_id>.md 必须传入执行器');

const reworkRes = await workflowEngine.submitHumanDecision(loopTaskId, 'reject', 'Need more polish');
assert.strictEqual(reworkRes.success, true);

pollCount = 0;
while (pollCount < 30) {
  await new Promise((r) => setTimeout(r, 150));
  if (db.getTask(loopTaskId)?.status === TaskStatus.BLOCKED) break;
  pollCount++;
}

const blockedTask = db.getTask(loopTaskId);
assert.strictEqual(blockedTask?.status, TaskStatus.BLOCKED);
assert.ok(blockedTask?.blocked_reason?.includes('budget exceeded'));

for (const tid of [dummyTaskId, unknownCliTaskId, stopTaskId, reviewTaskId, loopTaskId, competingTaskId]) {
  try { db.deleteTask(tid); } catch {}
}
try { db.deleteWorkflow(wfInfo.wfId); } catch {}

console.log('✅ workflowEngine.test.ts passed successfully!');
