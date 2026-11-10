import { executionTimeoutSchema, resolveExecutionTimeout } from '../services/executionPolicy.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from '../services/gitService.ts';
import { workflowEngine } from '../services/workflowEngine.ts';
import { DEFAULT_PORT, DEFAULT_HOST, TaskStatus } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { DEFAULT_WORKFLOW_ID, type WorkflowNode } from '../services/workflowDefinition.ts';

export function createWorkbenchMcpServer(): McpServer {
  const server = new McpServer({
    name: 'cb-workbench-mcp',
    version: '0.1.0',
  });

  // 1. Tool: workbench_submit_task
  server.tool(
    'workbench_submit_task',
    '将主 Agent 与 cb-flow 制作的完整任务包上传至开发工作台。任务将处于【待启动确认】状态，返回任务编号与详情页面链接。注意：MCP 提交不会自动开始执行，用户须在工作台页面手动核对并点击【确认并开始】。',
    {
      task_key: z.string().describe('任务唯一英文标识（如 add-supplier-filter）'),
      title: z.string().describe('任务的简明中文标题'),
      target_cwd: z.string().describe('当前对话实际工作目录的绝对路径'),
      manifest_json: z.string().describe('完整的 manifest.json 内容'),
      task_md: z.string().describe('完整的 task.md 内容'),
      development_md: z.string().describe('完整的 development.md 内容'),
      tests_md: z.string().describe('完整的 tests.md 内容'),
      acceptance_md: z.string().describe('完整的 acceptance.md 内容'),
      verifier_prompt_md: z.string().describe('完整的 prompts/verifier.md 内容'),
      worker_prompts: z
        .record(z.string())
        .describe('各 Worker 提示词映射，键为 workerId（如 "worker-dev"），值为独立提示词正文'),
      workflow_id: z.string().optional().describe('工作流模板 ID（默认为 "default"）'),
      node_prompts: z.record(z.string()).optional().describe('工作流各 Agent 节点独立提示词映射（键为节点 ID，值为提示词）'),
      execution_timeout_ms: executionTimeoutSchema.optional(),
      budget_max_rounds: z.number().optional().describe('可选：最大执行轮次预算（默认 10）'),
    },
    async (args) => {
      try {
        const taskId = `task-${crypto.randomBytes(6).toString('hex')}`;
        const revision = 1;
        const manifest=JSON.parse(args.manifest_json);
        const executionTimeoutMs=resolveExecutionTimeout(args.execution_timeout_ms,null,manifest);
        const executionTimeoutSource=args.execution_timeout_ms!==undefined?'request':manifest.executionPolicy?.executionTimeoutMs!==undefined?'manifest.executionTimeoutMs':executionTimeoutSchema.safeParse(manifest.executionPolicy?.timeoutMs).success?'manifest.timeoutMs':executionTimeoutSchema.safeParse(Number(process.env.CB_EXECUTION_TIMEOUT_MS)).success?'environment':'default';

        // Inspect workspace Git
        let gitInfo;
        try {
          gitInfo = GitService.inspectWorkspace(args.target_cwd);
        } catch (e: any) {
          gitInfo = {
            targetCwd: args.target_cwd,
            isGitRepo: false,
            gitRoot: null,
            branch: null,
            headCommit: null,
            isDirty: false,
            statusText: `Git inspection error: ${e.message}`,
          };
        }

        // Validate workflow
        const wfId = args.workflow_id || DEFAULT_WORKFLOW_ID;
        const wfDef = db.getWorkflow(wfId);
        if (!wfDef) {
          throw new Error(`未找到指定工作流模板: ${wfId}`);
        }
        if (args.node_prompts) {
          const nodes = JSON.parse(wfDef.nodes_json) as WorkflowNode[];
          for (const [nodeId] of Object.entries(args.node_prompts)) {
            const node = nodes.find((n) => n.id === nodeId);
            if (!node) throw new Error(`node_prompts 中的节点 ID 不存在: ${nodeId}`);
            if (node.type !== 'task' || node.execution_mode !== 'agent') {
              throw new Error(`节点 ${nodeId} 执行方式不是 Agent，不可配置 node_prompts`);
            }
          }
        }

        // Save into DB atomically via transaction
        db.transaction(() => {
          db.createTask({
            id: taskId,
            task_key: args.task_key,
            revision,
            title: args.title,
            status: TaskStatus.PENDING_CONFIRM,
            target_cwd: args.target_cwd,
            git_root: gitInfo.gitRoot,
            git_commit: gitInfo.headCommit,
            git_status: gitInfo.statusText,
            execution_timeout_ms: executionTimeoutMs,
            budget_max_rounds: args.budget_max_rounds,
          });

          // Initialize task workflow
          db.initTaskWorkflow(taskId, {
            workflowId: wfDef.id,
            nodePrompts: args.node_prompts,
          });

          // Save Revision
          db.saveRevision({
            task_id: taskId,
            revision,
            manifest_json: args.manifest_json,
            task_md: args.task_md,
            development_md: args.development_md,
            tests_md: args.tests_md,
            acceptance_md: args.acceptance_md,
            verifier_prompt_md: args.verifier_prompt_md,
          });

          // Save Worker Prompts
          for (const [workerId, promptText] of Object.entries(args.worker_prompts)) {
            db.saveWorkerPrompt({
              task_id: taskId,
              revision,
              worker_id: workerId,
              role: workerId.includes('review') ? 'reviewer' : 'developer',
              prompt_text: promptText,
            });
          }
        });

        // Save to File Store (projection)
        taskFileStore.saveTaskPackage(taskId, revision, {
          manifest_json: args.manifest_json,
          task_md: args.task_md,
          development_md: args.development_md,
          tests_md: args.tests_md,
          acceptance_md: args.acceptance_md,
          verifier_prompt_md: args.verifier_prompt_md,
          worker_prompts: args.worker_prompts,
        });

        const webUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/tasks/${taskId}`;
        logger.info(`[WorkbenchMCP] Task submitted: ${taskId} (${args.title})`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  taskId,
                  taskKey: args.task_key,
                  revision,
                  status: TaskStatus.PENDING_CONFIRM,
                  workflowId: wfDef.id,
                  execution_timeout_ms:executionTimeoutMs,
                  executionTimeoutSource,
                  statusDescription: '待启动确认',
                  targetCwd: args.target_cwd,
                  gitRoot: gitInfo.gitRoot,
                  gitCommit: gitInfo.headCommit,
                  webUrl,
                  message:
                    '任务包已成功上传到工作台，处于【待启动确认】状态。请用户在工作台页面核对目录并点击【确认并开始】。',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        logger.error('[WorkbenchMCP] Error in workbench_submit_task:', err);
        return {
          isError: true,
          content: [{ type: 'text', text: `上传任务包失败: ${err.message}` }],
        };
      }
    }
  );

  // 2. Tool: workbench_revise_task
  server.tool(
    'workbench_revise_task',
    '提交任务包的修订版本（如调整需求、补充测试用例或修正提示词）。',
    {
      task_id: z.string().describe('原任务的 ID'),
      manifest_json: z.string().describe('修订后的 manifest.json'),
      task_md: z.string().describe('修订后的 task.md'),
      development_md: z.string().describe('修订后的 development.md'),
      tests_md: z.string().describe('修订后的 tests.md'),
      acceptance_md: z.string().describe('修订后的 acceptance.md'),
      verifier_prompt_md: z.string().describe('修订后的 prompts/verifier.md'),
      worker_prompts: z.record(z.string()).describe('修订后的 Worker 提示词映射'),
    },
    async (args) => {
      try {
        const task = db.getTask(args.task_id);
        if (!task) {
          return {
            isError: true,
            content: [{ type: 'text', text: `未找到任务: ${args.task_id}` }],
          };
        }

        const newRevision = task.revision + 1;

        // Atomically save revision and worker prompts
        db.transaction(() => {
          db.saveRevision({
            task_id: args.task_id,
            revision: newRevision,
            manifest_json: args.manifest_json,
            task_md: args.task_md,
            development_md: args.development_md,
            tests_md: args.tests_md,
            acceptance_md: args.acceptance_md,
            verifier_prompt_md: args.verifier_prompt_md,
          });

          for (const [workerId, promptText] of Object.entries(args.worker_prompts)) {
            db.saveWorkerPrompt({
              task_id: args.task_id,
              revision: newRevision,
              worker_id: workerId,
              role: 'worker',
              prompt_text: promptText,
            });
          }
        });

        taskFileStore.saveTaskPackage(args.task_id, newRevision, {
          manifest_json: args.manifest_json,
          task_md: args.task_md,
          development_md: args.development_md,
          tests_md: args.tests_md,
          acceptance_md: args.acceptance_md,
          verifier_prompt_md: args.verifier_prompt_md,
          worker_prompts: args.worker_prompts,
        });

        const webUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/tasks/${args.task_id}`;
        logger.info(`[WorkbenchMCP] Task revised: ${args.task_id} -> r${newRevision}`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  taskId: args.task_id,
                  revision: newRevision,
                  webUrl,
                  message: `已保存第 ${newRevision} 版任务材料。用户可在工作台核对新版本。`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `修订任务失败: ${err.message}` }],
        };
      }
    }
  );

  // 3. Tool: workbench_get_task_status
  server.tool(
    'workbench_get_task_status',
    '查询任务在工作台中的当前执行状态、当前轮次、当前执行阶段及阻塞信息。',
    {
      task_id: z.string().describe('任务 ID'),
    },
    async (args) => {
      const task = db.getTask(args.task_id);
      if (!task) {
        return {
          isError: true,
          content: [{ type: 'text', text: `未找到任务: ${args.task_id}` }],
        };
      }

      const taskWf = db.getTaskWorkflow(args.task_id);
      let currentExecCount = 0;
      let currentMaxExec = 3;
      let currentNodeName = task.current_stage || '';

      if (taskWf) {
        try {
          const nodes = JSON.parse(taskWf.nodes_json) as WorkflowNode[];
          const node = nodes.find((n) => n.id === taskWf.current_node_id);
          if (node) {
            currentNodeName = node.name;
            currentMaxExec = node.max_executions || 0;
            currentExecCount = db.getNodeRunCount(args.task_id, node.id);
          }
        } catch {}
      }

      const webUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/tasks/${args.task_id}`;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                taskId: task.id,
                taskKey: task.task_key,
                revision: task.revision,
                title: task.title,
                status: task.status,
                workflowId: taskWf?.workflow_id || 'default',
                currentNodeId: taskWf?.current_node_id || 'start',
                currentNodeName,
                currentNodeExecutionCount: currentExecCount,
                currentNodeMaxExecutions: currentMaxExec,
                currentRound: task.current_round,
                currentStage: task.current_stage,
                activeWorkerId: task.active_worker_id,
                blockedReason: task.blocked_reason,
                webUrl,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 4. Tool: workbench_get_task_artifacts
  server.tool(
    'workbench_get_task_artifacts',
    '读取任务的代码变更差异、测试报告或 Codex 验收结论证据。',
    {
      task_id: z.string().describe('任务 ID'),
      round_number: z.number().optional().describe('可选：指定轮次，不传则返回最新轮次数据'),
    },
    async (args) => {
      const task = db.getTask(args.task_id);
      if (!task) {
        return {
          isError: true,
          content: [{ type: 'text', text: `未找到任务: ${args.task_id}` }],
        };
      }

      const testRuns = db.getTestRuns(args.task_id, args.round_number);
      const acceptanceRuns = db.getAcceptanceRuns(args.task_id);
      const latestAcceptance = acceptanceRuns[acceptanceRuns.length - 1];

      let diff = null;
      try {
        const cwd = task.confirmed_cwd || task.target_cwd;
        diff = GitService.getDiffSnapshot(cwd);
      } catch {}

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                taskId: task.id,
                revision: task.revision,
                diffSnapshot: diff,
                testRuns,
                latestAcceptance,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 5. Tool: workbench_delete_task
  server.tool(
    'workbench_delete_task',
    '从工作台中删除指定任务，一并删除该任务相关的方案和文件。',
    {
      task_id: z.string().describe('要删除的任务 ID'),
    },
    async (args) => {
      const task = db.getTask(args.task_id);
      if (!task) {
        return {
          isError: true,
          content: [{ type: 'text', text: `未找到任务: ${args.task_id}` }],
        };
      }
      await workflowEngine.handleTaskDeleted(args.task_id);
      db.deleteTask(args.task_id);
      taskFileStore.deleteTaskFiles(args.task_id);
      logger.info(`[WorkbenchMCP] Task deleted: ${args.task_id}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                taskId: args.task_id,
                message: `任务 ${args.task_id} 及其相关方案和文件已成功删除`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 6. Tool: workbench_list_workflows
  server.tool(
    'workbench_list_workflows',
    '获取工作台中所有可用的工作流模板列表及节点数量。',
    {},
    async () => {
      const list = db.listWorkflows().map((wf) => {
        let nodeCount = 0;
        try {
          nodeCount = JSON.parse(wf.nodes_json).length;
        } catch {}
        return {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          isDefault: Boolean(wf.is_default),
          nodeCount,
          updatedAt: wf.updated_at,
        };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, workflows: list }, null, 2),
          },
        ],
      };
    }
  );

  // 7. Tool: workbench_get_workflow
  server.tool(
    'workbench_get_workflow',
    '获取指定工作流的完整节点图定义（包含稳定节点 ID、执行方式、提示词模板、成功/失败去向和最大执行次数）。',
    {
      workflow_id: z.string().describe('工作流唯一标识（如 "default"）'),
    },
    async (args) => {
      const wf = db.getWorkflow(args.workflow_id);
      if (!wf) {
        return {
          isError: true,
          content: [{ type: 'text', text: `未找到工作流: ${args.workflow_id}` }],
        };
      }

      let nodes = [];
      try {
        nodes = JSON.parse(wf.nodes_json);
      } catch {}

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                workflow: {
                  id: wf.id,
                  name: wf.name,
                  description: wf.description,
                  isDefault: Boolean(wf.is_default),
                  nodes,
                  createdAt: wf.created_at,
                  updatedAt: wf.updated_at,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 8. Tool: workbench_delete_workflow
  server.tool(
    'workbench_delete_workflow',
    '删除指定的工作流模板。注意：系统默认工作流（default）及正被任务引用的工作流禁止删除。',
    {
      workflow_id: z.string().describe('待删除的工作流唯一标识（ID）'),
    },
    async (args) => {
      const wf = db.getWorkflow(args.workflow_id);
      if (!wf) {
        return {
          isError: true,
          content: [{ type: 'text', text: `未找到工作流: ${args.workflow_id}` }],
        };
      }
      if (wf.id === DEFAULT_WORKFLOW_ID || Boolean(wf.is_default)) {
        return {
          isError: true,
          content: [{ type: 'text', text: '系统默认工作流禁止删除' }],
        };
      }
      if (db.isWorkflowReferenced(wf.id)) {
        const refTasks = db.getWorkflowReferencingTasks(wf.id);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `工作流 [${wf.id}] 正被 ${refTasks.length} 个任务引用，禁止删除！请先清理相关任务。引用任务: ${refTasks.map((t) => `${t.title} (${t.id})`).join(', ')}`,
            },
          ],
        };
      }
      try {
        db.deleteWorkflow(wf.id);
        logger.info(`[WorkbenchMCP] Workflow deleted: ${wf.id}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message: `工作流 [${wf.name || wf.id}] 已成功删除`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `删除工作流失败: ${e.message}` }],
        };
      }
    }
  );

  // 9. Tool: workbench_advance_workflow
  server.tool(
    'workbench_advance_workflow',
    '当前正在运行的 Agent 报告本节点执行完成或失败并请求推进。后台结合连线配置统一推进，调用方无需也不得指定下一节点。',
    {
      task_id: z.string().describe('任务唯一标识'),
      node_id: z.string().describe('当前节点 ID（如 "acceptance" 或 "development"）'),
      attempt_id: z.string().describe('本次节点执行唯一 ID (run_id)'),
      completion_token: z.string().describe('本次节点执行分配的安全凭据'),
      request_id: z.string().describe('本次报告调用的唯一幂等请求 ID'),
      outcome: z.enum(['passed', 'failed']).describe('本次节点业务判定结果：passed (成功) 或 failed (失败)'),
      summary: z.string().describe('本次节点完成摘要或失败原因说明'),
    },
    async (args) => {
      const res = db.registerAdvanceReport(
        args.task_id,
        args.node_id,
        args.attempt_id,
        args.completion_token,
        args.request_id,
        args.outcome,
        args.summary
      );

      if (!res.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: `报告推进失败: ${res.message}` }],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                taskId: args.task_id,
                nodeId: args.node_id,
                attemptId: args.attempt_id,
                requestId: args.request_id,
                duplicate: res.duplicate || false,
                message: res.message,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createWorkbenchMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('[WorkbenchMCP] Workbench stdio MCP server connected.');
}
