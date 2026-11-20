import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { db } from '../src/storage/db.ts';
import { packageService } from '../src/services/packageService.ts';
import { PackageProtocolError } from '../src/services/packageProtocol.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { MANDATORY_CLI_POLICY } from '../src/adapters/types.ts';
import { computeWorkflowDefinitionSha256, type WorkflowNode } from '../src/services/workflowDefinition.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { runVerificationAgent } from './fixtures/verificationAgent.ts';
import { taskCleanupService } from '../src/services/taskCleanupService.ts';
import { createHttpServer } from '../src/server/httpServer.ts';

console.log('[Test] Running packageProtocol.test.ts...');

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pkg-proto-'));
const wfId = `custom-uniform-wf-${Date.now()}`;
const wfNodes: WorkflowNode[] = [
  { id: 'start', name: '开始', type: 'start', on_success: 'write_docs' },
  { id: 'write_docs', name: '编写说明', description: '生成交付说明', type: 'task', execution_mode: 'agent', executor: 'pkg-fixture', on_success: 'check_cmd' },
  { id: 'check_cmd', name: '命令验证', description: '运行通用命令', type: 'task', execution_mode: 'agent', result_rule: 'verification', executor: 'pkg-fixture', max_executions: 1, on_success: 'end', on_failure: 'write_docs' },
  { id: 'end', name: '结束', type: 'end' },
];

let verificationExitCode = 0;

adapterRegistry.register({
  id: 'pkg-fixture',
  name: 'Package Fixture',
  description: 'Fixture adapter',
  defaultModel: 'default',
  supportedModels: ['default'],
  connectionType: 'fixture',
  executionPolicy: MANDATORY_CLI_POLICY,
  async healthCheck() { return { healthy: true }; },
  async abort() {},
  async execute(ctx) {
    // Verify the prompt ONLY points to isolated attempt dir and NOT revisions dir
    assert.ok(!ctx.prompt.includes('revisions'), 'Prompt must not expose revisions root');
    assert.ok(ctx.prompt.includes('material'), 'Prompt must reference isolated material dir');
    if (!ctx.prompt.includes('Node ID: cmd_only')) {
      const verification = await runVerificationAgent(ctx, verificationExitCode);
      if (verification) return verification;
    }
    return { ok: true, output: 'docs written ok', durationMs: 5, modelUsed: 'default' };
  },
});

const wfRec = db.saveWorkflowDefinition({ id: wfId, name: 'Uniform Custom Workflow', nodes_json: JSON.stringify(wfNodes) });
const wfSha = computeWorkflowDefinitionSha256({ id: wfRec.id, name: wfRec.name, description: wfRec.description, nodes: wfNodes });

