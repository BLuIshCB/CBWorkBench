import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type CliErrorCode =
  | 'CONFIG'
  | 'AUTH_REQUIRED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXECUTION'
  | 'OUTPUT_LIMIT'
  | 'PROTOCOL';

export interface CliRunOptions {
  runId: string;
  taskId?: string;
  executable: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CliRunResult {
  runId: string;
  taskId?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  errorCode?: CliErrorCode;
  error?: string;
}

interface ActiveRun {
  runId: string;
  taskId?: string;
  child: ChildProcess;
  controller: AbortController;
  killed: boolean;
}

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20 MB

export class CliRunner {
  private static activeRuns = new Map<string, ActiveRun>();

  /**
   * 中断指定 taskId 或 runId 的运行任务
   */
  static async abort(targetId?: string): Promise<void> {
    const targets: ActiveRun[] = [];
    for (const run of this.activeRuns.values()) {
      if (!targetId || run.runId === targetId || run.taskId === targetId) {
        targets.push(run);
      }
    }

    for (const run of targets) {
      run.controller.abort();
      await this.killProcessTree(run.child.pid);
    }
  }

  /**
   * 终止所有活动运行进程
   */
  static async abortAll(): Promise<void> {
    await this.abort();
  }

  /**
   * 核心子进程启动与执行
   */
  static async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();
    const runId = options.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskId = options.taskId;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    // 1. 严格参数与目录有效性校验
    if (!options.cwd || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) {
      return {
        runId,
        taskId,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startTime,
        errorCode: 'CONFIG',
        error: `CLI 要求有效且绝对的工作目录路径: '${options.cwd}'`,
      };
    }

    try {
      const stat = fs.statSync(options.cwd);
      if (!stat.isDirectory()) {
        return {
          runId,
          taskId,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: Date.now() - startTime,
          errorCode: 'CONFIG',
          error: `工作目录路径非有效文件夹: '${options.cwd}'`,
        };
      }
    } catch (err: any) {
      return {
        runId,
        taskId,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startTime,
        errorCode: 'CONFIG',
        error: `工作目录不可访问或不存在: ${err.message}`,
      };
    }

    if (!options.executable || typeof options.executable !== 'string' || !options.executable.trim()) {
      return {
        runId,
        taskId,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startTime,
        errorCode: 'CONFIG',
        error: '未指定可执行文件路径 (executable)',
      };
    }

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return {
        runId,
        taskId,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startTime,
        errorCode: 'CONFIG',
        error: `超时时间必须为正整数: ${timeoutMs}`,
      };
    }

    const controller = new AbortController();
    const args = options.args || [];
    const env = { ...process.env, ...options.env };

    return new Promise<CliRunResult>((resolve) => {
      let child: ChildProcess;
      let timedOut = false;
      let cancelled = false;
      let outputLimitExceeded = false;
      let settled = false;

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalStdoutBytes = 0;
      let totalStderrBytes = 0;

      let timer: NodeJS.Timeout | null = null;

      const finishOnce = (result: CliRunResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.activeRuns.delete(runId);
        resolve(result);
      };

      try {
        child = spawn(options.executable, args, {
          cwd: options.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        return finishOnce({
          runId,
          taskId,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: Date.now() - startTime,
          errorCode: 'CONFIG',
          error: `无法启动子进程: ${err.message}`,
        });
      }

      const activeRecord: ActiveRun = {
        runId,
        taskId,
        child,
        controller,
        killed: false,
      };
      this.activeRuns.set(runId, activeRecord);

      // 设置超时定时器
      timer = setTimeout(async () => {
        timedOut = true;
        controller.abort();
        await this.killProcessTree(child.pid);
      }, timeoutMs);

      // 处理中断监听
      controller.signal.addEventListener('abort', () => {
        if (!timedOut && !outputLimitExceeded) {
          cancelled = true;
        }
      });

      // 处理 stdin 写入
      if (child.stdin) {
        child.stdin.on('error', (err: any) => {
          // EPIPE 发生在子进程提早退出并关闭管道时
          if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
            // 管道非预期错误记录到 stderrChunks
            stderrChunks.push(Buffer.from(`\n[CliRunner Stdin Error] ${err.message}\n`));
          }
        });

        if (options.stdin !== undefined) {
          const inputBuffer = Buffer.from(options.stdin, 'utf8');
          try {
            child.stdin.end(inputBuffer);
          } catch {
            // 写入失败将在 close 或 error 中捕获
          }
        } else {
          child.stdin.end();
        }
      }

      // 累积 stdout 原始 Buffer
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        totalStdoutBytes += chunk.length;
        if (totalStdoutBytes + totalStderrBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          controller.abort();
          this.killProcessTree(child.pid);
          return;
        }
        stdoutChunks.push(chunk);
      });

      // 累积 stderr 原始 Buffer
      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return;
        totalStderrBytes += chunk.length;
        if (totalStdoutBytes + totalStderrBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          controller.abort();
          this.killProcessTree(child.pid);
          return;
        }
        stderrChunks.push(chunk);
      });

      child.on('error', (err: any) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        finishOnce({
          runId,
          taskId,
          exitCode: null,
          signal: null,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
          timedOut,
          cancelled,
          durationMs: Date.now() - startTime,
          errorCode: 'EXECUTION',
          error: `子进程执行错误: ${err.message}`,
        });
      });

      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          return finishOnce({
            runId,
            taskId,
            exitCode: code,
            signal: signal ? String(signal) : null,
            stdout,
            stderr,
            timedOut: true,
            cancelled: false,
            durationMs,
            errorCode: 'TIMEOUT',
            error: `CLI 任务执行超过预设超时时间 (${timeoutMs}ms)`,
          });
        }

        if (outputLimitExceeded) {
          return finishOnce({
            runId,
            taskId,
            exitCode: code,
            signal: signal ? String(signal) : null,
            stdout,
            stderr,
            timedOut: false,
            cancelled: false,
            durationMs,
            errorCode: 'OUTPUT_LIMIT',
            error: `CLI 进程输出超过设定的最大限制 (${maxOutputBytes} bytes)`,
          });
        }

        if (cancelled) {
          return finishOnce({
            runId,
            taskId,
            exitCode: code,
            signal: signal ? String(signal) : null,
            stdout,
            stderr,
            timedOut: false,
            cancelled: true,
            durationMs,
            errorCode: 'CANCELLED',
            error: 'CLI 任务已被用户或系统取消',
          });
        }

        let errorCode: CliErrorCode | undefined;
        let errorMsg: string | undefined;

        if (code !== 0) {
          errorCode = 'EXECUTION';
          errorMsg = stderr.trim() || `CLI 进程非零退出 (exit code: ${code})`;
        }

        finishOnce({
          runId,
          taskId,
          exitCode: code,
          signal: signal ? String(signal) : null,
          stdout,
          stderr,
          timedOut: false,
          cancelled: false,
          durationMs,
          errorCode,
          error: errorMsg,
        });
      });
    });
  }

  /**
   * 安全回收子进程树 (Windows 使用 taskkill /PID <pid> /T /F)
   */
  private static async killProcessTree(pid?: number): Promise<void> {
    if (!pid) return;

    return new Promise<void>((resolve) => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        });
        killer.once('error', () => resolve());
        killer.once('close', () => resolve());
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        resolve();
      }
    });
  }
}
