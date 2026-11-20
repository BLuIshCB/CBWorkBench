import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TASKS_DATA_DIR } from '../config/constants.ts';
import {
  encodeNodeDirName,
  readRegularFileSafely,
  validatePackageRelativePath,
  validateUtf8NoBom,
  isTextMediaType,
  computeBufferSha256,
  setFileReadOnly,
  safeRemoveDirInsideBase,
  PathSecurityError,
} from '../utils/pathSecurity.ts';
import {
  PACKAGE_LIMITS,
  PackageProtocolError,
  type ManifestNodeEntry,
  type TaskPackageManifest,
} from '../services/packageProtocol.ts';

export interface ResourceSliceResult {
  path: string;
  encoding: 'utf-8' | 'base64';
  content: string;
  total_bytes: number;
  offset_bytes: number;
  bytes_read: number;
  next_offset: number;
  has_more: boolean;
  truncated: boolean;
  sha256: string;
}

export interface BoundInputEntry {
  slot: string;
  from_node_id: string;
  output: string;
  source_attempt_id: string;
  source_execution_index: number;
  source_code_generation: number;
  source_path: string;
  mounted_path: string;
  sha256: string;
  size_bytes: number;
}

export interface MaterializedAttemptPaths {
  attemptDir: string;
  contextPath: string;
  materialDir: string;
  sharedDir: string;
  inputsDir: string;
  outputsDir: string;
  logsDir: string;
  tempDir: string;
}

export function formatRevisionFolder(revision: number): string {
  return `r${String(revision).padStart(4, '0')}`;
}

function assertSafeId(id: string, label: string): void {
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new PackageProtocolError('INVALID_RESOURCE_PATH', `非法的 ${label}: ${id}`);
  }
}

export class TaskFileStore {
  private baseDir: string;

  constructor(baseDir: string = TASKS_DATA_DIR) {
    this.baseDir = path.resolve(baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getTaskRootDir(taskId: string): string {
    assertSafeId(taskId, 'task_id');
    return path.join(this.baseDir, taskId);
  }

  getStagingRootDir(taskId: string): string {
    return path.join(this.getTaskRootDir(taskId), '.staging');
  }

  getStagingDir(taskId: string, draftId: string): string {
    assertSafeId(draftId, 'draft_id');
    return path.join(this.getStagingRootDir(taskId), draftId);
  }

  getRevisionDir(taskId: string, revision: number): string {
    return path.join(this.getTaskRootDir(taskId), 'revisions', formatRevisionFolder(revision));
  }

  getRunsRevisionDir(taskId: string, revision: number): string {
    return path.join(this.getTaskRootDir(taskId), 'runs', formatRevisionFolder(revision));
  }

  getNodeRunDir(taskId: string, revision: number, nodeId: string, attemptId: string): string {
    assertSafeId(attemptId, 'attempt_id');
    return path.join(
      this.getRunsRevisionDir(taskId, revision),
      encodeNodeDirName(nodeId),
      attemptId
    );
  }

  stagePackageFiles(
    taskId: string,
    draftId: string,
    manifestRaw: Buffer,
    fileEntries: Array<{ path: string; buffer: Buffer }>
  ): string {
    const stagingDir = this.getStagingDir(taskId, draftId);
    if (fs.existsSync(stagingDir)) {
      safeRemoveDirInsideBase(this.baseDir, stagingDir);
    }
    fs.mkdirSync(stagingDir, { recursive: true });

    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), manifestRaw);
    for (const entry of fileEntries) {
      const check = validatePackageRelativePath(entry.path);
      if (!check.valid) {
        throw new PackageProtocolError('INVALID_RESOURCE_PATH', `非法路径 ${entry.path}: ${check.reason}`, [
          { path: entry.path },
        ]);
      }
      const destPath = path.join(stagingDir, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.buffer);
    }

    return stagingDir;
  }

