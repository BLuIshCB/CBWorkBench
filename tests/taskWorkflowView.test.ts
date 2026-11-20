import assert from 'node:assert';
import { createHttpServer } from '../src/server/httpServer.ts';
import { db } from '../src/storage/db.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';

console.log('[Test] Running taskWorkflowView.test.ts...');

const server = createHttpServer();

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    resolve();
  });
});

const address = server.address() as any;
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  // 1. Create a task in PENDING_CONFIRM
  const taskId = `task-wf-test-${Date.now()}`;
  db.createTask({
    id: taskId,
    task_key: 'wf-view-task',
    revision: 1,
    title: 'Test Workflow View & Node Model Switch',
    status: TaskStatus.PENDING_CONFIRM,
    target_cwd: process.cwd(),
  });
  const taskWf = db.initTaskWorkflow(taskId, { revision: 1 });
  assert.ok(taskWf);

  // 2. Fetch task detail via HTTP: taskWorkflow and nodes returned
  const detailRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
  assert.strictEqual(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.strictEqual(detailData.success, true);
  assert.ok(detailData.taskWorkflow);
  const nodes = JSON.parse(detailData.taskWorkflow.nodes_json);
  assert.ok(Array.isArray(nodes));
  const devNode = nodes.find((n: any) => n.id === 'development');
  const acceptanceNode = nodes.find((n: any) => n.id === 'acceptance');
  assert.ok(devNode, 'development node must exist');
  assert.ok(acceptanceNode, 'acceptance node must exist');
  assert.ok(devNode.prompt, 'development node prompt must be inspectable');

  // 3. Switch node model before starting (development & acceptance nodes)
  const updateDevRes = await fetch(`${baseUrl}/api/tasks/${taskId}/workflow/nodes/development`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', executor: 'workbuddy' }),
  });
  assert.strictEqual(updateDevRes.status, 200);
  const devResult = await updateDevRes.json();
  assert.strictEqual(devResult.success, true);
  assert.strictEqual(devResult.node.model, 'deepseek-v4-flash');

  const updateAcceptRes = await fetch(`${baseUrl}/api/tasks/${taskId}/workflow/nodes/acceptance`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'custom-acceptance-model', executor: 'codex' }),
  });
  assert.strictEqual(updateAcceptRes.status, 200);
  const acceptResult = await updateAcceptRes.json();
  assert.strictEqual(acceptResult.success, true);
  assert.strictEqual(acceptResult.node.model, 'custom-acceptance-model');

  // 4. Verify nodes in database have been updated
  const reloadedWf = db.getTaskWorkflow(taskId);
  const reloadedNodes = JSON.parse(reloadedWf!.nodes_json);
  assert.strictEqual(reloadedNodes.find((n: any) => n.id === 'development')?.model, 'deepseek-v4-flash');
  assert.strictEqual(reloadedNodes.find((n: any) => n.id === 'acceptance')?.model, 'custom-acceptance-model');

  // 5. Freeze check: Start task (simulated via status update to running)
  db.updateTaskStatus(taskId, TaskStatus.RUNNING);

  // 6. After task starts, switching model must be strictly rejected with 409
  const frozenUpdateRes = await fetch(`${baseUrl}/api/tasks/${taskId}/workflow/nodes/development`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'another-model' }),
  });
  assert.strictEqual(frozenUpdateRes.status, 409);
  const frozenData = await frozenUpdateRes.json();
  assert.strictEqual(frozenData.code, 'TASK_ALREADY_STARTED');
  assert.ok(frozenData.message.includes('冻结'));

  // 7. Verify model was NOT changed while frozen
  const afterFreezeWf = db.getTaskWorkflow(taskId);
  const afterFreezeNodes = JSON.parse(afterFreezeWf!.nodes_json);
  assert.strictEqual(afterFreezeNodes.find((n: any) => n.id === 'development')?.model, 'deepseek-v4-flash');

  // Cleanup
  db.deleteTask(taskId);

  console.log('✅ taskWorkflowView.test.ts passed successfully!');
} finally {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
