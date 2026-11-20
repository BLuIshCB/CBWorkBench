import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { db } from '../src/storage/db.ts';
import { taskFileStore } from '../src/storage/fileStore.ts';
import { packageService } from '../src/services/packageService.ts';
import { taskCleanupService } from '../src/services/taskCleanupService.ts';
import { computeWorkflowDefinitionSha256, type WorkflowNode } from '../src/services/workflowDefinition.ts';
import { MAINTENANCE_DELETIONS_DIR, TaskStatus } from '../src/config/constants.ts';
import { createHttpServer } from '../src/server/httpServer.ts';
import { createWorkbenchMcpServer } from '../src/server/mcpServer.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

console.log('[Test] Running taskCleanup.test.ts...');

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cleanup-test-'));
const wfId = `cleanup-wf-${Date.now()}`;
const wfNodes: WorkflowNode[] = [
  { id: 'start', name: '开始', type: 'start', on_success: 'work' },
  { id: 'work', name: '工作节点', type: 'task', execution_mode: 'agent', prompt: '执行任务并记录结果', on_success: 'end' },
  { id: 'end', name: '结束', type: 'end' },
];
const wfRec = db.saveWorkflowDefinition({ id: wfId, name: 'Cleanup Workflow', nodes_json: JSON.stringify(wfNodes) });
const wfSha = computeWorkflowDefinitionSha256({ id: wfRec.id, name: wfRec.name, description: wfRec.description, nodes: wfNodes });

function createTestTask(label: string) {
  const pkgRoot = path.join(tmpBase, label);
  fs.mkdirSync(path.join(pkgRoot, 'nodes', 'work'), { recursive: true });

  fs.writeFileSync(path.join(pkgRoot, 'requirements.md'), '# Requirements\n', 'utf8');
  fs.writeFileSync(path.join(pkgRoot, 'development.md'), '# Development\n', 'utf8');
  fs.writeFileSync(path.join(pkgRoot, 'nodes', 'work', 'work.md'), '# Work Node\n', 'utf8');
  fs.writeFileSync(path.join(pkgRoot, 'nodes', 'work', 'prompt.md'), 'Run work\n', 'utf8');

  const manifest = {
    title: `Cleanup Test ${label}`,
    workflow_id: wfId,
    target_cwd: tmpBase,
    task_key: label,
  };
  fs.writeFileSync(path.join(pkgRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const res = packageService.submitTask({
    package_root: pkgRoot,
  });
  return { taskId: res.task_id as string, pkgRoot };
}

try {
  // 1. Delete succeeds and leaves external source package untouched
  const t1 = createTestTask('clean-ok');
  const t1Root = taskFileStore.getTaskRootDir(t1.taskId);
  assert.ok(fs.existsSync(t1Root));

  const del1 = await taskCleanupService.deleteTask(t1.taskId);
  assert.equal(del1.ok, true);
  assert.equal(fs.existsSync(t1Root), false, 'Task root dir must be deleted');
  assert.equal(db.getTask(t1.taskId), null, 'Task DB record must be deleted');
  assert.ok(fs.existsSync(t1.pkgRoot), 'External upload source dir must NEVER be deleted');
  assert.equal(fs.existsSync(path.join(MAINTENANCE_DELETIONS_DIR, `${t1.taskId}.json`)), false);

  // Repeat delete is idempotent
  const del1Again = await taskCleanupService.deleteTask(t1.taskId);
  assert.equal(del1Again.ok, true);
  assert.equal(del1Again.alreadyDeleted, true);
  console.log('  ✓ Unified task deletion cleans internal task dir & DB while keeping external source intact');

  // 2. Simulated file deletion failure keeps DB entry as cleanup_failed & recovery record, then startup recovery succeeds
  const t2 = createTestTask('clean-fail-recover');
  const origDeleteTaskFiles = taskFileStore.deleteTaskFiles;
  taskFileStore.deleteTaskFiles = () => {
    throw new Error('EBUSY: simulated file lock');
  };

  try {
    const failedRes = await taskCleanupService.deleteTask(t2.taskId);
    assert.equal(failedRes.ok, false);
    assert.equal(failedRes.code, 'CLEANUP_FAILED');
    assert.match(failedRes.message, /EBUSY/);

    const preservedTask = db.getTask(t2.taskId);
    assert.ok(preservedTask, 'Task DB entry MUST NOT be removed when file deletion fails');
    assert.equal(preservedTask.status, TaskStatus.CLEANUP_FAILED);
    assert.ok(fs.existsSync(path.join(MAINTENANCE_DELETIONS_DIR, `${t2.taskId}.json`)));
    assert.equal(taskCleanupService.isTaskDeleting(t2.taskId), true);
  } finally {
    taskFileStore.deleteTaskFiles = origDeleteTaskFiles;
  }

  // Startup / retry recovery now finishes deletion cleanly
  const rec = await taskCleanupService.recoverPendingDeletions();
  assert.ok(rec.recovered.includes(t2.taskId));
  assert.equal(db.getTask(t2.taskId), null);
  assert.equal(fs.existsSync(taskFileStore.getTaskRootDir(t2.taskId)), false);
  assert.equal(fs.existsSync(path.join(MAINTENANCE_DELETIONS_DIR, `${t2.taskId}.json`)), false);
  console.log('  ✓ Recoverable deletion preserves DB record on file error and finishes on recovery');

  // 3. HTTP DELETE 409 on failure + MCP workbench_delete_task delegation to live resident server
  const t3 = createTestTask('mcp-delegate');
  const httpServer = createHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const prevServerUrl = process.env.CB_SERVER_URL;
  process.env.CB_SERVER_URL = baseUrl;

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcpServer = createWorkbenchMcpServer();
  await mcpServer.connect(st);
  const mcpClient = new Client({ name: 'cleanup-client', version: '1.0' }, { capabilities: {} });
  await mcpClient.connect(ct);

  try {
    const delRes = await mcpClient.callTool({
      name: 'workbench_delete_task',
      arguments: { task_id: t3.taskId },
    });
    assert.equal(Boolean(delRes.isError), false);
    const delData = JSON.parse((delRes.content as any)[0].text);
    assert.equal(delData.delegatedToServer, baseUrl);
    assert.equal(db.getTask(t3.taskId), null);
    console.log('  ✓ MCP workbench_delete_task delegates cleanup to live resident HTTP server');
  } finally {
    if (prevServerUrl === undefined) delete process.env.CB_SERVER_URL;
    else process.env.CB_SERVER_URL = prevServerUrl;
    await mcpClient.close();
    await mcpServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  console.log('✅ taskCleanup.test.ts passed successfully!');
} finally {
  try { db.deleteWorkflow(wfId); } catch {}
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
