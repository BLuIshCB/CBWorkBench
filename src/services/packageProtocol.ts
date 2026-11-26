import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { executionTimeoutSchema } from './executionPolicy.ts';
import {
  type WorkflowDefinition,
  type WorkflowNode,
  computeWorkflowDefinitionSha256,
} from './workflowDefinition.ts';
import {
  encodeNodeDirName,
  validatePackageRelativePath,
  findCaseCollision,
  readRegularFileSafely,
  validateUtf8NoBom,
  PathSecurityError,
} from '../utils/pathSecurity.ts';

export const PACKAGE_PROTOCOL_VERSION = 'cb.task-package/2.0';
export const NODE_RESULT_SCHEMA_VERSION = 'cb.node-result/1.0';

export const PACKAGE_LIMITS = {
  max_manifest_bytes: 2 * 1024 * 1024,
  max_file_bytes: 10 * 1024 * 1024,
  max_package_bytes: 50 * 1024 * 1024,
  max_files_per_package: 500,
  max_read_chunk_bytes: 256 * 1024,
} as const;

export interface PackageErrorDetail {
  node_id?: string;
  field?: string;
  path?: string;
  reason?: string;
}

export class PackageProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: PackageErrorDetail[];

  constructor(
    code: string,
    message: string,
    details: PackageErrorDetail[] = [],
    retryable: boolean = false
  ) {
    super(message);
    this.name = 'PackageProtocolError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, '必须为 64 位小写十六进制 SHA-256');
const nonEmptyTrimmed = z.string().trim().min(1);

export const manifestSchema = z
  .object({
    title: nonEmptyTrimmed,
    workflow_id: nonEmptyTrimmed,
    target_cwd: nonEmptyTrimmed,
    task_key: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, 'task_key 仅支持字母、数字、点、下划线和连字符')
      .optional(),
    budget_max_rounds: z.number().int().positive().max(100).optional(),
    execution_timeout_ms: executionTimeoutSchema.optional(),
  })
  .strict();

export type TaskPackageManifest = z.infer<typeof manifestSchema>;

export const submitTaskInputSchema = z
  .object({
    package_root: nonEmptyTrimmed,
    task_id: nonEmptyTrimmed.optional(),
    budget_max_rounds: z.number().int().positive().max(100).optional(),
    execution_timeout_ms: executionTimeoutSchema.optional(),
  })
  .strict();

export type SubmitTaskInput = z.infer<typeof submitTaskInputSchema>;

export const nodeResultSchema = z
  .object({
    schema_version: z.literal(NODE_RESULT_SCHEMA_VERSION),
    task_id: nonEmptyTrimmed,
    revision: z.number().int().positive(),
    package_digest: sha256HexSchema,
    node_id: nonEmptyTrimmed,
    attempt_id: nonEmptyTrimmed,
    execution_index: z.number().int().positive(),
    code_generation: z.number().int().nonnegative().optional(),
    outcome: z.enum(['passed', 'failed', 'blocked']),
    summary: nonEmptyTrimmed,
    issues: z
      .array(
        z.object({
          id: nonEmptyTrimmed,
          description: nonEmptyTrimmed,
          evidence: z.string().optional(),
        })
      )
      .default([]),
    outputs: z.record(
      z.object({
        path: nonEmptyTrimmed,
        sha256: sha256HexSchema.optional(),
        size_bytes: z.number().int().nonnegative().optional(),
      })
    ),
    extensions: z.record(z.unknown()).optional(),
  })
  .strict();

export type UnifiedNodeResult = z.infer<typeof nodeResultSchema>;

export interface ValidationIssue {
  code: string;
  message: string;
  details: PackageErrorDetail[];
}

/**
 * 校验极简任务包目录结构完整性与各节点材料契约。
 * 根目录必须包含 manifest.json 和 requirements.md，每个任务节点必须提供非空 prompt.md。
 */
