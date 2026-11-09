import { CliRunner } from '../services/cliRunner.ts';
import { ExecutionService } from '../services/executionService.ts';
import { confirmStartSchema } from '../services/executionPolicy.ts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from '../services/gitService.ts';
import { workflowEngine } from '../services/workflowEngine.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import { runtimeService } from '../services/runtimeService.ts';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  WORKER_FIXED_MODEL,
  VERIFIER_DEFAULT_MODEL,
  TaskStatus,
} from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { resolveSupportedNode } from '../utils/nodeResolver.js';
import {
  validateWorkflowNodes,
  DEFAULT_WORKFLOW_ID,
  DEFAULT_WORKFLOW_NODES,
  type WorkflowNode,
} from '../services/workflowDefinition.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, '..', 'ui');

export async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        // 5MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e: any) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  const jsonStr = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(jsonStr),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(jsonStr);
}

export function sendFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

export function createHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      const executionMatch=pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/execution$/);
      if(executionMatch && method==='GET') {
        if(!db.getTask(executionMatch[1])) {sendJson(res,404,{success:false,code:'NOT_FOUND',message:'Task not found'});return;}
        const latest=db.latestRun(executionMatch[1]);
        sendJson(res,200,{success:true,run:latest ? ExecutionService.snapshot(latest.runId) : null});return;
      }
      const cleanupMatch=pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/cleanup$/);
      if(cleanupMatch && method==='POST') {
        if(!db.getRun(cleanupMatch[1])){sendJson(res,404,{success:false,code:'NOT_FOUND',message:'Run not found'});return;}
        const confirmed=await CliRunner.retryCleanup(cleanupMatch[1]);
        sendJson(res,confirmed?200:409,{success:confirmed,...(confirmed?{}:{code:'CONFLICT'}),message:confirmed?'已确认回收':'无法安全确认回收，保留占用与现场；请检查原生进程。'});return;
      }
      const eventsMatch=pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/(events|stream)$/);
      if(eventsMatch && method==='GET') {
        const runId=eventsMatch[1];
        const rawAfter=eventsMatch[2]==='stream' ? (req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0') : (url.searchParams.get('after') ?? '0');
        const rawLimit=url.searchParams.get('limit') ?? '200';
        const after=Number(rawAfter),limit=Number(rawLimit);
        if(!/^\d+$/.test(String(rawAfter)) || !Number.isSafeInteger(after) || !/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit<1 || limit>500) {
          sendJson(res,400,{success:false,code:'INVALID_INPUT',message:'Invalid event cursor or limit'});return;
        }
        if(!db.getRun(runId)) {sendJson(res,404,{success:false,code:'NOT_FOUND',message:'Run not found'});return;}
        if(eventsMatch[2]==='events') {
          const rows=db.runEvents(runId,after,limit+1);const events=rows.slice(0,limit);
          sendJson(res,200,{success:true,events,nextAfter:events.at(-1)?.seq ?? after,hasMore:rows.length>limit});return;
        }
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        let cursor=after;let closed=false;let backpressured=false;
        const pump=()=>{
          if(closed || backpressured)return;
          try {
            const events=db.runEvents(runId,cursor,100);
            if(!events.length && (!db.getRun(runId) || db.getRun(runId)?.finishedAt!==null)){res.end();return;}
            for(const event of events) {
              const frame='id: '+event.seq+'\nevent: execution\ndata: '+JSON.stringify(event)+'\n\n';
              cursor=event.seq;
              if(Buffer.byteLength(frame)>1048576 || res.writableLength>1048576) {res.end();return;}
              if(!res.write(frame)) {backpressured=true;return;}
              if(event.type==='finished') {res.end();return;}
            }
          } catch {res.destroy();}
        };
        const poll=setInterval(pump,100);
        res.on('drain',()=>{backpressured=false;pump();});
        const heartbeat=setInterval(()=>{if(!backpressured && !res.write(': heartbeat\n\n'))backpressured=true;},15000);
        res.on('close',()=>{closed=true;clearInterval(poll);clearInterval(heartbeat);});
        pump();return;
      }
      // API Routes
      if (pathname === '/api/tasks' && method === 'GET') {
        const statusFilter = url.searchParams.get('status') as TaskStatus | undefined;
        const tasks = db.listTasks(statusFilter);
        sendJson(res, 200, { success: true, tasks });
        return;
      }

      // Clear all tasks and associated files
      if (
        (pathname === '/api/tasks/clear-all' && method === 'POST') ||
        (pathname === '/api/tasks' && method === 'DELETE')
      ) {
        await workflowEngine.handleAllTasksDeleted();
        const { deletedCount } = db.deleteAllTasks();
        taskFileStore.deleteAllTaskFiles();
        logger.info(`[HttpServer] Cleared all tasks (${deletedCount} tasks) and deleted associated files`);
        sendJson(res, 200, {
          success: true,
          message: `已成功清空所有任务（共 ${deletedCount} 个）及其相关方案和文件`,
          deletedCount,
        });
        return;
      }

      // Delete single task and associated files
      const deleteTaskMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)(\/delete)?$/);
      if (
        deleteTaskMatch &&
        (method === 'DELETE' || (method === 'POST' && pathname.endsWith('/delete')))
      ) {
        const taskId = deleteTaskMatch[1];
        const task = db.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { success: false, message: `Task not found: ${taskId}` });
          return;
        }

        await workflowEngine.handleTaskDeleted(taskId);
        db.deleteTask(taskId);
        taskFileStore.deleteTaskFiles(taskId);
        logger.info(`[HttpServer] Deleted task ${taskId} and its files`);
        sendJson(res, 200, {
          success: true,
          message: `任务 ${taskId} 及其相关方案和文件已成功删除`,
        });
        return;
      }

      const taskDetailMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)$/);
      if (taskDetailMatch && method === 'GET') {
        const taskId = taskDetailMatch[1];
        const task = db.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { success: false, message: 'Task not found' });
          return;
        }

        const latestRevision = db.getLatestRevision(taskId);
        const workerPrompts = latestRevision ? db.getWorkerPrompts(taskId, latestRevision.revision) : [];
        const rounds = db.getRounds(taskId);
        const testRuns = db.getTestRuns(taskId);
        const acceptanceRuns = db.getAcceptanceRuns(taskId);
        const humanDecisions = db.getHumanDecisions(taskId);

        // Fetch diff snapshot if confirmed_cwd exists
        let diffSnapshot = null;
        try {
          const cwd = task.confirmed_cwd || task.target_cwd;
          if (fs.existsSync(cwd)) {
            diffSnapshot = GitService.getDiffSnapshot(cwd);
          }
        } catch {}

        let taskWorkflow = db.getTaskWorkflow(taskId);
        if (!taskWorkflow) {
          taskWorkflow = db.initTaskWorkflow(taskId);
        }
        const workflowNodeRuns = db.getNodeRuns(taskId);
        const nodeExecutionCounts: Record<string, number> = {};
        if (taskWorkflow) {
          try {
            const nodes = JSON.parse(taskWorkflow.nodes_json) as WorkflowNode[];
            for (const n of nodes) {
              nodeExecutionCounts[n.id] = db.getNodeRunCount(taskId, n.id);
            }
          } catch {}
        }

        sendJson(res, 200, {
          success: true,
          task,
          latestRevision,
          workerPrompts,
          rounds,
          testRuns,
          acceptanceRuns,
          humanDecisions,
          diffSnapshot,
          taskWorkflow,
          workflowNodeRuns,
          nodeExecutionCounts,
        });
        return;
      }

      const confirmStartMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/confirm-start$/);
      if (confirmStartMatch && method === 'POST') {
        const taskId = confirmStartMatch[1];
        const parsed=confirmStartSchema.safeParse(await parseJsonBody(req));
        if(!parsed.success) {sendJson(res,400,{success:false,code:'INVALID_INPUT',message:'启动参数不合法，单次执行时限须为1–1440整数分钟（毫秒值）'});return;}
        const body=parsed.data;
        const result = await workflowEngine.confirmAndStartTask(taskId, body.confirmed_cwd, {
          executionTimeoutMs: body.execution_timeout_ms,
          workerExecutor: body.worker_executor,
          workerModel: body.worker_model,
          reviewerExecutor: body.reviewer_executor,
          reviewerModel: body.reviewer_model,
        });
        sendJson(res, result.success ? 200 : 409, result);
        return;
      }

      const stopMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/stop$/);
      if (stopMatch && method === 'POST') {
        const taskId = stopMatch[1];
        const result = workflowEngine.stopTask(taskId);
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }

      const humanReviewMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/human-review$/);
      if (humanReviewMatch && method === 'POST') {
        const taskId = humanReviewMatch[1];
        const body = await parseJsonBody(req);
        if (!body.action || !['approve', 'reject'].includes(body.action)) {
          sendJson(res, 400, { success: false, message: 'action must be "approve" or "reject"' });
          return;
        }
        const result = await workflowEngine.submitHumanDecision(taskId, body.action, body.reason || '');
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }

      if (pathname === '/api/runtime/clis' && method === 'GET') {
        const clis = await runtimeService.listConfiguredClis();
        sendJson(res, 200, { success: true, clis });
        return;
      }

      if (pathname === '/api/runtime/probe' && method === 'POST') {
        const body = await parseJsonBody(req);
        if ((body.verify !== undefined && typeof body.verify !== 'boolean') || (body.verify === true && body.prompt !== undefined)) {
          sendJson(res, 400, {success:false,code:'INVALID_INPUT',message:'verify 必须是布尔值；标准验证不允许提供 prompt'});
          return;
        }
        if (!body.cliId) {
          sendJson(res, 400, { success: false, message: 'cliId is required' });
          return;
        }
        try {
          const result = await runtimeService.probeCli({
            cliId: body.cliId,
            prompt: body.prompt,
            model: body.model,
            verify: body.verify,
            timeoutMs: body.timeoutMs,
            cwd: body.cwd,
          });
          sendJson(res, 200, { success: true, result });
        } catch (err: any) {
          sendJson(res, 500, { success: false, message: err?.message || 'Probe execution failed' });
        }
        return;
      }

      if (pathname === '/api/system/executors' && method === 'GET') {
        const agents = await adapterRegistry.listModelAdapters();
        sendJson(res, 200, {
          success: true,
          agents,
          workers: agents,
          reviewers: agents,
        });
        return;
      }

      if (pathname === '/api/system/status' && method === 'GET') {
        let nodeExec = '';
        try {
          nodeExec = resolveSupportedNode();
        } catch {}

        sendJson(res, 200, {
          success: true,
          status: {
            nodeVersion: process.versions.node,
            nodeExec,
            sqliteSupported: true,
            workerModel: VERIFIER_DEFAULT_MODEL,
            verifierModel: VERIFIER_DEFAULT_MODEL,
            activeTaskId: workflowEngine.getActiveTaskId(),
            isBusy: workflowEngine.isBusy(),
          },
        });
        return;
      }

      // Workflow Definitions APIs
      if (pathname === '/api/workflows' && method === 'GET') {
        const raw = db.listWorkflows();
        const workflows = raw.map((wf) => {
          let nodes: WorkflowNode[] = [];
          try {
            nodes = JSON.parse(wf.nodes_json);
          } catch {}
          return {
            id: wf.id,
            version: wf.version,
            name: wf.name,
            description: wf.description,
            nodeCount: nodes.length,
            isDefault: Boolean(wf.is_default),
            nodes,
            createdAt: wf.created_at,
            updatedAt: wf.updated_at,
          };
        });
        sendJson(res, 200, { success: true, workflows });
        return;
      }

      if (pathname === '/api/workflows/reset-default' && method === 'POST') {
        const saved = db.saveWorkflowDefinition({
          id: DEFAULT_WORKFLOW_ID,
          name: '默认开发交付流程',
          description: '标准交付：开始 -> 开发实现 -> 独立测试 -> 整体验收 -> 人工确认 -> 结束',
          nodes_json: JSON.stringify(DEFAULT_WORKFLOW_NODES),
          is_default: 1,
        });
        sendJson(res, 200, { success: true, message: '已恢复默认开发交付工作流', workflow: saved });
        return;
      }

      const workflowDetailMatch = pathname.match(/^\/api\/workflows\/([a-zA-Z0-9_\-]+)$/);
      if (workflowDetailMatch && method === 'GET') {
        const wfId = workflowDetailMatch[1];
        const versionParam = url.searchParams.get('version');
        const version = versionParam ? parseInt(versionParam, 10) : undefined;
        const wf = db.getWorkflow(wfId, Number.isNaN(version) ? undefined : version);
        if (!wf) {
          sendJson(res, 404, { success: false, message: `Workflow not found: ${wfId}` });
          return;
        }
        let nodes = [];
        try {
          nodes = JSON.parse(wf.nodes_json);
        } catch {}
        sendJson(res, 200, {
          success: true,
          workflow: {
            id: wf.id,
            version: wf.version,
            name: wf.name,
            description: wf.description,
            isDefault: Boolean(wf.is_default),
            nodes,
            createdAt: wf.created_at,
            updatedAt: wf.updated_at,
          },
        });
        return;
      }

      if (pathname === '/api/workflows' && method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.id || typeof body.id !== 'string') {
          sendJson(res, 400, { success: false, message: '工作流 ID (id) 为必填项' });
          return;
        }
        if (!body.name || typeof body.name !== 'string') {
          sendJson(res, 400, { success: false, message: '工作流名称 (name) 为必填项' });
          return;
        }
        if (!Array.isArray(body.nodes)) {
          sendJson(res, 400, { success: false, message: '节点列表 (nodes) 必须为数组' });
          return;
        }

        const validation = validateWorkflowNodes(body.nodes, body.id);
        if (!validation.valid) {
          sendJson(res, 400, {
            success: false,
            code: 'INVALID_WORKFLOW',
            message: `工作流校验未通过: ${validation.errors.join('；')}`,
            errors: validation.errors,
          });
          return;
        }

        const saved = db.saveWorkflowDefinition({
          id: body.id.trim(),
          name: body.name.trim(),
          description: body.description || null,
          nodes_json: JSON.stringify(body.nodes),
          is_default: body.is_default ? 1 : 0,
        });

        sendJson(res, 200, {
          success: true,
          message: `工作流 ${saved.id} (v${saved.version}) 保存成功`,
          workflow: saved,
        });
        return;
      }

      // Task Workflow Progress API
      const taskWfMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/workflow$/);
      if (taskWfMatch && method === 'GET') {
        const taskId = taskWfMatch[1];
        const task = db.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { success: false, message: 'Task not found' });
          return;
        }
        let taskWorkflow = db.getTaskWorkflow(taskId);
        if (!taskWorkflow) {
          taskWorkflow = db.initTaskWorkflow(taskId);
        }
        let nodes: WorkflowNode[] = [];
        try {
          nodes = JSON.parse(taskWorkflow.nodes_json);
        } catch {}
        const nodeRuns = db.getNodeRuns(taskId);
        const nodeExecutionCounts: Record<string, number> = {};
        for (const n of nodes) {
          nodeExecutionCounts[n.id] = db.getNodeRunCount(taskId, n.id);
        }
        const currentNode = nodes.find((n) => n.id === taskWorkflow.current_node_id);

        sendJson(res, 200, {
          success: true,
          taskId,
          taskWorkflow,
          nodes,
          currentNode,
          nodeRuns,
          nodeExecutionCounts,
        });
        return;
      }

      // Task Manual Decision API
      const manualDecisionMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/workflow\/manual-decision$/);
      if (manualDecisionMatch && method === 'POST') {
        const taskId = manualDecisionMatch[1];
        const body = await parseJsonBody(req);
        if (!body.action || !['approve', 'reject'].includes(body.action)) {
          sendJson(res, 400, { success: false, message: 'action must be "approve" or "reject"' });
          return;
        }
        const result = await workflowEngine.submitHumanDecision(taskId, body.action, body.reason || '');
        sendJson(res, result.success ? 200 : 400, result);
        return;
      }

      // Static UI Files
      if (pathname === '/' || pathname === '/runtime' || pathname === '/workflows' || pathname.startsWith('/tasks/')) {
        sendFile(res, path.join(UI_DIR, 'index.html'), 'text/html');
        return;
      }

      if (pathname === '/styles.css') {
        sendFile(res, path.join(UI_DIR, 'styles.css'), 'text/css');
        return;
      }

      if (pathname === '/app.js') {
        sendFile(res, path.join(UI_DIR, 'app.js'), 'application/javascript');
        return;
      }

      // Modular JS Files under /js/
      if (pathname.startsWith('/js/') && pathname.endsWith('.js')) {
        const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
        const fullPath = path.join(UI_DIR, safePath);
        if (fullPath.startsWith(UI_DIR) && fs.existsSync(fullPath)) {
          sendFile(res, fullPath, 'application/javascript');
          return;
        }
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err: any) {
      logger.error(`[HttpServer] Error processing ${method} ${pathname}:`, err);
      sendJson(res, 500, { success: false, code:'INTERNAL', message: err?.message || 'Internal Server Error' });
    }
  });
}

