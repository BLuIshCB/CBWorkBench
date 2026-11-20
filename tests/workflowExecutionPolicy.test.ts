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
import { MANDATORY_CLI_POLICY, type AgentExecutionContext } from '../src/adapters/types.ts';
import { TestRunner } from '../src/services/testRunner.ts';
import { CliRunner } from '../src/services/cliRunner.ts';
import { executionTimeoutSchema, resolveExecutionTimeout } from '../src/services/executionPolicy.ts';
import { computeWorkflowDefinitionSha256, type WorkflowNode } from '../src/services/workflowDefinition.ts';
import { runVerificationAgent } from './fixtures/verificationAgent.ts';

const calls: AgentExecutionContext[] = [];
let waitForCancellation: 'worker' | 'reviewer' | null = null;
adapterRegistry.register({
  id: 'policy-fixture',
  name: 'Policy fixture',
  description: 'Offline contract fixture',
  defaultModel: 'default',
  supportedModels: ['default'],
  connectionType: 'fixture',
  executionPolicy: MANDATORY_CLI_POLICY,
  async healthCheck() { return { healthy: true }; },
  async abort() {},
  async execute(context) {
    calls.push(context);
    if (waitForCancellation === (context.kind || 'worker')) {
      await new Promise<void>((resolve) => {
        if (context.signal?.aborted) resolve();
        else context.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, output: 'partial output', error: 'cancelled fixture', errorCode: 'CANCELLED', durationMs: 0, modelUsed: 'default' };
    }
    const verification = await runVerificationAgent(context);
    if (verification) return verification;
    return {
      ok: true,
      output:
        context.kind === 'reviewer'
          ? JSON.stringify({
              decision: 'passed',
              revision: 1,
              summary: 'fixture evidence',
              criteriaResults: [{ id: 'fixture', passed: true, evidence: 'Offline adapter contract verified' }],
              issues: [],
              manualChecksPending: [],
            })
          : 'development fixture',
      durationMs: 0,
      modelUsed: 'default',
    };
  },
});

const polWfId = `pol-wf-${randomUUID().slice(0, 8)}`;
const polNodes: WorkflowNode[] = [
  { id: 'start', name: '开始', type: 'start', on_success: 'development' },
  { id: 'development', name: '开发实现', type: 'task', execution_mode: 'agent', executor: 'policy-fixture', on_success: 'test' },
  { id: 'test', name: '测试验证', type: 'task', execution_mode: 'agent', result_rule: 'verification', executor: 'policy-fixture', on_success: 'acceptance', on_failure: 'development' },
  { id: 'acceptance', name: '整体验收', type: 'task', execution_mode: 'agent', result_rule: 'acceptance', executor: 'policy-fixture', on_success: 'human_review', on_failure: 'development' },
  { id: 'human_review', name: '人工确认', type: 'task', execution_mode: 'manual', on_success: 'end', on_failure: 'development' },
  { id: 'end', name: '结束', type: 'end' },
];
const savedWf = db.saveWorkflowDefinition({ id: polWfId, name: 'Policy Workflow', nodes_json: JSON.stringify(polNodes) });
const polWfSha = computeWorkflowDefinitionSha256({ id: savedWf.id, name: savedWf.name, description: savedWf.description, nodes: polNodes });

function createTask() {
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pol-pkg-'));
  try {
    const taskKey = 'policy-' + randomUUID().slice(0, 8);
    fs.writeFileSync(path.join(pkgRoot, 'requirements.md'), '# Requirements\n', 'utf8');
    fs.writeFileSync(path.join(pkgRoot, 'development.md'), '# Development\n', 'utf8');
    for (const n of polNodes) {
      if (n.type !== 'task') continue;
      const nodeDir = path.join(pkgRoot, 'nodes', n.id);
      fs.mkdirSync(nodeDir, { recursive: true });
      fs.writeFileSync(path.join(nodeDir, 'work.md'), `# ${n.name}\n`, 'utf8');
      fs.writeFileSync(path.join(nodeDir, 'prompt.md'), `Run ${n.id}\n`, 'utf8');
    }
    const manifest = {
      title: 'Policy fixture',
      workflow_id: polWfId,
      target_cwd: process.cwd(),
      task_key: taskKey,
      budget_max_rounds: 1,
    };
    fs.writeFileSync(path.join(pkgRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return packageService.submitTask({
      package_root: pkgRoot,
      budget_max_rounds: 1,
    }).task_id as string;
  } finally {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), 'Workflow did not reach expected state');
}

assert.equal(resolveExecutionTimeout(undefined, 60000), 60000);
assert.equal(resolveExecutionTimeout(120000, 60000), 120000);
for (const value of [0, -1, 60001, 86460000, Infinity, NaN, '60000']) {
  assert.equal(executionTimeoutSchema.safeParse(value).success, false);
}

const testTimeouts: number[] = [];
const original = TestRunner.runSingleTest;
TestRunner.runSingleTest = async function (tc, cwd, timeout, options) {
  testTimeouts.push(timeout!);
  return original.call(this, tc, cwd, timeout, options);
};

const createdIds: string[] = [];
try {
  const id = createTask();
  createdIds.push(id);
  assert.equal(
    (await workflowEngine.confirmAndStartTask(id, undefined, { workerExecutor: 'policy-fixture', reviewerExecutor: 'policy-fixture', executionTimeoutMs: 60000 })).success,
    true
  );
  await waitFor(() => db.getTask(id)?.status === 'human_review' && !workflowEngine.isBusy());
  assert.deepEqual(calls.map((c) => c.timeoutMs), [60000, 60000, 60000]);
  assert.deepEqual(testTimeouts, [60000]);
  assert.equal(db.getTask(id)?.execution_timeout_ms, 60000);

  const originalRun = CliRunner.run;
  let infrastructureCalls = 0;
  try {
    CliRunner.run = async (options) => {
      infrastructureCalls++;
      return {
        runId: options.runId,
        exitCode: 1,
        signal: null,
        stdout: 'partial evidence',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: 1,
        errorCode: 'EXECUTION',
        stopReason: 'PROCESS_FAILED',
        cleanupConfirmed: true,
        error: 'durable output failure',
      };
    };
    const failureId = createTask();
    createdIds.push(failureId);
    const previousCalls = calls.length;
    assert.equal((await workflowEngine.confirmAndStartTask(failureId, undefined, { workerExecutor: 'policy-fixture', reviewerExecutor: 'policy-fixture' })).success, true);
    await waitFor(() => db.getTask(failureId)?.status === 'blocked' && !workflowEngine.isBusy());
    assert.equal(infrastructureCalls, 1);
    assert.equal(calls.length, previousCalls + 2);
    assert.match(db.getTask(failureId)!.blocked_reason!, /durable output failure/);
  } finally {
    CliRunner.run = originalRun;
  }

  for (const kind of ['worker', 'reviewer'] as const) {
    waitForCancellation = kind;
    const cancelId = createTask();
    createdIds.push(cancelId);
    const start = calls.length;
    assert.equal((await workflowEngine.confirmAndStartTask(cancelId, undefined, { workerExecutor: 'policy-fixture', reviewerExecutor: 'policy-fixture' })).success, true);
    await waitFor(() => calls.slice(start).some((c) => (c.kind || 'worker') === kind));
    assert.equal(workflowEngine.stopTask(cancelId).success, true);
    await waitFor(() => db.getTask(cancelId)?.status === 'cancelled' && !workflowEngine.isBusy());
  }
} finally {
  TestRunner.runSingleTest = original;
  for (const tid of createdIds) {
    try { db.deleteTask(tid); } catch {}
  }
  try { db.deleteWorkflow(polWfId); } catch {}
}

console.log('✅ workflowExecutionPolicy.test.ts passed');
