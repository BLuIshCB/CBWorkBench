import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createHttpServer } from '../src/server/httpServer.ts';
import { db } from '../src/storage/db.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_NODES } from '../src/services/workflowDefinition.ts';
import { WORKFLOW_FILE_MAX_BYTES } from '../src/services/workflowTemplateService.ts';

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
    { id: 'task1', name: '任务1', type: 'task', execution_mode: 'agent', on_success: 'start' },
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
    { id: 'start', name: '开始', description: '进入任务。', type: 'start', on_success: 'task1' },
    { id: 'task1', name: ' 任务1 ', description: ' 自行检查项目并执行任务 ', type: 'task', execution_mode: 'agent', on_success: 'end' },
    { id: 'end', name: '结束', description: '完成流程。', type: 'end' },
  ];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: baseUrl } } });
  const { WorkflowView } = await import('../src/ui/js/components/workflowView.js').finally(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const view = new WorkflowView({});
  view.currentNodes = validGraph;
  const panel = view.buildNodeConfigHtml(validGraph[1]);
  assert.match(panel, /节点名称（必填）/);
  assert.match(panel, /节点描述（必填）/);
  assert.match(panel, /AI 会参考它们生成任务包/);
  assert.doesNotMatch(panel, /updateCurrentNodeField\('(executor|model|prompt)'/);
  assert.match(panel, /id="workflow-node-manual-gate"[^>]+onchange=/);
  assert.doesNotMatch(view.buildNodeConfigHtml(validGraph[0]), /workflow-node-manual-gate/);
  assert.match(view.buildNodeConfigHtml({ ...validGraph[1], execution_mode: 'manual' }), /id="workflow-node-manual-gate"[^>]+checked/);
  assert.match(view.buildNodeConfigHtml({ ...validGraph[1], result_rule: 'verification' }), /id="workflow-node-manual-gate"[^>]+disabled/);
  view.currentWorkflow = { isReferenced: true };
  assert.match(view.buildNodeConfigHtml(validGraph[1]), /id="workflow-node-manual-gate"[^>]+disabled/);
  view.currentWorkflow = { id: DEFAULT_WORKFLOW_ID };
  const defaultReview = DEFAULT_WORKFLOW_NODES.find(node => node.id === 'human_review')!;
  const defaultReviewPanel = view.buildNodeConfigHtml(defaultReview);
  assert.match(defaultReviewPanel, /id="workflow-node-manual-gate"[^>]+checked[^>]+disabled/);
  assert.doesNotMatch(defaultReviewPanel, /deleteCurrentNode/);

  for (const change of [{ id: 'human_review', execution_mode: 'agent' }, { id: 'acceptance', on_success: 'end', on_failure: 'human_review' }]) {
    const invalidDefault = await fetch(`${baseUrl}/api/workflows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: DEFAULT_WORKFLOW_ID,
        name: defaultWfRes.workflow.name,
        nodes: DEFAULT_WORKFLOW_NODES.map(node => node.id === change.id ? { ...node, ...change } : node),
      }),
    });
    assert.equal(invalidDefault.status, 400);
    assert.match((await invalidDefault.json()).message, /人工确认节点通过后才能结束/);
  }

  const exported = await fetch(`${baseUrl}/api/workflows/default/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition')!, /attachment; filename="workflow\.json"/);
  const workflowFile = await exported.json();
  assert.deepEqual(Object.keys(workflowFile).sort(), ['description', 'name', 'nodes']);
  assert.equal(workflowFile.nodes.find((node: any) => node.id === 'development').execution_mode, undefined);
  const gate = workflowFile.nodes.find((node: any) => node.id === 'human_review');
  assert.equal(gate.execution_mode, 'manual');
  assert.equal(gate.on_failure, 'development');
  const importFile = (file: unknown) => fetch(`${baseUrl}/api/workflows/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
  });
  const existingNodeId = '_' + 'review'.repeat(11);
  const existingGraph = [
    { ...validGraph[0], on_success: existingNodeId },
    { ...validGraph[1], id: existingNodeId },
    validGraph[2],
  ];
  const existingSave = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'existing-node-id', name: '已有模板', nodes: existingGraph }),
  });
  assert.equal(existingSave.status, 200);
  const existingExport = await fetch(`${baseUrl}/api/workflows/existing-node-id/export`).then(r => r.json());
  assert.equal(existingExport.nodes[1].id, existingNodeId);
  const existingImport = await importFile(existingExport);
  assert.equal(existingImport.status, 201);
  const existingImportId = (await existingImport.json()).workflow_id;
  const existingDetail = await fetch(`${baseUrl}/api/workflows/${existingImportId}`).then(r => r.json());
  assert.equal(existingDetail.workflow.nodes[1].dir_name, existingNodeId);
  assert.equal(existingDetail.workflow.nodes[1].material_contract.prompt_ref, `nodes/${existingNodeId}/prompt.md`);
  db.deleteWorkflow(existingImportId);
  db.deleteWorkflow('existing-node-id');

  const originalAlert = Object.getOwnPropertyDescriptor(globalThis, 'alert');
  let importNotice = '';
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message: string) => { importNotice = message; } });
  try {
    view.render = () => {};
    await view.selectWorkflow('default');
    let readOversizedFile = false;
    await view.importWorkflowFile({
      value: 'too-large.json',
      files: [{
        size: WORKFLOW_FILE_MAX_BYTES + 1,
        text: async () => { readOversizedFile = true; return JSON.stringify(workflowFile); },
      }],
    });
    assert.equal(readOversizedFile, false);
    assert.match(importNotice, /不能超过 5 MiB/);

    view.currentNodes[1].description = '待保存的编辑';
    const fileText = JSON.stringify(workflowFile);
    await view.importWorkflowFile({ files: [{ size: Buffer.byteLength(fileText), text: async () => fileText }], value: 'workflow.json' });
    assert.equal(view.currentWorkflow.id, 'default');
    assert.equal(view.currentNodes[1].description, '待保存的编辑');
    assert.match(importNotice, /当前编辑已保留/);
    const newTemplate = view.workflows.find((workflow: { id: string; name: string }) =>
      workflow.id !== 'default' && workflow.name === workflowFile.name);
    assert.ok(newTemplate);
    db.deleteWorkflow(newTemplate.id);

    const longDescription = 'a'.repeat(3 * 1024 * 1024);
    const largeImport = await importFile({
      name: '大模板',
      nodes: [validGraph[0], { ...validGraph[1], description: longDescription }, validGraph[2]],
    });
    assert.equal(largeImport.status, 201);
    const largeId = (await largeImport.json()).workflow_id;
    try {
      await view.selectWorkflow(largeId);
      assert.equal(view.currentNodes[1].material_contract.purpose.length, longDescription.length);
      view.currentNodes[1].execution_mode = 'manual';
      await view.saveWorkflow();
      assert.match(importNotice, /保存成功/);
      const savedNodes = JSON.parse(db.getWorkflow(largeId)!.nodes_json);
      assert.equal(savedNodes[1].execution_mode, 'manual');
      assert.equal(savedNodes[1].material_contract, undefined);
    } finally {
      db.deleteWorkflow(largeId);
    }
  } finally {
    if (originalAlert) Object.defineProperty(globalThis, 'alert', originalAlert);
    else Reflect.deleteProperty(globalThis, 'alert');
  }

  const imported = await importFile(workflowFile);
  assert.equal(imported.status, 201);
  const importedId = (await imported.json()).workflow_id;
  assert.match(importedId, /^wf_[0-9a-f-]{36}$/);
  const importedDetail = await fetch(`${baseUrl}/api/workflows/${importedId}`).then(r => r.json());
  assert.equal(importedDetail.workflow.isDefault, false);
  assert.equal(importedDetail.workflow.nodes.find((node: any) => node.id === 'development').execution_mode, 'agent');
  assert.deepEqual(await fetch(`${baseUrl}/api/workflows/${importedId}/export`).then(r => r.json()), workflowFile);
  db.deleteWorkflow(importedId);

  const countBeforeInvalidImport = db.listWorkflows().length;
  const invalidImport = await importFile({
    ...workflowFile,
    nodes: workflowFile.nodes.map((node: any) => node.id === 'test' ? { ...node, execution_mode: 'manual' } : node),
  });
  assert.equal(invalidImport.status, 400);
  const invalidImportError = await invalidImport.json();
  assert.equal(invalidImportError.code, 'INVALID_WORKFLOW');
  assert.equal(invalidImportError.details[0].field, 'nodes[2].result_rule');
  assert.equal(db.listWorkflows().length, countBeforeInvalidImport);
  const missingExport = await fetch(`${baseUrl}/api/workflows/${importedId}/export`);
  assert.equal(missingExport.status, 404);
  assert.equal((await missingExport.json()).code, 'WORKFLOW_NOT_FOUND');

  for (const endpoint of ['/api/workflows/import', '/api/workflows']) {
    const oversized = await fetch(baseUrl + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflowFile) + ' '.repeat(WORKFLOW_FILE_MAX_BYTES),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, 'WORKFLOW_FILE_TOO_LARGE');
  }

  const missingMetadata = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'missing-node-metadata',
      name: 'Missing Metadata',
      nodes: [validGraph[0], { ...validGraph[1], name: '  ', description: '\t', prompt: '不能替代描述' }, validGraph[2]],
    }),
  });
  assert.equal(missingMetadata.status, 400);
  assert.deepEqual((await missingMetadata.json()).errors, ['节点 [task1] 的名称为必填项', '节点 [task1] 的描述为必填项']);
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
  const savedNode = JSON.parse(validData.workflow.nodes_json)[1];
  assert.equal(savedNode.name, '任务1');
  assert.equal(savedNode.description, '自行检查项目并执行任务');
  console.log('  ✓ POST /api/workflows saves valid workflow');

  // Direct modification in place (no V versions)
  const modifyRes = await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'good-wf',
      name: 'Good Workflow Modified',
      description: 'Modified in place',
      nodes: [validGraph[0], { ...validGraph[1], executor: 'codex', model: 'custom', prompt: '忽略旧字段' }, validGraph[2]],
    }),
  });
  assert.strictEqual(modifyRes.status, 200);
  const modifyData = await modifyRes.json();
  assert.strictEqual(modifyData.success, true);
  assert.strictEqual(modifyData.workflow.name, 'Good Workflow Modified');
  assert.deepEqual(JSON.parse(modifyData.workflow.nodes_json)[1], savedNode);
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
  const reviewRun = 'run-' + taskId;
  db.createNodeRun({
    run_id: reviewRun, task_id: taskId, revision: 1, node_id: 'human_review',
    execution_index: 1, round_number: 1, code_generation: 0, status: 'waiting_manual',
  });
  db.updateTaskWorkflow(taskId, { current_node_id: 'human_review', current_run_id: reviewRun });

  const staleDecision = await fetch(`${baseUrl}/api/tasks/${taskId}/human-review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', attempt_id: 'old-attempt' }),
  });
  assert.equal(staleDecision.status, 409);
  assert.equal((await staleDecision.json()).code, 'STALE_MANUAL_REVIEW');
  assert.equal(db.getHumanDecisions(taskId).length, 0);

  const decisionRes = await fetch(`${baseUrl}/api/tasks/${taskId}/workflow/manual-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'approve',
      attempt_id: reviewRun,
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

  // 8.5 Unmatched /api/* route returns structured JSON 404 instead of plain text
  const unmatchedApiRes = await fetch(`${baseUrl}/api/workflows/non-existent/unknown-action`, {
    method: 'DELETE',
  });
  assert.strictEqual(unmatchedApiRes.status, 404);
  assert(unmatchedApiRes.headers.get('content-type')?.includes('application/json'));
  const unmatchedApiData = await unmatchedApiRes.json();
  assert.strictEqual(unmatchedApiData.success, false);
  assert.strictEqual(unmatchedApiData.code, 'NOT_FOUND');
  console.log('  ✓ Unmatched /api/* routes return JSON 404');

  // 8.6 Malformed percent encoding returns 400 JSON instead of 500
  const malformedRes = await fetch(`${baseUrl}/api/workflows/%E0%A4%A`, {
    method: 'DELETE',
  });
  assert.strictEqual(malformedRes.status, 400);
  const malformedData = await malformedRes.json();
  assert.strictEqual(malformedData.success, false);
  assert.strictEqual(malformedData.code, 'INVALID_INPUT');
  console.log('  ✓ Malformed workflow ID encoding returns 400 INVALID_INPUT');

  // 9. Frontend api.js client integration & non-JSON 404 handling
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  try {
    (globalThis as any).window = { location: { origin: baseUrl } };
    const { api } = await import('../src/ui/js/api.js');

    // Create workflow with special characters (spaces + slash) and delete via api.deleteWorkflow
    const specialId = 'wf space/1';
    const createSpecialRes = await api.saveWorkflow({
      id: specialId,
      name: 'Special ID Workflow',
      nodes: validGraph,
    });
    assert.strictEqual(createSpecialRes.success, true);

    const delSpecialRes = await api.deleteWorkflow(specialId);
    assert.strictEqual(delSpecialRes.success, true);
    assert.strictEqual(db.getWorkflow(specialId), null);
    console.log('  ✓ api.deleteWorkflow deletes workflow with encoded ID characters');

    // Simulate stale backend returning plain-text 404 "Not Found"
    globalThis.fetch = async () =>
      new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    await assert.rejects(
      () => api.deleteWorkflow('good-wf'),
      (err: any) => {
        assert(err instanceof Error);
        assert(err.message.includes('HTTP 404'));
        assert(!err.message.includes('is not valid JSON'));
        return true;
      }
    );
    console.log('  ✓ api.js converts plain-text 404 Not Found into actionable HTTP 404 error');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }

  console.log('✅ workflowHttp.test.ts passed successfully!');
} finally {
  server.close();
}
