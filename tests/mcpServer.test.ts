import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkbenchMcpServer } from '../src/server/mcpServer.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { db } from '../src/storage/db.ts';

console.log('[Test] Running mcpServer.test.ts...');

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createWorkbenchMcpServer();
await server.connect(serverTransport);

const client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });
await client.connect(clientTransport);

try {
  // 1. List tools and verify gate constraints
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);

  assert.strictEqual(toolNames.length, 9);
  assert.ok(toolNames.includes('workbench_submit_task'));
  assert.ok(toolNames.includes('workbench_revise_task'));
  assert.ok(toolNames.includes('workbench_get_task_status'));
  assert.ok(toolNames.includes('workbench_get_task_artifacts'));
  assert.ok(toolNames.includes('workbench_delete_task'));
  assert.ok(toolNames.includes('workbench_list_workflows'));
  assert.ok(toolNames.includes('workbench_get_workflow'));
  assert.ok(toolNames.includes('workbench_delete_workflow'));
  assert.ok(toolNames.includes('workbench_advance_workflow'));

  // Strict Gate check: MCP MUST NOT have start or approve tools
  assert.strictEqual(toolNames.some((n) => n.includes('start') || n.includes('confirm')), false);
  assert.strictEqual(toolNames.some((n) => n.includes('approve') || n.includes('review')), false);

  // 2. Query workflows via MCP
  const listWfRes = await client.callTool({
    name: 'workbench_list_workflows',
    arguments: {},
  });
  const listWfData = JSON.parse((listWfRes.content as any)[0].text);
  assert.strictEqual(listWfData.success, true);
  assert(listWfData.workflows.length >= 1);
  assert.strictEqual(listWfData.workflows[0].id, 'default');
  assert.strictEqual('version' in listWfData.workflows[0], false);

  const getWfRes = await client.callTool({
    name: 'workbench_get_workflow',
    arguments: { workflow_id: 'default' },
  });
  const getWfData = JSON.parse((getWfRes.content as any)[0].text);
  assert.strictEqual(getWfData.success, true);
  assert.strictEqual(getWfData.workflow.id, 'default');
  assert.strictEqual('version' in getWfData.workflow, false);
  assert(Array.isArray(getWfData.workflow.nodes));
  assert.strictEqual(getWfData.workflow.nodes.length, 6);

  // 3. Submit task via MCP with workflow and node_prompts
  const submitRes = await client.callTool({
    name: 'workbench_submit_task',
    arguments: {
      task_key: 'mcp-test-task',
      title: 'MCP Unit Test Task',
      target_cwd: process.cwd(),
      manifest_json: JSON.stringify({ packageVersion: 1 }),
      task_md: '# MCP Task',
      development_md: '# MCP Dev',
      tests_md: '# MCP Tests',
      acceptance_md: '# MCP Acceptance',
      verifier_prompt_md: '# Verifier Prompt',
      worker_prompts: {
        'worker-dev': 'You are test worker',
      },
      workflow_id: 'default',
      node_prompts: {
        development: '实现专属需求提示词',
      },
    },
  });

  assert.strictEqual(Boolean(submitRes.isError), false);
  const submitText = (submitRes.content as any)[0].text;
  const submitData = JSON.parse(submitText);
  assert.strictEqual(submitData.success, true);
  assert.strictEqual(submitData.status, TaskStatus.PENDING_CONFIRM);
  assert.strictEqual(submitData.workflowId, 'default');
  assert.strictEqual('workflowVersion' in submitData, false);
  assert.strictEqual(submitData.revision, 1);
  const taskId = submitData.taskId;
  assert.ok(taskId);

  // 4. Query status via MCP (includes workflow state)
  const statusRes = await client.callTool({
    name: 'workbench_get_task_status',
    arguments: { task_id: taskId },
  });
  const statusData = JSON.parse((statusRes.content as any)[0].text);
  assert.strictEqual(statusData.taskId, taskId);
  assert.strictEqual(statusData.status, TaskStatus.PENDING_CONFIRM);
  assert.strictEqual(statusData.workflowId, 'default');
  assert.strictEqual('workflowVersion' in statusData, false);
  assert.strictEqual(statusData.currentNodeId, 'start');
  assert.strictEqual(statusData.currentNodeExecutionCount, 0);

  // 5. Test advance workflow report via MCP
  // Create an active node run for this task and set task to RUNNING
  db.updateTaskStatus(taskId, TaskStatus.RUNNING);
  const runRecord = db.createNodeRun({
    run_id: 'run-mcp-adv-1',
    task_id: taskId,
    node_id: 'development',
    execution_index: 1,
    status: 'running',
    completion_token: 'tok-mcp-999',
  });

  const advanceRes = await client.callTool({
    name: 'workbench_advance_workflow',
    arguments: {
      task_id: taskId,
      node_id: 'development',
      attempt_id: 'run-mcp-adv-1',
      completion_token: 'tok-mcp-999',
      request_id: 'req-adv-101',
      outcome: 'passed',
      summary: 'MCP Agent 开发完成并通过',
    },
  });
  const advanceData = JSON.parse((advanceRes.content as any)[0].text);
  assert.strictEqual(advanceData.success, true);
  assert.strictEqual(advanceData.requestId, 'req-adv-101');

  // Idempotent duplicate check
  const advanceDupRes = await client.callTool({
    name: 'workbench_advance_workflow',
    arguments: {
      task_id: taskId,
      node_id: 'development',
      attempt_id: 'run-mcp-adv-1',
      completion_token: 'tok-mcp-999',
      request_id: 'req-adv-101',
      outcome: 'passed',
      summary: 'MCP Agent 开发完成并通过',
    },
  });
  const advanceDupData = JSON.parse((advanceDupRes.content as any)[0].text);
  assert.strictEqual(advanceDupData.success, true);
  assert.strictEqual(advanceDupData.duplicate, true);

  // 6. Revise task via MCP
  const reviseRes = await client.callTool({
    name: 'workbench_revise_task',
    arguments: {
      task_id: taskId,
      manifest_json: JSON.stringify({ packageVersion: 2 }),
      task_md: '# Revised Task',
      development_md: '# Revised Dev',
      tests_md: '# Revised Tests',
      acceptance_md: '# Revised Acceptance',
      verifier_prompt_md: '# Revised Verifier Prompt',
      worker_prompts: {
        'worker-dev': 'Revised worker prompt',
      },
    },
  });
  const reviseData = JSON.parse((reviseRes.content as any)[0].text);
  assert.strictEqual(reviseData.success, true);
  assert.strictEqual(reviseData.revision, 2);

  // 7. Query artifacts via MCP
  const artifactsRes = await client.callTool({
    name: 'workbench_get_task_artifacts',
    arguments: { task_id: taskId },
  });
  const artifactsData = JSON.parse((artifactsRes.content as any)[0].text);
  assert.strictEqual(artifactsData.taskId, taskId);
  assert.strictEqual(artifactsData.revision, 2);
  assert.ok(artifactsData.diffSnapshot !== undefined);

  // 8. Delete task via MCP
  const deleteRes = await client.callTool({
    name: 'workbench_delete_task',
    arguments: { task_id: taskId },
  });
  const deleteData = JSON.parse((deleteRes.content as any)[0].text);
  assert.strictEqual(deleteData.success, true);
  assert.strictEqual(deleteData.taskId, taskId);

  // 9. Delete workflow via MCP
  // 9.1 Deleting default workflow fails
  const delDefRes = await client.callTool({
    name: 'workbench_delete_workflow',
    arguments: { workflow_id: 'default' },
  });
  assert.strictEqual(delDefRes.isError, true);
  assert((delDefRes.content as any)[0].text.includes('系统默认工作流禁止删除'));

  // 9.2 Deleting custom workflow succeeds
  db.saveWorkflowDefinition({
    id: 'mcp-test-wf',
    name: 'MCP测试工作流',
    nodes_json: JSON.stringify([
      { id: 'start', name: '开始', type: 'start', on_success: 'end' },
      { id: 'end', name: '结束', type: 'end' },
    ]),
  });
  assert.ok(db.getWorkflow('mcp-test-wf'));

  const delCustomRes = await client.callTool({
    name: 'workbench_delete_workflow',
    arguments: { workflow_id: 'mcp-test-wf' },
  });
  assert.strictEqual(delCustomRes.isError, undefined);
  const delCustomData = JSON.parse((delCustomRes.content as any)[0].text);
  assert.strictEqual(delCustomData.success, true);
  assert.strictEqual(db.getWorkflow('mcp-test-wf'), null);

  console.log('✅ mcpServer.test.ts passed successfully!');
} finally {
  await client.close();
  await server.close();
}
