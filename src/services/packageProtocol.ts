import path from 'node:path';
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
} from '../utils/pathSecurity.ts';

export const PACKAGE_PROTOCOL_VERSION = 'cb.task-package/2.0';
export const NODE_RESULT_SCHEMA_VERSION = 'cb.node-result/1.0';

export const PACKAGE_LIMITS = {
  max_manifest_bytes: 2 * 1024 * 1024,
  max_file_bytes: 10 * 1024 * 1024,
  max_package_bytes: 50 * 1024 * 1024,
  max_files_per_package: 500,
  max_read_chunk_bytes: 256 * 1024,
  staging_ttl_ms: 24 * 60 * 60 * 1000,
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

export const manifestNodeResourceSchema = z
  .object({
    id: nonEmptyTrimmed,
    path: nonEmptyTrimmed,
    description: z.string().optional(),
  })
  .strict();

export const manifestInputBindingSchema = z
  .object({
    slot: nonEmptyTrimmed,
    from_node_id: nonEmptyTrimmed,
    output: nonEmptyTrimmed,
    required: z.boolean().optional().default(true),
    constraint: z
      .enum(['current_code_snapshot', 'current_revision', 'any'])
      .optional()
      .default('current_revision'),
  })
  .strict();

export const manifestOutputContractSchema = z
  .object({
    required_outputs: z.array(nonEmptyTrimmed).min(1),
    optional_outputs: z.array(nonEmptyTrimmed).optional().default([]),
    schema_ref: nonEmptyTrimmed.optional(),
  })
  .strict();

export const manifestNodeSchema = z
  .object({
    node_id: nonEmptyTrimmed,
    node_ref: nonEmptyTrimmed,
    prompt_ref: nonEmptyTrimmed,
    resources: z.array(manifestNodeResourceSchema).default([]),
    shared_refs: z.array(nonEmptyTrimmed).default([]),
    input_bindings: z.array(manifestInputBindingSchema).default([]),
    output_contract: manifestOutputContractSchema.default({
      required_outputs: ['result'],
      optional_outputs: [],
    }),
    extensions: z.record(z.unknown()).optional(),
  })
  .strict();

export const manifestFileOwnerSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('shared') }).strict(),
  z.object({ scope: z.literal('node'), node_id: nonEmptyTrimmed }).strict(),
]);

export const manifestFileSchema = z
  .object({
    path: nonEmptyTrimmed,
    owner: manifestFileOwnerSchema,
    media_type: nonEmptyTrimmed,
    size_bytes: z.number().int().nonnegative(),
    sha256: sha256HexSchema,
    description: z.string().optional(),
  })
  .strict();

export const manifestSchema = z
  .object({
    protocol_version: z.literal(PACKAGE_PROTOCOL_VERSION),
    task_key: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, 'task_key 仅支持字母、数字、点、下划线和连字符'),
    revision: z.number().int().positive(),
    title: nonEmptyTrimmed,
    target_cwd: nonEmptyTrimmed,
    workflow: z
      .object({
        id: nonEmptyTrimmed,
        definition_sha256: sha256HexSchema,
      })
      .strict(),
    readiness: z.enum(['ready', 'blocked']),
    blockers: z.array(nonEmptyTrimmed).default([]),
    nodes: z.array(manifestNodeSchema).min(1),
    files: z.array(manifestFileSchema).min(1),
    extensions: z.record(z.unknown()).optional(),
  })
  .strict();

export type TaskPackageManifest = z.infer<typeof manifestSchema>;
export type ManifestNodeEntry = z.infer<typeof manifestNodeSchema>;
export type ManifestFileEntry = z.infer<typeof manifestFileSchema>;

export const stagePackageInputSchema = z
  .object({
    protocol_version: z.string(),
    operation: z.enum(['create', 'revise']),
    task_id: nonEmptyTrimmed.optional(),
    expected_revision: z.number().int().positive().optional(),
    idempotency_key: nonEmptyTrimmed,
    execution_timeout_ms: executionTimeoutSchema.optional(),
    budget_max_rounds: z.number().int().positive().max(100).optional(),
    source: z
      .object({
        mode: nonEmptyTrimmed,
        package_root: nonEmptyTrimmed,
        manifest_path: nonEmptyTrimmed.optional().default('manifest.json'),
        manifest_sha256: sha256HexSchema,
      })
      .strict(),
  })
  .strict();