  verifyStagedPackage(
    taskId: string,
    draftId: string,
    manifest: TaskPackageManifest,
    expectedManifestSha256: string
  ): void {
    const stagingDir = this.getStagingDir(taskId, draftId);
    if (!fs.existsSync(stagingDir)) {
      throw new PackageProtocolError('DRAFT_NOT_FOUND', `暂存目录不存在: ${draftId}`);
    }

    let manifestBuf: Buffer;
    try {
      manifestBuf = readRegularFileSafely(stagingDir, 'manifest.json');
    } catch (err: any) {
      throw new PackageProtocolError(
        err instanceof PathSecurityError ? err.code : 'MISSING_FILE',
        `暂存 Manifest 缺失或不可读: ${err?.message || err}`,
        [{ path: 'manifest.json' }]
      );
    }

    const actualManifestSha = computeBufferSha256(manifestBuf);
    if (actualManifestSha !== expectedManifestSha256) {
      throw new PackageProtocolError(
        'MANIFEST_HASH_MISMATCH',
        `暂存 Manifest 哈希不匹配 (expected ${expectedManifestSha256}, actual ${actualManifestSha})`,
        [{ path: 'manifest.json' }]
      );
    }

    for (const fileMeta of manifest.files) {
      let buf: Buffer;
      try {
        buf = readRegularFileSafely(stagingDir, fileMeta.path);
      } catch (err: any) {
        throw new PackageProtocolError(
          err instanceof PathSecurityError ? err.code : 'MISSING_FILE',
          `暂存文件核验失败 [${fileMeta.path}]: ${err?.message || err}`,
          [{ path: fileMeta.path }]
        );
      }

      if (buf.length !== fileMeta.size_bytes) {
        throw new PackageProtocolError(
          'SIZE_MISMATCH',
          `暂存文件大小不符 [${fileMeta.path}]: 声明 ${fileMeta.size_bytes}B，实际 ${buf.length}B`,
          [{ path: fileMeta.path }]
        );
      }

      const actualSha = computeBufferSha256(buf);
      if (actualSha !== fileMeta.sha256) {
        throw new PackageProtocolError(
          'HASH_MISMATCH',
          `暂存文件 SHA-256 不符 [${fileMeta.path}]: 声明 ${fileMeta.sha256}，实际 ${actualSha}`,
          [{ path: fileMeta.path }]
        );
      }

      try {
        validateUtf8NoBom(buf, fileMeta.media_type, fileMeta.path);
      } catch (err: any) {
        throw new PackageProtocolError(
          err instanceof PathSecurityError ? err.code : 'INVALID_UTF8',
          err?.message || `文本编码校验失败: ${fileMeta.path}`,
          [{ path: fileMeta.path }]
        );
      }
    }
  }