function buildPackageDir(dirName: string, opts?: {
  revision?: number;
  readiness?: 'ready' | 'blocked';
  blockers?: string[];
  extraManifestField?: boolean;
  bomOnNodeMd?: boolean;
  badFileHash?: boolean;
  caseCollision?: boolean;
  crossNodeRef?: boolean;
  includeSchemaContract?: boolean;
  longChineseText?: boolean;
  wfShaOverride?: string;
}) {
  const pkgRoot = path.join(tmpBase, dirName);
  fs.mkdirSync(path.join(pkgRoot, 'shared', 'resources'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'nodes', 'write_docs', 'resources'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'nodes', 'check_cmd', 'resources'), { recursive: true });

  const files: any[] = [];
  const regFile = (rel: string, buf: Buffer, owner: any, mediaType = 'text/markdown') => {
    const dest = path.join(pkgRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    files.push({
      path: rel,
      owner,
      media_type: mediaType,
      size_bytes: buf.length,
      sha256: opts?.badFileHash && rel.endsWith('node.md') ? '0'.repeat(64) : sha256(buf),
    });
  };

  const sharedBuf = Buffer.from(
    opts?.longChineseText ? '中文多字节边界测试😀'.repeat(1200) : '# 共同约束\nREQ-100\n',
    'utf8'
  );
  regFile('shared/resources/baseline.md', sharedBuf, { scope: 'shared' });

  const writeNodeBuf = opts?.bomOnNodeMd
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Node\n', 'utf8')])
    : Buffer.from('# 编写说明节点\n负责撰写交付文档。\n', 'utf8');
  regFile('nodes/write_docs/node.md', writeNodeBuf, { scope: 'node', node_id: 'write_docs' });
  regFile('nodes/write_docs/prompt.md', Buffer.from('Write the documentation.', 'utf8'), { scope: 'node', node_id: 'write_docs' });
  regFile('nodes/write_docs/resources/guide.md', Buffer.from('# Guide\n', 'utf8'), { scope: 'node', node_id: 'write_docs' });

  if (opts?.caseCollision) {
    regFile('nodes/write_docs/resources/GUIDE.md', Buffer.from('# Duplicate Case\n', 'utf8'), { scope: 'node', node_id: 'write_docs' });
  }

  let schemaRef: string | undefined;
  if (opts?.includeSchemaContract) {
    const schemaJson = JSON.stringify({
      type: 'object',
      required: ['schema_version', 'outcome', 'outputs'],
      properties: {
        outcome: { enum: ['passed', 'failed', 'blocked'] },
        must_not_exist_prop: { type: 'string' },
      },
    });
    // Require a nonexistent field only if testing violation, here make valid schema first
    schemaRef = 'nodes/write_docs/resources/output-schema.json';
    regFile(schemaRef, Buffer.from(schemaJson, 'utf8'), { scope: 'node', node_id: 'write_docs' }, 'application/json');
  }

  regFile('nodes/check_cmd/node.md', Buffer.from('# 测试节点\n', 'utf8'), { scope: 'node', node_id: 'check_cmd' });
  regFile('nodes/check_cmd/prompt.md', Buffer.from('选择项目测试入口并执行，保存真实测试证据。', 'utf8'), { scope: 'node', node_id: 'check_cmd' });
  regFile('nodes/check_cmd/resources/notes.md', Buffer.from('Check command notes.', 'utf8'), { scope: 'node', node_id: 'check_cmd' });

  const manifest: any = {
    protocol_version: 'cb.task-package/2.0',
    task_key: 'uniform-task',
    revision: opts?.revision ?? 1,
    title: '统一节点材料测试',
    target_cwd: process.cwd(),
    workflow: { id: wfId, definition_sha256: opts?.wfShaOverride ?? wfSha },
    readiness: opts?.readiness ?? 'ready',
    blockers: opts?.blockers ?? [],
    nodes: [
      {
        node_id: 'write_docs',
        node_ref: 'nodes/write_docs/node.md',
        prompt_ref: 'nodes/write_docs/prompt.md',
        resources: [
          { id: 'guide', path: 'nodes/write_docs/resources/guide.md' },
          ...(opts?.caseCollision ? [{ id: 'guide2', path: 'nodes/write_docs/resources/GUIDE.md' }] : []),
          ...(schemaRef ? [{ id: 'schema', path: schemaRef }] : []),
          ...(opts?.crossNodeRef ? [{ id: 'steal', path: 'nodes/check_cmd/resources/notes.md' }] : []),
        ],
        shared_refs: ['shared/resources/baseline.md'],
        input_bindings: [],
        output_contract: {
          required_outputs: ['result'],
          optional_outputs: ['agent_output'],
          ...(schemaRef ? { schema_ref: schemaRef } : {}),
        },
      },
      {
        node_id: 'check_cmd',
        node_ref: 'nodes/check_cmd/node.md',
        prompt_ref: 'nodes/check_cmd/prompt.md',
        resources: [{ id: 'notes', path: 'nodes/check_cmd/resources/notes.md' }],
        shared_refs: [],
        input_bindings: [
          { slot: 'doc_result', from_node_id: 'write_docs', output: 'result', required: true, constraint: 'current_code_snapshot' },
        ],
        output_contract: { required_outputs: ['result'], optional_outputs: ['test_report'] },
      },
    ],
    files,
    ...(opts?.extraManifestField ? { unknown_typo_field: true } : {}),
  };

  const mBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(pkgRoot, 'manifest.json'), mBuf);
  return { pkgRoot, manifest, manifestSha: sha256(mBuf) };
}

