import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../storage/db.ts';
import { encodeNodeDirName } from '../utils/pathSecurity.ts';
import { PackageProtocolError } from './packageProtocol.ts';
import { DEFAULT_WORKFLOW_NODES, validateWorkflowNodes, type WorkflowNode } from './workflowDefinition.ts';

const text = z.string().trim().min(1, '不能留空');
const metadata = { name: text, description: text };
const workflowMetadata = { name: text, description: z.string().trim().optional() };
const taskOptions = {
  execution_mode: z.enum(['agent', 'manual']).optional(),
  result_rule: z.enum(['default', 'verification', 'acceptance']).optional(),
  max_executions: z.number().int().nonnegative().optional(),
};

export const createWorkflowSchema = z.object({
  ...workflowMetadata,
  steps: z.array(z.object({
    ...metadata,
    ...taskOptions,
    on_success: text.nullable().optional(),
    on_failure: text.nullable().optional(),
  }).strict()).min(1, '至少需要一个任务步骤'),
}).strict();

// 节点 ID 会进入页面绑定、材料目录和任务包校验，须能直接用作目录名。
const nodeId = z.string().min(1).refine(id => encodeNodeDirName(id) === id, '节点 ID 必须是可直接用作材料目录的安全标识');
const nodeMetadata = { ...metadata, id: nodeId };
const workflowFileSchema = z.object({
  ...workflowMetadata,
  nodes: z.array(z.discriminatedUnion('type', [
    z.object({ ...nodeMetadata, type: z.literal('start'), on_success: nodeId }).strict(),
    z.object({ ...nodeMetadata, type: z.literal('end') }).strict(),
    z.object({
      ...nodeMetadata,
      ...taskOptions,
      type: z.literal('task'),
      on_success: nodeId,
      on_failure: nodeId.nullable().optional(),
    }).strict(),
  ])),
}).strict();

type WorkflowFile = z.infer<typeof workflowFileSchema>;

function invalid(field: string, reason: string): never {
  throw new PackageProtocolError('INVALID_WORKFLOW', `${field}：${reason}`, [{ field, reason }]);
}

function validateGraph(nodes: WorkflowNode[], source: 'steps' | 'nodes'): void {
  const conflict = nodes.findIndex(node =>
    node.execution_mode === 'manual' && (node.result_rule === 'verification' || node.result_rule === 'acceptance'));
  if (conflict >= 0) {
    const index = source === 'steps' ? conflict - 1 : conflict;
    invalid(`${source}[${index}].result_rule`, '人工门禁节点不能配置自动测试或验收规则');
  }
  const { valid, errors } = validateWorkflowNodes(nodes);
  if (!valid) {
    throw new PackageProtocolError('INVALID_WORKFLOW', errors.join('；'), errors.map(reason => ({ field: source, reason })));
  }
}

function readWorkflowFile(input: unknown): WorkflowFile {
  const parsed = workflowFileSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => ({
      field: issue.path.reduce<string>((field, part) => typeof part === 'number'
        ? `${field}[${part}]` : [field, part].filter(Boolean).join('.'), '') || 'workflow',
      reason: issue.message,
    }));
    throw new PackageProtocolError(
      'INVALID_WORKFLOW', details.map(({ field, reason }) => `${field}：${reason}`).join('；'), details,
    );
  }
  return parsed.data;
}

/** 创建和导入始终生成独立模板。 */
function insertTemplate(name: string, description: string | undefined, nodes: WorkflowNode[]): string {
  return db.transaction(() => {
    let id = `wf_${randomUUID()}`;
    while (db.getWorkflow(id)) id = `wf_${randomUUID()}`;
    return db.saveWorkflowDefinition({ id, name, description, nodes_json: JSON.stringify(nodes) }).id;
  });
}

/** 展开步骤顺序和按名称指定的分支。 */
export function createWorkflowTemplate({ name, description, steps }: z.infer<typeof createWorkflowSchema>): string {
  const ids = steps.map((_, index) => `step_${index + 1}`);
  const targets = new Map<string, string | null>();
  steps.forEach((step, index) => {
    targets.set(step.name, targets.has(step.name) ? null : ids[index]);
  });
  const resolveTarget = (name: string, field: string) => {
    const id = targets.get(name);
    return id ?? invalid(field, id === null ? `存在多个名为「${name}」的步骤` : `未找到步骤「${name}」`);
  };

  const tasks = steps.map<WorkflowNode>(({ on_success, on_failure, execution_mode = 'agent', ...step }, index) => ({
    ...step,
    id: ids[index],
    type: 'task',
    execution_mode,
    on_success: on_success
      ? resolveTarget(on_success, `steps[${index}].on_success`)
      : on_success === null ? 'end' : ids[index + 1] ?? 'end',
    on_failure: on_failure ? resolveTarget(on_failure, `steps[${index}].on_failure`) : undefined,
  }));
  const nodes = [
    { ...DEFAULT_WORKFLOW_NODES[0], on_success: ids[0] },
    ...tasks,
    DEFAULT_WORKFLOW_NODES.at(-1)!,
  ];
  validateGraph(nodes, 'steps');
  return insertTemplate(name, description, nodes);
}

/** 文件省略的执行方式在存储前补为自动。 */
export function importWorkflowTemplate(input: unknown): string {
  const { name, description, nodes } = readWorkflowFile(input);
  const graph = nodes.map(node => node.type === 'task' ? { ...node, execution_mode: node.execution_mode ?? 'agent' } : node);
  validateGraph(graph, 'nodes');
  return insertTemplate(name, description, graph);
}

/** 仅导出模板定义和非默认配置。 */
export function exportWorkflowTemplate(id: string): WorkflowFile {
  const workflow = db.getWorkflow(id);
  if (!workflow) throw new PackageProtocolError('WORKFLOW_NOT_FOUND', `未找到工作流：${id}`);

  let nodes: WorkflowNode[];
  try {
    nodes = JSON.parse(workflow.nodes_json);
  } catch {
    return invalid('nodes', '已保存的节点数据不是有效的 JSON');
  }
  const validation = validateWorkflowNodes(nodes);
  if (!validation.valid) invalid('nodes', validation.errors.join('；'));

  return readWorkflowFile({
    name: workflow.name,
    ...(workflow.description?.trim() && { description: workflow.description }),
    nodes: nodes.map(node => {
      const common = { id: node.id, type: node.type, name: node.name, description: node.description };
      if (node.type === 'end') return common;
      const linkedNode = { ...common, on_success: node.on_success };
      if (node.type === 'start') return linkedNode;
      return {
        ...linkedNode,
        ...(node.execution_mode === 'manual' && { execution_mode: node.execution_mode }),
        ...(node.result_rule && node.result_rule !== 'default' && { result_rule: node.result_rule }),
        ...(node.max_executions && { max_executions: node.max_executions }),
        ...(node.on_failure && { on_failure: node.on_failure }),
      };
    }),
  });
}
