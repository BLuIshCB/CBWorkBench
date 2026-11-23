import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TASKS_DATA_DIR } from '../config/constants.ts';
import {
  encodeNodeDirName,
  readRegularFileSafely,
  validatePackageRelativePath,
  isTextMediaType,
  computeBufferSha256,
  setFileReadOnly,
  safeRemoveDirInsideBase,
  PathSecurityError,
} from '../utils/pathSecurity.ts';
import {
  PACKAGE_LIMITS,
  PackageProtocolError,
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

  /**
   * 将源任务包目录完整原子归档至正式修订目录 tasks/<taskId>/revisions/rNNNN/
   */
  saveTaskRevisionFromDirectory(
    taskId: string,
    revision: number,
    packageRoot: string
  ): {
    files: Array<{
      path: string;
      owner_scope: 'shared' | 'node';
      owner_node_id?: string;
      media_type: string;
      size_bytes: number;
      sha256: string;
    }>;
    packageDigest: string;
    manifestBuf: Buffer;
  } {
    const revDir = this.getRevisionDir(taskId, revision);
    if (fs.existsSync(revDir)) {
      throw new PackageProtocolError('REVISION_CONFLICT', `正式修订目录已存在: r${revision}`);
    }

    const taskRoot = this.getTaskRootDir(taskId);
    const revisionsDir = path.join(taskRoot, 'revisions');
    fs.mkdirSync(revisionsDir, { recursive: true });

    const tmpTargetDir = path.join(
      revisionsDir,
      `.tmp_${formatRevisionFolder(revision)}_${crypto.randomBytes(4).toString('hex')}`
    );
    fs.mkdirSync(tmpTargetDir, { recursive: true });

    const registeredFiles: Array<{
      path: string;
      owner_scope: 'shared' | 'node';
      owner_node_id?: string;
      media_type: string;
      size_bytes: number;
      sha256: string;
    }> = [];

    const copyFileSafely = (relPath: string, ownerScope: 'shared' | 'node', ownerNodeId?: string) => {
      const buf = readRegularFileSafely(packageRoot, relPath);
      const destPath = path.join(tmpTargetDir, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      setFileReadOnly(destPath);

      const mediaType = relPath.endsWith('.json')
        ? 'application/json'
        : relPath.endsWith('.md')
        ? 'text/markdown'
        : 'text/plain';

      registeredFiles.push({
        path: relPath,
        owner_scope: ownerScope,
        owner_node_id: ownerNodeId,
        media_type: mediaType,
        size_bytes: buf.length,
        sha256: computeBufferSha256(buf),
      });
      return buf;
    };

    // 1. 复制顶层文件
    const manifestBuf = copyFileSafely('manifest.json', 'shared');
    copyFileSafely('requirements.md', 'shared');
    copyFileSafely('development.md', 'shared');

    // 2. 递归复制 nodes/ 下的文件
    const nodesDir = path.join(packageRoot, 'nodes');
    if (fs.existsSync(nodesDir) && fs.statSync(nodesDir).isDirectory()) {
      const scanDirRecursively = (currentAbsDir: string, currentRelDir: string) => {
        const entries = fs.readdirSync(currentAbsDir);
        for (const entry of entries) {
          const entryAbs = path.join(currentAbsDir, entry);
          const entryRel = path.posix.join(currentRelDir, entry);
          const stat = fs.statSync(entryAbs);
          if (stat.isDirectory()) {
            scanDirRecursively(entryAbs, entryRel);
          } else if (stat.isFile()) {
            const parts = entryRel.split('/');
            const nodeId = parts.length > 1 ? parts[1] : undefined;
            copyFileSafely(entryRel, 'node', nodeId);
          }
        }
      };
      scanDirRecursively(nodesDir, 'nodes');
    }

    // 3. 原子重命名到正式修订目录
    fs.renameSync(tmpTargetDir, revDir);

    // 4. 计算综合 packageDigest (基于排序后的文件路径和哈希)
    registeredFiles.sort((a, b) => a.path.localeCompare(b.path));
    const digestHasher = crypto.createHash('sha256');
    for (const f of registeredFiles) {
      digestHasher.update(`${f.path}:${f.sha256}\n`);
    }
    const packageDigest = digestHasher.digest('hex');

    return {
      files: registeredFiles,
      packageDigest,
      manifestBuf,
    };
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

    const allowedMaterialFiles: string[] = [];
    const allowedSharedFiles: string[] = [];

    const copyFrozenToAttempt = (pkgRelPath: string, destRelInsideAttempt: string) => {
      const buf = readRegularFileSafely(revDir, pkgRelPath);
      const destPath = path.join(attemptDir, ...destRelInsideAttempt.split('/'));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      setFileReadOnly(destPath);
    };

    // 1. 复制全局需求与开发文档到 shared 目录
    if (fs.existsSync(path.join(revDir, 'requirements.md'))) {
      copyFrozenToAttempt('requirements.md', 'shared/requirements.md');
      allowedSharedFiles.push('shared/requirements.md', 'requirements.md');
    }
    if (fs.existsSync(path.join(revDir, 'development.md'))) {
      copyFrozenToAttempt('development.md', 'shared/development.md');
      allowedSharedFiles.push('shared/development.md', 'development.md');
    }

    // 2. 复制当前节点的专属材料到 material 目录
    const nodeDirRel = path.posix.join('nodes', params.nodeId);
    const revNodeDir = path.join(revDir, 'nodes', params.nodeId);

    const nodeDocName = `${params.nodeId}.md`;
    if (fs.existsSync(path.join(revNodeDir, nodeDocName))) {
      copyFrozenToAttempt(path.posix.join(nodeDirRel, nodeDocName), `material/${nodeDocName}`);
      allowedMaterialFiles.push(path.posix.join(nodeDirRel, nodeDocName), `material/${nodeDocName}`);
    }
    if (fs.existsSync(path.join(revNodeDir, 'prompt.md'))) {
      copyFrozenToAttempt(path.posix.join(nodeDirRel, 'prompt.md'), 'material/prompt.md');
      allowedMaterialFiles.push(path.posix.join(nodeDirRel, 'prompt.md'), 'material/prompt.md');
    }

    // 复制该节点下的 resources/ 目录（如有）
    const revNodeResDir = path.join(revNodeDir, 'resources');
    if (fs.existsSync(revNodeResDir) && fs.statSync(revNodeResDir).isDirectory()) {
      const scanNodeResources = (curAbs: string, curRel: string) => {
        for (const f of fs.readdirSync(curAbs)) {
          const abs = path.join(curAbs, f);
          const rel = path.posix.join(curRel, f);
          if (fs.statSync(abs).isDirectory()) {
            scanNodeResources(abs, rel);
          } else if (fs.statSync(abs).isFile()) {
            copyFrozenToAttempt(rel, path.posix.join('material/resources', rel.slice(path.posix.join(nodeDirRel, 'resources').length)));
            allowedMaterialFiles.push(rel);
          }
        }
      };
      scanNodeResources(revNodeResDir, path.posix.join(nodeDirRel, 'resources'));
    }

    // 3. 处理返工反馈
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
      work_file: `material/${params.nodeId}.md`,
      prompt_file: fs.existsSync(path.join(materialDir, 'prompt.md')) ? 'material/prompt.md' : null,
      requirements_file: 'shared/requirements.md',
      development_file: 'shared/development.md',
      allowed_material_files: allowedMaterialFiles,
      allowed_shared_files: allowedSharedFiles,
      rework_feedback_file: reworkFeedbackPath,
      rework_feedback: params.reworkFeedback || null,
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
