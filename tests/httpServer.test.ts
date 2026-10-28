import assert from 'node:assert';
import http from 'node:http';
import { createHttpServer } from '../src/server/httpServer.ts';
import { db } from '../src/storage/db.ts';
import { TaskStatus, WORKER_FIXED_MODEL, VERIFIER_DEFAULT_MODEL } from '../src/config/constants.ts';

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

  const jsRes = await fetch(`${baseUrl}/app.js`);
  assert.strictEqual(jsRes.status, 200);

  // 2. System Status API
  const sysRes = await fetch(`${baseUrl}/api/system/status`);
  assert.strictEqual(sysRes.status, 200);
  const sysData = await sysRes.json();
  assert.strictEqual(sysData.success, true);
  assert.strictEqual(sysData.status.workerModel, WORKER_FIXED_MODEL);
  assert.strictEqual(sysData.status.verifierModel, VERIFIER_DEFAULT_MODEL);

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

  console.log('✅ httpServer.test.ts passed successfully!');
} finally {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
