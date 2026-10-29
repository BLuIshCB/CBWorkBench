import path from 'node:path';
import fs from 'node:fs';
import { WORKER_FIXED_MODEL, DEFAULT_WORKER_TIMEOUT_MS, ROOT_DIR } from '../config/constants.ts';
import { resolveWorkBuddyCliConfig } from './workbuddyConfig.ts';
import { CliRunner, type CliErrorCode } from './cliRunner.ts';

export interface WorkerExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
  errorCode?: CliErrorCode;
  timedOut?: boolean;
  backend?: string;
  sessionId?: string;
  durationMs?: number;
  modelUsed?: string;
}

const stripAnsi = (text: string) =>
  text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

const authError = (text: string) =>
  /^(?:Error:\s*)?(?:authentication required|please (?:use \/login|log\s?in|sign in)|not authenticated|未登录|请(?:先)?登录)/im.test(
    text.trim()
  );

export class WorkBuddyClient {
  /**
   * 中断指定 taskId 的运行，或终止所有活动任务
   */
  static requestStop(taskId?: string): void {
    CliRunner.abort(taskId);
  }

  /**
   * 连通性健康检查：验证 Direct CLI 入口与 `--help` 可启动性
   */
  static async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (process.env.CB_MOCK_WORKBUDDY === 'true') {
      return { healthy: true, message: 'Explicit WorkBuddy mock mode.' };
    }

