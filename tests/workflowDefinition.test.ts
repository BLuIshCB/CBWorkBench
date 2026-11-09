import assert from 'node:assert';
import {
  DEFAULT_WORKFLOW_NODES,
  validateWorkflowNodes,
  DEFAULT_WORKFLOW_ID,
  type WorkflowNode,
} from '../src/services/workflowDefinition.ts';

console.log('[Test] Running workflowDefinition.test.ts...');

// 1. Default workflow is strictly valid
const defaultRes = validateWorkflowNodes(DEFAULT_WORKFLOW_NODES, DEFAULT_WORKFLOW_ID);
assert.strictEqual(defaultRes.valid, true, `Default workflow should be valid: ${defaultRes.errors.join(', ')}`);
console.log('  ✓ Default workflow passes validation');

// 2. Reject missing start or end
const noStart = DEFAULT_WORKFLOW_NODES.filter((n) => n.type !== 'start');
const noStartRes = validateWorkflowNodes(noStart);
assert.strictEqual(noStartRes.valid, false);
assert(noStartRes.errors.some((e) => e.includes('开始节点')));
console.log('  ✓ Rejects missing start node');

// 3. Reject duplicate node IDs
const dupNodes: WorkflowNode[] = [
  ...DEFAULT_WORKFLOW_NODES,
  { id: 'development', name: '重复开发', type: 'task', execution_mode: 'agent', on_success: 'end' },
];
const dupRes = validateWorkflowNodes(dupNodes);
assert.strictEqual(dupRes.valid, false);
assert(dupRes.errors.some((e) => e.includes('重复的节点 ID')));
console.log('  ✓ Rejects duplicate node IDs');

// 4. Reject incoming edge to start
const startIncoming: WorkflowNode[] = DEFAULT_WORKFLOW_NODES.map((n) => {
  if (n.id === 'test') {
    return { ...n, on_failure: 'start' };
  }
  return n;
});
const startIncRes = validateWorkflowNodes(startIncoming);
assert.strictEqual(startIncRes.valid, false);
assert(startIncRes.errors.some((e) => e.includes('返回开始节点') || e.includes('开始节点不得有任何入线')));
console.log('  ✓ Rejects edge returning to start');

// 5. Reject outgoing edge from end
const endOutgoing: WorkflowNode[] = DEFAULT_WORKFLOW_NODES.map((n) => {
  if (n.id === 'end') {
    return { ...n, on_success: 'development' };
  }
  return n;
});
const endOutRes = validateWorkflowNodes(endOutgoing);
assert.strictEqual(endOutRes.valid, false);
assert(endOutRes.errors.some((e) => e.includes('结束节点不得配置出线')));
console.log('  ✓ Rejects outgoing edge from end');

// 6. Reject invalid node types (strictly only start, end, task)
const badTypeNodes: WorkflowNode[] = [
  ...DEFAULT_WORKFLOW_NODES.filter((n) => n.id !== 'human_review'),
  {
    id: 'approval',
    name: '审批节点',
    type: 'approval' as any,
    on_success: 'end',
  },
];
const badTypeRes = validateWorkflowNodes(badTypeNodes);
assert.strictEqual(badTypeRes.valid, false);
assert(badTypeRes.errors.some((e) => e.includes('类型无效')));
console.log('  ✓ Rejects node types other than start, task, end');

// 7. Reject unreachable node
const unreachableNodes: WorkflowNode[] = [
  ...DEFAULT_WORKFLOW_NODES,
  {
    id: 'orphan',
    name: '孤立任务',
    type: 'task',
    execution_mode: 'command',
    on_success: 'end',
  },
];
const unreachableRes = validateWorkflowNodes(unreachableNodes);
assert.strictEqual(unreachableRes.valid, false);
assert(unreachableRes.errors.some((e) => e.includes('不可达节点')));
console.log('  ✓ Rejects unreachable orphan nodes');

// 8. Reject infinite cycle with no path to end
const cycleNodes: WorkflowNode[] = [
  { id: 'start', name: '开始', type: 'start', on_success: 'taskA' },
  { id: 'taskA', name: 'A', type: 'task', execution_mode: 'agent', on_success: 'taskB', on_failure: 'taskB' },
  { id: 'taskB', name: 'B', type: 'task', execution_mode: 'command', on_success: 'taskA', on_failure: 'taskA' },
  { id: 'end', name: '结束', type: 'end' },
];
const cycleRes = validateWorkflowNodes(cycleNodes);
assert.strictEqual(cycleRes.valid, false);
assert(cycleRes.errors.some((e) => e.includes('无法到达结束节点') || e.includes('结束节点必须至少有一条入线')));
console.log('  ✓ Rejects graph where nodes cannot reach end');

console.log('✅ workflowDefinition.test.ts passed successfully!');