  promoteStagedToRevision(
    taskId: string,
    draftId: string,
    revision: number,
    manifest: TaskPackageManifest
  ): string {
    const stagingDir = this.getStagingDir(taskId, draftId);
    const revDir = this.getRevisionDir(taskId, revision);

    if (fs.existsSync(revDir)) {
      throw new PackageProtocolError('REVISION_CONFLICT', `正式修订目录已存在: r${revision}`);
    }

    const tmpTargetDir = path.join(
      this.getTaskRootDir(taskId),
      'revisions',
      `.tmp_${formatRevisionFolder(revision)}_${crypto.randomBytes(4).toString('hex')}`
    );

    fs.mkdirSync(path.join(tmpTargetDir, 'shared', 'resources'), { recursive: true });
    for (const n of manifest.nodes) {
      const nodeDir = encodeNodeDirName(n.node_id);
      fs.mkdirSync(path.join(tmpTargetDir, 'nodes', nodeDir, 'resources'), { recursive: true });
    }

    const manifestBuf = readRegularFileSafely(stagingDir, 'manifest.json');
    const destManifest = path.join(tmpTargetDir, 'manifest.json');
    fs.writeFileSync(destManifest, manifestBuf);
    setFileReadOnly(destManifest);

    for (const fileMeta of manifest.files) {
      const buf = readRegularFileSafely(stagingDir, fileMeta.path);
      const dest = path.join(tmpTargetDir, ...fileMeta.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      setFileReadOnly(dest);
    }

    fs.renameSync(tmpTargetDir, revDir);
    safeRemoveDirInsideBase(this.baseDir, stagingDir);
    return revDir;
  }

  removeStagingDraft(taskId: string, draftId: string): void {
    const stagingDir = this.getStagingDir(taskId, draftId);
    if (fs.existsSync(stagingDir)) {
      safeRemoveDirInsideBase(this.baseDir, stagingDir);
    }
  }

  cleanupEmptyStagingTaskDir(taskId: string): void {
    const taskRoot = this.getTaskRootDir(taskId);
    const revRoot = path.join(taskRoot, 'revisions');
    if (!fs.existsSync(revRoot)) {
      safeRemoveDirInsideBase(this.baseDir, taskRoot);
    }
  }

  readSliceFromDir(
    rootDir: string,
    relPath: string,
    mediaType: string = '',
    offsetBytes: number = 0,
    maxBytes: number = PACKAGE_LIMITS.max_read_chunk_bytes
  ): ResourceSliceResult {
    const safeOffset = Math.max(0, Math.floor(offsetBytes));
    const safeMax = Math.max(1, Math.min(PACKAGE_LIMITS.max_read_chunk_bytes, Math.floor(maxBytes)));

    let buf: Buffer;
    try {
      buf = readRegularFileSafely(rootDir, relPath);
    } catch (err: any) {
      throw new PackageProtocolError(
        err instanceof PathSecurityError ? err.code : 'MISSING_FILE',
        err?.message || `无法读取资源: ${relPath}`,
        [{ path: relPath }]
      );
    }

    const sha256 = computeBufferSha256(buf);
    const totalBytes = buf.length;
    const clampedStart = Math.min(safeOffset, totalBytes);
    let end = Math.min(totalBytes, clampedStart + safeMax);

    const textMode = isTextMediaType(mediaType, relPath);
    if (textMode && end < totalBytes && end > clampedStart) {
      // Avoid slicing in the middle of a multi-byte UTF-8 sequence
      let back = 0;
      while (back < 3 && end - back > clampedStart && (buf[end - back] & 0xc0) === 0x80) {
        back++;
      }
      if (back > 0 && end - back > clampedStart) {
        end -= back;
      }
    }

    const slice = buf.subarray(clampedStart, end);
    return {
      path: relPath,
      encoding: textMode ? 'utf-8' : 'base64',
      content: textMode ? slice.toString('utf8') : slice.toString('base64'),
      total_bytes: totalBytes,
      offset_bytes: clampedStart,
      bytes_read: slice.length,
      next_offset: end,
      has_more: end < totalBytes,
      truncated: clampedStart > 0 || end < totalBytes,
      sha256,
    };
  }

  materializeNodeRunDirectory(params: {
    taskId: string;
    revision: number;
    packageDigest: string;
    workflowId: string;
    workflowSha256: string;
    nodeId: string;
    nodeName: string;
    executionMode: string;
    resultRule?: string;
    attemptId: string;
    executionIndex: number;
    codeGeneration: number;
    targetCwd: string;
    manifestNode: ManifestNodeEntry;
    boundInputs: Array<BoundInputEntry & { sourceAbsPath: string }>;
    reworkFeedback?: string;
    completionToken: string;
  }): { paths: MaterializedAttemptPaths; context: Record<string, unknown> } {
    const revDir = this.getRevisionDir(params.taskId, params.revision);
    const attemptDir = this.getNodeRunDir(params.taskId, params.revision, params.nodeId, params.attemptId);

    const materialDir = path.join(attemptDir, 'material');
    const sharedDir = path.join(attemptDir, 'shared');
    const inputsDir = path.join(attemptDir, 'inputs');
    const outputsDir = path.join(attemptDir, 'outputs');
    const logsDir = path.join(attemptDir, 'logs');
    const tempDir = path.join(attemptDir, 'temp');

    for (const d of [
      path.join(materialDir, 'resources'),
      path.join(sharedDir, 'resources'),
      inputsDir,
      outputsDir,
      logsDir,
      tempDir,
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }

    const nodeDirName = encodeNodeDirName(params.nodeId);
    const allowedMaterialFiles: string[] = [];
    const copyFrozenToAttempt = (pkgRelPath: string, destRelInsideAttempt: string) => {
      const buf = readRegularFileSafely(revDir, pkgRelPath);
      const destPath = path.join(attemptDir, ...destRelInsideAttempt.split('/'));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      setFileReadOnly(destPath);
    };

    // 1. Copy ONLY this node's own node.md, prompt.md, and resources/*
    copyFrozenToAttempt(params.manifestNode.node_ref, 'material/node.md');
    allowedMaterialFiles.push(params.manifestNode.node_ref);

    copyFrozenToAttempt(params.manifestNode.prompt_ref, 'material/prompt.md');
    allowedMaterialFiles.push(params.manifestNode.prompt_ref);

    const nodeResPrefix = `nodes/${nodeDirName}/resources/`;
    for (const res of params.manifestNode.resources) {
      const subPath = res.path.startsWith(nodeResPrefix)
        ? res.path.slice(nodeResPrefix.length)
        : path.posix.basename(res.path);
      copyFrozenToAttempt(res.path, `material/resources/${subPath}`);
      allowedMaterialFiles.push(res.path);
    }

    // 2. Copy ONLY this node's explicitly declared shared_refs
    const allowedSharedFiles: string[] = [];
    for (const sharedPath of params.manifestNode.shared_refs) {
      const subPath = sharedPath.startsWith('shared/resources/')
        ? sharedPath.slice('shared/resources/'.length)
        : path.posix.basename(sharedPath);
      copyFrozenToAttempt(sharedPath, `shared/resources/${subPath}`);
      allowedSharedFiles.push(sharedPath);
    }

    // 3. Copy resolved bound upstream inputs
    const materializedInputs: BoundInputEntry[] = [];
    for (const item of params.boundInputs) {
      const destAbs = path.join(attemptDir, ...item.mounted_path.split('/'));
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      const buf = fs.readFileSync(item.sourceAbsPath);
      fs.writeFileSync(destAbs, buf);
      setFileReadOnly(destAbs);
      materializedInputs.push({
        slot: item.slot,
        from_node_id: item.from_node_id,
        output: item.output,
        source_attempt_id: item.source_attempt_id,
        source_execution_index: item.source_execution_index,
        source_code_generation: item.source_code_generation,
        source_path: item.source_path,
        mounted_path: item.mounted_path,
        sha256: item.sha256,
        size_bytes: item.size_bytes,
      });
    }

    let reworkFeedbackPath: string | null = null;
    if (params.reworkFeedback && params.reworkFeedback.trim()) {
      reworkFeedbackPath = 'inputs/rework-feedback.md';
      const fbAbs = path.join(inputsDir, 'rework-feedback.md');
      fs.writeFileSync(fbAbs, params.reworkFeedback, 'utf8');
      setFileReadOnly(fbAbs);
    }

    const context: Record<string, unknown> = {
      schema_version: 'cb.node-context/1.0',
      task_id: params.taskId,
      revision: params.revision,
      package_digest: params.packageDigest,
      workflow: {
        id: params.workflowId,
        definition_sha256: params.workflowSha256,
      },
      node: {
        id: params.nodeId,
        dir_name: nodeDirName,
        name: params.nodeName,
        execution_mode: params.executionMode,
        result_rule: params.resultRule || 'default',
      },
      attempt: {
        attempt_id: params.attemptId,
        execution_index: params.executionIndex,
        code_generation: params.codeGeneration,
      },
      workspace: {
        target_cwd: params.targetCwd,
      },
      paths: {
        attempt_dir: attemptDir,
        material_dir: materialDir,
        shared_dir: sharedDir,
        inputs_dir: inputsDir,
        outputs_dir: outputsDir,
        logs_dir: logsDir,
        temp_dir: tempDir,
      },
      allowed_material_files: allowedMaterialFiles,
      allowed_shared_files: allowedSharedFiles,
      inputs: materializedInputs,
      rework_feedback_file: reworkFeedbackPath,
      rework_feedback: params.reworkFeedback || null,
      output_contract: params.manifestNode.output_contract,
      completion_protocol: {
        tool: 'workbench_advance_workflow',
        task_id: params.taskId,
        node_id: params.nodeId,
        attempt_id: params.attemptId,
        completion_token: params.completionToken,
        result_file: 'outputs/result.json',
      },
    };

    const contextPath = path.join(attemptDir, 'context.json');
    fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n', 'utf8');
    setFileReadOnly(contextPath);

    return {
      paths: {
        attemptDir,
        contextPath,
        materialDir,
        sharedDir,
        inputsDir,
        outputsDir,
        logsDir,
        tempDir,
      },
      context,
    };
  }

  deleteTaskFiles(taskId: string): boolean {
    const taskDir = this.getTaskRootDir(taskId);
    if (!fs.existsSync(taskDir)) {
      return false;
    }
    safeRemoveDirInsideBase(this.baseDir, taskDir);
    return true;
  }

  static computeSha256(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

export const taskFileStore = new TaskFileStore();
