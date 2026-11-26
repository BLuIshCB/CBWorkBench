import crypto from 'node:crypto';
import { workflowMaterialNodeDirName } from '../utils/pathSecurity.ts';

export type WorkflowNodeType = 'start' | 'end' | 'task';
export type TaskExecutionMode = 'agent' | 'manual';
export type TaskResultRule = 'default' | 'verification' | 'acceptance';

export interface WorkflowNode {
  id: string;
  name: string;
  description?: string;
  type: WorkflowNodeType;
  execution_mode?: TaskExecutionMode;
  result_rule?: TaskResultRule;
  executor?: string;
  model?: string;
  prompt?: string;
  max_executions?: number;
  on_success?: string | null;
  on_failure?: string | null;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
  created_at?: number;
  updated_at?: number;
  is_default?: boolean;
}

export interface UniformNodeMaterialContract {
  node_dir: string;
  node_ref: string;
  prompt_ref: string;
  resources_dir: string;
  instruction_usage: 'agent_prompt' | 'manual_guide';
  supports_resources: boolean;
  supports_shared_refs: boolean;
  supports_input_bindings: boolean;
  supports_output_contract: boolean;
  default_required_outputs: string[];
  purpose: string;
  purpose_configured: boolean;
}

export const DEFAULT_WORKFLOW_ID = 'default';
const DEFAULT_MANUAL_REVIEW_NODE_ID = 'human_review';
export const DEFAULT_MAX_EXECUTIONS = 0; // 0 表示不做次数限制

export const DEFAULT_WORKFLOW_NODES: WorkflowNode[] = [
  {
    id: 'start',
    name: '开始',
    description: '进入首个任务节点。',
    type: 'start',
    on_success: 'development',
  },
  {
    id: 'development',
    name: '开发实现',
    description: '按需求与开发清单实现功能变更，并在返工时依据上游反馈完成修复。',
    type: 'task',
    execution_mode: 'agent',
    max_executions: DEFAULT_MAX_EXECUTIONS,
    on_success: 'test',
    on_failure: null,
  },
  {
    id: 'test',
    name: '独立测试',
    description: '根据项目与任务材料自行选择并运行测试命令，提交命令、退出码和输出证据。',
    type: 'task',
    execution_mode: 'agent',
    result_rule: 'verification',
    max_executions: DEFAULT_MAX_EXECUTIONS,
    on_success: 'acceptance',
    on_failure: 'development',
  },
  {
    id: 'acceptance',
    name: '整体验收',
    description: '只读核验代码变更、上游产物证据及验收清单，输出结构化验收判定。',
    type: 'task',
    execution_mode: 'agent',
    result_rule: 'acceptance',
    max_executions: DEFAULT_MAX_EXECUTIONS,
    on_success: DEFAULT_MANUAL_REVIEW_NODE_ID,
    on_failure: 'development',
  },
  {
    id: DEFAULT_MANUAL_REVIEW_NODE_ID,
    name: '人工确认',
    description: '人类工程师复核最终交付结果、运行产物与待办人工核验项，决定通过或退回。',
    type: 'task',
    execution_mode: 'manual',
    max_executions: DEFAULT_MAX_EXECUTIONS,
    on_success: 'end',
    on_failure: 'development',
  },
  {
    id: 'end',
    name: '结束',
    description: '完成工作流。',
    type: 'end',
  },
];

export function toWorkflowDesignNodes(
  nodes: (WorkflowNode & { dir_name?: string; material_contract?: UniformNodeMaterialContract })[],
  useLegacyDescription = false,
): WorkflowNode[] {
  return nodes.map(({ executor, model, prompt, dir_name, material_contract, ...node }) => {
    const description = typeof node.description === 'string' ? node.description.trim() : '';
    const legacyDescription = node.type === 'task'
      ? (typeof prompt === 'string' ? prompt.trim() : '')
      : DEFAULT_WORKFLOW_NODES.find((control) => control.type === node.type)?.description;
    return {
      ...node,
      name: typeof node.name === 'string' ? node.name.trim() : '',
      description: description || (useLegacyDescription ? legacyDescription : undefined) || '',
    };
  });
}

export function resolveTaskNodeExecutor(node: WorkflowNode): string {
  return node.executor || (node.result_rule === 'acceptance' ? 'codex' : 'workbuddy');
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function canonicalizeValue(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      const v = (val as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = canonicalizeValue(v);
      }
    }
    return out;
  }
  return val;
}

