import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchDatabase } from '../src/storage/db.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { DEFAULT_WORKFLOW_ID } from '../src/services/workflowDefinition.ts';

console.log('[Test] Running workflowDb.test.ts...');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-wb-wf-db-test-'));
const testDbPath = path.join(tmpDir, 'test_workbench.db');
const testDb = new WorkbenchDatabase(testDbPath);

try {
  // 1. Check default workflow definition seeded
  const defaultWf = testDb.getWorkflow(DEFAULT_WORKFLOW_ID);
  assert(defaultWf, 'Default workflow definition should exist');
  assert.strictEqual(defaultWf.id, 'default');
  assert.strictEqual('version' in defaultWf, false);
  const nodes = JSON.parse(defaultWf.nodes_json);
  assert(Array.isArray(nodes));
  assert.strictEqual(nodes.length, 6);
  console.log('  ✓ Default workflow definition seeded successfully');

  // 2. List workflows
  const workflows = testDb.listWorkflows();
  assert(workflows.length >= 1);
  assert.strictEqual(workflows[0].id, 'default');
  console.log('  ✓ listWorkflows returns default workflow');

  // 3. Save new workflow definition and direct modification (no V versions)
  const customNodes = [
    { id: 'start', name: '开始', type: 'start', on_success: 'step1' },
    { id: 'step1', name: '步骤1', type: 'task', execution_mode: 'agent', executor: 'codex', model: 'legacy-model', prompt: '执行步骤1', on_success: 'end' },
    { id: 'end', name: '结束', type: 'end' },
  ];
  const createdWf = testDb.saveWorkflowDefinition({
    id: 'custom_wf',
    name: '自定义流程',
    nodes_json: JSON.stringify(customNodes),
  });
  assert.strictEqual(createdWf.id, 'custom_wf');
  assert.strictEqual(createdWf.name, '自定义流程');

  // Saving again modifies in-place directly without creating new V versions
  const updatedWf = testDb.saveWorkflowDefinition({
    id: 'custom_wf',
    name: '自定义流程修改版',
    nodes_json: JSON.stringify(customNodes),
  });
  assert.strictEqual(updatedWf.id, 'custom_wf');
  assert.strictEqual(updatedWf.name, '自定义流程修改版');
  const fetchedWf = testDb.getWorkflow('custom_wf');
  assert.strictEqual(fetchedWf?.name, '自定义流程修改版');
  const readLegacyNodes = JSON.parse(fetchedWf!.nodes_json);
  assert.equal(readLegacyNodes[1].description, '执行步骤1');
  assert.equal(readLegacyNodes[1].prompt, undefined);
  assert.equal(readLegacyNodes[1].executor, undefined);
  assert.equal(readLegacyNodes[1].model, undefined);
  assert.ok(readLegacyNodes[0].description && readLegacyNodes[2].description);
  console.log('  ✓ Workflow definition modified directly in place (no V versions)');

  // 3.1 If workflow is referenced by a task, modification is strictly prohibited
  const refTask = testDb.createTask({
    id: 'task-locking-wf',
    task_key: 'lock-key',
    title: '引用工作流的任务',
    target_cwd: tmpDir,
  });
  testDb.initTaskWorkflow('task-locking-wf', { workflowId: 'custom_wf' });
  assert.strictEqual(testDb.isWorkflowReferenced('custom_wf'), true);

  assert.throws(() => {
    testDb.saveWorkflowDefinition({
      id: 'custom_wf',
      name: '非法修改测试',
      nodes_json: JSON.stringify(customNodes),
    });
  }, /正被任务引用/);
  console.log('  ✓ Modifying workflow referenced by a task is strictly rejected');

  // Clean up referencing task to allow subsequent modifications
  testDb.deleteTask('task-locking-wf');
  assert.strictEqual(testDb.isWorkflowReferenced('custom_wf'), false);

  const allowedAfterDelete = testDb.saveWorkflowDefinition({
    id: 'custom_wf',
    name: '任务清理后允许修改',
    nodes_json: JSON.stringify(customNodes),
  });
  assert.strictEqual(allowedAfterDelete.name, '任务清理后允许修改');
  console.log('  ✓ Workflow can be modified again once referencing tasks are removed');

  // 4. Task workflow creation & initialization
  const task = testDb.createTask({
    id: 'task-wf-1',
    task_key: 'test-key',
    title: '工作流测试任务',
    target_cwd: tmpDir,
  });
  assert.strictEqual(task.id, 'task-wf-1');

  const taskWf = testDb.getTaskWorkflow('task-wf-1');
  assert(taskWf, 'Task workflow should be initialized automatically');
  assert.strictEqual(taskWf.current_node_id, 'start');
  assert.strictEqual(taskWf.code_generation, 0);
  assert.strictEqual('workflow_version' in taskWf, false);
  console.log('  ✓ Task workflow initialized on task creation');

  // 5. Updating task workflow state
  testDb.updateTaskWorkflow('task-wf-1', {
    current_node_id: 'development',
    code_generation: 1,
  });
  const updatedTaskWf = testDb.getTaskWorkflow('task-wf-1');
  assert.strictEqual(updatedTaskWf?.current_node_id, 'development');
  assert.strictEqual(updatedTaskWf?.code_generation, 1);
  console.log('  ✓ Task workflow updates persist accurately');

  // 6. Node runs creation and limits counting
  const run1 = testDb.createNodeRun({
    run_id: 'run-dev-1',
    task_id: 'task-wf-1',
    node_id: 'development',
    execution_index: 1,
    status: 'running',
    completion_token: 'token-abc-123',
  });
  assert.strictEqual(run1.run_id, 'run-dev-1');
  assert.strictEqual(run1.execution_index, 1);
  assert.strictEqual(run1.completion_token, 'token-abc-123');

  const countAfter1 = testDb.getNodeRunCount('task-wf-1', 'development');
  assert.strictEqual(countAfter1, 1);

  // By token lookup
  const foundByToken = testDb.getNodeRunByToken('task-wf-1', 'token-abc-123');
  assert.strictEqual(foundByToken?.run_id, 'run-dev-1');

  // 7. MCP advance report registration and idempotency
  // First set task to running so report is accepted
  testDb.updateTaskStatus('task-wf-1', TaskStatus.RUNNING);
  testDb.updateTaskWorkflow('task-wf-1', { current_run_id: run1.run_id });

  const report1 = testDb.registerAdvanceReport(
    'task-wf-1',
    'development',
    'run-dev-1',
    'token-abc-123',
    'req-001',
    'passed',
    '开发完成并通过初审'
  );
  assert.strictEqual(report1.success, true);
  assert.strictEqual(report1.duplicate, undefined);

  // Duplicate call with same request_id is idempotent
  const reportDup = testDb.registerAdvanceReport(
    'task-wf-1',
    'development',
    'run-dev-1',
    'token-abc-123',
    'req-001',
    'passed',
    '开发完成并通过初审'
  );
  assert.strictEqual(reportDup.success, true);
  assert.strictEqual(reportDup.duplicate, true);

  // Second different request_id for the same run is rejected
  const reportConflict = testDb.registerAdvanceReport(
    'task-wf-1',
    'development',
    'run-dev-1',
    'token-abc-123',
    'req-002',
    'passed',
    '另一个请求'
  );
  assert.strictEqual(reportConflict.success, false);
  console.log('  ✓ MCP advance report registration and idempotency verified');

  // Complete node run
  testDb.updateNodeRun('run-dev-1', {
    status: 'passed',
    finished_at: Date.now(),
  });
  const finishedRun1 = testDb.getNodeRunByRunId('run-dev-1');
  assert.strictEqual(finishedRun1?.status, 'passed');

  // 8. Unique constraint on (task_id, node_id, execution_index)
  assert.throws(() => {
    testDb.createNodeRun({
      run_id: 'run-dev-dup',
      task_id: 'task-wf-1',
      node_id: 'development',
      execution_index: 1, // duplicate index
    });
  }, /UNIQUE constraint/);
  console.log('  ✓ Unique constraint on execution_index prevents concurrent duplicate counting');

  // 9. Deleting task removes task workflow and node runs
  testDb.deleteTask('task-wf-1');
  assert.strictEqual(testDb.getTaskWorkflow('task-wf-1'), null);
  assert.strictEqual(testDb.getNodeRuns('task-wf-1').length, 0);
  console.log('  ✓ deleteTask cascades cleanly to workflow tables');

  // 10. Deleting workflow definitions
  // 10.1 Default workflow cannot be deleted
  assert.throws(() => {
    testDb.deleteWorkflow(DEFAULT_WORKFLOW_ID);
  }, /默认工作流禁止删除/);
  console.log('  ✓ Deleting default workflow is strictly prohibited');

  // 10.2 Workflow referenced by a task cannot be deleted
  testDb.createTask({
    id: 'task-ref-del',
    task_key: 'del-key',
    title: '删除引用测试任务',
    target_cwd: tmpDir,
  });
  testDb.initTaskWorkflow('task-ref-del', { workflowId: 'custom_wf' });
  assert.throws(() => {
    testDb.deleteWorkflow('custom_wf');
  }, /正被任务引用/);
  console.log('  ✓ Deleting workflow referenced by a task is strictly prohibited');

  // 10.3 After deleting the referencing task, workflow deletion succeeds
  testDb.deleteTask('task-ref-del');
  const deleteResult = testDb.deleteWorkflow('custom_wf');
  assert.strictEqual(deleteResult, true);
  assert.strictEqual(testDb.getWorkflow('custom_wf'), null);
  assert(!testDb.listWorkflows().some((w) => w.id === 'custom_wf'));
  console.log('  ✓ Unreferenced workflow can be deleted cleanly');

  // 10.4 Deleting non-existent workflow returns false
  assert.strictEqual(testDb.deleteWorkflow('non_existent_wf'), false);
  console.log('  ✓ Deleting non-existent workflow returns false');

  const legacyPath = path.join(tmpDir, 'legacy.db');
  const legacySeed = new WorkbenchDatabase(legacyPath);
  legacySeed.createTask({ id: 'old-task', task_key: 'legacy', title: '旧任务', target_cwd: tmpDir, revision: 2 });
  legacySeed.saveRevision({
    task_id: 'old-task', revision: 2, manifest_json: '{}', manifest_sha256: 'manifest',
    package_digest: 'package', workflow_id: 'old-flow', workflow_sha256: 'saved-workflow-hash',
  });
  const oldDb = new DatabaseSync(legacyPath);
  oldDb.exec(`
    DROP TABLE workflow_definitions;
    DROP TABLE task_workflows;
    DROP TABLE workflow_node_runs;
    CREATE TABLE workflow_definitions (
      id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, description TEXT,
      nodes_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, version)
    );
    CREATE TABLE task_workflows (
      task_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
      nodes_json TEXT NOT NULL, current_node_id TEXT NOT NULL, current_run_id TEXT,
      code_generation INTEGER NOT NULL DEFAULT 0, tests_passed_generation INTEGER NOT NULL DEFAULT 0,
      acceptance_passed_generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workflow_node_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
      node_id TEXT NOT NULL, execution_index INTEGER NOT NULL, status TEXT NOT NULL, result_summary TEXT,
      completion_token TEXT, request_id TEXT, execution_run_id TEXT, created_at INTEGER NOT NULL,
      finished_at INTEGER, UNIQUE (task_id, node_id, execution_index)
    );
    INSERT INTO workflow_definitions VALUES ('old-flow', 1, '第一版', NULL, '[]', 1, 1, 0);
    INSERT INTO workflow_definitions VALUES ('old-flow', 2, '第二版', NULL, '[]', 2, 2, 0);
    INSERT INTO workflow_definitions VALUES ('editable-flow', 1, '保留的旧版', NULL, '[]', 1, 1, 0);
    INSERT INTO workflow_definitions VALUES ('editable-flow', 2, '可编辑新版', NULL, '[]', 2, 2, 0);
  `);
  oldDb.prepare(`INSERT INTO task_workflows (task_id, workflow_id, workflow_version, nodes_json, current_node_id,
    current_run_id, code_generation, updated_at) VALUES ('old-task', 'old-flow', 2, ?, 'step1', 'old-run', 3, 3)`)
    .run(JSON.stringify(customNodes));
  oldDb.prepare(`INSERT INTO workflow_node_runs (run_id, task_id, node_id, execution_index, status, result_summary,
    created_at) VALUES ('old-run', 'old-task', 'step1', 1, 'passed', '旧记录', ?)`)
    .run(legacySeed.getRevision('old-task', 2)!.created_at + 1);
  oldDb.close();

  const upgraded = new WorkbenchDatabase(legacyPath);
  assert.equal(upgraded.listTasks()[0].workflow_sha256, 'saved-workflow-hash');
  assert.equal(upgraded.getTask('old-task')?.current_node_id, 'step1');
  assert.equal(upgraded.getTaskWorkflow('old-task')?.revision, 2);
  assert.equal(upgraded.getTaskWorkflow('old-task')?.code_generation, 3);
  assert.equal(upgraded.getNodeRuns('old-task', 'step1', 2)[0].result_summary, '旧记录');
  assert.equal(upgraded.getNodeRunByRunId('old-run')?.attempt_dir, null);
  assert.equal(upgraded.getWorkflow('old-flow')?.name, '第二版');
  assert.equal(upgraded.listWorkflows().filter((workflow) => workflow.id === 'old-flow').length, 1);
  assert.equal('version' in upgraded.getWorkflow('old-flow')!, false);
  upgraded.saveWorkflowDefinition({ id: 'editable-flow', name: '改名后的新版', nodes_json: '[]' });
  const history = new DatabaseSync(legacyPath, { readOnly: true });
  assert.deepEqual(history.prepare('SELECT name FROM workflow_definitions WHERE id = ? ORDER BY version')
    .all('editable-flow').map(({ name }) => name), ['保留的旧版', '改名后的新版']);
  history.close();
  upgraded.createTask({ id: 'new-task', task_key: 'new', title: '新任务', target_cwd: tmpDir });
  assert.equal(upgraded.getTaskWorkflow('new-task')?.current_node_id, 'start');
  upgraded.createNodeRun({ run_id: 'new-run', task_id: 'new-task', node_id: 'development', execution_index: 1 });
  assert.equal(upgraded.getNodeRunByRunId('new-run')?.revision, 1);
  const reopened = new WorkbenchDatabase(legacyPath);
  assert.equal(reopened.getTaskWorkflow('old-task')?.code_generation, 3);
  assert.equal(reopened.getTask('old-task')?.workflow_sha256, 'saved-workflow-hash');
  console.log('  ✓ Legacy workflow databases are upgraded without losing tasks, progress or run history');

  console.log('✅ workflowDb.test.ts passed successfully!');
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