const createdTaskIds: string[] = [];

try {
  // 1. Reject unsupported source.mode = upload
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'bad-mode',
        source: { mode: 'upload', package_root: tmpBase, manifest_sha256: '0'.repeat(64) },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'UNSUPPORTED_SOURCE_MODE'
  );

  // 2. Reject unknown manifest field
  const unknownPkg = buildPackageDir('unknown-field', { extraManifestField: true });
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'unknown-field',
        source: { mode: 'local_path', package_root: unknownPkg.pkgRoot, manifest_sha256: unknownPkg.manifestSha },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'INVALID_MANIFEST_SCHEMA'
  );

  // 3. Reject workflow hash mismatch
  const badWfSha = buildPackageDir('bad-wf-sha', { wfShaOverride: 'f'.repeat(64) });
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'bad-wf-sha',
        source: { mode: 'local_path', package_root: badWfSha.pkgRoot, manifest_sha256: badWfSha.manifestSha },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'WORKFLOW_HASH_MISMATCH'
  );

  // 4. Reject UTF-8 BOM
  const bomPkg = buildPackageDir('bom-pkg', { bomOnNodeMd: true });
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'bom-pkg',
        source: { mode: 'local_path', package_root: bomPkg.pkgRoot, manifest_sha256: bomPkg.manifestSha },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'BOM_NOT_ALLOWED'
  );

  // 5. Reject file hash mismatch
  const badHashPkg = buildPackageDir('bad-hash', { badFileHash: true });
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'bad-hash',
        source: { mode: 'local_path', package_root: badHashPkg.pkgRoot, manifest_sha256: badHashPkg.manifestSha },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'HASH_MISMATCH'
  );

  // 6. Reject case-collision paths
  const casePkg = buildPackageDir('case-collision', { caseCollision: true });
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'case-col',
        source: { mode: 'local_path', package_root: casePkg.pkgRoot, manifest_sha256: casePkg.manifestSha },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'CASE_COLLISION'
  );

  // 7. Reject cross-node ownership reference
  const crossPkg = buildPackageDir('cross-node', { crossNodeRef: true });
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'cross-node',
        source: { mode: 'local_path', package_root: crossPkg.pkgRoot, manifest_sha256: crossPkg.manifestSha },
      }),
    (e: any) => e instanceof PackageProtocolError && (e.code === 'INVALID_RESOURCE_PATH' || e.code === 'INVALID_OWNER')
  );

  // 8. Reject symlink / junction escape inside package_root
  const symPkg = buildPackageDir('sym-escape');
  const outsideFile = path.join(tmpBase, 'secret.txt');
  fs.writeFileSync(outsideFile, 'SECRET', 'utf8');
  let symlinkCreated = false;
  try {
    fs.unlinkSync(path.join(symPkg.pkgRoot, 'nodes', 'write_docs', 'resources', 'guide.md'));
    fs.symlinkSync(outsideFile, path.join(symPkg.pkgRoot, 'nodes', 'write_docs', 'resources', 'guide.md'));
    symlinkCreated = true;
  } catch {
    // On unprivileged Windows without Developer Mode, file symlinks may require elevation; try directory junction!
    try {
      const linkDir = path.join(symPkg.pkgRoot, 'nodes', 'write_docs', 'resources');
      fs.rmSync(linkDir, { recursive: true, force: true });
      const targetDir = path.join(tmpBase, 'ext-dir');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'guide.md'), '# Guide\n', 'utf8');
      fs.symlinkSync(targetDir, linkDir, 'junction');
      symlinkCreated = true;
    } catch {}
  }
  if (symlinkCreated) {
    assert.throws(
      () =>
        packageService.stagePackage({
          protocol_version: 'cb.task-package/2.0',
          operation: 'create',
          idempotency_key: 'sym-escape',
          source: { mode: 'local_path', package_root: symPkg.pkgRoot, manifest_sha256: symPkg.manifestSha },
        }),
      (e: any) => e instanceof PackageProtocolError && e.code === 'PATH_ESCAPE'
    );
    console.log('  ✓ Symlink / Windows junction escape strictly rejected');
  }

  // 9. Blocked draft can stage, cannot finalize
  const blockedPkg = buildPackageDir('blocked-pkg', { readiness: 'blocked', blockers: ['缺少环境依赖'] });
  const stagedBlocked = packageService.stagePackage({
    protocol_version: 'cb.task-package/2.0',
    operation: 'create',
    idempotency_key: 'blocked-stage-1',
    source: { mode: 'local_path', package_root: blockedPkg.pkgRoot, manifest_sha256: blockedPkg.manifestSha },
  });
  assert.equal(stagedBlocked.readiness, 'blocked');
  assert.throws(
    () =>
      packageService.finalizePackage({
        draft_id: stagedBlocked.draft_id,
        manifest_sha256: blockedPkg.manifestSha,
        idempotency_key: 'blocked-fin-1',
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'PACKAGE_NOT_READY'
  );
  // Clean up staged-only dir
  await taskCleanupService.deleteTask(stagedBlocked.task_id);

  // 10. Happy path with long multi-byte UTF-8 paged reading, schema contract, input_bindings handoff
  const goodPkg = buildPackageDir('good-pkg', { includeSchemaContract: true, longChineseText: true });
  const stagedGood = packageService.stagePackage({
    protocol_version: 'cb.task-package/2.0',
    operation: 'create',
    idempotency_key: 'good-stage-1',
    source: { mode: 'local_path', package_root: goodPkg.pkgRoot, manifest_sha256: goodPkg.manifestSha },
  });

  // Idempotent stage replay & conflict
  const replayStage = packageService.stagePackage({
    protocol_version: 'cb.task-package/2.0',
    operation: 'create',
    idempotency_key: 'good-stage-1',
    source: { mode: 'local_path', package_root: goodPkg.pkgRoot, manifest_sha256: goodPkg.manifestSha },
  });
  assert.equal(replayStage.idempotent_replay, true);
  assert.throws(
    () =>
      packageService.stagePackage({
        protocol_version: 'cb.task-package/2.0',
        operation: 'create',
        idempotency_key: 'good-stage-1',
        source: { mode: 'local_path', package_root: goodPkg.pkgRoot, manifest_sha256: 'a'.repeat(64) },
      }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'IDEMPOTENCY_CONFLICT'
  );

  const finalizedGood = packageService.finalizePackage({
    draft_id: stagedGood.draft_id,
    manifest_sha256: goodPkg.manifestSha,
    idempotency_key: 'good-fin-1',
  });
  const taskId = finalizedGood.task_id;
  createdTaskIds.push(taskId);

  // Delete source directory to verify independence
  fs.rmSync(goodPkg.pkgRoot, { recursive: true, force: true });

  // Paged reading across UTF-8 multi-byte boundaries
  let offset = 0;
  let assembled = '';
  let pages = 0;
  while (true) {
    const page = packageService.getPackage({
      task_id: taskId,
      resource_path: 'shared/resources/baseline.md',
      offset_bytes: offset,
      max_bytes: 1024,
    }) as any;
    assembled += page.resource.content;
    pages++;
    if (!page.resource.has_more) break;
    assert.equal(page.resource.truncated, true);
    offset = page.resource.next_offset;
  }
  assert.ok(pages > 5);
  assert.equal(assembled, '中文多字节边界测试😀'.repeat(1200));
  console.log('  ✓ Multi-byte UTF-8 paged reading reassembled losslessly');

  // Execute custom workflow -> verify input_bindings handoff & completion
  const startRes = await workflowEngine.confirmAndStartTask(taskId, undefined, {
    workerExecutor: 'pkg-fixture',
    reviewerExecutor: 'pkg-fixture',
  });
  assert.equal(startRes.success, true);

  const deadline = Date.now() + 8000;
  while (db.getTask(taskId)?.status !== TaskStatus.COMPLETED && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(db.getTask(taskId)?.status, TaskStatus.COMPLETED);

  const runs = db.getNodeRuns(taskId);
  assert.equal(runs.length, 2);
  const cmdRun = runs.find((r) => r.node_id === 'check_cmd')!;
  const inputsMeta = JSON.parse(cmdRun.inputs_json || '[]');
  assert.equal(inputsMeta.length, 1);
  assert.equal(inputsMeta[0].slot, 'doc_result');
  assert.equal(inputsMeta[0].from_node_id, 'write_docs');
  assert.ok(fs.existsSync(path.join(cmdRun.attempt_dir!, inputsMeta[0].mounted_path)));
  assert.equal(cmdRun.code_generation, runs[0].code_generation, '只读测试不应产生新的代码代次');
  const testEvidence = db.getTestRuns(taskId);
  assert.equal(testEvidence.length, 1);
  assert.equal(testEvidence[0].exit_code, 0);
  assert.match(testEvidence[0].stdout, /node-owned-test/);
  console.log('  ✓ Custom uniform workflow executed end-to-end with input_bindings & schema contract');

  // 11. HTTP resource slice endpoint
  const httpServer = createHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = (httpServer.address() as any).port;
  try {
    const resSlice = await fetch(
      `http://127.0.0.1:${httpPort}/api/tasks/${taskId}/revisions/1/resource?path=${encodeURIComponent('nodes/write_docs/node.md')}`
    ).then((r) => r.json());
    assert.equal(resSlice.success, true);
    assert.ok(resSlice.resource.content.includes('编写说明节点'));
    console.log('  ✓ HTTP /api/tasks/:id/revisions/:rev/resource serves frozen node materials');
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  // 12. A test Agent without actual evidence blocks instead of silently passing
  const noCmdWfId = `nocmd-wf-${Date.now()}`;
  const noCmdNodes: WorkflowNode[] = [
    { id: 'start', name: '开始', type: 'start', on_success: 'cmd_only' },
    { id: 'cmd_only', name: '无命令节点', type: 'task', execution_mode: 'agent', result_rule: 'verification', executor: 'pkg-fixture', on_success: 'end' },
    { id: 'end', name: '结束', type: 'end' },
  ];
  const noCmdWf = db.saveWorkflowDefinition({ id: noCmdWfId, name: 'No Cmd Workflow', nodes_json: JSON.stringify(noCmdNodes) });
  const noCmdSha = computeWorkflowDefinitionSha256({ id: noCmdWf.id, name: noCmdWf.name, description: noCmdWf.description, nodes: noCmdNodes });
  const noCmdDir = path.join(tmpBase, 'nocmd-pkg');
  fs.mkdirSync(path.join(noCmdDir, 'nodes', 'cmd_only', 'resources'), { recursive: true });
  const ncNodeBuf = Buffer.from('# Node\n- 命令: `echo should_never_run`\n', 'utf8');
  const ncPromptBuf = Buffer.from('Run `echo should_never_run`\n', 'utf8');
  fs.writeFileSync(path.join(noCmdDir, 'nodes', 'cmd_only', 'node.md'), ncNodeBuf);
  fs.writeFileSync(path.join(noCmdDir, 'nodes', 'cmd_only', 'prompt.md'), ncPromptBuf);
  const ncManifest = {
    protocol_version: 'cb.task-package/2.0',
    task_key: 'nocmd-test',
    revision: 1,
    title: 'No Cmd Test',
    target_cwd: process.cwd(),
    workflow: { id: noCmdWfId, definition_sha256: noCmdSha },
    readiness: 'ready',
    blockers: [],
    nodes: [{
      node_id: 'cmd_only',
      node_ref: 'nodes/cmd_only/node.md',
      prompt_ref: 'nodes/cmd_only/prompt.md',
      resources: [],
      shared_refs: [],
      input_bindings: [],
      output_contract: { required_outputs: ['result'], optional_outputs: [] },
    }],
    files: [
      { path: 'nodes/cmd_only/node.md', owner: { scope: 'node', node_id: 'cmd_only' }, media_type: 'text/markdown', size_bytes: ncNodeBuf.length, sha256: sha256(ncNodeBuf) },
      { path: 'nodes/cmd_only/prompt.md', owner: { scope: 'node', node_id: 'cmd_only' }, media_type: 'text/markdown', size_bytes: ncPromptBuf.length, sha256: sha256(ncPromptBuf) },
    ],
  };
  const ncMBuf = Buffer.from(JSON.stringify(ncManifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(noCmdDir, 'manifest.json'), ncMBuf);
  const ncMSha = sha256(ncMBuf);
  const ncStaged = packageService.stagePackage({
    protocol_version: 'cb.task-package/2.0',
    operation: 'create',
    idempotency_key: `nocmd:${ncMSha}`,
    source: { mode: 'local_path', package_root: noCmdDir, manifest_sha256: ncMSha },
  });
  const ncTaskId = packageService.finalizePackage({
    draft_id: ncStaged.draft_id,
    manifest_sha256: ncMSha,
    idempotency_key: `fin-nocmd:${ncMSha}`,
  }).task_id;
  createdTaskIds.push(ncTaskId);
  await workflowEngine.confirmAndStartTask(ncTaskId, undefined, { workerExecutor: 'pkg-fixture', reviewerExecutor: 'pkg-fixture' });
  const ncDeadline = Date.now() + 5000;
  while (db.getTask(ncTaskId)?.status !== TaskStatus.BLOCKED && Date.now() < ncDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(db.getTask(ncTaskId)?.status, TaskStatus.BLOCKED);
  assert.match(db.getTask(ncTaskId)!.blocked_reason!, /缺少有效执行证据/);
  await taskCleanupService.deleteTask(ncTaskId);
  try { db.deleteWorkflow(noCmdWfId); } catch {}
  console.log('  ✓ Test Agent without execution evidence is blocked');

  // 非零测试退出码即使 Agent 正常退出，也必须返工而不是放行。
  verificationExitCode = 2;
  const failedPkg = buildPackageDir('failed-test-pkg');
  const failedDraft = packageService.stagePackage({
    protocol_version: 'cb.task-package/2.0', operation: 'create', idempotency_key: 'failed-test-stage',
    source: { mode: 'local_path', package_root: failedPkg.pkgRoot, manifest_sha256: failedPkg.manifestSha },
  });
  const failedTaskId = packageService.finalizePackage({
    draft_id: failedDraft.draft_id, manifest_sha256: failedPkg.manifestSha, idempotency_key: 'failed-test-finalize',
  }).task_id;
  createdTaskIds.push(failedTaskId);
  assert.equal((await workflowEngine.confirmAndStartTask(failedTaskId, undefined, { workerExecutor: 'pkg-fixture', reviewerExecutor: 'pkg-fixture' })).success, true);
  const failureDeadline = Date.now() + 8000;
  while ((db.getTask(failedTaskId)?.status !== TaskStatus.BLOCKED || workflowEngine.isBusy()) && Date.now() < failureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(db.getTask(failedTaskId)?.status, TaskStatus.BLOCKED);
  const failedTestRun = db.getNodeRuns(failedTaskId, 'check_cmd')[0];
  assert.equal(failedTestRun.status, 'failed');
  assert.match(failedTestRun.result_summary!, /退出码 2/);
  assert.equal(db.getTestRuns(failedTaskId)[0].exit_code, 2);
  assert.ok(db.getTaskWorkflow(failedTaskId)!.tests_passed_generation < db.getTaskWorkflow(failedTaskId)!.code_generation);
  verificationExitCode = 0;
  console.log('  ✓ Agent-owned failed test command prevents completion and routes to rework');

  console.log('✅ packageProtocol.test.ts passed successfully!');
} finally {
  for (const tid of createdTaskIds) {
    try { await taskCleanupService.deleteTask(tid); } catch {}
  }
  try { db.deleteWorkflow(wfId); } catch {}
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
