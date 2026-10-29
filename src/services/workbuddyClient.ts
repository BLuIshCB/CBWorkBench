import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORKER_FIXED_MODEL, DEFAULT_WORKER_TIMEOUT_MS } from '../config/constants.ts';
import { resolveWorkBuddyConfigs } from './workbuddyConfig.ts';
import type { WorkBuddyBackend, WorkBuddyServerConfig } from './workbuddyConfig.ts';

export interface WorkerExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
  errorCode?: 'CONFIG' | 'AUTH_REQUIRED' | 'TIMEOUT' | 'CANCELLED' | 'EXECUTION';
  timedOut?: boolean;
  backend?: WorkBuddyBackend;
  sessionId?: string;
}

type ActiveRun = { taskId?: string; backend?: WorkBuddyBackend; controller: AbortController; client?: Client; transport?: StdioClientTransport; remoteTaskId?: string };
const stripAnsi = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const authError = (text: string) => /^(?:Error:\s*)?(?:authentication required|please (?:use \/login|log\s?in|sign in)|not authenticated|未登录|请(?:先)?登录)/im.test(text.trim());
const textContent = (response: any): string => stripAnsi((response.content || [])
  .filter((item: any) => item.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n'));

export class WorkBuddyClient {
  private static activeRuns = new Set<ActiveRun>();

  /** 保留旧接口，启动参数由准确的 workbuddy-cli 配置表提供。 */
  static resolveMcpServerConfig(): WorkBuddyServerConfig {
    const config = resolveWorkBuddyConfigs().cli;
    if (!config) throw new Error('WorkBuddy CLI MCP 未配置，请配置 workbuddy-cli 或 CB_WORKBUDDY_MCP_CONFIG。');
    return config;
  }

  static requestStop(taskId?: string): void {
    for (const run of this.activeRuns) {
      if (!taskId || run.taskId === taskId) run.controller.abort(new Error('Execution stopped by user.'));
    }
  }

  /** 实际连接并验证工具；桌面端同时验证 sidecar 连通状态，不派发模型任务。 */
  static async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (process.env.CB_MOCK_WORKBUDDY === 'true') return { healthy: true, message: 'Explicit WorkBuddy mock mode.' };
    const run: ActiveRun = { controller: new AbortController() };
    const timer = setTimeout(() => run.controller.abort(), 15000);
    try {
      const backend = await this.connect(run);
      return { healthy: true, message: backend === 'desktop' ? 'WorkBuddy Desktop connected.' : 'WorkBuddy CLI MCP connected; 登录态将在实际任务时验证。' };
    } catch (error: any) {
      return { healthy: false, message: error.message };
    } finally {
      clearTimeout(timer);
      await this.close(run);
    }
  }

  static async runTask(params: { prompt: string; cwd: string; model?: string; timeoutMs?: number; taskId?: string }): Promise<WorkerExecutionResult> {
    if (process.env.CB_MOCK_WORKBUDDY === 'true') return { ok: true, output: `[MOCK WORKBUDDY RESULT]\nCompleted prompt for cwd: ${params.cwd}` };
    const timeoutMs = params.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    let validDirectory = false;
    try { validDirectory = path.isAbsolute(params.cwd) && fs.statSync(params.cwd).isDirectory(); } catch { /* 无权限或路径不存在均为配置错误。 */ }
    if (!params.prompt?.trim() || !validDirectory
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      return { ok: false, output: '', errorCode: 'CONFIG', error: 'WorkBuddy 需要非空提示词、存在的绝对工作目录和有效的正整数超时时间。' };
    }
    const run: ActiveRun = { taskId: params.taskId, controller: new AbortController() };
    this.activeRuns.add(run);
    let timedOut = false;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => { timedOut = true; run.controller.abort(new Error('WorkBuddy execution timed out.')); }, timeoutMs);
    let backend: WorkBuddyBackend | undefined;
    let output = '';
    let terminal = false;
    try {
      backend = await this.connect(run);
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      const model = params.model || WORKER_FIXED_MODEL;
      if (backend === 'cli') {
        const response = await this.call(run, 'run_workbuddy_task', { prompt: params.prompt, cwd: params.cwd, model, timeoutMs: Math.max(1, deadline - Date.now()) }, timeoutMs);
        output = textContent(response);
        if (response.isError || /^(?:EPERM:|EACCES:|Error:|ENOENT:)/m.test(output) || authError(output)) throw new Error(output || 'WorkBuddy CLI execution failed.');
      } else {
        const started = this.object(await this.call(run, 'workbuddy_start', {
          prompt: params.prompt, cwd: params.cwd, model, reasoning_effort: 'low',
          timeout_seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
        }));
        if (started.ok !== true || typeof started.task_id !== 'string' || !started.task_id) throw new Error(started.error || 'WorkBuddy start returned no task_id.');
        run.remoteTaskId = started.task_id;
        while (true) {
          const state = this.object(await this.call(run, 'workbuddy_wait', {
            task_id: run.remoteTaskId, timeout_seconds: Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000))),
          }, 55000));
          if (state.ok !== true || state.task_id !== run.remoteTaskId) throw new Error(state.error || 'WorkBuddy returned a mismatched task.');
          if (state.state === 'completed') {
            terminal = true;
            output = typeof state.answer === 'string' ? state.answer : '';
            if (state.error || state.result?.isError || authError(output)) throw new Error(state.error || output || 'WorkBuddy execution failed.');
            if (!output.trim()) throw new Error('WorkBuddy completed without an answer.');
            return { ok: true, output, backend, sessionId: state.session_id };
          }
          if (['failed', 'cancelled'].includes(state.state)) {
            terminal = true;
            const message = state.error || `WorkBuddy task ${state.state}`;
            return { ok: false, output, backend, error: this.errorMessage(message), errorCode: authError(message) ? 'AUTH_REQUIRED' : state.state === 'cancelled' ? 'CANCELLED' : /timed? out|timeout/i.test(message) ? 'TIMEOUT' : 'EXECUTION', timedOut: /timed? out|timeout/i.test(message) };
          }
          if (!['queued', 'connecting', 'running', 'observing', 'cancelling'].includes(state.state)) throw new Error('Unknown WorkBuddy task state.');
        }
      }
      if (!output.trim()) throw new Error('WorkBuddy returned no output.');
      return { ok: true, output, backend };
    } catch (error: any) {
      const message = error?.message || String(error);
      const cancelled = run.controller.signal.aborted;
      return {
        ok: false, output, backend, timedOut,
        errorCode: timedOut ? 'TIMEOUT' : cancelled ? 'CANCELLED' : authError(message) ? 'AUTH_REQUIRED' : backend ? 'EXECUTION' : 'CONFIG',
        error: timedOut ? `WorkBuddy 执行超过 ${timeoutMs}ms，已请求取消。` : cancelled ? 'WorkBuddy 执行已取消。' : this.errorMessage(message),
      };
    } finally {
      clearTimeout(timer);
      // 已派发任务不得换后端重试，否则 Worker 可能重复修改代码。
      if (run.remoteTaskId && !terminal) await this.cancelRemote(run);
      await this.close(run);
      this.activeRuns.delete(run);
    }
  }

  private static errorMessage(message: string): string {
    return authError(message)
      ? 'WorkBuddy 登录态不可用。桌面模式请启动并登录 WorkBuddy；CLI 模式请在相同 CODEBUDDY_CONFIG_DIR 下执行 /login，桌面登录不等于独立 CLI 登录。'
      : message;
  }

  private static async connect(run: ActiveRun): Promise<WorkBuddyBackend> {
    const mode = process.env.CB_WORKBUDDY_BACKEND || 'auto';
    if (!['auto', 'desktop', 'cli'].includes(mode)) throw new Error('CB_WORKBUDDY_BACKEND must be auto, desktop or cli.');
    const configs = resolveWorkBuddyConfigs();
    const candidates: WorkBuddyBackend[] = mode === 'auto' ? ['desktop', 'cli'] : [mode as WorkBuddyBackend];
    const errors: string[] = [];
    for (const backend of candidates) {
      const config = configs[backend];
      if (!config) continue;
      try {
        if (run.controller.signal.aborted) throw run.controller.signal.reason;
        run.backend = backend;
        run.transport = new StdioClientTransport({ ...config, stderr: 'pipe' });
        // stderr 可能包含鉴权/用户数据，消费管道但不直接写入工作台日志。
        run.transport.stderr?.resume();
        run.client = new Client({ name: 'cb-workbench-client', version: '0.1.0' }, { capabilities: {} });
        await run.client.connect(run.transport, { timeout: 10000, signal: run.controller.signal });
        const tools = await run.client.listTools({}, { timeout: 10000, signal: run.controller.signal });
        const names = new Set(tools.tools.map(tool => tool.name));
        const required = backend === 'desktop' ? ['workbuddy_status', 'workbuddy_start', 'workbuddy_wait', 'workbuddy_cancel'] : ['run_workbuddy_task'];
        if (!required.every(name => names.has(name))) throw new Error('MCP server is missing required WorkBuddy tools.');
        if (backend === 'desktop') {
          const status = this.object(await this.call(run, 'workbuddy_status', {}, 10000));
          if (status.ok !== true || status.connected !== true) throw new Error(status.error || 'WorkBuddy Desktop is not connected.');
        }
        return backend;
      } catch (error: any) {
        errors.push(`${backend}: ${error.message}`);
        await this.close(run);
        if (run.controller.signal.aborted) throw run.controller.signal.reason;
      }
    }
    throw new Error(errors.join('\n') || '未找到 WorkBuddy MCP 配置，请配置 workbuddy-desktop / workbuddy-cli 或 CB_WORKBUDDY_MCP_CONFIG。');
  }

  private static call(run: ActiveRun, name: string, args: Record<string, unknown>, timeout = 15000) {
    return run.client!.callTool({ name, arguments: args }, undefined, { timeout, signal: run.controller.signal });
  }

  private static object(response: any): Record<string, any> {
    if (response.isError) throw new Error(textContent(response) || 'WorkBuddy MCP tool failed.');
    const parsed = response.structuredContent || JSON.parse(textContent(response));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid WorkBuddy MCP response.');
    return parsed;
  }

  private static async cancelRemote(run: ActiveRun): Promise<void> {
    try {
      // 取消不能复用已 aborted 的信号；等待终态让桥接器回收独立 Host。
      for (let attempt = 0; attempt < 2; attempt++) {
        await run.client!.callTool({ name: 'workbuddy_cancel', arguments: { task_id: run.remoteTaskId } }, undefined, { timeout: 5000 });
        const state = this.object(await run.client!.callTool({ name: 'workbuddy_wait', arguments: { task_id: run.remoteTaskId, timeout_seconds: 3 } }, undefined, { timeout: 4000 }));
        if (['completed', 'failed', 'cancelled'].includes(state.state)) break;
      }
    } catch { /* 连接已断开时仍继续回收本地 MCP 进程。 */ }
  }

  private static async close(run: ActiveRun): Promise<void> {
    const transport = run.transport;
    // CLI MCP 不处理取消通知，Windows 必须回收整个子进程树。
    if (run.backend === 'cli' && run.controller.signal.aborted && transport?.pid && process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const killer = spawn('taskkill', ['/pid', String(transport.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', () => resolve()); killer.once('close', () => resolve());
      });
    }
    try { await run.client?.close(); } catch { /* transport 可能已关闭。 */ }
    try { await transport?.close(); } catch { /* 启动失败也要释放 transport。 */ }
    run.client = undefined;
    run.transport = undefined;
  }
}
