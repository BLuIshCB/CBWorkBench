import { CliRunner } from '../services/cliRunner.ts';
import { execFile } from 'node:child_process';
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
  CLI_DECLARATIONS,
  invalidateCliConfigCache,
  resolveAgentCliConfigPath,
  resolveDeclaredCliDiscovery,
} from '../services/cliConfig.ts';
import { ensurePathHydrated, hydrateShellPath, resolveProfileShell } from '../services/shellPath.ts';
import { isRunnable } from '../services/cliDiscovery.ts';
import { packageService } from '../services/packageService.ts';
import { taskCleanupService } from '../services/taskCleanupService.ts';
import { PackageProtocolError } from '../services/packageProtocol.ts';
import { reworkFileName } from '../services/nodeCompletion.ts';
import {
  DATA_DIR,
  DATA_DIR_SOURCE,
  DEFAULT_PORT,
  DEFAULT_HOST,
  INSTANCE_ID,
  LEGACY_DATA_PATH,
  VERIFIER_DEFAULT_MODEL,
  TaskStatus,
} from '../config/constants.ts';
import {
  isPidAlive,
  isStandaloneExe,
  readServerInfoFile,
  removeServerInfoFile,
  resolveResidentServerForDataDir,
  writeServerInfoFile,
} from '../config/dataDir.ts';
import { logger } from '../utils/logger.ts';
import { resolveSupportedNode } from '../utils/nodeResolver.js';
import {
  validateWorkflowNodes,
  toWorkflowDesignNodes,
  DEFAULT_WORKFLOW_ID,
  DEFAULT_WORKFLOW_NODES,
  buildUniformNodeMaterialContract,
  computeWorkflowDefinitionSha256,
  type WorkflowNode,
} from '../services/workflowDefinition.ts';
import { encodeNodeDirName } from '../utils/pathSecurity.ts';
import { EMBEDDED_ASSETS } from '../ui/embeddedAssets.ts';
import { uiActivityTracker } from '../services/uiActivityTracker.ts';
import { exportWorkflowTemplate, importWorkflowTemplate } from '../services/workflowTemplateService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveUiDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'ui'),
    path.resolve(__dirname, 'src', 'ui'),
    path.resolve(process.cwd(), 'src', 'ui'),
    path.resolve(process.cwd(), 'ui'),
  ];
  if (typeof process.execPath === 'string') {
    candidates.push(path.resolve(path.dirname(process.execPath), 'src', 'ui'));
    candidates.push(path.resolve(path.dirname(process.execPath), 'ui'));
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return path.resolve(__dirname, '..', 'ui');
}
const UI_DIR = resolveUiDir();

function decodeRouteParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 浏览器 input[type=file] 拿不到绝对路径，只能由服务端弹系统对话框。 */
function pickFileWithDialog(): Promise<string | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    "$dialog.Title = '选择 CLI 入口'",
    "$dialog.Filter = '可执行文件|*.exe;*.cmd;*.bat;*.js|所有文件|*.*'",
    "if ($dialog.ShowDialog() -eq 'OK') { [Console]::Out.Write($dialog.FileName) }",
  ].join('; ');
  return new Promise((resolve) => {
    execFile(
      resolveProfileShell('win32')?.command ?? 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-STA', '-Command', script],
      { timeout: 120000, windowsHide: false, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : (stdout.trim() || null)),
    );
  });
}

