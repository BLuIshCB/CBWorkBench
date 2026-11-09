import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createHttpServer } from '../src/server/httpServer.ts';
import { db } from '../src/storage/db.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_NODES } from '../src/services/workflowDefinition.ts';

console.log('[Test] Running workflowHttp.test.ts...');

const server = createHttpServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as any;
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  // 1. GET /api/workflows
  const listRes = await fetch(`${baseUrl}/api/workflows`).then((r) => r.json());
  assert.strictEqual(listRes.success, true);
  assert(Array.isArray(listRes.workflows));
  assert(listRes.workflows.some((w: any) => w.id === 'default'));
  console.log('  ✓ GET /api/workflows returns workflows');

  // 2. GET /api/workflows/default
  const defaultWfRes = await fetch(`${baseUrl}/api/workflows/default`).then((r) => r.json());
  assert.strictEqual(defaultWfRes.success, true);
  assert.strictEqual(defaultWfRes.workflow.id, 'default');
  assert.strictEqual(defaultWfRes.workflow.nodes.length, 6);
  console.log('  ✓ GET /api/workflows/default returns default workflow definition');

  // 3. POST /api/workflows validation failure (e.g. missing end node)
  const invalidGraph = [
    { id: 'start', name: '开始', type: 'start', on_success: 'task1' },
    { id: 'task1', name: '任务1', type: 'task', execution_mode: 'command', on_success: 'start' },
  ];
  const invalidRes = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'bad-wf',
      name: 'Bad Workflow',
      nodes: invalidGraph,
    }),
  });
  assert.strictEqual(invalidRes.status, 400);
  const invalidData = await invalidRes.json();
  assert.strictEqual(invalidData.success, false);
  assert.strictEqual(invalidData.code, 'INVALID_WORKFLOW');
  assert(invalidData.errors.length > 0);
  console.log('  ✓ POST /api/workflows rejects invalid graph with 400 and validation errors');

  // 4. POST /api/workflows valid custom workflow
  const validGraph = [
    { id: 'start', name: '开始', type: 'start', on_success: 'task1' },
    { id: 'task1', name: '任务1', type: 'task', execution_mode: 'command', command: 'echo hi', on_success: 'end' },
    { id: 'end', name: '结束', type: 'end' },
  ];
  const validRes = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'good-wf',
      name: 'Good Workflow',
      description: 'A valid 3-node workflow',
      nodes: validGraph,
    }),
  });
  assert.strictEqual(validRes.status, 200);
  const validData = await validRes.json();
  assert.strictEqual(validData.success, true);
  assert.strictEqual(validData.workflow.version, 1);
  console.log('  ✓ POST /api/workflows saves valid workflow');

  // 5. GET /api/tasks/:id/workflow
  const taskId = 'task-http-wf-' + randomUUID();
  db.createTask({
    id: taskId,
    task_key: 'http-key',
    title: 'HTTP Task',
    target_cwd: process.cwd(),
  });

  const taskWfRes = await fetch(`${baseUrl}/api/tasks/${taskId}/workflow`).then((r) => r.json());
  assert.strictEqual(taskWfRes.success, true);
  assert.strictEqual(taskWfRes.taskId, taskId);
  assert.strictEqual(taskWfRes.taskWorkflow.workflow_id, 'default');
  assert.strictEqual(taskWfRes.taskWorkflow.current_node_id, 'start');
  assert.strictEqual(taskWfRes.nodes.length, 6);
  console.log('  ✓ GET /api/tasks/:id/workflow returns task workflow state');

  // 6. POST /api/tasks/:id/workflow/manual-decision
  // Set task to HUMAN_REVIEW
  db.updateTaskStatus(taskId, TaskStatus.HUMAN_REVIEW);
  db.updateTaskWorkflow(taskId, { current_node_id: 'human_review' });

  const decisionRes = await fetch(`${baseUrl}/api/tasks/${taskId}/workflow/manual-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'approve',
      reason: 'HTTP test manual approval',
    }),
  });
  assert.strictEqual(decisionRes.status, 200);
  const decisionData = await decisionRes.json();
  assert.strictEqual(decisionData.success, true);
  assert.strictEqual(db.getTask(taskId)?.status, TaskStatus.COMPLETED);
  console.log('  ✓ POST /api/tasks/:id/workflow/manual-decision completes workflow');

  // 7. POST /api/workflows/reset-default
  const resetRes = await fetch(`${baseUrl}/api/workflows/reset-default`, {
    method: 'POST',
  }).then((r) => r.json());
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(resetRes.workflow.id, 'default');
  console.log('  ✓ POST /api/workflows/reset-default restores default template');

  console.log('✅ workflowHttp.test.ts passed successfully!');
} finally {
  server.close();
}
