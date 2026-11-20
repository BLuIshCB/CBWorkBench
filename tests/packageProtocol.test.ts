import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { db } from '../src/storage/db.ts';
import { packageService } from '../src/services/packageService.ts';
import { PackageProtocolError, validateTaskPackageDirectory } from '../src/services/packageProtocol.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { MANDATORY_CLI_POLICY } from '../src/adapters/types.ts';
import { computeWorkflowDefinitionSha256, type WorkflowNode } from '../src/services/workflowDefinition.ts';
import { TaskStatus } from '../src/config/constants.ts';
import { runVerificationAgent } from './fixtures/verificationAgent.ts';
import { taskCleanupService } from '../src/services/taskCleanupService.ts';
import { createHttpServer } from '../src/server/httpServer.ts';

console.log('[Test] Running packageProtocol.test.ts...');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pkg-proto-'));
const wfId = `custom-mvp-wf-${Date.now()}`;
const wfNodes: WorkflowNode[] = [
  { id: 'start', name: '开始', type: 'start', on_success: 'write_docs' },
  { id: 'write_docs', name: '编写说明', description: '生成交付说明', prompt: '平台预设提示词：认真编写文档', type: 'task', execution_mode: 'agent', executor: 'pkg-fixture', on_success: 'check_cmd' },
  { id: 'check_cmd', name: '命令验证', description: '运行通用命令', type: 'task', execution_mode: 'agent', result_rule: 'verification', executor: 'pkg-fixture', max_executions: 1, on_success: 'end', on_failure: 'write_docs' },
  { id: 'end', name: '结束', type: 'end' },
];

let verificationExitCode = 0;
let lastSeenPrompts: Record<string, string> = {};

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
    if (ctx.prompt.includes('Node ID: write_docs')) {
      lastSeenPrompts['write_docs'] = ctx.prompt;
    }
    if (ctx.prompt.includes('Node ID: check_cmd')) {
      lastSeenPrompts['check_cmd'] = ctx.prompt;
    }
    // Verify prompt does not leak revisions root
    assert.ok(!ctx.prompt.includes('revisions'), 'Prompt must not expose revisions root');
    assert.ok(ctx.prompt.includes('material'), 'Prompt must reference isolated material dir');
    if (!ctx.prompt.includes('Node ID: cmd_only')) {
      const verification = await runVerificationAgent(ctx, verificationExitCode);
      if (verification) return verification;
    }
    return { ok: true, output: 'docs written ok', durationMs: 5, modelUsed: 'default' };
  },
});

const wfRec = db.saveWorkflowDefinition({ id: wfId, name: 'MVP Custom Workflow', nodes_json: JSON.stringify(wfNodes) });
const wfDef = { id: wfRec.id, name: wfRec.name, description: wfRec.description, nodes: wfNodes };

