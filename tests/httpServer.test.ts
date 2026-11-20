import assert from 'node:assert';
import http from 'node:http';
import { createHttpServer } from '../src/server/httpServer.ts';
import { db } from '../src/storage/db.ts';
import { TaskStatus, WORKER_FIXED_MODEL, VERIFIER_DEFAULT_MODEL } from '../src/config/constants.ts';
import { EMBEDDED_ASSETS } from '../src/ui/embeddedAssets.ts';

console.log('[Test] Running httpServer.test.ts...');

const server = createHttpServer();

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    resolve();
  });
});

const address = server.address() as any;
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  // 1. Static UI routes
  const indexRes = await fetch(`${baseUrl}/`);
  assert.strictEqual(indexRes.status, 200);
  const indexText = await indexRes.text();
  assert.ok(indexText.includes('CBWorkBench'));

  const cssRes = await fetch(`${baseUrl}/styles.css`);
  assert.strictEqual(cssRes.status, 200);

  const mainModuleRes = await fetch(`${baseUrl}/js/main.js`);
  assert.strictEqual(mainModuleRes.status, 200);
  assert.ok((await mainModuleRes.text()).includes('export class App'));

  const utilsModuleRes = await fetch(`${baseUrl}/js/utils.js`);
  assert.strictEqual(utilsModuleRes.status, 200);
  assert.ok((await utilsModuleRes.text()).includes('export function escapeHtml'));

  // EXE 前后端必须使用同一次打包的资源，不能被旁边的源码覆盖。
  const previousSeaExe = process.env.CB_SEA_EXE;
  const previousApiAsset = EMBEDDED_ASSETS['/js/api.js'];
  EMBEDDED_ASSETS['/js/api.js'] = {
    content: '// bundled API client',
    contentType: 'application/javascript',
  };
  try {
    process.env.CB_SEA_EXE = 'true';
    const bundledRes = await fetch(`${baseUrl}/js/api.js`);
    assert.strictEqual(bundledRes.status, 200);
    assert.strictEqual(await bundledRes.text(), '// bundled API client');
    const missingBundledRes = await fetch(`${baseUrl}/js/main.js`);
    assert.strictEqual(missingBundledRes.status, 404);

    delete process.env.CB_SEA_EXE;
    const sourceRes = await fetch(`${baseUrl}/js/api.js`);
    assert.strictEqual(sourceRes.status, 200);
    assert.ok((await sourceRes.text()).includes('export const api'));
  } finally {
    if (previousSeaExe === undefined) delete process.env.CB_SEA_EXE;
    else process.env.CB_SEA_EXE = previousSeaExe;
    if (previousApiAsset === undefined) delete EMBEDDED_ASSETS['/js/api.js'];
    else EMBEDDED_ASSETS['/js/api.js'] = previousApiAsset;
  }

  // 2. System Status & Instance APIs
  const sysRes = await fetch(`${baseUrl}/api/system/status`);
  assert.strictEqual(sysRes.status, 200);
  const sysData = await sysRes.json();
  assert.strictEqual(sysData.success, true);
  assert.strictEqual(sysData.status.workerModel, VERIFIER_DEFAULT_MODEL);
  assert.strictEqual(sysData.status.verifierModel, VERIFIER_DEFAULT_MODEL);
  assert.ok(sysData.status.instanceId);
  assert.ok(sysData.status.dataDir);

  const instRes = await fetch(`${baseUrl}/api/system/instance`);
  assert.strictEqual(instRes.status, 200);
  const instData = await instRes.json();
  assert.strictEqual(instData.success, true);
  assert.strictEqual(instData.instance_id, sysData.status.instanceId);
  assert.strictEqual(instData.data_dir, sysData.status.dataDir);

  // 3. List tasks API
  const listRes = await fetch(`${baseUrl}/api/tasks`);
  assert.strictEqual(listRes.status, 200);
  const listData = await listRes.json();
  assert.strictEqual(listData.success, true);
  assert.ok(Array.isArray(listData.tasks));

  // 4. Non-existent task detail
  const notFoundRes = await fetch(`${baseUrl}/api/tasks/not-a-real-task-id`);
  assert.strictEqual(notFoundRes.status, 404);

  // 5. Create a test task in DB and fetch detail
  const testTaskId = `http-test-${Date.now()}`;
  db.createTask({
    id: testTaskId,
    task_key: 'http-test-key',
    revision: 1,
    title: 'HTTP Test Task',
    target_cwd: process.cwd(),
    git_root: process.cwd(),
    git_commit: 'test1234',
    git_status: 'clean'
  });

  const detailRes = await fetch(`${baseUrl}/api/tasks/${testTaskId}`);
  assert.strictEqual(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.strictEqual(detailData.success, true);
  assert.strictEqual(detailData.task.id, testTaskId);
  assert.strictEqual(detailData.task.status, TaskStatus.PENDING_CONFIRM);

  // 6. Test invalid human review input
  const invalidReviewRes = await fetch(`${baseUrl}/api/tasks/${testTaskId}/human-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'invalid_action' })
  });
  assert.strictEqual(invalidReviewRes.status, 400);

  // 6.1 Test Delete Single Task API
  const deleteRes = await fetch(`${baseUrl}/api/tasks/${testTaskId}`, {
    method: 'DELETE',
  });
  assert.strictEqual(deleteRes.status, 200);
  const deleteData = await deleteRes.json();
  assert.strictEqual(deleteData.success, true);
  assert.strictEqual(db.getTask(testTaskId), null);

  // 6.2 Test Clear All API with dummy tasks
  const dummyId = `http-dummy-${Date.now()}`;
  db.createTask({
    id: dummyId,
    task_key: 'dummy-task',
    revision: 1,
    title: 'Dummy Task',
    target_cwd: process.cwd(),
  });
  const clearRes = await fetch(`${baseUrl}/api/tasks/clear-all`, {
    method: 'POST',
  });
  assert.strictEqual(clearRes.status, 200);
  const clearData = await clearRes.json();
  assert.strictEqual(clearData.success, true);
  assert.ok(typeof clearData.deletedCount === 'number');
  assert.strictEqual(db.getTask(dummyId), null);

  // 6.3 Task Workflow Node Model Switching & Freeze Protection
  const wfTaskId = `http-wf-task-${Date.now()}`;
  db.createTask({
    id: wfTaskId,
    task_key: 'wf-task',
    revision: 1,
    title: 'Workflow Node Model Test Task',
    status: TaskStatus.PENDING_CONFIRM,
    target_cwd: process.cwd(),
  });
  db.initTaskWorkflow(wfTaskId, { revision: 1 });

  // Switch development node model before starting -> 200 OK
  const updateNodeRes = await fetch(`${baseUrl}/api/tasks/${wfTaskId}/workflow/nodes/development`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', executor: 'workbuddy' }),
  });
  assert.strictEqual(updateNodeRes.status, 200);
  const updateNodeData = await updateNodeRes.json();
  assert.strictEqual(updateNodeData.success, true);
  assert.strictEqual(updateNodeData.node.model, 'deepseek-v4-flash');

  // Verify persisted in database
  const updatedWf = db.getTaskWorkflow(wfTaskId);
  const updatedNodes = JSON.parse(updatedWf!.nodes_json);
  const devNode = updatedNodes.find((n: any) => n.id === 'development');
  assert.strictEqual(devNode.model, 'deepseek-v4-flash');

  // Try updating non-existent node -> 404
  const notFoundNodeRes = await fetch(`${baseUrl}/api/tasks/${wfTaskId}/workflow/nodes/non-existent`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test' }),
  });
  assert.strictEqual(notFoundNodeRes.status, 404);

  // Transition task to running
  db.updateTaskStatus(wfTaskId, TaskStatus.RUNNING);

  // Attempting to update model after start is frozen -> 409 Conflict
  const frozenRes = await fetch(`${baseUrl}/api/tasks/${wfTaskId}/workflow/nodes/development`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o' }),
  });
  assert.strictEqual(frozenRes.status, 409);
  const frozenData = await frozenRes.json();
  assert.strictEqual(frozenData.code, 'TASK_ALREADY_STARTED');
  assert.ok(frozenData.message.includes('冻结'));

  // Cleanup
  db.deleteTask(wfTaskId);

  // 7. Runtime Static Route & APIs
  const runtimePageRes = await fetch(`${baseUrl}/runtime`);
  assert.strictEqual(runtimePageRes.status, 200);
  const runtimeHtml = await runtimePageRes.text();
  assert.ok(runtimeHtml.includes('CBWorkBench'));

  const clisRes = await fetch(`${baseUrl}/api/runtime/clis`);
  assert.strictEqual(clisRes.status, 200);
  const clisData = await clisRes.json();
  assert.strictEqual(clisData.success, true);
  assert.ok(Array.isArray(clisData.clis));
  assert.ok(clisData.clis.some((c: any) => c.id === 'workbuddy'));
  assert.ok(clisData.clis.some((c: any) => c.id === 'codex'));
  assert.strictEqual(clisData.clis.some((c: any) => c.id === 'node'), false);

  process.env.CB_MOCK_WORKBUDDY = 'true';
  const probeRes = await fetch(`${baseUrl}/api/runtime/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cliId: 'workbuddy',
      prompt: '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。',
    }),
  });
  assert.strictEqual(probeRes.status, 200);
  const probeData = await probeRes.json();
  assert.strictEqual(probeData.success, true);
  assert.strictEqual(probeData.result.ok, true);
  assert.ok(probeData.result.output.includes('MOCK WORKBUDDY RESULT'));

  console.log('✅ httpServer.test.ts passed successfully!');
} finally {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
