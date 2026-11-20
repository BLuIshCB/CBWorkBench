import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  INSTANCE_ID,
  LEGACY_DATA_PATH,
  TaskStatus,
} from '../config/constants.ts';
import { db, type WorkflowDefinitionRecord } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { workflowEngine } from './workflowEngine.ts';
import { taskCleanupService } from './taskCleanupService.ts';
import {
  type WorkflowDefinition,
  type WorkflowNode,
  computeWorkflowDefinitionSha256,
} from './workflowDefinition.ts';
import {
  PACKAGE_LIMITS,
  PackageProtocolError,
  buildPackageProtocolSpec,
  manifestSchema,
  submitTaskInputSchema,
  validateTaskPackageDirectory,
  type TaskPackageManifest,
} from './packageProtocol.ts';
import {
  computeBufferSha256,
  encodeNodeDirName,
  readRegularFileSafely,
  validateUtf8NoBom,
} from '../utils/pathSecurity.ts';
import { logger } from '../utils/logger.ts';

function toWorkflowDefinition(row: WorkflowDefinitionRecord): WorkflowDefinition {
  let nodes: WorkflowNode[] = [];
  try {
    nodes = JSON.parse(row.nodes_json);
  } catch {}
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_default: Boolean(row.is_default),
  };
}

export class PackageService {
  getProtocol() {
    return buildPackageProtocolSpec({
      instance_id: INSTANCE_ID,
      data_dir: DATA_DIR,
      legacy_data_path: LEGACY_DATA_PATH,
    });
  }

