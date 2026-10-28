import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from '../services/gitService.ts';
import { DEFAULT_PORT, DEFAULT_HOST, TaskStatus } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

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
      budget_max_rounds: z.number().optional().describe('可选：最大执行轮次预算（默认 10）'),
      budget_timeout_sec: z.number().optional().describe('可选：总执行时长预算秒数（默认 1800）'),
    },
    async (args) => {
      try {
        const taskId = `task-${crypto.randomBytes(6).toString('hex')}`;
        const revision = 1;

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

        // Save into DB
        const task = db.createTask({
          id: taskId,
          task_key: args.task_key,
          revision,
          title: args.title,
          status: TaskStatus.PENDING_CONFIRM,
          target_cwd: args.target_cwd,
          git_root: gitInfo.gitRoot,
          git_commit: gitInfo.headCommit,
          git_status: gitInfo.statusText,
          budget_max_rounds: args.budget_max_rounds,
          budget_timeout_sec: args.budget_timeout_sec,
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

        // Save to File Store
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

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createWorkbenchMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('[WorkbenchMCP] Workbench stdio MCP server connected.');
}