/** 读 → 合并 → 原子写，避免整体覆盖丢其他 id；写入前保留一份 .bak。 */
function writeCliEntry(cliId: string, executable: string, script?: string): void {
  const configFile = resolveAgentCliConfigPath();
  const current = fs.existsSync(configFile)
    ? JSON.parse(fs.readFileSync(configFile, 'utf8') || '{}')
    : {};
  const next = { ...current };
  const entry: Record<string, unknown> = { ...(current[cliId] ?? {}), executable: path.resolve(executable) };
  // 包装器与 .js 由探测自己归一化；此时再留 script 会作为参数传给包装器，必须清掉。
  const scriptApplies = Boolean(script) && !/\.(cmd|bat|ps1|js)$/i.test(executable);
  if (scriptApplies) entry.script = path.resolve(script!);
  else delete entry.script;
  next[cliId] = entry;

  if (fs.existsSync(configFile)) fs.copyFileSync(configFile, `${configFile}.bak`);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tempFile = `${configFile}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, configFile);

  invalidateCliConfigCache();
  runtimeService.invalidate(cliId);
}

export async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const limit = 5 * 1024 * 1024;
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size > limit) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) return;
      const body = Buffer.concat(chunks, size).toString('utf8');
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

function sendWorkflowTemplateError(res: http.ServerResponse, error: PackageProtocolError): void {
  sendJson(res, error.code === 'WORKFLOW_NOT_FOUND' ? 404 : 400, {
    success: false, code: error.code, message: error.message, details: error.details,
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

export function sendFile(
  res: http.ServerResponse,
  filePath: string,
  contentType: string,
  virtualKey?: string
): void {
  // EXE 只使用随包资源，避免旧后端加载工作区里的新版页面与接口客户端。
  if (!isStandaloneExe() && fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
    return;
  }

  if (virtualKey && EMBEDDED_ASSETS[virtualKey]) {
    const asset = EMBEDDED_ASSETS[virtualKey];
    const buffer = Buffer.from(asset.content, 'utf-8');
    res.writeHead(200, {
      'Content-Type': `${asset.contentType}; charset=utf-8`,
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buffer);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

/** 浏览器同源写请求会带 Origin，非浏览器客户端（curl / MCP / 测试）不带。 */
function isSameOriginRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createHttpServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // 写接口只接受同源请求：否则任意网页都能跨站改 CLI 配置，再借 probe 拉起本地可执行文件。
    if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(req)) {
      sendJson(res, 403, { success: false, code: 'CROSS_ORIGIN_BLOCKED', message: '拒绝跨站写入请求' });
      return;
    }

    try {
      const executionMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/execution$/);
      if (executionMatch && method === 'GET') {
        if (!db.getTask(executionMatch[1])) {
          sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Task not found' });
          return;
        }
        const latest = db.latestRun(executionMatch[1]);
        sendJson(res, 200, { success: true, run: latest ? ExecutionService.snapshot(latest.runId) : null });
        return;
      }

      const cleanupMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/cleanup$/);
      if (cleanupMatch && method === 'POST') {
        if (!db.getRun(cleanupMatch[1])) {
          sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Run not found' });
          return;
        }
        const confirmed = await CliRunner.retryCleanup(cleanupMatch[1]);
        sendJson(res, confirmed ? 200 : 409, {
          success: confirmed,
          ...(confirmed ? {} : { code: 'CONFLICT' }),
          message: confirmed ? '已确认回收' : '无法安全确认回收，保留占用与现场；请检查原生进程。',
        });
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/(events|stream)$/);
      if (eventsMatch && method === 'GET') {
        const runId = eventsMatch[1];
        const rawAfter =
          eventsMatch[2] === 'stream'
            ? (req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0')
            : (url.searchParams.get('after') ?? '0');
        const rawLimit = url.searchParams.get('limit') ?? '200';
        const after = Number(rawAfter);
        const limit = Number(rawLimit);
        if (
          !/^\d+$/.test(String(rawAfter)) ||
          !Number.isSafeInteger(after) ||
          !/^\d+$/.test(rawLimit) ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 500
        ) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'Invalid event cursor or limit' });
          return;
        }
        if (!db.getRun(runId)) {
          sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Run not found' });
          return;
        }
        if (eventsMatch[2] === 'events') {
          const rows = db.runEvents(runId, after, limit + 1);
          const events = rows.slice(0, limit);
          sendJson(res, 200, { success: true, events, nextAfter: events.at(-1)?.seq ?? after, hasMore: rows.length > limit });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        let cursor = after;
        let closed = false;
        let backpressured = false;
        const pump = () => {
          if (closed || backpressured) return;
          try {
            const events = db.runEvents(runId, cursor, 100);
            if (!events.length && (!db.getRun(runId) || db.getRun(runId)?.finishedAt !== null)) {
              res.end();
              return;
            }
            for (const event of events) {
              const frame = 'id: ' + event.seq + '\nevent: execution\ndata: ' + JSON.stringify(event) + '\n\n';
              cursor = event.seq;
              if (Buffer.byteLength(frame) > 1048576 || res.writableLength > 1048576) {
                res.end();
                return;
              }
              if (!res.write(frame)) {
                backpressured = true;
                return;
              }
              if (event.type === 'finished') {
                res.end();
                return;
              }
            }
          } catch {
            res.destroy();
          }
        };
        const poll = setInterval(pump, 100);
        res.on('drain', () => {
          backpressured = false;
          pump();
        });
        const heartbeat = setInterval(() => {
          if (!backpressured && !res.write(': heartbeat\n\n')) backpressured = true;
        }, 15000);
        res.on('close', () => {
          closed = true;
          clearInterval(poll);
          clearInterval(heartbeat);
        });
        pump();
        return;
      }

      // Instance discovery endpoint
      if (pathname === '/api/system/instance' && method === 'GET') {
        const addr = (req.socket?.server as any)?.address?.();
        sendJson(res, 200, {
          success: true,
          instance_id: INSTANCE_ID,
          data_dir: DATA_DIR,
          source: DATA_DIR_SOURCE,
          legacy_data_path: LEGACY_DATA_PATH,
          pid: process.pid,
          host: addr?.address || DEFAULT_HOST,
          port: addr?.port || DEFAULT_PORT,
          has_active_ui: uiActivityTracker.hasActiveUi(),
          last_browser_opened_at: uiActivityTracker.getLastBrowserOpenedAt(),
        });
        return;
      }

      // UI Heartbeat endpoint
      if (pathname === '/api/system/ui-heartbeat' && method === 'POST') {
        let body: any = {};
        try {
          body = await parseJsonBody(req);
        } catch {}
        const clientId = String(body.clientId || url.searchParams.get('clientId') || '');
        const action = String(body.action || url.searchParams.get('action') || 'ping');
        if (action === 'close') {
          uiActivityTracker.removeSession(clientId);
        } else {
          uiActivityTracker.recordHeartbeat(clientId);
        }
        sendJson(res, 200, { success: true, has_active_ui: uiActivityTracker.hasActiveUi() });
        return;
      }

      // UI Browser Open notification endpoint
      if (pathname === '/api/system/ui-open' && method === 'POST') {
        uiActivityTracker.recordBrowserOpen();
        sendJson(res, 200, { success: true, last_browser_opened_at: uiActivityTracker.getLastBrowserOpenedAt() });
        return;
      }

      // Task List
      if (pathname === '/api/tasks' && method === 'GET') {
        const statusFilter = url.searchParams.get('status') as TaskStatus | undefined;
        const tasks = db.listTasks(statusFilter);
        sendJson(res, 200, { success: true, tasks });
        return;
      }

      // Clear all tasks via unified recoverable cleanup
      if (
        (pathname === '/api/tasks/clear-all' && method === 'POST') ||
        (pathname === '/api/tasks' && method === 'DELETE')
      ) {
        const result = await taskCleanupService.deleteAllTasks();
        if (!result.ok) {
          sendJson(res, 409, {
            success: false,
            code: 'CLEANUP_FAILED',
            message: `部分任务清理失败 (${result.failedCount})：${result.failures.map((f) => `${f.task_id}: ${f.message}`).join('；')}`,
            deletedCount: result.deletedCount,
            failures: result.failures,
          });
          return;
        }
        logger.info(`[HttpServer] Cleared all tasks (${result.deletedCount} tasks) and all owned resources`);
        sendJson(res, 200, {
          success: true,
          message: `已成功清空所有任务（共 ${result.deletedCount} 个）及其全部关联材料和文件`,
          deletedCount: result.deletedCount,
        });
        return;
      }

      // Delete single task via unified recoverable cleanup
      const deleteTaskMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)(\/delete)?$/);
      if (
        deleteTaskMatch &&
        (method === 'DELETE' || (method === 'POST' && pathname.endsWith('/delete')))
      ) {
        const taskId = deleteTaskMatch[1];
        const task = db.getTask(taskId);
        const dirExists = fs.existsSync(taskFileStore.getTaskRootDir(taskId));
        if (!task && !dirExists && !taskCleanupService.isTaskDeleting(taskId)) {
          sendJson(res, 404, { success: false, message: `Task not found: ${taskId}` });
          return;
        }

        const result = await taskCleanupService.deleteTask(taskId);
        if (!result.ok) {
          sendJson(res, 409, {
            success: false,
            code: result.code || 'CLEANUP_FAILED',
            message: result.message,
          });
          return;
        }

        logger.info(`[HttpServer] Deleted task ${taskId} and all owned files`);
        sendJson(res, 200, {
          success: true,
          message: result.message,
        });
        return;
      }

      // Task revision resource slice viewer
      const resourceMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/revisions\/(\d+)\/resource$/);
      if (resourceMatch && method === 'GET') {
        const taskId = resourceMatch[1];
        const rev = Number(resourceMatch[2]);
        const relPath = url.searchParams.get('path') || '';
        const offset = Number(url.searchParams.get('offset') || '0');
        const limit = Number(url.searchParams.get('limit') || '262144');
        if (!relPath) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'path query parameter is required' });
          return;
        }
        try {
          const pkgRes = packageService.getPackage({
            task_id: taskId,
            revision: rev,
            resource_path: relPath,
            offset_bytes: Number.isFinite(offset) ? offset : 0,
            max_bytes: Number.isFinite(limit) ? limit : 262144,
          });
          sendJson(res, 200, { success: true, ...pkgRes });
        } catch (err: any) {
          const status = err instanceof PackageProtocolError && err.code === 'TASK_NOT_FOUND' ? 404 : 400;
          sendJson(res, status, {
            success: false,
            code: err?.code || 'INVALID_INPUT',
            message: err?.message || 'Failed to read resource',
          });
        }
        return;
      }

      const reworkMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/revisions\/(\d+)\/rework\/(\d+)$/);
      if (reworkMatch && method === 'GET') {
        const [, taskId, revision, sequence] = reworkMatch;
        const nodeId = url.searchParams.get('node') || '';
        const document = taskCleanupService.isTaskDeleting(taskId)
          ? undefined : db.getReworkDocument(taskId, Number(revision), nodeId, Number(sequence));
        if (!document) {
          sendJson(res, 404, { success: false, message: '未找到返工文档' });
          return;
        }
        sendJson(res, 200, { success: true, resource: {
          path: reworkFileName(document.sequence), content: document.content, encoding: 'utf-8',
        } });
        return;
      }

      // Task detail
      const taskDetailMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)$/);
      if (taskDetailMatch && method === 'GET') {
        const taskId = taskDetailMatch[1];
        const task = db.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { success: false, message: 'Task not found' });
          return;
        }

        const latestRevision = db.getLatestRevision(taskId);
        const revisions = db.listRevisions(taskId);
        const packageFiles = latestRevision ? db.getPackageFiles(taskId, latestRevision.revision) : [];
        let parsedManifest: any = null;
        if (latestRevision?.manifest_json) {
          try {
            parsedManifest = JSON.parse(latestRevision.manifest_json);
          } catch {}
        }

        const rounds = db.getRounds(taskId);
        const testRuns = db.getTestRuns(taskId);
        const acceptanceRuns = db.getAcceptanceRuns(taskId);
        const humanDecisions = db.getHumanDecisions(taskId);

        let diffSnapshot = null;
        try {
          const cwd = task.confirmed_cwd || task.target_cwd;
          if (fs.existsSync(cwd)) {
            diffSnapshot = GitService.getDiffSnapshot(cwd);
          }
        } catch {}

        let taskWorkflow = db.getTaskWorkflow(taskId);
        if (!taskWorkflow) {
          taskWorkflow = db.initTaskWorkflow(taskId, { revision: task.revision });
        }
        const workflowNodeRuns = db.getNodeRuns(taskId).map(({ completion_token, ...run }) => run);
        const reworkDocuments = db.listReworkDocuments(taskId, task.revision);
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
          revisions,
          manifest: parsedManifest,
          packageFiles,
          rounds,
          testRuns,
          acceptanceRuns,
          humanDecisions,
          diffSnapshot,
          taskWorkflow,
          workflowNodeRuns,
          reworkDocuments,
          nodeExecutionCounts,
        });
        return;
      }

      const confirmStartMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/confirm-start$/);
      if (confirmStartMatch && method === 'POST') {
        const taskId = confirmStartMatch[1];
        const parsed = confirmStartSchema.safeParse(await parseJsonBody(req));
        if (!parsed.success) {
          sendJson(res, 400, {
            success: false,
            code: 'INVALID_INPUT',
            message: '启动参数不合法，单次执行时限须为1–1440整数分钟（毫秒值）',
          });
          return;
        }
        const body = parsed.data;
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
        // 首次请求最多等一次水合（10s 上限），之后走进程内缓存
        await ensurePathHydrated();
        const withVersion = url.searchParams.get('version') === '1' || url.searchParams.get('refresh') === '1';
        if (url.searchParams.get('refresh') === '1') {
          invalidateCliConfigCache();
          runtimeService.invalidate();
        }
        const clis = await runtimeService.listConfiguredClis({
          withVersion,
          // 模型目录同样要 spawn CLI，随「刷新状态」一起取
          withCatalog: withVersion,
          forceVersion: url.searchParams.get('refresh') === '1',
        });
        sendJson(res, 200, { success: true, clis });
        return;
      }

      if (pathname === '/api/runtime/refresh-path' && method === 'POST') {
        const hydration = await hydrateShellPath(true);
        invalidateCliConfigCache();
        runtimeService.invalidate();
        sendJson(res, 200, {
          success: true,
          hydration,
          clis: await runtimeService.listConfiguredClis(),
        });
        return;
      }

      if (pathname === '/api/runtime/pick-file' && method === 'POST') {
        if (process.platform !== 'win32') {
          sendJson(res, 501, { success: false, message: '系统文件选择框仅支持 Windows，请直接粘贴绝对路径。' });
          return;
        }
        const picked = await pickFileWithDialog();
        sendJson(res, 200, { success: true, path: picked });
        return;
      }

      if (pathname === '/api/runtime/cli-path' && method === 'POST') {
        const body = await parseJsonBody(req);
        const cliId = typeof body.cliId === 'string' ? body.cliId : '';
        const executable = typeof body.executable === 'string' ? body.executable.trim() : '';
        const script = typeof body.script === 'string' ? body.script.trim() : '';
        if (!CLI_DECLARATIONS[cliId]) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: `未知 CLI: ${cliId}` });
          return;
        }
        if (!executable || !path.isAbsolute(executable)) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: '请提供绝对路径的 CLI 入口' });
          return;
        }
        const executableCheck = isRunnable(executable);
        if (!executableCheck.runnable) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: `入口不可运行（${executableCheck.reason}）: ${executable}` });
          return;
        }
        if (script && !isRunnable(script).runnable) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: `脚本不可运行: ${script}` });
          return;
        }
        try {
          writeCliEntry(cliId, executable, script || undefined);
          sendJson(res, 200, { success: true, discovery: resolveDeclaredCliDiscovery(CLI_DECLARATIONS[cliId]) });
        } catch (error: any) {
          sendJson(res, 500, { success: false, message: `写入 CLI 配置失败: ${error?.message ?? error}` });
        }
        return;
      }

      if (pathname === '/api/runtime/probe' && method === 'POST') {
        await ensurePathHydrated();
        const body = await parseJsonBody(req);
        if (
          (body.verify !== undefined && typeof body.verify !== 'boolean') ||
          (body.verify === true && body.prompt !== undefined)
        ) {
          sendJson(res, 400, {
            success: false,
            code: 'INVALID_INPUT',
            message: 'verify 必须是布尔值；标准验证不允许提供 prompt',
          });
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
            instanceId: INSTANCE_ID,
            dataDir: DATA_DIR,
            legacyDataPath: LEGACY_DATA_PATH,
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
          const referencingTasks = db.getWorkflowReferencingTasks(wf.id);
          const definitionSha = computeWorkflowDefinitionSha256({
            id: wf.id,
            name: wf.name,
            description: wf.description,
            nodes,
          });
          return {
            id: wf.id,
            name: wf.name,
            description: wf.description,
            nodeCount: nodes.length,
            isDefault: Boolean(wf.is_default),
            isReferenced: referencingTasks.length > 0,
            referencingCount: referencingTasks.length,
            definition_sha256: definitionSha,
            nodes,
            createdAt: wf.created_at,
            updatedAt: wf.updated_at,
          };
        });
        sendJson(res, 200, { success: true, workflows });
        return;
      }

      if (pathname === '/api/workflows/import' && method === 'POST') {
        let input: unknown;
        try {
          input = await parseJsonBody(req);
        } catch (error) {
          sendWorkflowTemplateError(res, new PackageProtocolError(
            'INVALID_WORKFLOW', error instanceof Error ? error.message : '工作流文件不是有效的 JSON',
          ));
          return;
        }

        try {
          sendJson(res, 201, { success: true, workflow_id: importWorkflowTemplate(input) });
        } catch (error) {
          if (!(error instanceof PackageProtocolError)) throw error;
          sendWorkflowTemplateError(res, error);
        }
        return;
      }

      const workflowExportMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/export$/);
      if (workflowExportMatch && method === 'GET') {
        const id = decodeRouteParam(workflowExportMatch[1]);
        if (id === null) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: '无效的工作流 ID 编码' });
          return;
        }
        try {
          const body = JSON.stringify(exportWorkflowTemplate(id), null, 2) + '\n';
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="workflow.json"',
            'Content-Length': Buffer.byteLength(body),
          });
          res.end(body);
        } catch (error) {
          if (!(error instanceof PackageProtocolError)) throw error;
          sendWorkflowTemplateError(res, error);
        }
        return;
      }

      if (pathname === '/api/workflows/reset-default' && method === 'POST') {
        if (db.isWorkflowReferenced(DEFAULT_WORKFLOW_ID)) {
          sendJson(res, 403, {
            success: false,
            code: 'WORKFLOW_IN_USE',
            message: '默认工作流当前正被任务引用，禁止重置！若需重置请先清理相关任务。',
          });
          return;
        }
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

      const workflowDetailMatch = pathname.match(/^\/api\/workflows\/([^\/]+)$/);
      if (workflowDetailMatch && method === 'GET' && pathname !== '/api/workflows/reset-default') {
        const wfId = decodeRouteParam(workflowDetailMatch[1]);
        if (wfId === null) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: '无效的工作流 ID 编码' });
          return;
        }
        const wf = db.getWorkflow(wfId);
        if (!wf) {
          sendJson(res, 404, { success: false, message: `Workflow not found: ${wfId}` });
          return;
        }
        let nodes: WorkflowNode[] = [];
        try {
          nodes = JSON.parse(wf.nodes_json);
        } catch {}
        const referencingTasks = db.getWorkflowReferencingTasks(wf.id);
        const definitionSha = computeWorkflowDefinitionSha256({
          id: wf.id,
          name: wf.name,
          description: wf.description,
          nodes,
        });
        const enrichedNodes = nodes.map((n) => ({
          ...n,
          ...(n.type === 'task'
            ? {
                dir_name: encodeNodeDirName(n.id),
                material_contract: buildUniformNodeMaterialContract(n),
              }
            : {}),
        }));
        sendJson(res, 200, {
          success: true,
          workflow: {
            id: wf.id,
            name: wf.name,
            description: wf.description,
            isDefault: Boolean(wf.is_default),
            isReferenced: referencingTasks.length > 0,
            referencingTasks,
            definition_sha256: definitionSha,
            nodes: enrichedNodes,
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

        const trimmedId = body.id.trim();

        if (db.isWorkflowReferenced(trimmedId)) {
          sendJson(res, 403, {
            success: false,
            code: 'WORKFLOW_IN_USE',
            message: `工作流 [${trimmedId}] 当前正被任务引用，禁止修改！若需修改，请先清理相关任务或新建独立工作流。`,
            referencingTasks: db.getWorkflowReferencingTasks(trimmedId),
          });
          return;
        }

        const validation = validateWorkflowNodes(body.nodes, trimmedId);
        if (!validation.valid) {
          sendJson(res, 400, {
            success: false,
            code: 'INVALID_WORKFLOW',
            message: `工作流校验未通过: ${validation.errors.join('；')}`,
            errors: validation.errors,
          });
          return;
        }

        try {
          const saved = db.saveWorkflowDefinition({
            id: trimmedId,
            name: body.name.trim(),
            description: body.description || null,
            nodes_json: JSON.stringify(toWorkflowDesignNodes(body.nodes)),
            is_default: body.is_default ? 1 : 0,
          });

          sendJson(res, 200, {
            success: true,
            message: `工作流 [${saved.name || saved.id}] 保存成功`,
            workflow: saved,
          });
        } catch (e: any) {
          sendJson(res, 400, {
            success: false,
            message: e.message || '保存工作流失败',
          });
        }
        return;
      }

      const deleteWorkflowMatch = pathname.match(/^\/api\/workflows\/([^\/]+)(\/delete)?$/);
      if (
        deleteWorkflowMatch &&
        pathname !== '/api/workflows/reset-default' &&
        (method === 'DELETE' || (method === 'POST' && pathname.endsWith('/delete')))
      ) {
        const wfId = decodeRouteParam(deleteWorkflowMatch[1]);
        if (wfId === null) {
          sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: '无效的工作流 ID 编码' });
          return;
        }
        const wf = db.getWorkflow(wfId);
        if (!wf) {
          sendJson(res, 404, { success: false, message: `工作流未找到: ${wfId}` });
          return;
        }

        if (wf.id === DEFAULT_WORKFLOW_ID || Boolean(wf.is_default)) {
          sendJson(res, 400, {
            success: false,
            code: 'FORBIDDEN_DELETE_DEFAULT',
            message: '系统默认工作流禁止删除',
          });
          return;
        }

        if (db.isWorkflowReferenced(wf.id)) {
          sendJson(res, 403, {
            success: false,
            code: 'WORKFLOW_IN_USE',
            message: `工作流 [${wf.id}] 当前正被任务引用，禁止删除！若需删除，请先清理相关任务。`,
            referencingTasks: db.getWorkflowReferencingTasks(wf.id),
          });
          return;
        }

        try {
          db.deleteWorkflow(wf.id);
          logger.info(`[HttpServer] Deleted workflow ${wf.id} (${wf.name})`);
          sendJson(res, 200, {
            success: true,
            message: `工作流 [${wf.name || wf.id}] 已成功删除`,
          });
        } catch (e: any) {
          sendJson(res, 400, {
            success: false,
            message: e.message || '删除工作流失败',
          });
        }
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
          taskWorkflow = db.initTaskWorkflow(taskId, { revision: task.revision });
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

      // Task Workflow Node Update API (Update model / executor before execution starts)
      const taskNodeUpdateMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_\-]+)\/workflow\/nodes\/([a-zA-Z0-9_\-]+)$/);
      if (taskNodeUpdateMatch && (method === 'PUT' || method === 'PATCH')) {
        const taskId = taskNodeUpdateMatch[1];
        const nodeId = taskNodeUpdateMatch[2];
        const body = await parseJsonBody(req);
        const task = db.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { success: false, message: 'Task not found' });
          return;
        }
        if (task.status !== TaskStatus.PENDING_CONFIRM) {
          sendJson(res, 409, {
            success: false,
            code: 'TASK_ALREADY_STARTED',
            message: '任务已开始执行，节点模型与配置已冻结，无法修改。',
          });
          return;
        }
        let taskWorkflow = db.getTaskWorkflow(taskId);
        if (!taskWorkflow) {
          taskWorkflow = db.initTaskWorkflow(taskId, { revision: task.revision });
        }
        let nodes: WorkflowNode[] = [];
        try {
          nodes = JSON.parse(taskWorkflow.nodes_json);
        } catch {
          nodes = [];
        }
        const targetNode = nodes.find((n) => n.id === nodeId);
        if (!targetNode) {
          sendJson(res, 404, { success: false, message: `未找到节点: ${nodeId}` });
          return;
        }
        if (body.prompt !== undefined) {
          sendJson(res, 400, { success: false, message: '节点提示词来自任务包中的 prompt.md；请提交新修订更新提示词。' });
          return;
        }
        if (targetNode.type !== 'task' || targetNode.execution_mode !== 'agent') {
          sendJson(res, 400, { success: false, message: '只有自动任务节点可配置执行器和模型。' });
          return;
        }
        if (body.executor !== undefined) {
          try {
            adapterRegistry.getAdapter(body.executor);
            targetNode.executor = body.executor;
          } catch (e: any) {
            sendJson(res, 400, { success: false, message: `不支持的执行器: ${body.executor}` });
            return;
          }
        }
        if (body.model !== undefined) {
          targetNode.model = String(body.model).trim();
        }
        db.updateTaskWorkflow(taskId, { nodes_json: JSON.stringify(nodes) });
        sendJson(res, 200, { success: true, node: targetNode, nodes });
        return;
      }

      // Static UI Files
      if (pathname === '/' || pathname === '/runtime' || pathname === '/workflows' || pathname.startsWith('/tasks/')) {
        sendFile(res, path.join(UI_DIR, 'index.html'), 'text/html', '/index.html');
        return;
      }

      if (pathname === '/styles.css') {
        sendFile(res, path.join(UI_DIR, 'styles.css'), 'text/css', '/styles.css');
        return;
      }

      if (pathname.startsWith('/js/') && pathname.endsWith('.js')) {
        const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
        const fullPath = path.join(UI_DIR, safePath);
        const virtualKey = '/' + safePath.replace(/\\/g, '/').replace(/^\/+/, '');
        sendFile(res, fullPath, 'application/javascript', virtualKey);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: `Not Found: ${method} ${pathname}` });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err: any) {
      logger.error(`[HttpServer] Error processing ${method} ${pathname}:`, err);
      sendJson(res, 500, { success: false, code: 'INTERNAL', message: err?.message || 'Internal Server Error' });
    }
  });
}

export async function startServer(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST,
  allowFallbackPort: boolean = false
): Promise<http.Server> {
  process.on('uncaughtException', (err) => {
    logger.error('[App] Uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[App] Unhandled promise rejection:', reason);
  });

  // Enforce single resident daemon per DATA_DIR
  await resolveResidentServerForDataDir(DATA_DIR, INSTANCE_ID);
  const existingServer = readServerInfoFile(DATA_DIR);
  if (existingServer && existingServer.pid !== process.pid && isPidAlive(existingServer.pid)) {
    throw new Error(
      `当前数据目录 (${DATA_DIR}) 已有常驻后台正在运行 (PID=${existingServer.pid}, URL=${existingServer.url})，禁止同一数据目录启动多个调度后台`
    );
  }

  // Recover pending deletions before task loop recovery
  try {
    await taskCleanupService.recoverPendingDeletions();
  } catch (e: any) {
    logger.error('[HttpServer] Error during pending deletion recovery:', e);
  }

  try {
    const recovery = db.recoverPendingTasks();
    if (recovery.recoveredCount > 0) {
      logger.info(`[HttpServer] Startup crash recovery: recovered ${recovery.recoveredCount} tasks stuck in running/queued state.`);
    }
  } catch (e: any) {
    logger.error('[HttpServer] Error during recovery check:', e);
  }

  // 登录 shell PATH 水合预热：不阻塞启动，失败仍可继续走 PATH/安装目录/裸名降级。
  void ensurePathHydrated().then(() => invalidateCliConfigCache()).catch(() => {});

  const server = createHttpServer();

  return new Promise((resolve, reject) => {
    let canRetry = allowFallbackPort && port !== 0;
    server.on('error', (err: NodeJS.ErrnoException) => {
      // 同一数据目录在启动时可能刚发布服务地址，此时不能再开第二个调度后台。
      if (canRetry && err.code === 'EADDRINUSE' && !readServerInfoFile(DATA_DIR)) {
        canRetry = false;
        logger.info(`[HttpServer] 默认端口 ${port} 已占用，正在选择可用端口。`);
        server.listen(0, host);
        return;
      }
      logger.error(`[HttpServer] Failed to bind to ${host}:${port}:`, err);
      reject(err);
    });

    server.once('listening', () => {
      const otherServer = readServerInfoFile(DATA_DIR);
      if (otherServer && otherServer.pid !== process.pid && isPidAlive(otherServer.pid)) {
        server.close();
        reject(new Error(`当前数据目录已有常驻后台正在运行: ${otherServer.url}`));
        return;
      }
      const boundAddr = server.address() as any;
      const actualPort = boundAddr?.port || port;
      const serverUrl = `http://${host}:${actualPort}`;
      writeServerInfoFile(DATA_DIR, {
        instance_id: INSTANCE_ID,
        data_dir: DATA_DIR,
        pid: process.pid,
        host,
        port: actualPort,
        url: serverUrl,
        started_at: Date.now(),
      });

      const cleanupLock = () => removeServerInfoFile(DATA_DIR, process.pid);
      server.on('close', cleanupLock);
      process.once('exit', cleanupLock);

      logger.info(`[HttpServer] CBWorkBench resident server listening at ${serverUrl} (instance=${INSTANCE_ID}, dataDir=${DATA_DIR})`);
      console.log(`\n============================================================`);
      console.log(`🚀 CBWorkBench 多 Agent 开发工作台后台服务已启动！`);
      console.log(`🌐 访问地址: ${serverUrl}`);
      console.log(`📁 数据目录: ${DATA_DIR} (${DATA_DIR_SOURCE})`);
      console.log(`🆔 实例标识: ${INSTANCE_ID}`);
      if (LEGACY_DATA_PATH) {
        console.log(`📦 检测到旧目录: ${LEGACY_DATA_PATH} (已保留未覆盖/未删除)`);
      }
      console.log(`🛠️ 接入模式: ${adapterRegistry.listAdapters().map((adapter) => adapter.name).join(' / ')}，统一 CLI 对话`);
      console.log(`============================================================\n`);
      resolve(server);
    });
    server.listen(port, host);
  });
}
