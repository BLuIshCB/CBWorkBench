import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

function sha256Buf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildLocalPackage(opts: {
  dir: string;
  taskKey: string;
  revision: number;
  title: string;
  workflowId: string;
  workflowSha: string;
  nodes: any[];
  sharedText?: string;
}) {
  const files: any[] = [];
  const manifestNodes: any[] = [];

  const sharedPath = 'shared/resources/requirements.md';
  fs.mkdirSync(path.join(opts.dir, 'shared', 'resources'), { recursive: true });
  const sharedBuf = Buffer.from(opts.sharedText || '# Shared Requirements\nREQ-001\n', 'utf8');
  fs.writeFileSync(path.join(opts.dir, sharedPath), sharedBuf);
  files.push({
    path: sharedPath,
    owner: { scope: 'shared' },
    media_type: 'text/markdown',
    size_bytes: sharedBuf.length,
    sha256: sha256Buf(sharedBuf),
  });

  for (const n of opts.nodes) {
    if (n.type !== 'task') continue;
    const nodeDir = n.dir_name || n.id;
    const nodeRef = `nodes/${nodeDir}/node.md`;
    const promptRef = `nodes/${nodeDir}/prompt.md`;
    const resRef = `nodes/${nodeDir}/resources/notes.md`;
    fs.mkdirSync(path.join(opts.dir, 'nodes', nodeDir, 'resources'), { recursive: true });

    const nodeBuf = Buffer.from(`# Node ${n.id} (rev ${opts.revision})\n`, 'utf8');
    const promptBuf = Buffer.from(`Prompt for ${n.id} (rev ${opts.revision})\n`, 'utf8');
    const resBuf = Buffer.from(`Private resource for ${n.id}\n`, 'utf8');

    fs.writeFileSync(path.join(opts.dir, nodeRef), nodeBuf);
    fs.writeFileSync(path.join(opts.dir, promptRef), promptBuf);
    fs.writeFileSync(path.join(opts.dir, resRef), resBuf);

    files.push(
      { path: nodeRef, owner: { scope: 'node', node_id: n.id }, media_type: 'text/markdown', size_bytes: nodeBuf.length, sha256: sha256Buf(nodeBuf) },
      { path: promptRef, owner: { scope: 'node', node_id: n.id }, media_type: 'text/markdown', size_bytes: promptBuf.length, sha256: sha256Buf(promptBuf) },
      { path: resRef, owner: { scope: 'node', node_id: n.id }, media_type: 'text/markdown', size_bytes: resBuf.length, sha256: sha256Buf(resBuf) }
    );

    manifestNodes.push({
      node_id: n.id,
      node_ref: nodeRef,
      prompt_ref: promptRef,
      resources: [{ id: 'notes', path: resRef, description: '节点附属说明' }],
      shared_refs: [sharedPath],
      input_bindings: [],
      output_contract: { required_outputs: ['result'], optional_outputs: [] },
    });
  }

  const manifest = {
    protocol_version: 'cb.task-package/2.0',
    task_key: opts.taskKey,
    revision: opts.revision,
    title: opts.title,
    target_cwd: process.cwd(),
    workflow: { id: opts.workflowId, definition_sha256: opts.workflowSha },
    readiness: 'ready',
    blockers: [],
    nodes: manifestNodes,
    files,
  };
  const mBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(opts.dir, 'manifest.json'), mBuf);
  return { manifest, manifestSha: sha256Buf(mBuf) };
}

const tmpPkgRoot1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mcp-pkg1-'));
const tmpPkgRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mcp-pkg2-'));

