import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '../storage/db.ts';
import { GitService } from '../services/gitService.ts';
import {
  DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  INSTANCE_ID,
} from '../config/constants.ts';
import {
  assertServerMatchesLocalInstance,
  resolveResidentServerForDataDir,
  DataDirConfigError,
} from '../config/dataDir.ts';
import { logger } from '../utils/logger.ts';
import {
  DEFAULT_WORKFLOW_ID,
  buildUniformNodeMaterialContract,
  computeWorkflowDefinitionSha256,
  type WorkflowNode,
} from '../services/workflowDefinition.ts';
import { PackageProtocolError } from '../services/packageProtocol.ts';
import { packageService } from '../services/packageService.ts';
import { taskCleanupService } from '../services/taskCleanupService.ts';
import { executionTimeoutSchema } from '../services/executionPolicy.ts';
import { encodeNodeDirName, PathSecurityError } from '../utils/pathSecurity.ts';
import { advanceInputShape, reportNodeCompletion } from '../services/nodeCompletion.ts';

function okJson(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            ok: true,
            request_id: crypto.randomUUID(),
            ...payload,
          },
          null,
          2
        ),
      },
    ],
  };
}

function errJson(err: unknown) {
  const requestId = crypto.randomUUID();
  if (err instanceof PackageProtocolError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: false,
              request_id: requestId,
              error: {
                code: err.code,
                message: err.message,
                retryable: err.retryable,
                details: err.details,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
  if (err instanceof PathSecurityError || err instanceof DataDirConfigError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: false,
              request_id: requestId,
              error: {
                code: err.code,
                message: err.message,
                retryable: false,
                details: [],
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            ok: false,
            request_id: requestId,
            error: {
              code: 'INTERNAL_ERROR',
              message,
              retryable: false,
              details: [],
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

async function verifyInstanceBindingIfConfigured(): Promise<string | null> {
  const configuredUrl = process.env.CB_SERVER_URL?.trim();
  if (configuredUrl) {
    const verified = await assertServerMatchesLocalInstance(configuredUrl, DATA_DIR, INSTANCE_ID);
    return verified.url;
  }
  const active = await resolveResidentServerForDataDir(DATA_DIR, INSTANCE_ID);
  return active ? active.url : null;
}

export function createWorkbenchMcpServer(advanceOnly = false): McpServer {
  const server = new McpServer({
    name: 'cb-workbench-mcp',
    version: '0.2.0',
  });

  server.tool('workbench_advance_workflow',
    '登记当前自动节点的执行结果。工作台在 CLI 正常退出后按工作流连线切换节点。',
    advanceInputShape, async (args) => {
      try {
        const res = reportNodeCompletion(args);
        if (!res.success) throw new PackageProtocolError('ADVANCE_REJECTED', res.message);
        return okJson({
          success: true, taskId: args.task_id, nodeId: args.node_id, attemptId: args.attempt_id,
          requestId: args.request_id, duplicate: res.duplicate || false, message: res.message,
        });
      } catch (error) {
        return errJson(error);
      }
    });
  if (advanceOnly) return server;

  // 1. workbench_get_package_protocol
  server.tool(
    'workbench_get_package_protocol',
    '查询 cb.task-package/2.0 任务包协议规范、大小限制、传输能力（仅支持 local_path）、模板、实例 ID 与当前绝对数据目录。',
    {},
    async () => {
      try {
        await verifyInstanceBindingIfConfigured();
        return okJson({ ...packageService.getProtocol() });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 2. workbench_list_workflows
  server.tool(
    'workbench_list_workflows',
    '获取工作台中所有可用的工作流模板列表、节点数量及定义摘要 (definition_sha256)。',
    {},
    async () => {
      try {
        const list = db.listWorkflows().map((wf) => {
          let nodes: WorkflowNode[] = [];
          try {
            nodes = JSON.parse(wf.nodes_json);
          } catch {}
          const defSha = computeWorkflowDefinitionSha256({
            id: wf.id,
            name: wf.name,
            description: wf.description,
            nodes,
          });
          return {
            id: wf.id,
            name: wf.name,
            description: wf.description,
            isDefault: Boolean(wf.is_default),
            nodeCount: nodes.length,
            definition_sha256: defSha,
            updatedAt: wf.updated_at,
          };
        });

        return okJson({ success: true, workflows: list });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 3. workbench_get_workflow
  server.tool(
    'workbench_get_workflow',
    '获取指定工作流的节点图、definition_sha256、节点名称和描述及材料契约 (material_contract)。根据名称和描述编写本次任务的节点提示词；执行器在任务中配置。',
    {
      workflow_id: z.string().describe('工作流唯一标识（如 "default"）'),
      node_ids: z.array(z.string()).optional().describe('可选：仅返回指定节点列表的详情'),
    },
    async (args) => {
      try {
        const wf = db.getWorkflow(args.workflow_id);
        if (!wf) {
          throw new PackageProtocolError('WORKFLOW_NOT_FOUND', `未找到工作流: ${args.workflow_id}`);
        }

        let nodes: WorkflowNode[] = [];
        try {
          nodes = JSON.parse(wf.nodes_json);
        } catch {}

        const definitionSha = computeWorkflowDefinitionSha256({
          id: wf.id,
          name: wf.name,
          description: wf.description,
          nodes,
        });

        const filterSet = args.node_ids ? new Set(args.node_ids) : null;
        const enrichedNodes = nodes
          .filter((n) => !filterSet || filterSet.has(n.id))
          .map((n) => ({
            ...n,
            ...(n.type === 'task'
              ? {
                  dir_name: encodeNodeDirName(n.id),
                  material_contract: buildUniformNodeMaterialContract(n),
                }
              : {}),
          }));

        return okJson({
          success: true,
          workflow: {
            id: wf.id,
            name: wf.name,
            description: wf.description,
            isDefault: Boolean(wf.is_default),
            definition_sha256: definitionSha,
            total_nodes: nodes.length,
            truncated: Boolean(filterSet && enrichedNodes.length < nodes.length),
            nodes: enrichedNodes,
            createdAt: wf.created_at,
            updatedAt: wf.updated_at,
          },
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 4. workbench_delete_workflow
  server.tool(
    'workbench_delete_workflow',
    '删除指定的工作流模板。注意：系统默认工作流（default）及正被任务引用的工作流禁止删除。',
    {
      workflow_id: z.string().describe('待删除的工作流唯一标识（ID）'),
    },
    async (args) => {
      try {
        const wf = db.getWorkflow(args.workflow_id);
        if (!wf) {
          throw new PackageProtocolError('WORKFLOW_NOT_FOUND', `未找到工作流: ${args.workflow_id}`);
        }
        if (wf.id === DEFAULT_WORKFLOW_ID || Boolean(wf.is_default)) {
          throw new PackageProtocolError('FORBIDDEN_DELETE_DEFAULT', '系统默认工作流禁止删除');
        }
        if (db.isWorkflowReferenced(wf.id)) {
          const refTasks = db.getWorkflowReferencingTasks(wf.id);
          throw new PackageProtocolError(
            'WORKFLOW_IN_USE',
            `工作流 [${wf.id}] 正被 ${refTasks.length} 个任务引用，禁止删除！引用任务: ${refTasks.map((t) => `${t.title} (${t.id})`).join(', ')}`
          );
        }
        db.deleteWorkflow(wf.id);
        logger.info(`[WorkbenchMCP] Workflow deleted: ${wf.id}`);
        return okJson({
          success: true,
          message: `工作流 [${wf.name || wf.id}] 已成功删除`,
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 5. workbench_submit_task
  server.tool(
    'workbench_submit_task',
    '提交极简任务包到开发工作台。服务端直接校验 package_root 目录完整性与各节点材料，落盘归档并将任务置为待人工确认启动状态 (pending_confirm)。',
    {
      package_root: z.string().describe('任务包本地绝对路径（必须包含 manifest.json、requirements.md 和各节点的 nodes/<node_id>/prompt.md）'),
      task_id: z.string().optional().describe('可选。若传入则作为现有任务的新修订版本提交；若省略则自动创建新任务'),
      budget_max_rounds: z.number().int().positive().max(100).optional().describe('可选。最大执行轮次上限'),
      execution_timeout_ms: executionTimeoutSchema.optional().describe('可选。单节点执行超时毫秒数'),
    },
    async (args) => {
      try {
        await verifyInstanceBindingIfConfigured();
        const res = packageService.submitTask(args);
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 6. workbench_get_package
  server.tool(
    'workbench_get_package',
    '查询正式任务包的 Manifest、文件索引、提交回执，并支持按 resource_path + offset_bytes + max_bytes 分页读取包内文件。',
    {
      task_id: z.string().describe('按任务 ID 查询'),
      revision: z.number().int().positive().optional().describe('可选修订号（不传则返回任务当前修订）'),
      resource_path: z.string().optional().describe('可选：读取指定包内相对路径的文件内容（支持分页）'),
      offset_bytes: z.number().int().nonnegative().optional().describe('读取起始字节偏移（默认 0）'),
      max_bytes: z.number().int().positive().optional().describe('单次读取最大字节数（上限 262144）'),
    },
    async (args) => {
      try {
        await verifyInstanceBindingIfConfigured();
        const res = packageService.getPackage(args);
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 7. workbench_get_node_context
  server.tool(
    'workbench_get_node_context',
    '按任务、节点、执行 attempt_id 与 completion_token 获取当前节点运行视图与允许访问的资源（严格节点隔离，禁止读取他节点私有资源）。',
    {
      task_id: z.string().describe('任务 ID'),
      node_id: z.string().describe('当前节点 ID'),
      attempt_id: z.string().describe('当前节点执行 ID (run_id)'),
      completion_token: z.string().describe('后台为本次节点执行分配的凭据'),
      resource_path: z.string().optional().describe('可选：按节点权限读取允许的材料、共同资源、绑定输入或本尝试输出'),
      offset_bytes: z.number().int().nonnegative().optional().describe('读取起始字节偏移'),
      max_bytes: z.number().int().positive().optional().describe('单次读取最大字节数'),
    },
    async (args) => {
      try {
        await verifyInstanceBindingIfConfigured();
        const res = packageService.getNodeContext(args);
        return okJson(res);
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 9. workbench_get_task_status
  server.tool(
    'workbench_get_task_status',
    '查询任务在工作台中的当前执行状态、当前节点、节点执行次数、修订版本、包摘要及阻塞信息。',
    {
      task_id: z.string().describe('任务 ID'),
    },
    async (args) => {
      try {
        const task = db.getTask(args.task_id);
        if (!task) {
          throw new PackageProtocolError('TASK_NOT_FOUND', `未找到任务: ${args.task_id}`);
        }

        const taskWf = db.getTaskWorkflow(args.task_id);
        const rev = db.getRevision(args.task_id, task.revision);
        let currentExecCount = 0;
        let currentMaxExec = 0;
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
        return okJson({
          taskId: task.id,
          taskKey: task.task_key,
          revision: task.revision,
          title: task.title,
          status: task.status,
          workflowId: taskWf?.workflow_id || 'default',
          workflowSha256: taskWf?.workflow_sha256 || rev?.workflow_sha256 || '',
          packageDigest: rev?.package_digest || null,
          readiness: rev?.readiness || null,
          currentNodeId: taskWf?.current_node_id || 'start',
          currentNodeName,
          currentNodeExecutionCount: currentExecCount,
          currentNodeMaxExecutions: currentMaxExec,
          currentRound: task.current_round,
          currentStage: task.current_stage,
          activeWorkerId: task.active_worker_id,
          blockedReason: task.blocked_reason,
          webUrl,
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 10. workbench_get_task_artifacts
  server.tool(
    'workbench_get_task_artifacts',
    '读取任务的代码变更差异、节点执行产物、命令执行记录及验收结论证据。',
    {
      task_id: z.string().describe('任务 ID'),
      round_number: z.number().optional().describe('可选：指定轮次，不传则返回全部测试记录与最新验收'),
    },
    async (args) => {
      try {
        const task = db.getTask(args.task_id);
        if (!task) {
          throw new PackageProtocolError('TASK_NOT_FOUND', `未找到任务: ${args.task_id}`);
        }

        const nodeRuns = db.getNodeRuns(args.task_id).map(({ completion_token, ...run }) => run);
        const testRuns = db.getTestRuns(args.task_id, args.round_number);
        const acceptanceRuns = db.getAcceptanceRuns(args.task_id);
        const latestAcceptance = acceptanceRuns[acceptanceRuns.length - 1];

        let diff = null;
        try {
          const cwd = task.confirmed_cwd || task.target_cwd;
          diff = GitService.getDiffSnapshot(cwd);
        } catch {}

        return okJson({
          taskId: task.id,
          revision: task.revision,
          diffSnapshot: diff,
          nodeRuns,
          testRuns,
          latestAcceptance,
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  // 11. workbench_delete_task
  server.tool(
    'workbench_delete_task',
    '从工作台中删除指定任务及其全部所属节点材料、历史修订、运行产物与草稿。若常驻后台正在运行，统一委托常驻后台执行可恢复清理。',
    {
      task_id: z.string().describe('要删除的任务 ID'),
    },
    async (args) => {
      try {
        const serverUrl = await verifyInstanceBindingIfConfigured();
        if (serverUrl) {
          const res = await fetch(`${serverUrl}/api/tasks/${encodeURIComponent(args.task_id)}`, {
            method: 'DELETE',
          });
          const data = (await res.json()) as any;
          if (!res.ok || !data?.success) {
            throw new PackageProtocolError(
              data?.code || 'CLEANUP_FAILED',
              data?.message || `常驻后台删除任务失败 (HTTP ${res.status})`
            );
          }
          return okJson({
            success: true,
            taskId: args.task_id,
            delegatedToServer: serverUrl,
            message: data.message,
          });
        }

        const existingTask = db.getTask(args.task_id);
        if (!existingTask) {
          throw new PackageProtocolError('TASK_NOT_FOUND', `未找到任务: ${args.task_id}`);
        }

        const result = await taskCleanupService.deleteTask(args.task_id);
        if (!result.ok) {
          throw new PackageProtocolError(result.code || 'CLEANUP_FAILED', result.message);
        }

        logger.info(`[WorkbenchMCP] Task deleted: ${args.task_id}`);
        return okJson({
          success: true,
          taskId: args.task_id,
          message: result.message,
        });
      } catch (err) {
        return errJson(err);
      }
    }
  );

  return server;
}

export async function startMcpServer(advanceOnly = false): Promise<void> {
  const server = createWorkbenchMcpServer(advanceOnly);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`[WorkbenchMCP] Workbench stdio MCP server connected. instance=${INSTANCE_ID}, dataDir=${DATA_DIR}`);
}