export function computeWorkflowDefinitionSha256(wf: {
  id: string;
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
}): string {
  const payload = canonicalizeValue({
    id: wf.id,
    name: wf.name,
    description: wf.description ?? null,
    nodes: wf.nodes,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

export function buildUniformNodeMaterialContract(node: WorkflowNode): UniformNodeMaterialContract | null {
  if (node.type !== 'task') return null;
  const dirName = workflowMaterialNodeDirName(node.id);
  const purpose = node.description?.trim() || '';
  const instructionUsage: UniformNodeMaterialContract['instruction_usage'] =
    node.execution_mode === 'manual' ? 'manual_guide' : 'agent_prompt';

  return {
    node_dir: `nodes/${dirName}`,
    node_ref: `nodes/${dirName}/${dirName}.md`,
    prompt_ref: `nodes/${dirName}/prompt.md`,
    resources_dir: `nodes/${dirName}/resources`,
    instruction_usage: instructionUsage,
    supports_resources: true,
    supports_shared_refs: true,
    supports_input_bindings: true,
    supports_output_contract: true,
    default_required_outputs: node.result_rule === 'verification' ? ['result', 'test_report'] : ['result'],
    purpose,
    purpose_configured: Boolean(purpose),
  };
}

/**
 * Validates a workflow definition's node graph according to CBWorkBench rules:
 * 1. Exactly one 'start' node and one 'end' node.
 * 2. Unique non-empty node IDs.
 * 3. 'start' node has no incoming edges, only one on_success pointing to an existing task node.
 * 4. 'end' node has no outgoing edges, must have at least one incoming edge.
 * 5. 'task' nodes have valid execution_mode ('agent', 'manual') and valid max_executions.
 * 6. No edges may point back to 'start'.
 * 7. All targets (on_success, on_failure) must reference existing nodes.
 * 8. All nodes must be reachable from 'start'.
 * 9. Every node must have at least one path to 'end' (no dead-end loops without exit).
 * 10. The default workflow includes testing, acceptance and a final manual review before end.
 * 11. New workflow definitions require names and descriptions; existing task snapshots are exempt.
 */
export function validateWorkflowNodes(
  nodes: WorkflowNode[],
  workflowId?: string,
  { requireMetadata = true } = {},
): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(nodes) || nodes.length < 3) {
    return { valid: false, errors: ['工作流必须至少包含 3 个节点（开始、任务、结束）'] };
  }
  if (nodes.some((node) => !node || typeof node !== 'object' || Array.isArray(node))) {
    return { valid: false, errors: ['每个节点必须是有效的对象'] };
  }

  const nodeMap = new Map<string, WorkflowNode>();
  let startCount = 0;
  let endCount = 0;
  let startNode: WorkflowNode | null = null;
  let endNode: WorkflowNode | null = null;

  for (const node of nodes) {
    if (!node.id || typeof node.id !== 'string' || !node.id.trim()) {
      errors.push('节点 ID 不能为空');
      continue;
    }
    const id = node.id.trim();
    if (requireMetadata) {
      if (typeof node.name !== 'string' || !node.name.trim()) {
        errors.push(`节点 [${id}] 的名称为必填项`);
      }
      if (typeof node.description !== 'string' || !node.description.trim()) {
        errors.push(`节点 [${id}] 的描述为必填项`);
      }
    }
    if (id.toLowerCase() === 'shared') {
      errors.push('节点 ID 不得使用保留名称 shared');
    }
    if (nodeMap.has(id)) {
      errors.push(`重复的节点 ID: ${id}`);
    }
    nodeMap.set(id, node);

    if (node.type === 'start') {
      startCount++;
      startNode = node;
    } else if (node.type === 'end') {
      endCount++;
      endNode = node;
    } else if (node.type !== 'task') {
      errors.push(`节点 ${id} 类型无效: ${node.type}，必须严格为 start、task 或 end`);
    }
  }

  if (startCount !== 1 || !startNode) {
    errors.push(`工作流必须有且仅有一个开始节点（当前: ${startCount}）`);
  }
  if (endCount !== 1 || !endNode) {
    errors.push(`工作流必须有且仅有一个结束节点（当前: ${endCount}）`);
  }

  if (startNode) {
    if (!startNode.on_success) {
      errors.push('开始节点必须指定后继节点 (on_success)');
    } else if (!nodeMap.has(startNode.on_success)) {
      errors.push(`开始节点的目标节点不存在: ${startNode.on_success}`);
    } else if (nodeMap.get(startNode.on_success)?.type !== 'task') {
      errors.push('开始节点的后继节点必须是任务节点');
    }
    if (startNode.on_failure) {
      errors.push('开始节点不得配置失败去向');
    }
  }

  if (endNode) {
    if (endNode.on_success) {
      errors.push('结束节点不得配置出线 (on_success)');
    }
    if (endNode.on_failure) {
      errors.push('结束节点不得配置出线 (on_failure)');
    }
  }

  const predecessors = new Map<string, string[]>();
  const addPredecessor = (target: string, source: string) => {
    const sources = predecessors.get(target);
    if (sources) sources.push(source);
    else predecessors.set(target, [source]);
  };
  if (startNode?.on_success && nodeMap.get(startNode.on_success)?.type === 'task') {
    addPredecessor(startNode.on_success, startNode.id);
  }

  for (const node of nodes) {
    if (node.type === 'task') {
      const validModes: TaskExecutionMode[] = ['agent', 'manual'];
      if (!node.execution_mode || !validModes.includes(node.execution_mode)) {
        errors.push(`任务节点 ${node.id} 的执行方式无效: ${node.execution_mode}，必须为 agent 或 manual；测试命令由 Agent 节点自行执行`);
      }

      if ('command' in node) errors.push(`任务节点 ${node.id} 不再支持 command 配置，命令由节点自行确定并执行`);
      if (node.result_rule && !['default', 'verification', 'acceptance'].includes(node.result_rule)) {
        errors.push(`任务节点 ${node.id} 的结果规则无效: ${node.result_rule}`);
      }
      if (node.execution_mode !== 'agent' && node.result_rule && node.result_rule !== 'default') {
        errors.push(`任务节点 ${node.id} 的测试或验收规则仅适用于 Agent 节点`);
      }

      if (node.max_executions !== undefined && node.max_executions !== 0 && (!Number.isInteger(node.max_executions) || node.max_executions < 1)) {
        errors.push(`任务节点 ${node.id} 的最大执行次数必须为正整数或 0 (不限制)`);
      }

      if (!node.on_success) {
        errors.push(`任务节点 ${node.id} 必须配置成功去向 (on_success)`);
      } else {
        if (!nodeMap.has(node.on_success)) {
          errors.push(`任务节点 ${node.id} 的成功去向不存在: ${node.on_success}`);
        } else if (node.on_success === startNode?.id) {
          errors.push(`连线不得返回开始节点 (${node.id} -> ${node.on_success})`);
        } else {
          addPredecessor(node.on_success, node.id);
        }
      }

      if (node.on_failure) {
        if (!nodeMap.has(node.on_failure)) {
          errors.push(`任务节点 ${node.id} 的失败去向不存在: ${node.on_failure}`);
        } else if (node.on_failure === startNode?.id) {
          errors.push(`连线不得返回开始节点 (${node.id} -> ${node.on_failure})`);
        } else if (node.on_failure === endNode?.id) {
          errors.push(`任务节点 ${node.id} 的失败去向不能直接连向结束节点`);
        } else {
          addPredecessor(node.on_failure, node.id);
        }
      }
    }
  }

  if (startNode && predecessors.has(startNode.id)) {
    errors.push('开始节点不得有任何入线');
  }

  if (endNode && !predecessors.has(endNode.id)) {
    errors.push('结束节点必须至少有一条入线');
  }

  // Reachability analysis from start
  if (startNode && errors.length === 0) {
    const reachableFromStart = new Set<string>();
    const queue: string[] = [startNode.id];
    reachableFromStart.add(startNode.id);

    for (let index = 0; index < queue.length; index++) {
      const currId = queue[index];
      const currNode = nodeMap.get(currId);
      if (!currNode) continue;

      const successors: string[] = [];
      if (currNode.on_success) successors.push(currNode.on_success);
      if (currNode.on_failure) successors.push(currNode.on_failure);

      for (const succ of successors) {
        if (!reachableFromStart.has(succ)) {
          reachableFromStart.add(succ);
          queue.push(succ);
        }
      }
    }

    for (const node of nodes) {
      if (!reachableFromStart.has(node.id)) {
        errors.push(`存在不可达节点: ${node.id}`);
      }
    }

    // Reachability to end analysis
    if (endNode) {
      const canReachEnd = new Set([endNode.id]);
      const reverseQueue = [endNode.id];
      for (let index = 0; index < reverseQueue.length; index++) {
        for (const predecessor of predecessors.get(reverseQueue[index]) ?? []) {
          if (!canReachEnd.has(predecessor)) {
            canReachEnd.add(predecessor);
            reverseQueue.push(predecessor);
          }
        }
      }

      for (const node of nodes) {
        if (!canReachEnd.has(node.id)) {
          errors.push(`节点 ${node.id} 无法到达结束节点（闭环无出口）`);
        }
      }
    }
  }

  // Default workflow rule check
  if (workflowId === DEFAULT_WORKFLOW_ID && startNode && endNode && errors.length === 0) {
    const requiredNodes = ['test', 'acceptance'];
    for (const reqNode of requiredNodes) {
      if (!nodeMap.has(reqNode)) {
        errors.push(`默认开发交付工作流必须包含必需节点: ${reqNode}`);
      }
    }
    const review = nodeMap.get(DEFAULT_MANUAL_REVIEW_NODE_ID);
    if (review?.type !== 'task' || review.execution_mode !== 'manual' ||
        review.on_success !== endNode.id || predecessors.get(endNode.id)?.length !== 1) {
      errors.push('默认开发交付工作流必须由末尾的人工确认节点通过后才能结束');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