export const finalizePackageInputSchema = z
  .object({
    draft_id: nonEmptyTrimmed,
    manifest_sha256: sha256HexSchema,
    idempotency_key: nonEmptyTrimmed,
    validate_only: z.boolean().optional().default(false),
  })
  .strict();

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
 * Checks whether there exists a simple path in the workflow graph from `start`
 * to `targetNodeId` that visits `producerNodeId` strictly before `targetNodeId`.
 */
function canProducerPrecedeConsumer(
  nodes: WorkflowNode[],
  producerNodeId: string,
  targetNodeId: string
): boolean {
  const startNode = nodes.find((n) => n.type === 'start');
  if (!startNode) return false;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const queue: Array<{ id: string; seenProducer: boolean; visited: Set<string> }> = [
    { id: startNode.id, seenProducer: false, visited: new Set([startNode.id]) },
  ];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr.id === targetNodeId && curr.seenProducer) {
      return true;
    }
    const node = nodeMap.get(curr.id);
    if (!node) continue;
    const nextSeen = curr.seenProducer || curr.id === producerNodeId;
    const nextIds = [node.on_success, node.on_failure].filter((x): x is string => Boolean(x));
    for (const nextId of nextIds) {
      if (nextId === targetNodeId && nextSeen) {
        return true;
      }
      const stateKey = `${nextId}:${nextSeen ? 1 : 0}`;
      if (!curr.visited.has(stateKey)) {
        const nextVisited = new Set(curr.visited);
        nextVisited.add(stateKey);
        queue.push({ id: nextId, seenProducer: nextSeen, visited: nextVisited });
      }
    }
  }
  return false;
}

