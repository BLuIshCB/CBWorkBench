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
import { GitService } from './gitService.ts';
import { resolveExecutionTimeout } from './executionPolicy.ts';
import { workflowEngine } from './workflowEngine.ts';
import { taskCleanupService } from './taskCleanupService.ts';
import {
  type WorkflowDefinition,
  type WorkflowNode,
  computeWorkflowDefinitionSha256,
} from './workflowDefinition.ts';
import {
  PACKAGE_LIMITS,
  PACKAGE_PROTOCOL_VERSION,
  PackageProtocolError,
  buildPackageProtocolSpec,
  finalizePackageInputSchema,
  manifestSchema,
  stagePackageInputSchema,
  validateManifestSemantics,
  type TaskPackageManifest,
} from './packageProtocol.ts';
import {
  PathSecurityError,
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

  cleanupExpiredDrafts(): void {
    const now = Date.now();
    const expired = db.listExpiredDrafts(now);
    for (const draft of expired) {
      if (taskCleanupService.isTaskDeleting(draft.task_id)) continue;
      if (workflowEngine.getActiveTaskId() === draft.task_id) continue;
      try {
        taskFileStore.removeStagingDraft(draft.task_id, draft.draft_id);
        if (draft.operation === 'create' && !db.getTask(draft.task_id)) {
          taskFileStore.cleanupEmptyStagingTaskDir(draft.task_id);
        }
        db.deleteDraft(draft.draft_id);
      } catch (err: any) {
        logger.warn(`[PackageService] Failed to clean expired draft ${draft.draft_id}: ${err?.message || err}`);
      }
    }
  }

  stagePackage(rawInput: unknown) {
    this.cleanupExpiredDrafts();

    const parsedInput = stagePackageInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new PackageProtocolError(
        'INVALID_MANIFEST_SCHEMA',
        `暂存请求参数不合法: ${parsedInput.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        parsedInput.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message }))
      );
    }

    const input = parsedInput.data;
    if (input.protocol_version !== PACKAGE_PROTOCOL_VERSION) {
      throw new PackageProtocolError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        `不支持的任务包协议版本: ${input.protocol_version}，当前仅支持 ${PACKAGE_PROTOCOL_VERSION}`
      );
    }

    if (input.source.mode !== 'local_path') {
      throw new PackageProtocolError(
        'UNSUPPORTED_SOURCE_MODE',
        `不支持的传输模式: ${input.source.mode}，当前仅支持 local_path 本机路径导入`
      );
    }

    // Idempotency check before touching files or creating tasks
    const existingByKey = db.getDraftByIdempotencyKey(input.idempotency_key);
    if (existingByKey) {
      if (existingByKey.manifest_sha256 !== input.source.manifest_sha256) {
        throw new PackageProtocolError(
          'IDEMPOTENCY_CONFLICT',
          `幂等键 [${input.idempotency_key}] 已绑定其他 Manifest 摘要，禁止复用`
        );
      }
      if (existingByKey.status === 'finalized' && existingByKey.receipt_json) {
        return {
          ...JSON.parse(existingByKey.receipt_json),
          idempotent_replay: true,
        };
      }
      return {
        ok: true,
        idempotent_replay: true,
        draft_id: existingByKey.draft_id,
        task_id: existingByKey.task_id,
        operation: existingByKey.operation,
        target_revision: existingByKey.target_revision,
        status: existingByKey.status,
        readiness: existingByKey.readiness,
        blockers: JSON.parse(existingByKey.blockers_json),
        manifest_sha256: existingByKey.manifest_sha256,
        package_digest: existingByKey.manifest_sha256,
        validation: {
          valid: JSON.parse(existingByKey.validation_errors_json).length === 0,
          errors: JSON.parse(existingByKey.validation_errors_json),
        },
      };
    }

    let taskId: string;
    let targetRevision: number;
    let expectedRevision: number | null = null;

    if (input.operation === 'create') {
      if (input.task_id) {
        if (taskCleanupService.isTaskDeleting(input.task_id)) {
          throw new PackageProtocolError('TASK_DELETING', `任务 ${input.task_id} 正在清理删除中`);
        }
        if (db.getTask(input.task_id)) {
          throw new PackageProtocolError('REVISION_CONFLICT', `任务 ID 已存在: ${input.task_id}`);
        }
        taskId = input.task_id;
      } else {
        taskId = `task-${crypto.randomBytes(6).toString('hex')}`;
      }
      targetRevision = 1;
    } else {
      if (!input.task_id || input.expected_revision === undefined) {
        throw new PackageProtocolError(
          'INVALID_MANIFEST_SCHEMA',
          'revise 操作必须同时提供 task_id 和 expected_revision'
        );
      }
      taskId = input.task_id;
      expectedRevision = input.expected_revision;
      if (taskCleanupService.isTaskDeleting(taskId)) {
        throw new PackageProtocolError('TASK_DELETING', `任务 ${taskId} 正在清理删除中，禁止提交新修订`);
      }
      const existingTask = db.getTask(taskId);
      if (!existingTask) {
        throw new PackageProtocolError('TASK_NOT_FOUND', `未找到待修订任务: ${taskId}`);
      }
      if (
        existingTask.status === TaskStatus.RUNNING ||
        existingTask.status === TaskStatus.QUEUED ||
        workflowEngine.getActiveTaskId() === taskId
      ) {
        throw new PackageProtocolError(
          'TASK_RUNNING',
          `任务 ${taskId} 正在运行中，禁止替换生效材料；请先停止并确认进程退出后再提交新修订`
        );
      }
      if (existingTask.revision !== expectedRevision) {
        throw new PackageProtocolError(
          'REVISION_CONFLICT',
          `任务 ${taskId} 当前修订为 ${existingTask.revision}，与 expected_revision=${expectedRevision} 不符`
        );
      }
      targetRevision = expectedRevision + 1;
    }

    // Read manifest safely from local_path
    const packageRoot = input.source.package_root;
    if (!path.isAbsolute(packageRoot)) {
      throw new PackageProtocolError('SOURCE_UNAVAILABLE', `package_root 必须为绝对路径: ${packageRoot}`);
    }

    let manifestBuf: Buffer;
    try {
      manifestBuf = readRegularFileSafely(packageRoot, input.source.manifest_path);
    } catch (err: any) {
      throw new PackageProtocolError(
        err instanceof PathSecurityError ? err.code : 'SOURCE_UNAVAILABLE',
        `读取 Manifest 失败: ${err?.message || err}`,
        [{ path: input.source.manifest_path }]
      );
    }

    if (manifestBuf.length > PACKAGE_LIMITS.max_manifest_bytes) {
      throw new PackageProtocolError(
        'SIZE_LIMIT_EXCEEDED',
        `manifest.json 大小 (${manifestBuf.length}B) 超过上限 (${PACKAGE_LIMITS.max_manifest_bytes}B)`,
        [{ path: input.source.manifest_path }]
      );
    }

    try {
      validateUtf8NoBom(manifestBuf, 'application/json', input.source.manifest_path);
    } catch (err: any) {
      throw new PackageProtocolError(
        err instanceof PathSecurityError ? err.code : 'INVALID_UTF8',
        err?.message || 'Manifest UTF-8 校验失败',
        [{ path: input.source.manifest_path }]
      );
    }

    const actualManifestSha = computeBufferSha256(manifestBuf);
    if (actualManifestSha !== input.source.manifest_sha256) {
      throw new PackageProtocolError(
        'MANIFEST_HASH_MISMATCH',
        `Manifest SHA-256 不匹配 (declared ${input.source.manifest_sha256}, actual ${actualManifestSha})`,
        [{ path: input.source.manifest_path }]
      );
    }

    let rawManifestObj: unknown;
    try {
      rawManifestObj = JSON.parse(manifestBuf.toString('utf8'));
    } catch (err: any) {
      throw new PackageProtocolError(
        'INVALID_MANIFEST_SCHEMA',
        `Manifest JSON 解析失败: ${err?.message || err}`,
        [{ path: input.source.manifest_path }]
      );
    }

    const parsedManifest = manifestSchema.safeParse(rawManifestObj);
    if (!parsedManifest.success) {
      throw new PackageProtocolError(
        'INVALID_MANIFEST_SCHEMA',
        `Manifest 结构校验失败: ${parsedManifest.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        parsedManifest.error.issues.map((i) => ({
          field: i.path.join('.'),
          reason: i.message,
        }))
      );
    }

    const manifest = parsedManifest.data;
    if (manifest.revision !== targetRevision) {
      throw new PackageProtocolError(
        'REVISION_CONFLICT',
        `Manifest 中的 revision (${manifest.revision}) 与目标修订 (${targetRevision}) 不符`,
        [{ field: 'revision' }]
      );
    }

    const wfRow = db.getWorkflow(manifest.workflow.id);
    if (!wfRow) {
      throw new PackageProtocolError(
        'WORKFLOW_NOT_FOUND',
        `未找到工作流定义: ${manifest.workflow.id}`,
        [{ field: 'workflow.id' }]
      );
    }

    const wfDef = toWorkflowDefinition(wfRow);
    const semanticIssues = validateManifestSemantics(manifest, wfDef);
    if (semanticIssues.length > 0) {
      const first = semanticIssues[0];
      throw new PackageProtocolError(first.code, first.message, semanticIssues.flatMap((i) => i.details));
    }

    // Read & verify every declared file from local_path before staging
    const schemaPaths = new Set(
      manifest.nodes.map((n) => n.output_contract.schema_ref).filter((x): x is string => Boolean(x))
    );
    const fileBuffers: Array<{ path: string; buffer: Buffer }> = [];
    let totalBytes = 0;

    for (const f of manifest.files) {
      let buf: Buffer;
      try {
        buf = readRegularFileSafely(packageRoot, f.path);
      } catch (err: any) {
        throw new PackageProtocolError(
          err instanceof PathSecurityError ? err.code : 'MISSING_FILE',
          `读取文件 [${f.path}] 失败: ${err?.message || err}`,
          [{ path: f.path }]
        );
      }

      if (buf.length !== f.size_bytes) {
        throw new PackageProtocolError(
          'SIZE_MISMATCH',
          `文件 [${f.path}] 大小不匹配: 声明 ${f.size_bytes}B，实际 ${buf.length}B`,
          [{ path: f.path }]
        );
      }

      const actualSha = computeBufferSha256(buf);
      if (actualSha !== f.sha256) {
        throw new PackageProtocolError(
          'HASH_MISMATCH',
          `文件 [${f.path}] SHA-256 不匹配: 声明 ${f.sha256}，实际 ${actualSha}`,
          [{ path: f.path }]
        );
      }

      try {
        validateUtf8NoBom(buf, f.media_type, f.path);
      } catch (err: any) {
        throw new PackageProtocolError(
          err instanceof PathSecurityError ? err.code : 'INVALID_UTF8',
          err?.message || `编码校验失败: ${f.path}`,
          [{ path: f.path }]
        );
      }

      if (schemaPaths.has(f.path)) {
        try {
          const parsedSchema = JSON.parse(buf.toString('utf8'));
          if (!parsedSchema || typeof parsedSchema !== 'object' || Array.isArray(parsedSchema)) {
            throw new Error('Schema 顶层必须是 JSON 对象');
          }
        } catch (err: any) {
          throw new PackageProtocolError(
            'INVALID_OUTPUT_CONTRACT',
            `输出 Schema 资源 [${f.path}] 不是合法 JSON Schema 对象: ${err?.message || err}`,
            [{ path: f.path, field: 'output_contract.schema_ref' }]
          );
        }
      }

      totalBytes += buf.length;
      fileBuffers.push({ path: f.path, buffer: buf });
    }

    const draftId = `draft-${crypto.randomBytes(6).toString('hex')}`;
    taskFileStore.stagePackageFiles(taskId, draftId, manifestBuf, fileBuffers);

    const draft = db.saveDraft({
      draft_id: draftId,
      task_id: taskId,
      operation: input.operation,
      target_revision: targetRevision,
      expected_revision: expectedRevision,
      idempotency_key: input.idempotency_key,
      manifest_json: manifestBuf.toString('utf8'),
      manifest_sha256: actualManifestSha,
      workflow_id: manifest.workflow.id,
      workflow_sha256: manifest.workflow.definition_sha256,
      readiness: manifest.readiness,
      blockers_json: JSON.stringify(manifest.blockers),
      validation_errors_json: '[]',
      execution_timeout_ms: input.execution_timeout_ms ?? null,
      budget_max_rounds: input.budget_max_rounds ?? null,
      status: 'staging',
      receipt_json: null,
      expires_at: Date.now() + PACKAGE_LIMITS.staging_ttl_ms,
    });

    return {
      ok: true,
      draft_id: draft.draft_id,
      task_id: draft.task_id,
      operation: draft.operation,
      target_revision: draft.target_revision,
      status: draft.status,
      readiness: draft.readiness,
      blockers: manifest.blockers,
      workflow_id: manifest.workflow.id,
      workflow_definition_sha256: manifest.workflow.definition_sha256,
      manifest_sha256: actualManifestSha,
      package_digest: actualManifestSha,
      file_count: fileBuffers.length,
      total_bytes: totalBytes,
      validation: { valid: true, errors: [] },
    };
  }

  finalizePackage(rawInput: unknown) {
    const parsedInput = finalizePackageInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new PackageProtocolError(
        'INVALID_MANIFEST_SCHEMA',
        `提交确认参数不合法: ${parsedInput.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        parsedInput.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message }))
      );
    }

    const input = parsedInput.data;

    // Idempotency check
    const byKey = db.getDraftByIdempotencyKey(input.idempotency_key);
    if (byKey && byKey.status === 'finalized') {
      if (byKey.manifest_sha256 !== input.manifest_sha256 || byKey.draft_id !== input.draft_id) {
        throw new PackageProtocolError(
          'IDEMPOTENCY_CONFLICT',
          `幂等键 [${input.idempotency_key}] 已用于其他提交，禁止更改草稿或摘要重试`
        );
      }
      if (byKey.receipt_json && !input.validate_only) {
        return {
          ...JSON.parse(byKey.receipt_json),
          idempotent_replay: true,
        };
      }
    }

    const draft = db.getDraft(input.draft_id);
    if (!draft) {
      throw new PackageProtocolError('DRAFT_NOT_FOUND', `未找到暂存草稿: ${input.draft_id}`);
    }

    if (draft.manifest_sha256 !== input.manifest_sha256) {
      throw new PackageProtocolError(
        'MANIFEST_HASH_MISMATCH',
        `Manifest 摘要与暂存草稿不匹配 (expected ${draft.manifest_sha256}, got ${input.manifest_sha256})`
      );
    }

    if (draft.status === 'finalized' && draft.receipt_json && !input.validate_only) {
      if (draft.idempotency_key !== input.idempotency_key) {
        throw new PackageProtocolError(
          'IDEMPOTENCY_CONFLICT',
          `草稿 ${draft.draft_id} 已由其他幂等键正式提交`
        );
      }
      return {
        ...JSON.parse(draft.receipt_json),
        idempotent_replay: true,
      };
    }

    if (taskCleanupService.isTaskDeleting(draft.task_id)) {
      throw new PackageProtocolError('TASK_DELETING', `任务 ${draft.task_id} 正在清理删除中`);
    }

    const manifest = manifestSchema.parse(JSON.parse(draft.manifest_json));
    const issues: Array<{ code: string; message: string; details?: any }> = [];

    if (draft.operation === 'create') {
      if (db.getTask(draft.task_id)) {
        issues.push({ code: 'REVISION_CONFLICT', message: `任务 ID 已存在: ${draft.task_id}` });
      }
    } else {
      const existingTask = db.getTask(draft.task_id);
      if (!existingTask) {
        issues.push({ code: 'TASK_NOT_FOUND', message: `未找到任务: ${draft.task_id}` });
      } else if (
        existingTask.status === TaskStatus.RUNNING ||
        existingTask.status === TaskStatus.QUEUED ||
        workflowEngine.getActiveTaskId() === draft.task_id
      ) {
        issues.push({
          code: 'TASK_RUNNING',
          message: `任务 ${draft.task_id} 正在运行中，禁止替换材料`,
        });
      } else if (existingTask.revision !== draft.expected_revision) {
        issues.push({
          code: 'REVISION_CONFLICT',
          message: `任务修订冲突: 当前为 ${existingTask.revision}，期望 ${draft.expected_revision}`,
        });
      }
    }

    const wfRow = db.getWorkflow(manifest.workflow.id);
    if (!wfRow) {
      issues.push({ code: 'WORKFLOW_NOT_FOUND', message: `未找到工作流: ${manifest.workflow.id}` });
    } else {
      const wfDef = toWorkflowDefinition(wfRow);
      for (const sIssue of validateManifestSemantics(manifest, wfDef)) {
        issues.push(sIssue);
      }
    }

    try {
      taskFileStore.verifyStagedPackage(draft.task_id, draft.draft_id, manifest, draft.manifest_sha256);
    } catch (err: any) {
      issues.push({
        code: err instanceof PackageProtocolError ? err.code : 'HASH_MISMATCH',
        message: err?.message || '暂存文件完整性校验失败',
        details: err instanceof PackageProtocolError ? err.details : [],
      });
    }

    const totalBytes = manifest.files.reduce((acc, f) => acc + f.size_bytes, 0);

    if (input.validate_only) {
      return {
        ok: issues.length === 0 && manifest.readiness === 'ready',
        validate_only: true,
        draft_id: draft.draft_id,
        task_id: draft.task_id,
        revision: draft.target_revision,
        readiness: manifest.readiness,
        blockers: manifest.blockers,
        workflow_id: manifest.workflow.id,
        workflow_definition_sha256: manifest.workflow.definition_sha256,
        manifest_sha256: draft.manifest_sha256,
        package_digest: draft.manifest_sha256,
        integrity: {
          valid: issues.length === 0,
          file_count: manifest.files.length,
          total_bytes: totalBytes,
        },
        issues,
      };
    }

    if (issues.length > 0) {
      const first = issues[0];
      throw new PackageProtocolError(
        first.code,
        first.message,
        issues.flatMap((i) => i.details || [])
      );
    }

    if (manifest.readiness !== 'ready') {
      throw new PackageProtocolError(
        'PACKAGE_NOT_READY',
        `任务包处于 blocked 状态，不能正式提交进入待启动确认：${manifest.blockers.join('；')}`,
        manifest.blockers.map((b) => ({ reason: b }))
      );
    }

    let gitInfo;
    try {
      gitInfo = GitService.inspectWorkspace(manifest.target_cwd);
    } catch (e: any) {
      gitInfo = {
        targetCwd: manifest.target_cwd,
        isGitRepo: false,
        gitRoot: null,
        branch: null,
        headCommit: null,
        isDirty: false,
        statusText: `Workspace inspection note: ${e.message}`,
      };
    }

    // 1. Promote files into immutable revision dir BEFORE committing formal DB transaction
    taskFileStore.promoteStagedToRevision(
      draft.task_id,
      draft.draft_id,
      draft.target_revision,
      manifest
    );

    const executionTimeoutMs = resolveExecutionTimeout(
      draft.execution_timeout_ms ?? undefined,
      null,
      manifest
    );

    const webUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/tasks/${draft.task_id}`;
    const receipt = {
      ok: true,
      task_id: draft.task_id,
      task_key: manifest.task_key,
      revision: draft.target_revision,
      status: TaskStatus.PENDING_CONFIRM,
      workflow_id: manifest.workflow.id,
      workflow_definition_sha256: manifest.workflow.definition_sha256,
      manifest_sha256: draft.manifest_sha256,
      package_digest: draft.manifest_sha256,
      integrity: {
        valid: true,
        file_count: manifest.files.length,
        total_bytes: totalBytes,
      },
      target_cwd: manifest.target_cwd,
      web_url: webUrl,
    };

    try {
      db.transaction(() => {
        // Re-verify inside transaction
        const latestWfRow = db.getWorkflow(manifest.workflow.id);
        if (!latestWfRow) {
          throw new PackageProtocolError('WORKFLOW_NOT_FOUND', `工作流不存在: ${manifest.workflow.id}`);
        }
        const latestSha = computeWorkflowDefinitionSha256(toWorkflowDefinition(latestWfRow));
        if (latestSha !== manifest.workflow.definition_sha256) {
          throw new PackageProtocolError(
            'WORKFLOW_HASH_MISMATCH',
            `提交期间工作流 [${manifest.workflow.id}] 已被修改，请重新生成 Manifest`
          );
        }

        if (draft.operation === 'create') {
          db.createTask({
            id: draft.task_id,
            task_key: manifest.task_key,
            revision: draft.target_revision,
            title: manifest.title,
            status: TaskStatus.PENDING_CONFIRM,
            target_cwd: manifest.target_cwd,
            git_root: gitInfo.gitRoot,
            git_commit: gitInfo.headCommit,
            git_status: gitInfo.statusText,
            execution_timeout_ms: executionTimeoutMs,
            budget_max_rounds: draft.budget_max_rounds ?? undefined,
            workflow_id: manifest.workflow.id,
          });
          db.initTaskWorkflow(draft.task_id, {
            workflowId: manifest.workflow.id,
            workflowSha256: manifest.workflow.definition_sha256,
            revision: draft.target_revision,
          });
        } else {
          const curTask = db.getTask(draft.task_id);
          if (!curTask || curTask.revision !== draft.expected_revision) {
            throw new PackageProtocolError('REVISION_CONFLICT', '并发修订冲突，请刷新状态后重试');
          }
          db.updateTaskStatus(draft.task_id, TaskStatus.PENDING_CONFIRM, {
            title: manifest.title,
            target_cwd: manifest.target_cwd,
            revision: draft.target_revision,
            blocked_reason: null,
            stop_requested: 0,
            completed_at: null,
            execution_timeout_ms: executionTimeoutMs,
            ...(draft.budget_max_rounds ? { budget_max_rounds: draft.budget_max_rounds } : {}),
          });
          db.initTaskWorkflow(draft.task_id, {
            workflowId: manifest.workflow.id,
            workflowSha256: manifest.workflow.definition_sha256,
            revision: draft.target_revision,
          });
        }

        db.saveRevision({
          task_id: draft.task_id,
          revision: draft.target_revision,
          manifest_json: draft.manifest_json,
          manifest_sha256: draft.manifest_sha256,
          package_digest: draft.manifest_sha256,
          workflow_id: manifest.workflow.id,
          workflow_sha256: manifest.workflow.definition_sha256,
          readiness: manifest.readiness,
          idempotency_key: input.idempotency_key,
          files: manifest.files.map((f) => ({
            path: f.path,
            owner_scope: f.owner.scope,
            owner_node_id: f.owner.scope === 'node' ? f.owner.node_id : null,
            media_type: f.media_type,
            size_bytes: f.size_bytes,
            sha256: f.sha256,
          })),
        });

        db.updateDraft(draft.draft_id, {
          status: 'finalized',
          receipt_json: JSON.stringify(receipt),
        });
      });
    } catch (err) {
      // If DB transaction fails for a new create, avoid leaving orphaned promoted files behind
      if (draft.operation === 'create' && !db.getTask(draft.task_id)) {
        try {
          taskFileStore.deleteTaskFiles(draft.task_id);
        } catch {}
      }
      throw err;
    }

    logger.info(`[PackageService] Finalized package ${draft.task_id} r${draft.target_revision} (${manifest.title})`);
    return receipt;
  }

  getPackage(query: {
    idempotency_key?: string;
    task_id?: string;
    revision?: number;
    draft_id?: string;
    resource_path?: string;
    offset_bytes?: number;
    max_bytes?: number;
  }) {
    if (query.idempotency_key) {
      const draft = db.getDraftByIdempotencyKey(query.idempotency_key);
      if (!draft) {
        throw new PackageProtocolError('DRAFT_NOT_FOUND', `未找到幂等键对应提交记录: ${query.idempotency_key}`);
      }
      if (draft.status === 'finalized') {
        return this.getPackage({
          task_id: draft.task_id,
          revision: draft.target_revision,
          resource_path: query.resource_path,
          offset_bytes: query.offset_bytes,
          max_bytes: query.max_bytes,
        });
      }
      const manifest = JSON.parse(draft.manifest_json) as TaskPackageManifest;
      const rootDir = taskFileStore.getStagingDir(draft.task_id, draft.draft_id);
      if (query.resource_path) {
        const reg = manifest.files.find((f) => f.path === query.resource_path);
        if (!reg && query.resource_path !== 'manifest.json') {
          throw new PackageProtocolError('MISSING_FILE', `资源未在清单中登记: ${query.resource_path}`, [
            { path: query.resource_path },
          ]);
        }
        return {
          ok: true,
          draft_id: draft.draft_id,
          task_id: draft.task_id,
          revision: draft.target_revision,
          status: draft.status,
          resource: taskFileStore.readSliceFromDir(
            rootDir,
            query.resource_path,
            reg?.media_type || 'application/json',
            query.offset_bytes ?? 0,
            query.max_bytes ?? PACKAGE_LIMITS.max_read_chunk_bytes
          ),
        };
      }
      return {
        ok: true,
        draft_id: draft.draft_id,
        task_id: draft.task_id,
        revision: draft.target_revision,
        status: draft.status,
        readiness: draft.readiness,
        blockers: JSON.parse(draft.blockers_json),
        manifest_sha256: draft.manifest_sha256,
        package_digest: draft.manifest_sha256,
        manifest,
      };
    }

    if (query.draft_id) {
      const draft = db.getDraft(query.draft_id);
      if (!draft) {
        throw new PackageProtocolError('DRAFT_NOT_FOUND', `未找到草稿: ${query.draft_id}`);
      }
      if (draft.status === 'finalized') {
        return this.getPackage({
          task_id: draft.task_id,
          revision: draft.target_revision,
          resource_path: query.resource_path,
          offset_bytes: query.offset_bytes,
          max_bytes: query.max_bytes,
        });
      }
      const manifest = JSON.parse(draft.manifest_json) as TaskPackageManifest;
      return {
        ok: true,
        draft_id: draft.draft_id,
        task_id: draft.task_id,
        revision: draft.target_revision,
        status: draft.status,
        readiness: draft.readiness,
        blockers: JSON.parse(draft.blockers_json),
        manifest_sha256: draft.manifest_sha256,
        package_digest: draft.manifest_sha256,
        manifest,
      };
    }

    if (!query.task_id) {
      throw new PackageProtocolError('INVALID_MANIFEST_SCHEMA', '必须提供 task_id、draft_id 或 idempotency_key');
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
      web_url: `http://${DEFAULT_HOST}:${DEFAULT_PORT}/tasks/${task.id}`,
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

    // Map allowed package-relative OR attempt-relative path strictly inside THIS node's materialized view!
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
      }
    } else if ((context.allowed_shared_files as string[]).includes(reqPath)) {
      mappedAttemptRel = reqPath; // shared/resources/... matches attemptDir/shared/resources/...
    } else if ((context.inputs as Array<{ mounted_path: string }>).some((i) => i.mounted_path === reqPath)) {
      mappedAttemptRel = reqPath;
    } else if (reqPath.startsWith('material/') || reqPath.startsWith('shared/') || reqPath.startsWith('inputs/')) {
      // Allow direct attempt-relative path only if it maps to a materialized file inside this attempt
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