    try {
      const config = resolveWorkBuddyCliConfig();
      const args = [...(config.script ? [config.script] : []), '--help'];

      const runRes = await CliRunner.run({
        runId: `wb-health-${Date.now()}`,
        executable: config.executable,
        args,
        cwd: ROOT_DIR,
        timeoutMs: 10000,
        env: config.env,
      });

      const combined = `${runRes.stdout}\n${runRes.stderr}`;
      const isHealthy =
        runRes.exitCode === 0 ||
        /Usage:\s*(codebuddy|cbc)/i.test(combined) ||
        combined.includes('CodeBuddy Code');

      if (isHealthy) {
        return {
          healthy: true,
          message: 'WorkBuddy Direct CLI 就绪 (--no-session-persistence 模式已就绪)',
        };
      }

      return {
        healthy: false,
        message: runRes.error || runRes.stderr || 'WorkBuddy CLI 启动失败',
      };
    } catch (err: any) {
      return { healthy: false, message: err.message };
    }
  }

  /**
   * 执行实际 Worker 任务 (Direct CLI 子进程，UTF-8 stdin 传递完整提示词)
   */
  static async runTask(params: {
    prompt: string;
    cwd: string;
    model?: string;
    timeoutMs?: number;
    taskId?: string;
  }): Promise<WorkerExecutionResult> {
    const startTime = Date.now();
    const model = params.model || WORKER_FIXED_MODEL;
    const timeoutMs = params.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;

    if (process.env.CB_MOCK_WORKBUDDY === 'true') {
      return {
        ok: true,
        output: `[MOCK WORKBUDDY RESULT]\nCompleted prompt for cwd: ${params.cwd}`,
        modelUsed: model,
        durationMs: Date.now() - startTime,
        backend: 'direct-cli-mock',
      };
    }

    // 校验工作目录与输入有效性
    let validDirectory = false;
    try {
      validDirectory = path.isAbsolute(params.cwd) && fs.statSync(params.cwd).isDirectory();
    } catch {}

    if (
      !params.prompt?.trim() ||
      !validDirectory ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2147483647
    ) {
      return {
        ok: false,
        output: '',
        errorCode: 'CONFIG',
        error: 'WorkBuddy 需要非空提示词、存在的绝对工作目录和有效的正整数超时时间。',
        durationMs: Date.now() - startTime,
        modelUsed: model,
      };
    }

    let config;
    try {
      config = resolveWorkBuddyCliConfig();
    } catch (err: any) {
      return {
        ok: false,
        output: '',
        errorCode: 'CONFIG',
        error: err.message,
        durationMs: Date.now() - startTime,
        modelUsed: model,
      };
    }

    // 构造 Direct CLI 参数（必须带上 --no-session-persistence）
    const args = [
      ...(config.script ? [config.script] : []),
      '-p',
      '--no-session-persistence',
      '--output-format',
      'json',
      '--model',
      model,
      '-y',
    ];

    const runResult = await CliRunner.run({
      runId: `wb-${params.taskId || 'standalone'}-${Date.now()}`,
      taskId: params.taskId,
      executable: config.executable,
      args,
      cwd: params.cwd,
      env: config.env,
      stdin: params.prompt,
      timeoutMs,
    });

    const durationMs = Date.now() - startTime;
    const base = {
      modelUsed: model,
      durationMs,
      backend: 'direct-cli',
    };

    if (runResult.timedOut) {
      return {
        ok: false,
        output: runResult.stdout,
        error: `WorkBuddy 执行超过 ${timeoutMs}ms，已请求取消。`,
        errorCode: 'TIMEOUT',
        timedOut: true,
        ...base,
      };
    }

    if (runResult.cancelled) {
      return {
        ok: false,
        output: runResult.stdout,
        error: 'WorkBuddy 执行已取消。',
        errorCode: 'CANCELLED',
        ...base,
      };
    }

    if (runResult.errorCode === 'OUTPUT_LIMIT') {
      return {
        ok: false,
        output: runResult.stdout,
        error: runResult.error,
        errorCode: 'OUTPUT_LIMIT',
        ...base,
      };
    }

    const cleanStdout = stripAnsi(runResult.stdout.trim());
    const cleanStderr = stripAnsi(runResult.stderr.trim());

    // 检查鉴权异常
    if (authError(cleanStdout) || authError(cleanStderr)) {
      return {
        ok: false,
        output: cleanStdout,
        error:
          'WorkBuddy 登录态不可用。请在相同 CODEBUDDY_CONFIG_DIR 下运行 /login 登录。桌面端登录不代表独立 CLI 已登录。',
        errorCode: 'AUTH_REQUIRED',
        ...base,
      };
    }

    if (runResult.exitCode !== 0 && !cleanStdout) {
      return {
        ok: false,
        output: '',
        error: cleanStderr || `WorkBuddy CLI 非零退出 (exitCode=${runResult.exitCode})`,
        errorCode: 'EXECUTION',
        ...base,
      };
    }

    // 解析 JSON 输出
    let parsed: any = null;
    try {
      parsed = JSON.parse(cleanStdout);
    } catch {
      // 兼容 Markdown 代码块包裹: ```json ... ```
      const jsonBlockMatch = cleanStdout.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (jsonBlockMatch) {
        try {
          parsed = JSON.parse(jsonBlockMatch[1].trim());
        } catch {}
      }

      // 兼容可能混杂的前置/后置日志：从首个 { 截取到末尾最后一个 }
      if (!parsed) {
        const jsonStart = cleanStdout.indexOf('{');
        const jsonEnd = cleanStdout.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          try {
            parsed = JSON.parse(cleanStdout.slice(jsonStart, jsonEnd + 1));
          } catch {}
        }
      }

      if (!parsed) {
        return {
          ok: false,
          output: cleanStdout,
          error: cleanStderr || 'WorkBuddy 返回了无法解析的 JSON 响应格式。',
          errorCode: 'PROTOCOL',
          ...base,
        };
      }
    }

    if (parsed && typeof parsed === 'object') {
      if (parsed.is_error || parsed.error) {
        const errorMsg =
          typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.output === 'string'
            ? parsed.output
            : 'WorkBuddy 内部执行失败';
        return {
          ok: false,
          output: cleanStdout,
          error: errorMsg,
          errorCode: authError(errorMsg) ? 'AUTH_REQUIRED' : 'EXECUTION',
          ...base,
        };
      }

      const outputText =
        typeof parsed.output === 'string'
          ? parsed.output
          : typeof parsed.result === 'string'
          ? parsed.result
          : typeof parsed.answer === 'string'
          ? parsed.answer
          : JSON.stringify(parsed);

      if (!outputText.trim()) {
        return {
          ok: false,
          output: '',
          error: 'WorkBuddy 返回空输出内容。',
          errorCode: 'PROTOCOL',
          ...base,
        };
      }

      return {
        ok: true,
        output: outputText,
        ...base,
      };
    }

    return {
      ok: false,
      output: cleanStdout,
      error: 'WorkBuddy CLI 返回了非预期的数据结构。',
      errorCode: 'PROTOCOL',
      ...base,
    };
  }
}
