import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
    { id: 'step1', name: '步骤1', type: 'task', execution_mode: 'command', command: 'echo 1', on_success: 'end' },
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

  console.log('✅ workflowDb.test.ts passed successfully!');
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
