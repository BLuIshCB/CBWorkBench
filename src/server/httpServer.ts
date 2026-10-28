import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from '../services/gitService.ts';
import { workflowEngine } from '../services/workflowEngine.ts';
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  WORKER_FIXED_MODEL,
  VERIFIER_DEFAULT_MODEL,
  TaskStatus,
} from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { resolveSupportedNode } from '../utils/nodeResolver.js';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // API Routes
      if (pathname === '/api/tasks' && method === 'GET') {
        const statusFilter = url.searchParams.get('status') as TaskStatus | undefined;
        const tasks = db.listTasks(statusFilter);
        sendJson(res, 200, { success: true, tasks });
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
        });
        return;
      }

      const confirmStartMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/confirm-start$/);
      if (confirmStartMatch && method === 'POST') {
        const taskId = confirmStartMatch[1];
        const body = await parseJsonBody(req);
        const result = await workflowEngine.confirmAndStartTask(taskId, body.confirmed_cwd);
        sendJson(res, result.success ? 200 : 400, result);
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
            workerModel: WORKER_FIXED_MODEL,
            verifierModel: VERIFIER_DEFAULT_MODEL,
            activeTaskId: workflowEngine.getActiveTaskId(),
            isBusy: workflowEngine.isBusy(),
          },
        });
        return;
      }

      // Static UI Files
      if (pathname === '/' || pathname.startsWith('/tasks/')) {
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

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err: any) {
      logger.error(`[HttpServer] Error processing ${method} ${pathname}:`, err);
      sendJson(res, 500, { success: false, message: err?.message || 'Internal Server Error' });
    }
  });
}

export async function startServer(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST
): Promise<http.Server> {
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
      console.log(`🛠️ 接入模式: WorkBuddy (${WORKER_FIXED_MODEL}) + Codex (${VERIFIER_DEFAULT_MODEL})`);
      console.log(`============================================================\n`);
      resolve(server);
    });
  });
}