try {
  // 1. List tools and verify gate + cleanup constraints
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);

  assert.strictEqual(toolNames.length, 12);
  assert.ok(toolNames.includes('workbench_get_package_protocol'));
  assert.ok(toolNames.includes('workbench_list_workflows'));
  assert.ok(toolNames.includes('workbench_get_workflow'));
  assert.ok(toolNames.includes('workbench_delete_workflow'));
  assert.ok(toolNames.includes('workbench_stage_package'));
  assert.ok(toolNames.includes('workbench_finalize_package'));
  assert.ok(toolNames.includes('workbench_get_package'));
  assert.ok(toolNames.includes('workbench_get_node_context'));
  assert.ok(toolNames.includes('workbench_get_task_status'));
  assert.ok(toolNames.includes('workbench_get_task_artifacts'));
  assert.ok(toolNames.includes('workbench_delete_task'));
  assert.ok(toolNames.includes('workbench_advance_workflow'));

  // Deprecated tools MUST be gone
  assert.strictEqual(toolNames.includes('workbench_submit_task'), false);
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

  // 3. Query workflows via MCP (no version field, has definition_sha256 & material_contract)
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

  // 4. Stage + Validate + Finalize local_path package
  const built1 = buildLocalPackage({
    dir: tmpPkgRoot1,
    taskKey: 'mcp-test-task',
    revision: 1,
    title: 'MCP Unit Test Task v2',
    workflowId: 'default',
    workflowSha: getWfData.workflow.definition_sha256,
    nodes: getWfData.workflow.nodes,
  });

  const stageRes = await client.callTool({
    name: 'workbench_stage_package',
    arguments: {
      protocol_version: 'cb.task-package/2.0',
      operation: 'create',
      idempotency_key: `mcp-stage-1:${built1.manifestSha}`,
      source: {
        mode: 'local_path',
        package_root: tmpPkgRoot1,
        manifest_path: 'manifest.json',
        manifest_sha256: built1.manifestSha,
      },
    },
  });
  assert.strictEqual(Boolean(stageRes.isError), false);
  const stageData = JSON.parse((stageRes.content as any)[0].text);
  assert.strictEqual(stageData.ok, true);
  assert.strictEqual(stageData.status, 'staging');
  const draftId1 = stageData.draft_id;
  const taskId = stageData.task_id;
  assert.strictEqual(db.getTask(taskId), null, 'Staging must not create a startable task row');

  // Validate only
  const valOnlyRes = await client.callTool({
    name: 'workbench_finalize_package',
    arguments: {
      draft_id: draftId1,
      manifest_sha256: built1.manifestSha,
      idempotency_key: `mcp-fin-1:${built1.manifestSha}`,
      validate_only: true,
    },
  });
  const valOnlyData = JSON.parse((valOnlyRes.content as any)[0].text);
  assert.strictEqual(valOnlyData.ok, true);
  assert.strictEqual(valOnlyData.validate_only, true);
  assert.strictEqual(db.getTask(taskId), null, 'validate_only must have no side effects');

  // Finalize
  const finRes = await client.callTool({
    name: 'workbench_finalize_package',
    arguments: {
      draft_id: draftId1,
      manifest_sha256: built1.manifestSha,
      idempotency_key: `mcp-fin-1:${built1.manifestSha}`,
    },
  });
  assert.strictEqual(Boolean(finRes.isError), false);
  const finData = JSON.parse((finRes.content as any)[0].text);
  assert.strictEqual(finData.ok, true);
  assert.strictEqual(finData.task_id, taskId);
  assert.strictEqual(finData.revision, 1);
  assert.strictEqual(finData.status, TaskStatus.PENDING_CONFIRM);
  assert.strictEqual(finData.package_digest, built1.manifestSha);

  // Delete original source dir -> package in workbench remains readable!
  fs.rmSync(tmpPkgRoot1, { recursive: true, force: true });

  const getPkgRes = await client.callTool({
    name: 'workbench_get_package',
    arguments: {
      task_id: taskId,
      resource_path: 'nodes/development/resources/notes.md',
    },
  });
  const getPkgData = JSON.parse((getPkgRes.content as any)[0].text);
  assert.strictEqual(getPkgData.ok, true);
  assert.ok(getPkgData.resource.content.includes('Private resource for development'));

  // 5. Query status via MCP
  const statusRes = await client.callTool({
    name: 'workbench_get_task_status',
    arguments: { task_id: taskId },
  });
  const statusData = JSON.parse((statusRes.content as any)[0].text);
  assert.strictEqual(statusData.taskId, taskId);
  assert.strictEqual(statusData.status, TaskStatus.PENDING_CONFIRM);
  assert.strictEqual(statusData.packageDigest, built1.manifestSha);

  // 6. Test node context isolation & advance_workflow
  const mat = taskFileStore.materializeNodeRunDirectory({
    taskId,
    revision: 1,
    packageDigest: built1.manifestSha,
    workflowId: 'default',
    workflowSha256: getWfData.workflow.definition_sha256,
    nodeId: 'development',
    nodeName: '开发实现',
    executionMode: 'agent',
    attemptId: 'run-mcp-adv-1',
    executionIndex: 1,
    codeGeneration: 1,
    targetCwd: process.cwd(),
    manifestNode: built1.manifest.nodes.find((n: any) => n.node_id === 'development'),
    boundInputs: [],
    completionToken: 'tok-mcp-999',
  });

  db.updateTaskStatus(taskId, TaskStatus.RUNNING);
  db.createNodeRun({
    run_id: 'run-mcp-adv-1',
    task_id: taskId,
    revision: 1,
    node_id: 'development',
    execution_index: 1,
    status: 'running',
    completion_token: 'tok-mcp-999',
    attempt_dir: mat.paths.attemptDir,
  });

  // Cross-node access MUST be rejected
  const deniedCtx = await client.callTool({
    name: 'workbench_get_node_context',
    arguments: {
      task_id: taskId,
      node_id: 'development',
      attempt_id: 'run-mcp-adv-1',
      completion_token: 'tok-mcp-999',
      resource_path: 'nodes/acceptance/resources/notes.md',
    },
  });
  assert.strictEqual(deniedCtx.isError, true);
  assert.strictEqual(JSON.parse((deniedCtx.content as any)[0].text).error.code, 'ACCESS_DENIED');

  // Own material access succeeds
  const allowedCtx = await client.callTool({
    name: 'workbench_get_node_context',
    arguments: {
      task_id: taskId,
      node_id: 'development',
      attempt_id: 'run-mcp-adv-1',
      completion_token: 'tok-mcp-999',
      resource_path: 'nodes/development/resources/notes.md',
    },
  });
  assert.strictEqual(Boolean(allowedCtx.isError), false);
  assert.ok(JSON.parse((allowedCtx.content as any)[0].text).resource.content.includes('Private resource for development'));

  // Advance workflow report
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

  // Stop task before revising (running task cannot be revised)
  db.updateTaskStatus(taskId, TaskStatus.CANCELLED);

  const built2 = buildLocalPackage({
    dir: tmpPkgRoot2,
    taskKey: 'mcp-test-task',
    revision: 2,
    title: 'MCP Unit Test Task v2 Revised',
    workflowId: 'default',
    workflowSha: getWfData.workflow.definition_sha256,
    nodes: getWfData.workflow.nodes,
  });
  const stageRev2 = await client.callTool({
    name: 'workbench_stage_package',
    arguments: {
      protocol_version: 'cb.task-package/2.0',
      operation: 'revise',
      task_id: taskId,
      expected_revision: 1,
      idempotency_key: `mcp-stage-2:${built2.manifestSha}`,
      source: {
        mode: 'local_path',
        package_root: tmpPkgRoot2,
        manifest_path: 'manifest.json',
        manifest_sha256: built2.manifestSha,
      },
    },
  });
  const draftId2 = JSON.parse((stageRev2.content as any)[0].text).draft_id;
  const finRev2 = await client.callTool({
    name: 'workbench_finalize_package',
    arguments: {
      draft_id: draftId2,
      manifest_sha256: built2.manifestSha,
      idempotency_key: `mcp-fin-2:${built2.manifestSha}`,
    },
  });
  const finRev2Data = JSON.parse((finRev2.content as any)[0].text);
  assert.strictEqual(finRev2Data.ok, true);
  assert.strictEqual(finRev2Data.revision, 2);
  assert.strictEqual(finRev2Data.status, TaskStatus.PENDING_CONFIRM);

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
  assert.strictEqual(delDefRes.isError, true);

  db.saveWorkflowDefinition({
    id: 'mcp-test-wf',
    name: 'MCP测试工作流',
    nodes_json: JSON.stringify([
      { id: 'start', name: '开始', type: 'start', on_success: 'end' },
      { id: 'end', name: '结束', type: 'end' },
    ]),
  });
  const delCustomRes = await client.callTool({
    name: 'workbench_delete_workflow',
    arguments: { workflow_id: 'mcp-test-wf' },
  });
  assert.strictEqual(delCustomRes.isError, undefined);
  assert.strictEqual(db.getWorkflow('mcp-test-wf'), null);

  console.log('✅ mcpServer.test.ts passed successfully!');
} finally {
  try { fs.rmSync(tmpPkgRoot1, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpPkgRoot2, { recursive: true, force: true }); } catch {}
  await client.close();
  await server.close();
}