export function validateManifestSemantics(
  manifest: TaskPackageManifest,
  workflow: WorkflowDefinition
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!path.isAbsolute(manifest.target_cwd)) {
    issues.push({
      code: 'INVALID_MANIFEST_SCHEMA',
      message: `target_cwd 必须为绝对路径: ${manifest.target_cwd}`,
      details: [{ field: 'target_cwd', reason: 'not_absolute' }],
    });
  }

  const actualWfSha = computeWorkflowDefinitionSha256(workflow);
  if (manifest.workflow.definition_sha256 !== actualWfSha) {
    issues.push({
      code: 'WORKFLOW_HASH_MISMATCH',
      message: `工作流 [${workflow.id}] 定义摘要不匹配，请重新获取工作流契约后更新 Manifest`,
      details: [
        {
          field: 'workflow.definition_sha256',
          reason: `expected ${actualWfSha}, got ${manifest.workflow.definition_sha256}`,
        },
      ],
    });
  }

  if (manifest.readiness === 'blocked' && manifest.blockers.length === 0) {
    issues.push({
      code: 'INVALID_MANIFEST_SCHEMA',
      message: 'readiness 为 blocked 时必须提供至少一条 blockers 说明',
      details: [{ field: 'blockers' }],
    });
  }
  if (manifest.readiness === 'ready' && manifest.blockers.length > 0) {
    issues.push({
      code: 'INVALID_MANIFEST_SCHEMA',
      message: 'readiness 为 ready 时 blockers 必须为空数组',
      details: [{ field: 'blockers' }],
    });
  }

  const wfTaskNodes = workflow.nodes.filter((n) => n.type === 'task');
  const wfTaskIds = new Set(wfTaskNodes.map((n) => n.id));
  const wfNonTaskIds = new Set(workflow.nodes.filter((n) => n.type !== 'task').map((n) => n.id));

  const manifestNodeMap = new Map<string, ManifestNodeEntry>();
  for (const mNode of manifest.nodes) {
    if (wfNonTaskIds.has(mNode.node_id)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `控制节点 [${mNode.node_id}] (start/end) 不应在 manifest.nodes 中声明`,
        details: [{ node_id: mNode.node_id, field: 'nodes' }],
      });
      continue;
    }
    if (!wfTaskIds.has(mNode.node_id)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `工作流 [${workflow.id}] 中不存在任务节点 [${mNode.node_id}]`,
        details: [{ node_id: mNode.node_id, field: 'nodes' }],
      });
      continue;
    }
    if (manifestNodeMap.has(mNode.node_id)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `manifest.nodes 包含重复节点 [${mNode.node_id}]`,
        details: [{ node_id: mNode.node_id, field: 'nodes' }],
      });
      continue;
    }
    manifestNodeMap.set(mNode.node_id, mNode);
  }

  for (const taskNode of wfTaskNodes) {
    if (!manifestNodeMap.has(taskNode.id)) {
      issues.push({
        code: 'NODE_COVERAGE_MISMATCH',
        message: `manifest.nodes 缺少工作流任务节点 [${taskNode.id}]`,
        details: [{ node_id: taskNode.id, field: 'nodes' }],
      });
    }
  }

  // File registry checks
  if (manifest.files.length > PACKAGE_LIMITS.max_files_per_package) {
    issues.push({
      code: 'SIZE_LIMIT_EXCEEDED',
      message: `包内文件数量 (${manifest.files.length}) 超过上限 (${PACKAGE_LIMITS.max_files_per_package})`,
      details: [{ field: 'files' }],
    });
  }

  const fileMap = new Map<string, ManifestFileEntry>();
  const allFilePaths: string[] = [];
  let totalBytes = 0;

  for (const f of manifest.files) {
    allFilePaths.push(f.path);
    const pathCheck = validatePackageRelativePath(f.path);
    if (!pathCheck.valid) {
      issues.push({
        code: 'INVALID_RESOURCE_PATH',
        message: `非法文件路径 [${f.path}]: ${pathCheck.reason}`,
        details: [{ path: f.path, field: 'files[].path' }],
      });
      continue;
    }
    if (f.path.toLowerCase() === 'manifest.json') {
      issues.push({
        code: 'INVALID_MANIFEST_SCHEMA',
        message: 'files 列表不得登记 manifest.json 本身',
        details: [{ path: f.path, field: 'files' }],
      });
      continue;
    }
    if (f.size_bytes > PACKAGE_LIMITS.max_file_bytes) {
      issues.push({
        code: 'SIZE_LIMIT_EXCEEDED',
        message: `文件 [${f.path}] 声明大小 (${f.size_bytes}B) 超过单文件上限 (${PACKAGE_LIMITS.max_file_bytes}B)`,
        details: [{ path: f.path, field: 'files[].size_bytes' }],
      });
    }
    totalBytes += f.size_bytes;

    if (f.owner.scope === 'shared') {
      if (!f.path.startsWith('shared/resources/')) {
        issues.push({
          code: 'INVALID_OWNER',
          message: `共同资源 [${f.path}] 必须位于 shared/resources/ 目录下`,
          details: [{ path: f.path, field: 'files[].owner' }],
        });
      }
    } else {
      const ownerNodeId = f.owner.node_id;
      if (!wfTaskIds.has(ownerNodeId)) {
        issues.push({
          code: 'INVALID_OWNER',
          message: `文件 [${f.path}] 的归属节点 [${ownerNodeId}] 不是有效任务节点`,
          details: [{ node_id: ownerNodeId, path: f.path, field: 'files[].owner' }],
        });
      } else {
        const expectedPrefix = `nodes/${encodeNodeDirName(ownerNodeId)}/`;
        if (!f.path.startsWith(expectedPrefix)) {
          issues.push({
            code: 'INVALID_OWNER',
            message: `节点 [${ownerNodeId}] 的文件 [${f.path}] 必须位于 ${expectedPrefix} 下`,
            details: [{ node_id: ownerNodeId, path: f.path, field: 'files[].owner' }],
          });
        }
      }
    }

    fileMap.set(f.path, f);
  }

  if (totalBytes > PACKAGE_LIMITS.max_package_bytes) {
    issues.push({
      code: 'SIZE_LIMIT_EXCEEDED',
      message: `任务包总大小 (${totalBytes}B) 超过上限 (${PACKAGE_LIMITS.max_package_bytes}B)`,
      details: [{ field: 'files' }],
    });
  }

  const collision = findCaseCollision(allFilePaths);
  if (collision) {
    issues.push({
      code: 'CASE_COLLISION',
      message: `包内存在大小写归一化后重名的文件: ${collision[0]} 与 ${collision[1]}`,
      details: [{ path: collision[0] }, { path: collision[1] }],
    });
  }

  const referencedFiles = new Set<string>();

  for (const [nodeId, mNode] of manifestNodeMap.entries()) {
    const dirName = encodeNodeDirName(nodeId);
    const expectedNodeMd = `nodes/${dirName}/node.md`;
    const expectedPromptMd = `nodes/${dirName}/prompt.md`;
    const resourcesPrefix = `nodes/${dirName}/resources/`;

    const checkNodeOwnedRef = (refPath: string, field: string) => {
      referencedFiles.add(refPath);
      const reg = fileMap.get(refPath);
      if (!reg) {
        issues.push({
          code: 'MISSING_FILE',
          message: `节点 [${nodeId}] 引用的文件未在 files 中登记: ${refPath}`,
          details: [{ node_id: nodeId, field, path: refPath }],
        });
        return;
      }
      if (reg.owner.scope !== 'node' || reg.owner.node_id !== nodeId) {
        issues.push({
          code: 'INVALID_OWNER',
          message: `节点 [${nodeId}] 不能引用非本节点所有的文件: ${refPath}`,
          details: [{ node_id: nodeId, field, path: refPath }],
        });
      }
    };

    if (mNode.node_ref !== expectedNodeMd) {
      issues.push({
        code: 'INVALID_RESOURCE_PATH',
        message: `节点 [${nodeId}] 的 node_ref 必须为 ${expectedNodeMd}`,
        details: [{ node_id: nodeId, field: 'node_ref', path: mNode.node_ref }],
      });
    } else {
      checkNodeOwnedRef(mNode.node_ref, 'node_ref');
    }

    if (mNode.prompt_ref !== expectedPromptMd) {
      issues.push({
        code: 'INVALID_RESOURCE_PATH',
        message: `节点 [${nodeId}] 的 prompt_ref 必须为 ${expectedPromptMd}`,
        details: [{ node_id: nodeId, field: 'prompt_ref', path: mNode.prompt_ref }],
      });
    } else {
      checkNodeOwnedRef(mNode.prompt_ref, 'prompt_ref');
    }

    const resIds = new Set<string>();
    for (const res of mNode.resources) {
      if (resIds.has(res.id)) {
        issues.push({
          code: 'INVALID_MANIFEST_SCHEMA',
          message: `节点 [${nodeId}] 存在重复资源 ID: ${res.id}`,
          details: [{ node_id: nodeId, field: 'resources[].id', path: res.path }],
        });
      }
      resIds.add(res.id);

      if (!res.path.startsWith(resourcesPrefix)) {
        issues.push({
          code: 'INVALID_RESOURCE_PATH',
          message: `节点 [${nodeId}] 的资源 [${res.path}] 必须位于 ${resourcesPrefix} 下`,
          details: [{ node_id: nodeId, field: 'resources[].path', path: res.path }],
        });
      } else {
        checkNodeOwnedRef(res.path, 'resources[].path');
      }
    }

    const sharedSet = new Set<string>();
    for (const sharedPath of mNode.shared_refs) {
      if (sharedSet.has(sharedPath)) {
        issues.push({
          code: 'INVALID_MANIFEST_SCHEMA',
          message: `节点 [${nodeId}] 重复引用共同资源: ${sharedPath}`,
          details: [{ node_id: nodeId, field: 'shared_refs', path: sharedPath }],
        });
        continue;
      }
      sharedSet.add(sharedPath);
      referencedFiles.add(sharedPath);

      if (!sharedPath.startsWith('shared/resources/')) {
        issues.push({
          code: 'INVALID_RESOURCE_PATH',
          message: `节点 [${nodeId}] 的 shared_refs 必须位于 shared/resources/ 下: ${sharedPath}`,
          details: [{ node_id: nodeId, field: 'shared_refs', path: sharedPath }],
        });
        continue;
      }

      const reg = fileMap.get(sharedPath);
      if (!reg) {
        issues.push({
          code: 'MISSING_FILE',
          message: `节点 [${nodeId}] 引用的共同资源未在 files 中登记: ${sharedPath}`,
          details: [{ node_id: nodeId, field: 'shared_refs', path: sharedPath }],
        });
      } else if (reg.owner.scope !== 'shared') {
        issues.push({
          code: 'INVALID_OWNER',
          message: `文件 [${sharedPath}] 在 files 中必须声明 owner.scope = "shared"`,
          details: [{ node_id: nodeId, field: 'shared_refs', path: sharedPath }],
        });
      }
    }

    // Output contract check
    const reqOut = new Set(mNode.output_contract.required_outputs);
    for (const opt of mNode.output_contract.optional_outputs) {
      if (reqOut.has(opt)) {
        issues.push({
          code: 'INVALID_OUTPUT_CONTRACT',
          message: `节点 [${nodeId}] 的输出 [${opt}] 不能同时出现在 required_outputs 和 optional_outputs`,
          details: [{ node_id: nodeId, field: 'output_contract' }],
        });
      }
    }
    if (mNode.output_contract.schema_ref) {
      const schemaPath = mNode.output_contract.schema_ref;
      if (!schemaPath.startsWith(resourcesPrefix)) {
        issues.push({
          code: 'INVALID_RESOURCE_PATH',
          message: `节点 [${nodeId}] 的 schema_ref 必须位于 ${resourcesPrefix} 下: ${schemaPath}`,
          details: [{ node_id: nodeId, field: 'output_contract.schema_ref', path: schemaPath }],
        });
      } else {
        checkNodeOwnedRef(schemaPath, 'output_contract.schema_ref');
      }
    }

    // Input bindings check
    const slotSet = new Set<string>();
    for (const binding of mNode.input_bindings) {
      if (slotSet.has(binding.slot)) {
        issues.push({
          code: 'INVALID_INPUT_BINDING',
          message: `节点 [${nodeId}] 存在重复输入槽位: ${binding.slot}`,
          details: [{ node_id: nodeId, field: 'input_bindings[].slot' }],
        });
      }
      slotSet.add(binding.slot);

      if (binding.from_node_id === nodeId) {
        issues.push({
          code: 'INVALID_INPUT_BINDING',
          message: `节点 [${nodeId}] 的 input_bindings 不能绑定自身输出`,
          details: [{ node_id: nodeId, field: 'input_bindings[].from_node_id' }],
        });
        continue;
      }

      const sourceNode = manifestNodeMap.get(binding.from_node_id);
      if (!sourceNode) {
        issues.push({
          code: 'INVALID_INPUT_BINDING',
          message: `节点 [${nodeId}] 绑定的来源节点 [${binding.from_node_id}] 不存在或不是任务节点`,
          details: [{ node_id: nodeId, field: 'input_bindings[].from_node_id' }],
        });
        continue;
      }

      const declaredOutputs = new Set([
        ...sourceNode.output_contract.required_outputs,
        ...sourceNode.output_contract.optional_outputs,
      ]);
      if (!declaredOutputs.has(binding.output)) {
        issues.push({
          code: 'INVALID_INPUT_BINDING',
          message: `来源节点 [${binding.from_node_id}] 未声明输出 [${binding.output}]`,
          details: [{ node_id: nodeId, field: 'input_bindings[].output' }],
        });
      }

      if (
        binding.required !== false &&
        !canProducerPrecedeConsumer(workflow.nodes, binding.from_node_id, nodeId)
      ) {
        issues.push({
          code: 'INVALID_INPUT_BINDING',
          message: `节点 [${nodeId}] 的必需输入 [${binding.slot}] 在工作流中不存在先经过 [${binding.from_node_id}] 再到达的路径`,
          details: [{ node_id: nodeId, field: 'input_bindings' }],
        });
      }
    }
  }

  for (const f of manifest.files) {
    if (!referencedFiles.has(f.path)) {
      issues.push({
        code: 'UNREGISTERED_FILE',
        message: `files 中登记的文件未被任何节点引用: ${f.path}`,
        details: [{ path: f.path, field: 'files' }],
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
    unsupported_source_modes: ['upload'],
    limits: PACKAGE_LIMITS,
    directory_layout: {
      manifest: 'manifest.json',
      shared_resources_dir: 'shared/resources',
      node_dir_pattern: 'nodes/<safe_node_dir>',
      node_required_files: ['node.md', 'prompt.md'],
      node_resources_dir: 'resources',
      revision_dir_pattern: 'tasks/<task_id>/revisions/r0001',
      run_dir_pattern: 'tasks/<task_id>/runs/r0001/<safe_node_dir>/<attempt_id>',
    },
    workflow_binding: {
      versioning_enabled: false,
      binding_fields: ['workflow.id', 'workflow.definition_sha256'],
    },
    error_codes: [
      'UNSUPPORTED_PROTOCOL_VERSION',
      'UNSUPPORTED_SOURCE_MODE',
      'SOURCE_UNAVAILABLE',
      'MANIFEST_HASH_MISMATCH',
      'INVALID_MANIFEST_SCHEMA',
      'WORKFLOW_NOT_FOUND',
      'WORKFLOW_HASH_MISMATCH',
      'NODE_COVERAGE_MISMATCH',
      'INVALID_RESOURCE_PATH',
      'PATH_ESCAPE',
      'CASE_COLLISION',
      'MISSING_FILE',
      'SIZE_MISMATCH',
      'HASH_MISMATCH',
      'BOM_NOT_ALLOWED',
      'INVALID_UTF8',
      'SIZE_LIMIT_EXCEEDED',
      'INVALID_OWNER',
      'UNREGISTERED_FILE',
      'INVALID_INPUT_BINDING',
      'INVALID_OUTPUT_CONTRACT',
      'PACKAGE_NOT_READY',
      'DRAFT_NOT_FOUND',
      'TASK_NOT_FOUND',
      'TASK_RUNNING',
      'TASK_DELETING',
      'REVISION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'ACCESS_DENIED',
      'INSTANCE_MISMATCH',
      'CLEANUP_FAILED',
      'OUTPUT_CONTRACT_VIOLATION',
    ],
    templates: {
      verification_report: {
        path: 'outputs/test_report.json',
        result_rule: 'verification',
        description: '测试 Agent 自行选择并运行命令后提交的证据；非零退出码走失败路径，缺失或无效证据阻塞任务。',
        content: {
          tests: [{ command: '<actually executed command>', cwd: '<actual working directory>', exit_code: 0, stdout: '<actual stdout>', stderr: '<actual stderr>' }],
        },
      },
      manifest: {
        protocol_version: PACKAGE_PROTOCOL_VERSION,
        task_key: 'example-task',
        revision: 1,
        title: '示例任务',
        target_cwd: 'D:/CODE/PROJECT',
        workflow: {
          id: 'default',
          definition_sha256: '<from workbench_get_workflow>',
        },
        readiness: 'ready',
        blockers: [],
        nodes: [
          {
            node_id: '<task_node_id>',
            node_ref: 'nodes/<safe_node_dir>/node.md',
            prompt_ref: 'nodes/<safe_node_dir>/prompt.md',
            resources: [
              {
                id: 'res-01',
                path: 'nodes/<safe_node_dir>/resources/checklist.md',
                description: '可选附属资源说明',
              },
            ],
            shared_refs: ['shared/resources/requirements.md'],
            input_bindings: [
              {
                slot: 'upstream_result',
                from_node_id: '<upstream_node_id>',
                output: 'result',
                required: true,
                constraint: 'current_code_snapshot',
              },
            ],
            output_contract: {
              required_outputs: ['result'],
              optional_outputs: [],
            },
          },
        ],
        files: [
          {
            path: 'nodes/<safe_node_dir>/node.md',
            owner: { scope: 'node', node_id: '<task_node_id>' },
            media_type: 'text/markdown',
            size_bytes: 0,
            sha256: '<64-hex>',
          },
        ],
      },
      node_md_sections: [
        '## 节点目标与负责范围',
        '## 输入材料及用途',
        '## 工作范围与约束边界',
        '## 具体工作项与执行步骤',
        '## 完成条件与证据要求',
        '## 交付物与输出格式',
        '## 阻塞条件与处理方式',
      ],
      prompt_md_sections: [
        '## 独立角色与执行前提',
        '## 材料读取顺序',
        '## 允许行为与禁止越权边界',
        '## 验证与证据要求',
        '## 输出位置与阻塞处理',
      ],
      node_result_example: {
        schema_version: NODE_RESULT_SCHEMA_VERSION,
        task_id: '<task_id>',
        revision: 1,
        package_digest: '<manifest_sha256>',
        node_id: '<node_id>',
        attempt_id: '<attempt_id>',
        execution_index: 1,
        outcome: 'passed',
        summary: '本节点执行完成并满足契约要求',
        issues: [],
        outputs: {
          result: { path: 'outputs/result.json', sha256: '<64-hex>' },
        },
      },
    },
  };
}