function buildMinimalPackageDir(dirName: string, opts?: {
  omitManifest?: boolean;
  omitRequirements?: boolean;
  emptyRequirements?: boolean;
  omitDevelopment?: boolean;
  emptyDevelopment?: boolean;
  omitNodesDir?: boolean;
  omitWorkMdFor?: string;
  emptyWorkMdFor?: string;
  bomOnRequirements?: boolean;
  extraNodeDir?: string;
  omitNodeDir?: string;
  controlNodeDir?: string;
  caseCollision?: boolean;
  customPromptForWriteDocs?: boolean;
  targetCwdOverride?: string;
  wfIdOverride?: string;
  longChineseText?: boolean;
}) {
  const pkgRoot = path.join(tmpBase, dirName);
  fs.mkdirSync(pkgRoot, { recursive: true });

  if (!opts?.omitManifest) {
    const manifest = {
      title: '极简任务包 MVP 测试',
      workflow_id: opts?.wfIdOverride ?? wfId,
      target_cwd: opts?.targetCwdOverride ?? process.cwd(),
      task_key: 'mvp-task',
    };
    fs.writeFileSync(path.join(pkgRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }

  if (!opts?.omitRequirements) {
    const reqContent = opts?.longChineseText
      ? '中文多字节边界测试😀'.repeat(1200)
      : (opts?.emptyRequirements ? '   ' : '# 需求说明\n必须实现 MVP 极简结构。\n');
    const reqBuf = opts?.bomOnRequirements
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(reqContent, 'utf8')])
      : Buffer.from(reqContent, 'utf8');
    fs.writeFileSync(path.join(pkgRoot, 'requirements.md'), reqBuf);
  }

  if (!opts?.omitDevelopment) {
    const devContent = opts?.emptyDevelopment ? '   ' : '# 开发指南\n遵循单分支开发策略。\n';
    fs.writeFileSync(path.join(pkgRoot, 'development.md'), devContent, 'utf8');
  }

  if (!opts?.omitNodesDir) {
    const nodesDir = path.join(pkgRoot, 'nodes');
    fs.mkdirSync(nodesDir, { recursive: true });

    const taskNodeIds = ['write_docs', 'check_cmd'];
    for (const nid of taskNodeIds) {
      if (opts?.omitNodeDir === nid) continue;
      const nd = path.join(nodesDir, nid);
      fs.mkdirSync(nd, { recursive: true });
      if (opts?.omitWorkMdFor !== nid) {
        const wContent = opts?.emptyWorkMdFor === nid ? '   ' : `# 任务清单: ${nid}\n完成对应节点的工作。\n`;
        fs.writeFileSync(path.join(nd, 'work.md'), wContent, 'utf8');
      }
      if (nid === 'check_cmd') {
        fs.writeFileSync(path.join(nd, 'prompt.md'), '自定义提示词：执行项目测试并捕获证据', 'utf8');
      } else if (opts?.customPromptForWriteDocs) {
        fs.writeFileSync(path.join(nd, 'prompt.md'), '自定义提示词：请编写完整的技术交付文档', 'utf8');
      }
    }

    if (opts?.extraNodeDir) {
      const extraDir = path.join(nodesDir, opts.extraNodeDir);
      fs.mkdirSync(extraDir, { recursive: true });
      fs.writeFileSync(path.join(extraDir, 'work.md'), '# Extra\n', 'utf8');
    }

    if (opts?.controlNodeDir) {
      const cDir = path.join(nodesDir, opts.controlNodeDir);
      fs.mkdirSync(cDir, { recursive: true });
      fs.writeFileSync(path.join(cDir, 'work.md'), '# Control\n', 'utf8');
    }

    if (opts?.caseCollision) {
      const colDir = path.join(nodesDir, 'WRITE_DOCS');
      fs.mkdirSync(colDir, { recursive: true });
      fs.writeFileSync(path.join(colDir, 'work.md'), '# Collide\n', 'utf8');
    }
  }

  return pkgRoot;
}

const createdTaskIds: string[] = [];

