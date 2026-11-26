import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkbenchMcpServer } from '../src/server/mcpServer.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { db } from '../src/storage/db.ts';
import { taskFileStore } from '../src/storage/fileStore.ts';

console.log('[Test] Running mcpServer.test.ts...');

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createWorkbenchMcpServer();
await server.connect(serverTransport);

const client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });
await client.connect(clientTransport);

function buildLocalPackage(opts: {
  dir: string;
  taskKey: string;
  revision: number;
  title: string;
  workflowId: string;
  nodes: any[];
  sharedText?: string;
}) {
  fs.mkdirSync(opts.dir, { recursive: true });
  fs.writeFileSync(
    path.join(opts.dir, 'requirements.md'),
    opts.sharedText || '# Shared Requirements\nREQ-001\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(opts.dir, 'development.md'),
    '# Development Guidelines\n',
    'utf8'
  );

  for (const n of opts.nodes) {
    if (n.type !== 'task') continue;
    const nodeDir = path.join(opts.dir, 'nodes', n.id);
    const nodeResDir = path.join(nodeDir, 'resources');
    fs.mkdirSync(nodeResDir, { recursive: true });

    fs.writeFileSync(
      path.join(nodeDir, `${n.id}.md`),
      `# Work for ${n.id} (rev ${opts.revision})\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(nodeDir, 'prompt.md'),
      `Prompt for ${n.id} (rev ${opts.revision})\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(nodeResDir, 'notes.md'),
      `Private resource for ${n.id}\n`,
      'utf8'
    );
  }

  const manifest = {
    title: opts.title,
    workflow_id: opts.workflowId,
    target_cwd: process.cwd(),
    task_key: opts.taskKey,
  };
  fs.writeFileSync(path.join(opts.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

const tmpPkgRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mcp-pkg1-'));
const tmpPkgRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mcp-pkg2-'));

try {
  // 1. List tools and verify gate + cleanup constraints
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);

  assert.strictEqual(toolNames.length, 11);
  assert.ok(toolNames.includes('workbench_get_package_protocol'));
  assert.ok(toolNames.includes('workbench_list_workflows'));
  assert.ok(toolNames.includes('workbench_get_workflow'));
  assert.ok(toolNames.includes('workbench_delete_workflow'));
  assert.ok(toolNames.includes('workbench_submit_task'));
  assert.ok(toolNames.includes('workbench_get_package'));
  assert.ok(toolNames.includes('workbench_get_node_context'));
  assert.ok(toolNames.includes('workbench_get_task_status'));
  assert.ok(toolNames.includes('workbench_get_task_artifacts'));
  assert.ok(toolNames.includes('workbench_delete_task'));
  assert.ok(toolNames.includes('workbench_advance_workflow'));

  // Deprecated tools MUST be gone
  assert.strictEqual(toolNames.includes('workbench_stage_package'), false);
  assert.strictEqual(toolNames.includes('workbench_finalize_package'), false);
  assert.strictEqual(toolNames.includes('workbench_revise_task'), false);
  assert.strictEqual(toolNames.includes('workbench_upload_package_resource'), false);

  // Strict Gate check: MCP MUST NOT have start, confirm, approve, or review tools
  assert.strictEqual(toolNames.some((n) => n.includes('start') || n.includes('confirm')), false);
  assert.strictEqual(toolNames.some((n) => n.includes('approve') || n.includes('review')), false);

  // 2. Query protocol capabilities
  const protoRes = await client.callTool({ name: 'workbench_get_package_protocol', arguments: {} });
  const protoData = JSON.parse((protoRes.content as any)[0].text);
  assert.strictEqual(protoData.ok, true);
  assert.strictEqual(protoData.protocol_version, 'cb.task-package/2.0');
  assert.deepStrictEqual(protoData.supported_source_modes, ['local_path']);
  assert.ok(protoData.instance.instance_id);
  assert.ok(path.isAbsolute(protoData.instance.data_dir));

  // 3. Query workflows via MCP
  const listWfRes = await client.callTool({ name: 'workbench_list_workflows', arguments: {} });
  const listWfData = JSON.parse((listWfRes.content as any)[0].text);
  assert.strictEqual(listWfData.success, true);
  assert.strictEqual(listWfData.workflows[0].id, 'default');
  assert.strictEqual('version' in listWfData.workflows[0], false);
  assert.ok(listWfData.workflows[0].definition_sha256);

  const getWfRes = await client.callTool({
    name: 'workbench_get_workflow',
    arguments: { workflow_id: 'default' },
  });
  const getWfData = JSON.parse((getWfRes.content as any)[0].text);
  assert.strictEqual(getWfData.success, true);
  assert.strictEqual(getWfData.workflow.id, 'default');
  assert.strictEqual('version' in getWfData.workflow, false);
  assert.ok(getWfData.workflow.definition_sha256);
  const devNode = getWfData.workflow.nodes.find((n: any) => n.id === 'development');
  assert.ok(devNode.material_contract);
  assert.strictEqual(devNode.material_contract.node_dir, 'nodes/development');
  assert.ok(devNode.name && devNode.description);
  assert.equal(devNode.material_contract.purpose, devNode.description);
  assert.equal(devNode.executor, undefined);
  assert.equal(devNode.model, undefined);
  assert.equal(devNode.prompt, undefined);
  assert.equal(listWfData.workflows[0].definition_sha256, getWfData.workflow.definition_sha256);

  // 4. Submit minimal package via workbench_submit_task
  buildLocalPackage({
    dir: tmpPkgRoot1,
    taskKey: 'mcp-test-task',
    revision: 1,
    title: 'MCP Unit Test Task MVP',
    workflowId: 'default',
    nodes: getWfData.workflow.nodes,
  });

  const submitRes = await client.callTool({
    name: 'workbench_submit_task',
    arguments: {
      package_root: tmpPkgRoot1,
    },
  });
  assert.strictEqual(Boolean(submitRes.isError), false);
  const submitData = JSON.parse((submitRes.content as any)[0].text);
  assert.strictEqual(submitData.ok, true);
  assert.strictEqual(submitData.revision, 1);
  assert.strictEqual(submitData.status, TaskStatus.PENDING_CONFIRM);
  const taskId = submitData.task_id;
  assert.ok(taskId);
  assert.ok(submitData.web_url);

  const storedTask = db.getTask(taskId);
  assert.ok(storedTask);
  assert.strictEqual(storedTask.status, TaskStatus.PENDING_CONFIRM);

  // Delete original source dir -> package in workbench remains readable!
  fs.rmSync(tmpPkgRoot1, { recursive: true, force: true });

  const getPkgRes = await client.callTool({
    name: 'workbench_get_package',
    arguments: {
      task_id: taskId,
      resource_path: 'nodes/development/development.md',
    },
  });
  const getPkgData = JSON.parse((getPkgRes.content as any)[0].text);
  assert.strictEqual(getPkgData.ok, true);
  assert.ok(getPkgData.resource.content.includes('Work for development'));

  // 5. Query task status via MCP
  const statusRes = await client.callTool({
    name: 'workbench_get_task_status',
    arguments: { task_id: taskId },
  });
  const statusData = JSON.parse((statusRes.content as any)[0].text);
  assert.strictEqual(statusData.taskId, taskId);
  assert.strictEqual(statusData.status, TaskStatus.PENDING_CONFIRM);

  // 6. Test isolated attempt view + workflow advancement
  db.updateTaskStatus(taskId, TaskStatus.RUNNING);
  const mockToken = crypto.randomBytes(16).toString('hex');
  const mockAttempt = 'attempt-mcp-1';
  taskFileStore.materializeNodeRunDirectory({
    taskId,
    revision: 1,
    packageDigest: 'digest-fixture',
    workflowId: 'default',
    workflowSha256: getWfData.workflow.definition_sha256,
    nodeId: 'development',
    nodeName: '开发实现',
    executionMode: 'agent',
    attemptId: mockAttempt,
    executionIndex: 1,
    codeGeneration: 1,
    targetCwd: process.cwd(),
    completionToken: mockToken,
  });

  const runDir = taskFileStore.getNodeRunDir(taskId, 1, 'development', mockAttempt);
  db.createNodeRun({
    run_id: mockAttempt,
    task_id: taskId,
    revision: 1,
    node_id: 'development',
    execution_index: 1,
    round_number: 1,
    code_generation: 1,
    status: 'running',
    completion_token: mockToken,
    attempt_dir: runDir,
  });

  // Query node context via MCP
  const ctxRes = await client.callTool({
    name: 'workbench_get_node_context',
    arguments: {
      task_id: taskId,
      node_id: 'development',
      attempt_id: mockAttempt,
      completion_token: mockToken,
      resource_path: 'material/development.md',
    },
  });
  const ctxData = JSON.parse((ctxRes.content as any)[0].text);
  assert.strictEqual(ctxData.ok, true);
  assert.ok(ctxData.resource.content.includes('Work for development'));

  // Simulate worker creating outputs and calling advance
  db.updateTaskWorkflow(taskId, { current_node_id: 'development', current_run_id: mockAttempt });
  const outPath = path.join(runDir, 'outputs');
  fs.writeFileSync(path.join(outPath, 'dev_notes.md'), 'Dev done', 'utf8');

  const advanceRes = await client.callTool({
    name: 'workbench_advance_workflow',
    arguments: {
      task_id: taskId,
      node_id: 'development',
      attempt_id: mockAttempt,
      completion_token: mockToken,
      request_id: `complete-${mockAttempt}`,
      outcome: 'passed',
      summary: 'MCP Agent 开发完成并通过',
    },
  });
  const advanceData = JSON.parse((advanceRes.content as any)[0].text);
  assert.strictEqual(advanceData.success, true);
  const completionExe = process.env.CB_COMPLETION_TEST_EXE;
  const completed = await promisify(execFile)(completionExe || process.execPath, [
    ...(completionExe ? [] : [path.resolve('bin/cb-workbench.js')]),
    'complete-node', '--context', path.join(runDir, 'context.json'),
    '--outcome', 'passed', '--summary', 'MCP Agent 开发完成并通过',
  ], { timeout: 30000, windowsHide: true });
  assert.match(completed.stdout, /MCP 已受理节点结果/);
  assert.equal(db.getTaskWorkflow(taskId)?.current_node_id, 'development');
  const conflict = await client.callTool({
    name: 'workbench_advance_workflow',
    arguments: {
      task_id: taskId, node_id: 'development', attempt_id: mockAttempt,
      completion_token: 'invalid-token', request_id: `complete-${mockAttempt}`,
      outcome: 'passed', summary: 'MCP Agent 开发完成并通过',
    },
  });
  assert.equal(conflict.isError, true);

  // Stop task before revising (running task cannot be revised)
  db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
  const previousNodes = JSON.parse(db.getTaskWorkflow(taskId)!.nodes_json);
  const previousDevelopment = previousNodes.find((node: any) => node.id === 'development');
  previousDevelopment.executor = 'codex';
  previousDevelopment.model = 'task-selected-model';
  db.updateTaskWorkflow(taskId, { nodes_json: JSON.stringify(previousNodes) });

  buildLocalPackage({
    dir: tmpPkgRoot2,
    taskKey: 'mcp-test-task',
    revision: 2,
    title: 'MCP Unit Test Task MVP Revised',
    workflowId: 'default',
    nodes: getWfData.workflow.nodes,
  });

  const submitRev2 = await client.callTool({
    name: 'workbench_submit_task',
    arguments: {
      package_root: tmpPkgRoot2,
      task_id: taskId,
    },
  });
  const submitRev2Data = JSON.parse((submitRev2.content as any)[0].text);
  assert.strictEqual(submitRev2Data.ok, true);
  assert.strictEqual(submitRev2Data.revision, 2);
  assert.strictEqual(submitRev2Data.status, TaskStatus.PENDING_CONFIRM);
  const revisedDevelop = JSON.parse(db.getTaskWorkflow(taskId)!.nodes_json).find((node: any) => node.id === 'development');
  assert.equal(revisedDevelop.executor, 'codex');
  assert.equal(revisedDevelop.model, 'task-selected-model');
  assert.equal(revisedDevelop.prompt, undefined);

  // 7. Query artifacts via MCP
  const artifactsRes = await client.callTool({
    name: 'workbench_get_task_artifacts',
    arguments: { task_id: taskId },
  });
  const artifactsData = JSON.parse((artifactsRes.content as any)[0].text);
  assert.strictEqual(artifactsData.taskId, taskId);
  assert.strictEqual(artifactsData.revision, 2);

  // 8. Delete task via MCP
  const deleteRes = await client.callTool({
    name: 'workbench_delete_task',
    arguments: { task_id: taskId },
  });
  const deleteData = JSON.parse((deleteRes.content as any)[0].text);
  assert.strictEqual(deleteData.success, true);
  assert.strictEqual(db.getTask(taskId), null);

  // 9. Delete workflow via MCP
  const delDefRes = await client.callTool({
    name: 'workbench_delete_workflow',
    arguments: { workflow_id: 'default' },
  });
  const delDefParsed = JSON.parse((delDefRes.content as any)[0].text);
  assert.strictEqual(delDefParsed.error?.code || delDefParsed.code, 'FORBIDDEN_DELETE_DEFAULT');

  const customWfId = 'mcp-test-wf';
  db.saveWorkflowDefinition({ id: customWfId, name: 'Custom MCP WF', nodes_json: JSON.stringify(getWfData.workflow.nodes) });
  const delCustRes = await client.callTool({
    name: 'workbench_delete_workflow',
    arguments: { workflow_id: customWfId },
  });
  assert.strictEqual(JSON.parse((delCustRes.content as any)[0].text).success, true);
  assert.strictEqual(db.getWorkflow(customWfId), null);
} finally {
  await client.close();
  await server.close();
  fs.rmSync(tmpPkgRoot1, { recursive: true, force: true });
  fs.rmSync(tmpPkgRoot2, { recursive: true, force: true });
}