  submitTask(rawInput: unknown) {
    const parsedInput = submitTaskInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new PackageProtocolError(
        'INVALID_MANIFEST_SCHEMA',
        `提交参数不合法: ${parsedInput.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        parsedInput.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message }))
      );
    }

    const input = parsedInput.data;
    const packageRoot = path.resolve(input.package_root);

    if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
      throw new PackageProtocolError('MISSING_FILE', `任务包根目录不存在或不是目录: ${packageRoot}`, [
        { path: packageRoot, field: 'package_root' },
      ]);
    }

    const manifestPath = path.join(packageRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new PackageProtocolError('MISSING_FILE', `任务包根目录下未找到 manifest.json: ${manifestPath}`, [
        { path: 'manifest.json', field: 'manifest' },
      ]);
    }

    let manifestRaw: string;
    let manifest: TaskPackageManifest;
    try {
      const buf = readRegularFileSafely(packageRoot, 'manifest.json');
      validateUtf8NoBom(buf, 'application/json', 'manifest.json');
      manifestRaw = buf.toString('utf8');
      manifest = manifestSchema.parse(JSON.parse(manifestRaw));
    } catch (err: any) {
      if (err instanceof PackageProtocolError) throw err;
      throw new PackageProtocolError('INVALID_MANIFEST_SCHEMA', `manifest.json 解析或格式错误: ${err?.message || err}`, [
        { path: 'manifest.json' },
      ]);
    }

    const wfRow = db.getWorkflow(manifest.workflow_id);
    if (!wfRow) {
      throw new PackageProtocolError('WORKFLOW_NOT_FOUND', `指定的工作流不存在: ${manifest.workflow_id}`, [
        { field: 'workflow_id' },
      ]);
    }
    const wfDef = toWorkflowDefinition(wfRow);
    const wfSha = computeWorkflowDefinitionSha256(wfDef);

    // 校验任务包目录合法性
    const issues = validateTaskPackageDirectory(packageRoot, wfDef);
    if (issues.length > 0) {
      const primaryIssue = issues.find((i) => i.code === 'PATH_ESCAPE') || issues[0];
      throw new PackageProtocolError(
        primaryIssue.code,
        `任务包目录校验未通过: ${issues.map((i) => i.message).join('; ')}`,
        issues.flatMap((i) => i.details)
      );
    }

    let taskId = input.task_id;
    let targetRevision = 1;
    const existingTask = taskId ? db.getTask(taskId) : null;

    if (taskId) {
      if (taskCleanupService.isTaskDeleting(taskId)) {
        throw new PackageProtocolError('TASK_DELETING', `任务 ${taskId} 正在清理删除中，禁止提交修订`);
      }
      if (!existingTask) {
        throw new PackageProtocolError('TASK_NOT_FOUND', `未找到要修订的任务: ${taskId}`);
      }
      if (workflowEngine.getActiveTaskId() === taskId) {
        throw new PackageProtocolError('TASK_RUNNING', `任务 ${taskId} 正在运行中，禁止替换材料`);
      }
      targetRevision = existingTask.revision + 1;
    } else {
      taskId = `task-${crypto.randomBytes(6).toString('hex')}`;
    }

    // 将源目录文件原子归档落盘至 revisions/rNNNN/
    const saved = taskFileStore.saveTaskRevisionFromDirectory(taskId, targetRevision, packageRoot);

    const budgetMaxRounds =
      input.budget_max_rounds ?? manifest.budget_max_rounds ?? existingTask?.budget_max_rounds;
    const executionTimeoutMs =
      input.execution_timeout_ms ?? manifest.execution_timeout_ms ?? existingTask?.execution_timeout_ms;

    // 数据库入库
    if (!existingTask) {
      db.createTask({
        id: taskId,
        task_key: manifest.task_key || taskId,
        revision: targetRevision,
        title: manifest.title,
        status: TaskStatus.PENDING_CONFIRM,
        target_cwd: manifest.target_cwd,
        budget_max_rounds: budgetMaxRounds,
        execution_timeout_ms: executionTimeoutMs,
        workflow_id: wfDef.id,
      });
      db.initTaskWorkflow(taskId, {
        workflowId: wfDef.id,
        workflowSha256: wfSha,
        nodesOverride: wfDef.nodes,
        revision: targetRevision,
      });
    } else {
      db.updateTaskStatus(taskId, TaskStatus.PENDING_CONFIRM, {
        revision: targetRevision,
        title: manifest.title,
        target_cwd: manifest.target_cwd,
        budget_max_rounds: budgetMaxRounds,
        execution_timeout_ms: executionTimeoutMs,
      });
      const startNode = wfDef.nodes.find((n) => n.type === 'start');
      db.updateTaskWorkflow(taskId, {
        workflow_id: wfDef.id,
        workflow_sha256: wfSha,
        nodes_json: JSON.stringify(wfDef.nodes),
        current_node_id: startNode?.on_success || null,
        revision: targetRevision,
      });
    }

    const manifestSha = computeBufferSha256(Buffer.from(manifestRaw, 'utf8'));
    db.saveRevision({
      task_id: taskId,
      revision: targetRevision,
      manifest_json: manifestRaw,
      manifest_sha256: manifestSha,
      package_digest: saved.packageDigest,
      workflow_id: wfDef.id,
      workflow_sha256: wfSha,
      readiness: 'ready',
      files: saved.files,
    });

    const webUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/#task-${taskId}`;
    logger.info(`[PackageService] Submitted task package ${taskId} r${targetRevision} (${manifest.title})`);

    return {
      ok: true,
      task_id: taskId,
      revision: targetRevision,
      status: TaskStatus.PENDING_CONFIRM,
      web_url: webUrl,
    };
  }

  getPackage(query: {
    task_id?: string;
    revision?: number;
    resource_path?: string;
    offset_bytes?: number;
    max_bytes?: number;
  }) {
    if (!query.task_id) {
      throw new PackageProtocolError('INVALID_MANIFEST_SCHEMA', '必须提供 task_id');
    }

    const task = db.getTask(query.task_id);
    if (!task) {
      throw new PackageProtocolError('TASK_NOT_FOUND', `未找到任务: ${query.task_id}`);
    }
    const revNum = query.revision ?? task.revision;
    const revRecord = db.getRevision(query.task_id, revNum);
    if (!revRecord) {
      throw new PackageProtocolError('TASK_NOT_FOUND', `任务 ${query.task_id} 不存在修订 r${revNum}`);
    }

    const revDir = taskFileStore.getRevisionDir(query.task_id, revNum);
    const files = db.getPackageFiles(query.task_id, revNum);
    const manifest = JSON.parse(revRecord.manifest_json) as TaskPackageManifest;

    if (query.resource_path) {
      const reg = files.find((f) => f.path === query.resource_path);
      if (!reg && query.resource_path !== 'manifest.json') {
        throw new PackageProtocolError('MISSING_FILE', `资源未在修订 r${revNum} 中登记: ${query.resource_path}`, [
          { path: query.resource_path },
        ]);
      }
      return {
        ok: true,
        task_id: task.id,
        revision: revNum,
        status: task.status,
        package_digest: revRecord.package_digest,
        resource: taskFileStore.readSliceFromDir(
          revDir,
          query.resource_path,
          reg?.media_type || 'application/json',
          query.offset_bytes ?? 0,
          query.max_bytes ?? PACKAGE_LIMITS.max_read_chunk_bytes
        ),
      };
    }

    return {
      ok: true,
      task_id: task.id,
      task_key: task.task_key,
      title: task.title,
      revision: revNum,
      status: task.status,
      workflow_id: revRecord.workflow_id,
      workflow_definition_sha256: revRecord.workflow_sha256,
      manifest_sha256: revRecord.manifest_sha256,
      package_digest: revRecord.package_digest,
      readiness: revRecord.readiness,
      manifest,
      files: files.map((f) => ({
        ...f,
        resource_ref: `pkg://${task.id}/r${revNum}/${f.path}`,
      })),
      web_url: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/#task-${task.id}`,
    };
  }

  getNodeContext(query: {
    task_id: string;
    node_id: string;
    attempt_id: string;
    completion_token: string;
    resource_path?: string;
    offset_bytes?: number;
    max_bytes?: number;
  }) {
    if (taskCleanupService.isTaskDeleting(query.task_id)) {
      throw new PackageProtocolError('TASK_DELETING', `任务 ${query.task_id} 正在清理删除中`);
    }

    const run = db.getNodeRunByRunId(query.attempt_id);
    if (!run || run.task_id !== query.task_id || run.node_id !== query.node_id) {
      throw new PackageProtocolError('ACCESS_DENIED', '执行记录与任务或节点不匹配');
    }
    if (!run.completion_token || run.completion_token !== query.completion_token) {
      throw new PackageProtocolError('ACCESS_DENIED', '执行凭据 (completion_token) 无效');
    }
    if (!run.attempt_dir || !fs.existsSync(run.attempt_dir)) {
      throw new PackageProtocolError('MISSING_FILE', '节点运行上下文目录不存在');
    }

    const contextBuf = readRegularFileSafely(run.attempt_dir, 'context.json');
    const context = JSON.parse(contextBuf.toString('utf8'));

    if (!query.resource_path) {
      return {
        ok: true,
        context,
      };
    }

    const reqPath = query.resource_path;
    const nodeDirName = encodeNodeDirName(query.node_id);
    const nodePrefix = `nodes/${nodeDirName}/`;

    let mappedAttemptRel: string | null = null;
    if (reqPath === 'context.json') {
      mappedAttemptRel = 'context.json';
    } else if (reqPath === context.rework_feedback_file) {
      mappedAttemptRel = reqPath;
    } else if ((context.allowed_material_files as string[]).includes(reqPath)) {
      if (reqPath.startsWith(nodePrefix)) {
        mappedAttemptRel = `material/${reqPath.slice(nodePrefix.length)}`;
      } else {
        mappedAttemptRel = reqPath;
      }
    } else if ((context.allowed_shared_files as string[]).includes(reqPath)) {
      mappedAttemptRel = reqPath.startsWith('shared/') ? reqPath : `shared/${reqPath}`;
    } else if (reqPath.startsWith('material/') || reqPath.startsWith('shared/') || reqPath.startsWith('inputs/')) {
      const fullCandidate = path.join(run.attempt_dir, ...reqPath.split('/'));
      if (fs.existsSync(fullCandidate)) {
        mappedAttemptRel = reqPath;
      }
    } else if (reqPath.startsWith('outputs/')) {
      const fullCandidate = path.join(run.attempt_dir, ...reqPath.split('/'));
      if (fs.existsSync(fullCandidate)) {
        mappedAttemptRel = reqPath;
      }
    }

    if (!mappedAttemptRel) {
      throw new PackageProtocolError(
        'ACCESS_DENIED',
        `节点 [${query.node_id}] 无权访问未授权资源或他节点私有材料: ${reqPath}`,
        [{ node_id: query.node_id, path: reqPath }]
      );
    }

    return {
      ok: true,
      task_id: query.task_id,
      node_id: query.node_id,
      attempt_id: query.attempt_id,
      resource: taskFileStore.readSliceFromDir(
        run.attempt_dir,
        mappedAttemptRel,
        '',
        query.offset_bytes ?? 0,
        query.max_bytes ?? PACKAGE_LIMITS.max_read_chunk_bytes
      ),
    };
  }
}

export const packageService = new PackageService();
