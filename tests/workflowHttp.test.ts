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
  assert.strictEqual(validData.workflow.id, 'good-wf');
  console.log('  ✓ POST /api/workflows saves valid workflow');

  // Direct modification in place (no V versions)
  const modifyRes = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'good-wf',
      name: 'Good Workflow Modified',
      description: 'Modified in place',
      nodes: validGraph,
    }),
  });
  assert.strictEqual(modifyRes.status, 200);
  const modifyData = await modifyRes.json();
  assert.strictEqual(modifyData.success, true);
  assert.strictEqual(modifyData.workflow.name, 'Good Workflow Modified');
  console.log('  ✓ POST /api/workflows modifies existing workflow directly in place');

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

  // 5.1 While default workflow is referenced by taskId, modifying it is blocked
  const rejectInUseRes = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'default',
      name: 'Illegal Edit',
      nodes: DEFAULT_WORKFLOW_NODES,
    }),
  });
  assert.strictEqual(rejectInUseRes.status, 403);
  const rejectInUseData = await rejectInUseRes.json();
  assert.strictEqual(rejectInUseData.code, 'WORKFLOW_IN_USE');
  console.log('  ✓ POST /api/workflows rejects modification when referenced by a task');

  // Reset default is also blocked while referenced
  const resetBlockedRes = await fetch(`${baseUrl}/api/workflows/reset-default`, {
    method: 'POST',
  });
  assert.strictEqual(resetBlockedRes.status, 403);
  console.log('  ✓ POST /api/workflows/reset-default blocked while referenced by a task');

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

  // 7. After referencing tasks are cleared, reset default workflow succeeds
  db.deleteTask(taskId);
  for (const ref of db.getWorkflowReferencingTasks('default')) {
    try { db.deleteTask(ref.id); } catch {}
  }
  const resetRes = await fetch(`${baseUrl}/api/workflows/reset-default`, {
    method: 'POST',
  }).then((r) => r.json());
  assert.strictEqual(resetRes.success, true);
  assert.strictEqual(resetRes.workflow.id, 'default');
  console.log('  ✓ POST /api/workflows/reset-default restores default template after task deleted');

  // 8. DELETE /api/workflows/:id
  // 8.1 Default workflow cannot be deleted
  const delDefaultRes = await fetch(`${baseUrl}/api/workflows/default`, {
    method: 'DELETE',
  });
  assert.strictEqual(delDefaultRes.status, 400);
  const delDefaultData = await delDefaultRes.json();
  assert.strictEqual(delDefaultData.success, false);
  assert.strictEqual(delDefaultData.code, 'FORBIDDEN_DELETE_DEFAULT');
  console.log('  ✓ DELETE /api/workflows/default returns 400 FORBIDDEN_DELETE_DEFAULT');

  // 8.2 Non-existent workflow returns 404
  const delMissingRes = await fetch(`${baseUrl}/api/workflows/non-existent-wf`, {
    method: 'DELETE',
  });
  assert.strictEqual(delMissingRes.status, 404);
  console.log('  ✓ DELETE /api/workflows/non-existent-wf returns 404');

  // 8.3 Workflow referenced by task cannot be deleted (returns 403)
  const lockingTaskId = 'task-lock-del-' + randomUUID();
  db.createTask({
    id: lockingTaskId,
    task_key: 'lock-del-key',
    title: 'Locking Task',
    target_cwd: process.cwd(),
  });
  db.initTaskWorkflow(lockingTaskId, { workflowId: 'good-wf' });

  const delLockedRes = await fetch(`${baseUrl}/api/workflows/good-wf`, {
    method: 'DELETE',
  });
  assert.strictEqual(delLockedRes.status, 403);
  const delLockedData = await delLockedRes.json();
  assert.strictEqual(delLockedData.code, 'WORKFLOW_IN_USE');
  assert(delLockedData.referencingTasks.length > 0);
  console.log('  ✓ DELETE /api/workflows/good-wf returns 403 WORKFLOW_IN_USE when referenced');

  // 8.4 After deleting referencing task, deleting workflow succeeds
  db.deleteTask(lockingTaskId);
  const delSuccessRes = await fetch(`${baseUrl}/api/workflows/good-wf`, {
    method: 'DELETE',
  });
  assert.strictEqual(delSuccessRes.status, 200);
  const delSuccessData = await delSuccessRes.json();
  assert.strictEqual(delSuccessData.success, true);
  assert.strictEqual(db.getWorkflow('good-wf'), null);
  console.log('  ✓ DELETE /api/workflows/good-wf succeeds once task is removed');

  console.log('✅ workflowHttp.test.ts passed successfully!');
} finally {
  server.close();
}