try {
  // 1. Directory validation: missing manifest.json
  const noManifestPkg = buildMinimalPackageDir('no-manifest', { omitManifest: true });
  assert.throws(
    () => packageService.submitTask({ package_root: noManifestPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'MISSING_FILE'
  );

  // 2. Directory validation: missing requirements.md
  const noReqPkg = buildMinimalPackageDir('no-req', { omitRequirements: true });
  assert.throws(
    () => packageService.submitTask({ package_root: noReqPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'MISSING_FILE'
  );

  // 3. Directory validation: empty requirements.md
  const emptyReqPkg = buildMinimalPackageDir('empty-req', { emptyRequirements: true });
  assert.throws(
    () => packageService.submitTask({ package_root: emptyReqPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'INVALID_MANIFEST_SCHEMA'
  );

  // 4. Directory validation: UTF-8 BOM rejected
  const bomPkg = buildMinimalPackageDir('bom-pkg', { bomOnRequirements: true });
  assert.throws(
    () => packageService.submitTask({ package_root: bomPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'BOM_NOT_ALLOWED'
  );

  // 5. Directory validation: missing development.md
  const noDevPkg = buildMinimalPackageDir('no-dev', { omitDevelopment: true });
  assert.throws(
    () => packageService.submitTask({ package_root: noDevPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'MISSING_FILE'
  );

  // 6. Directory validation: missing nodes/ dir
  const noNodesPkg = buildMinimalPackageDir('no-nodes', { omitNodesDir: true });
  assert.throws(
    () => packageService.submitTask({ package_root: noNodesPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'MISSING_FILE'
  );

  // 7. Directory validation: missing a task node directory
  const missNodePkg = buildMinimalPackageDir('miss-node', { omitNodeDir: 'write_docs' });
  assert.throws(
    () => packageService.submitTask({ package_root: missNodePkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'NODE_COVERAGE_MISMATCH'
  );

  // 8. Directory validation: extra unknown node directory
  const extraNodePkg = buildMinimalPackageDir('extra-node', { extraNodeDir: 'unknown_step' });
  assert.throws(
    () => packageService.submitTask({ package_root: extraNodePkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'NODE_COVERAGE_MISMATCH'
  );

  // 9. Directory validation: control node (start/end) directory rejected
  const controlNodePkg = buildMinimalPackageDir('control-node', { controlNodeDir: 'start' });
  assert.throws(
    () => packageService.submitTask({ package_root: controlNodePkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'NODE_COVERAGE_MISMATCH'
  );

  // 10. Directory validation: missing work.md in a node directory
  const noWorkPkg = buildMinimalPackageDir('no-work', { omitWorkMdFor: 'write_docs' });
  assert.throws(
    () => packageService.submitTask({ package_root: noWorkPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'MISSING_FILE'
  );

  // 11. Directory validation: empty work.md in a node directory
  const emptyWorkPkg = buildMinimalPackageDir('empty-work', { emptyWorkMdFor: 'write_docs' });
  assert.throws(
    () => packageService.submitTask({ package_root: emptyWorkPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'INVALID_MANIFEST_SCHEMA'
  );

  // 12. Directory validation: case mismatch on node directories
  const caseColPkg = buildMinimalPackageDir('case-col', { omitNodeDir: 'write_docs', extraNodeDir: 'WRITE_DOCS' });
  assert.throws(
    () => packageService.submitTask({ package_root: caseColPkg }),
    (e: any) => e instanceof PackageProtocolError && e.code === 'NODE_COVERAGE_MISMATCH'
  );

  // 13. Symlink / junction escape inside package_root
  const symPkg = buildMinimalPackageDir('sym-escape');
  const outsideFile = path.join(tmpBase, 'secret.txt');
  fs.writeFileSync(outsideFile, 'SECRET', 'utf8');
  let symlinkCreated = false;
  try {
    const linkDir = path.join(symPkg, 'nodes', 'write_docs');
    fs.rmSync(linkDir, { recursive: true, force: true });
    const targetDir = path.join(tmpBase, 'ext-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'work.md'), '# Work\n', 'utf8');
    fs.symlinkSync(targetDir, linkDir, 'junction');
    symlinkCreated = true;
  } catch {
    // Windows permission or privilege error when creating symlink/junction
  }
  if (symlinkCreated) {
    assert.throws(
      () => packageService.submitTask({ package_root: symPkg }),
      (e: any) => e instanceof PackageProtocolError && e.code === 'PATH_ESCAPE'
    );
    console.log('  ✓ Symlink / Windows junction escape strictly rejected');
  }

  // 14. Happy path: Submit minimal task package (single stage!)
  const goodPkg = buildMinimalPackageDir('good-pkg', { longChineseText: true });
  const submitResult = packageService.submitTask({
    package_root: goodPkg,
  });
  assert.equal(submitResult.ok, true);
  assert.equal(submitResult.revision, 1);
  assert.equal(submitResult.status, TaskStatus.PENDING_CONFIRM);
  assert.ok(submitResult.task_id);
  assert.ok(submitResult.web_url);

  const taskId = submitResult.task_id;
  createdTaskIds.push(taskId);

  // Verify external package deletion does not affect frozen revision
  fs.rmSync(goodPkg, { recursive: true, force: true });

  // Paged reading of multi-byte UTF-8 file
  let offset = 0;
  let assembled = '';
  let pages = 0;
  while (true) {
    const page = packageService.getPackage({
      task_id: taskId,
      resource_path: 'requirements.md',
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

  // Verify read slice via HTTP
  const httpServer = createHttpServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = (httpServer.address() as any).port;
  try {
    const resSlice = await fetch(
      `http://127.0.0.1:${httpPort}/api/tasks/${taskId}/revisions/1/resource?path=${encodeURIComponent('nodes/write_docs/work.md')}`
    ).then((r) => r.json());
    assert.equal(resSlice.success, true);
    assert.ok(resSlice.resource.content.includes('任务清单: write_docs'));
    console.log('  ✓ HTTP /api/tasks/:id/revisions/:rev/resource serves frozen node materials');
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  // 15. Execute workflow -> verify prompt fallback and custom prompt
  // In goodPkg:
  // - write_docs had NO prompt.md -> should fallback to currentNode.prompt ("平台预设提示词：认真编写文档")
  // - check_cmd HAD prompt.md -> should use custom prompt ("自定义提示词：执行项目测试并捕获证据")
  lastSeenPrompts = {};
  const startRes = await workflowEngine.confirmAndStartTask(taskId, undefined, {
    workerExecutor: 'pkg-fixture',
    reviewerExecutor: 'pkg-fixture',
  });
  assert.equal(startRes.success, true);

  const deadline = Date.now() + 8000;
  while (db.getTask(taskId)?.status !== TaskStatus.COMPLETED && db.getTask(taskId)?.status !== TaskStatus.BLOCKED && db.getTask(taskId)?.status !== TaskStatus.FAILED && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const taskState = db.getTask(taskId);
  assert.equal(taskState?.status, TaskStatus.COMPLETED);

  assert.ok(lastSeenPrompts['write_docs'].includes('平台预设提示词：认真编写文档'), 'write_docs should fallback to platform default prompt');
  assert.ok(lastSeenPrompts['write_docs'].includes('本节点具体工作 (work.md)'), 'Prompt must contain work.md');
  assert.ok(lastSeenPrompts['write_docs'].includes('开发文档 (development.md)'), 'Prompt must contain development.md');
  assert.ok(lastSeenPrompts['check_cmd'].includes('自定义提示词：执行项目测试并捕获证据'), 'check_cmd should use custom prompt.md');
  console.log('  ✓ Prompt fallback to workflow default and prompt.md precedence verified');

  // 16. Missing execution evidence blocks verification node
  const noCmdWfId = `nocmd-wf-${Date.now()}`;
  const noCmdNodes: WorkflowNode[] = [
    { id: 'start', name: '开始', type: 'start', on_success: 'cmd_only' },
    { id: 'cmd_only', name: '无命令节点', type: 'task', execution_mode: 'agent', result_rule: 'verification', executor: 'pkg-fixture', on_success: 'end' },
    { id: 'end', name: '结束', type: 'end' },
  ];
  db.saveWorkflowDefinition({ id: noCmdWfId, name: 'No Cmd Workflow', nodes_json: JSON.stringify(noCmdNodes) });
  const noCmdPkg = path.join(tmpBase, 'nocmd-pkg');
  fs.mkdirSync(path.join(noCmdPkg, 'nodes', 'cmd_only'), { recursive: true });
  fs.writeFileSync(path.join(noCmdPkg, 'requirements.md'), '# Req\n', 'utf8');
  fs.writeFileSync(path.join(noCmdPkg, 'development.md'), '# Dev\n', 'utf8');
  fs.writeFileSync(path.join(noCmdPkg, 'nodes', 'cmd_only', 'work.md'), '# Work\n', 'utf8');
  fs.writeFileSync(
    path.join(noCmdPkg, 'manifest.json'),
    JSON.stringify({ title: 'No Cmd Test', workflow_id: noCmdWfId, target_cwd: process.cwd(), task_key: 'nocmd-test' }),
    'utf8'
  );

  const ncSubmit = packageService.submitTask({ package_root: noCmdPkg });
  const ncTaskId = ncSubmit.task_id;
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

  // 17. Non-zero test command exit code routes to rework / failure
  verificationExitCode = 2;
  const failedPkg = buildMinimalPackageDir('failed-test-pkg');
  const failedSubmit = packageService.submitTask({ package_root: failedPkg });
  const failedTaskId = failedSubmit.task_id;
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