export async function startServer(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST
): Promise<http.Server> {
  process.on('uncaughtException', (err) => {
    logger.error('[App] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[App] Unhandled promise rejection:', reason);
  });

  // Crash recovery check for unfinalized tasks from previous process
  try {
    const recovery = db.recoverPendingTasks();
    if (recovery.recoveredCount > 0) {
      logger.info(`[HttpServer] Startup crash recovery: recovered ${recovery.recoveredCount} tasks stuck in running/queued state.`);
    }
  } catch (e: any) {
    logger.error(`[HttpServer] Error during recovery check:`, e);
  }

  const server = createHttpServer();

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      logger.error(`[HttpServer] Failed to bind to ${host}:${port}:`, err);
      reject(err);
    });

    server.listen(port, host, () => {
      logger.info(`[HttpServer] CBWorkBench resident server listening at http://${host}:${port}`);
      console.log(`\n============================================================`);
      console.log(`🚀 CBWorkBench 多 Agent 开发工作台后台服务已启动！`);
      console.log(`🌐 访问地址: http://${host}:${port}`);
      console.log(`🛠️ 接入模式: ${adapterRegistry.listAdapters().map(adapter => adapter.name).join(' / ')}，统一 CLI 对话`);
      console.log(`============================================================\n`);
      resolve(server);
    });
  });
}
