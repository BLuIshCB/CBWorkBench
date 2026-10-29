import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkbenchMcpServer } from '../src/server/mcpServer.ts';
import { TaskStatus } from '../src/config/constants.ts';

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

  assert.strictEqual(toolNames.length, 5);
  assert.ok(toolNames.includes('workbench_submit_task'));
  assert.ok(toolNames.includes('workbench_revise_task'));
  assert.ok(toolNames.includes('workbench_get_task_status'));
  assert.ok(toolNames.includes('workbench_get_task_artifacts'));
  assert.ok(toolNames.includes('workbench_delete_task'));

  // Strict Gate check: MCP MUST NOT have start or approve tools
  assert.strictEqual(toolNames.some((n) => n.includes('start') || n.includes('confirm')), false);
  assert.strictEqual(toolNames.some((n) => n.includes('approve') || n.includes('review')), false);

  // 2. Submit task via MCP
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
    },
  });

  assert.strictEqual(Boolean(submitRes.isError), false);
  const submitText = (submitRes.content as any)[0].text;
  const submitData = JSON.parse(submitText);
  assert.strictEqual(submitData.success, true);
  assert.strictEqual(submitData.status, TaskStatus.PENDING_CONFIRM);
  assert.strictEqual(submitData.revision, 1);
  const taskId = submitData.taskId;
  assert.ok(taskId);

  // 3. Query status via MCP
  const statusRes = await client.callTool({
    name: 'workbench_get_task_status',
    arguments: { task_id: taskId },
  });
  const statusData = JSON.parse((statusRes.content as any)[0].text);
  assert.strictEqual(statusData.taskId, taskId);
  assert.strictEqual(statusData.status, TaskStatus.PENDING_CONFIRM);

  // 4. Revise task via MCP
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

  // 5. Query artifacts via MCP
  const artifactsRes = await client.callTool({
    name: 'workbench_get_task_artifacts',
    arguments: { task_id: taskId },
  });
  const artifactsData = JSON.parse((artifactsRes.content as any)[0].text);
  assert.strictEqual(artifactsData.taskId, taskId);
  assert.strictEqual(artifactsData.revision, 2);
  assert.ok(artifactsData.diffSnapshot !== undefined);

  // 6. Delete task via MCP
  const deleteRes = await client.callTool({
    name: 'workbench_delete_task',
    arguments: { task_id: taskId },
  });
  const deleteData = JSON.parse((deleteRes.content as any)[0].text);
  assert.strictEqual(deleteData.success, true);
  assert.strictEqual(deleteData.taskId, taskId);

  console.log('✅ mcpServer.test.ts passed successfully!');
} finally {
  await client.close();
  await server.close();
}