export function validateTaskPackageDirectory(
  packageRoot: string,
  workflow: WorkflowDefinition
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!path.isAbsolute(packageRoot)) {
    return [
      {
        code: 'INVALID_RESOURCE_PATH',
        message: `package_root 必须为绝对路径: ${packageRoot}`,
        details: [{ path: packageRoot, field: 'package_root' }],
      },
    ];
  }

  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    return [
      {
        code: 'MISSING_FILE',
        message: `任务包根目录不存在或不是有效目录: ${packageRoot}`,
        details: [{ path: packageRoot, field: 'package_root' }],
      },
    ];
  }

  // 1. 校验 manifest.json
  const manifestPath = path.join(packageRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    issues.push({
      code: 'MISSING_FILE',
      message: '任务包根目录下缺少 manifest.json',
      details: [{ path: 'manifest.json', field: 'manifest' }],
    });
  } else {
    try {
      const manifestBuf = readRegularFileSafely(packageRoot, 'manifest.json');
      validateUtf8NoBom(manifestBuf, 'application/json', 'manifest.json');
      const manifestJson = JSON.parse(manifestBuf.toString('utf8'));
      const parsed = manifestSchema.safeParse(manifestJson);
      if (!parsed.success) {
        issues.push({
          code: 'INVALID_MANIFEST_SCHEMA',
          message: `manifest.json 格式错误: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
        });
      } else {
        if (!path.isAbsolute(parsed.data.target_cwd)) {
          issues.push({
            code: 'INVALID_MANIFEST_SCHEMA',
            message: `target_cwd 必须为绝对路径: ${parsed.data.target_cwd}`,
            details: [{ field: 'target_cwd', reason: 'not_absolute' }],
          });
        }
        if (parsed.data.workflow_id !== workflow.id) {
          issues.push({
            code: 'WORKFLOW_NOT_FOUND',
            message: `manifest.json 中指定的 workflow_id [${parsed.data.workflow_id}] 与当前工作流 [${workflow.id}] 不一致`,
            details: [{ field: 'workflow_id' }],
          });
        }
      }
    } catch (err: any) {
      issues.push({
        code: (err instanceof PackageProtocolError || err instanceof PathSecurityError) ? err.code : 'INVALID_MANIFEST_SCHEMA',
        message: `读取或校验 manifest.json 失败: ${err?.message || err}`,
        details: [{ path: 'manifest.json' }],
      });
    }
  }

  // 2. 校验 requirements.md (必需且非空)
  const reqPath = path.join(packageRoot, 'requirements.md');
  if (!fs.existsSync(reqPath)) {
    issues.push({
      code: 'MISSING_FILE',
      message: '任务包根目录下缺少需求文档 requirements.md',
      details: [{ path: 'requirements.md', field: 'requirements' }],
    });
  } else {
    try {
      const buf = readRegularFileSafely(packageRoot, 'requirements.md');
      validateUtf8NoBom(buf, 'text/markdown', 'requirements.md');
      if (buf.toString('utf8').trim().length === 0) {
        issues.push({
          code: 'INVALID_MANIFEST_SCHEMA',
          message: '需求文档 requirements.md 不能为空',
          details: [{ path: 'requirements.md' }],
        });
      }
    } catch (err: any) {
      issues.push({
        code: (err instanceof PackageProtocolError || err instanceof PathSecurityError) ? err.code : 'INVALID_UTF8',
        message: `读取 requirements.md 失败: ${err?.message || err}`,
        details: [{ path: 'requirements.md' }],
      });
    }
  }

  // 开发文档随包提供时校验编码。
  const devPath = path.join(packageRoot, 'development.md');
  if (fs.existsSync(devPath)) {
    try {
      const buf = readRegularFileSafely(packageRoot, 'development.md');
      validateUtf8NoBom(buf, 'text/markdown', 'development.md');
      if (buf.toString('utf8').trim().length === 0) {
        issues.push({
          code: 'INVALID_MANIFEST_SCHEMA',
          message: '开发文档 development.md 不能为空',
          details: [{ path: 'development.md' }],
        });
      }
    } catch (err: any) {
      issues.push({
        code: (err instanceof PackageProtocolError || err instanceof PathSecurityError) ? err.code : 'INVALID_UTF8',
        message: `读取 development.md 失败: ${err?.message || err}`,
        details: [{ path: 'development.md' }],
      });
    }
  }

  // 4. 校验 nodes/ 目录
  const nodesDir = path.join(packageRoot, 'nodes');
  if (!fs.existsSync(nodesDir) || !fs.statSync(nodesDir).isDirectory()) {
    issues.push({
      code: 'MISSING_FILE',
      message: '任务包下缺少 nodes/ 目录',
      details: [{ path: 'nodes' }],
    });
    return issues;
  }

  const wfTaskNodes = workflow.nodes.filter((n) => n.type === 'task');
  const wfTaskIds = new Set(wfTaskNodes.map((n) => n.id));
  const wfControlIds = new Set(workflow.nodes.filter((n) => n.type !== 'task').map((n) => n.id));

  let actualEntries: string[] = [];
  try {
    actualEntries = fs.readdirSync(nodesDir);
  } catch (err: any) {
    issues.push({
      code: 'INVALID_RESOURCE_PATH',
      message: `无法读取 nodes 目录: ${err?.message || err}`,
      details: [{ path: 'nodes' }],
    });
    return issues;
  }

  const collision = findCaseCollision(actualEntries);
  if (collision) {
    issues.push({
      code: 'CASE_COLLISION',
      message: `nodes 目录下存在大小写归一化冲突的文件夹: ${collision[0]} 与 ${collision[1]}`,
      details: [{ path: collision[0] }, { path: collision[1] }],
    });
  }

  const coveredTaskIds = new Set<string>();

  for (const entryName of actualEntries) {
    const entryPath = path.join(nodesDir, entryName);
    let stat: fs.Stats;
    try {
      const lstat = fs.lstatSync(entryPath);
      if (lstat.isSymbolicLink()) {
        issues.push({
          code: 'PATH_ESCAPE',
          message: `禁止符号链接或路径越权: nodes/${entryName}`,
          details: [{ path: `nodes/${entryName}` }],
        });
        continue;
      }
      stat = fs.statSync(entryPath);
    } catch (err: any) {
      issues.push({
        code: 'INVALID_RESOURCE_PATH',
        message: `无法访问节点目录 nodes/${entryName}: ${err?.message || err}`,
        details: [{ path: `nodes/${entryName}` }],
      });
      continue;
    }

    if (!stat.isDirectory()) {
      continue;
    }

    if (wfControlIds.has(entryName)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `控制节点 [${entryName}] (start/end) 不应在 nodes/ 目录下建立材料文件夹`,
        details: [{ node_id: entryName, field: 'nodes' }],
      });
      continue;
    }

    if (!wfTaskIds.has(entryName)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `工作流 [${workflow.id}] 中不存在任务节点 [${entryName}]`,
        details: [{ node_id: entryName, field: 'nodes' }],
      });
      continue;
    }

    coveredTaskIds.add(entryName);

    // 节点同名说明选填，prompt.md 是执行入口。
    const nodeDocRel = path.posix.join('nodes', entryName, `${entryName}.md`);
    const nodeDocPath = path.join(entryPath, `${entryName}.md`);
    if (entryName.toLowerCase() !== 'prompt' && fs.existsSync(nodeDocPath)) {
      try {
        const buf = readRegularFileSafely(packageRoot, nodeDocRel);
        validateUtf8NoBom(buf, 'text/markdown', nodeDocRel);
        if (buf.toString('utf8').trim().length === 0) {
          issues.push({
            code: 'INVALID_MANIFEST_SCHEMA',
            message: `任务节点 [${entryName}] 的 ${nodeDocRel} 不能为空`,
            details: [{ node_id: entryName, path: nodeDocRel }],
          });
        }
      } catch (err: any) {
        issues.push({
          code: (err instanceof PackageProtocolError || err instanceof PathSecurityError) ? err.code : 'INVALID_UTF8',
          message: `读取 ${nodeDocRel} 失败: ${err?.message || err}`,
          details: [{ node_id: entryName, path: nodeDocRel }],
        });
      }
    }

    const promptFileRel = path.posix.join('nodes', entryName, 'prompt.md');
    if (!fs.readdirSync(entryPath).includes('prompt.md')) {
      issues.push({
        code: 'MISSING_FILE',
        message: `任务节点 [${entryName}] 缺少必需提示词 ${promptFileRel}`,
        details: [{ node_id: entryName, path: promptFileRel }],
      });
    } else {
      try {
        const buf = readRegularFileSafely(packageRoot, promptFileRel);
        validateUtf8NoBom(buf, 'text/markdown', promptFileRel);
        if (!buf.toString('utf8').trim()) {
          issues.push({ code: 'INVALID_MANIFEST_SCHEMA', message: `${promptFileRel} 不能为空`, details: [{ node_id: entryName, path: promptFileRel }] });
        }
      } catch (err: any) {
        issues.push({
          code: (err instanceof PackageProtocolError || err instanceof PathSecurityError) ? err.code : 'INVALID_UTF8',
          message: `读取 ${promptFileRel} 失败: ${err?.message || err}`,
          details: [{ node_id: entryName, path: promptFileRel }],
        });
      }
    }
  }

  // 检查是否覆盖了工作流的所有 task 节点
  for (const taskNode of wfTaskNodes) {
    if (!coveredTaskIds.has(taskNode.id)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `nodes/ 目录下缺少工作流任务节点 [${taskNode.id}] 的材料目录`,
        details: [{ node_id: taskNode.id, field: 'nodes' }],
      });
    }
  }

  return issues;
}

export function buildPackageProtocolSpec(instanceInfo: {
  instance_id: string;
  data_dir: string;
  legacy_data_path: string | null;
}) {
  return {
    protocol_version: PACKAGE_PROTOCOL_VERSION,
    node_result_schema_version: NODE_RESULT_SCHEMA_VERSION,
    instance: {
      instance_id: instanceInfo.instance_id,
      data_dir: instanceInfo.data_dir,
      legacy_data_path: instanceInfo.legacy_data_path,
    },
    supported_source_modes: ['local_path'],
    limits: PACKAGE_LIMITS,
    directory_layout: {
      manifest: 'manifest.json',
      requirements: 'requirements.md',
      development: 'development.md',
      development_required: false,
      node_dir_pattern: 'nodes/<node_id>',
      node_required_files: ['prompt.md'],
      node_optional_files: ['<node_id>.md', 'resources/'],
      revision_dir_pattern: 'tasks/<task_id>/revisions/r0001',
      run_dir_pattern: 'tasks/<task_id>/runs/r0001/<node_id>/<attempt_id>',
    },
    error_codes: [
      'INVALID_MANIFEST_SCHEMA',
      'WORKFLOW_NOT_FOUND',
      'NODE_COVERAGE_MISMATCH',
      'INVALID_RESOURCE_PATH',
      'PATH_ESCAPE',
      'CASE_COLLISION',
      'MISSING_FILE',
      'BOM_NOT_ALLOWED',
      'INVALID_UTF8',
      'SIZE_LIMIT_EXCEEDED',
      'TASK_NOT_FOUND',
      'TASK_RUNNING',
      'TASK_DELETING',
      'REVISION_CONFLICT',
      'ACCESS_DENIED',
    ],
    templates: {
      manifest: {
        title: '示例任务标题',
        workflow_id: 'default',
        target_cwd: 'D:/CODE/PROJECT',
        task_key: 'example-task',
        budget_max_rounds: 10,
        execution_timeout_ms: 3600000,
      },
      requirements_md: '# 需求文档：[任务标题]\n\n## 1. 业务目标与背景\n\n## 2. 核心功能范围 (In Scope)\n- [REQ-01] ...\n\n## 3. 排除范围 (Out of Scope)\n\n## 4. 验收标准与测试基线 (Acceptance Criteria)\n- [ ] ...\n',
      development_md: '# 开发文档：[任务技术方案]\n\n## 1. 架构方案与模块设计\n\n## 2. 工程纪律与编码标准\n- 遵循单分支开发策略 (main)，所有改动就地生效。\n- 开发阶段不考虑向后兼容，废弃项直接删除。\n- 严格基于 TDD (红-绿-重构) 推进。\n\n## 3. 变更文件范围\n\n## 4. 自动化验证命令\n',
      node_md: '# 节点工作文档：[节点名称] ([node_id])\n\n## 1. 节点目标与职责\n\n## 2. 具体工作项与执行清单\n- [ ] 步骤 1：...\n\n## 3. 交付物与完成条件\n',
      prompt_md: '你负责 [节点名称]。\n说明本节点的工作步骤、必需证据和完成条件，参考需求文档及已提供的补充材料。\n',
      submit_task: {
        package_root: path.join(instanceInfo.data_dir, 'task-drafts', 'example-task-a1b2c3', 'r0001'),
      },
    },
  };
}
