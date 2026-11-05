import { db } from '../storage/db.ts';
import { ExecutionService, type StopReason, type RunSnapshot } from './executionService.ts';
import { StringDecoder } from 'node:string_decoder';
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
  kind?: RunSnapshot['kind'];
  deferFinish?: boolean;
  roundId?: number;
  shell?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: {stream: 'stdout' | 'stderr'; text: string}) => void;
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
  // 仅正常关闭且非零退出才属于断言失败，停止或执行设施错误须中断测试链。
  failureKind?: 'exit-code' | 'infrastructure';
  error?: string;
  stopReason?: StopReason;
  cleanupConfirmed?: boolean;
}

interface ActiveRun {
  runId: string;
  taskId?: string;
  child: ChildProcess;
  controller: AbortController;
  killed: boolean;
  cleanup?: Promise<boolean>;
  cleanupFailed?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024; // 20 MB

export class CliRunner {
  private static activeRuns = new Map<string, ActiveRun>();

  /**
   * 中断指定 taskId 或 runId 的运行任务
   */
  static hasTaskRuns(taskId:string): boolean {return [...this.activeRuns.values()].some(run=>run.taskId===taskId);}
  static hasCleanupFailure(): boolean { return [...this.activeRuns.values()].some(run=>run.cleanupFailed); }
  static async retryCleanup(runId:string):Promise<boolean> {
    const run=this.activeRuns.get(runId);
    if(!run?.cleanupFailed || run.child.exitCode!==null || run.child.signalCode!==null)return false;
    // 只重试仍持有活动子进程句柄的运行，不使用历史 PID 猜测进程身份。
    if(!run.child.kill(0))return false;
    run.cleanup=undefined;
    const confirmed=await this.cleanup(run);
    if(confirmed){this.activeRuns.delete(runId);db.recordRunCleanup(runId);}
    return confirmed;
  }
  static pendingRunIds(): string[] { return [...this.activeRuns.keys()]; }
  static hasUncleanRuns(): boolean { return this.activeRuns.size > 0; }

  private static cleanup(run: ActiveRun): Promise<boolean> {
    return run.cleanup ??= this.killProcessTree(run.child.pid);
  }

  static async abort(targetId?: string): Promise<void> {
    const targets: ActiveRun[] = [];
    for (const run of this.activeRuns.values()) {
      if (!targetId || run.runId === targetId || run.taskId === targetId) {
        targets.push(run);
      }
    }

    for (const run of targets) {
      run.controller.abort();
      if (await this.cleanup(run)) this.activeRuns.delete(run.runId);
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
    const result = await this.runProcess({...options,onChunk:chunk=>{
      ExecutionService.output(options.runId,chunk);
      options.onChunk?.(chunk);
    }});
    const reasons:Partial<Record<CliErrorCode,StopReason>>={TIMEOUT:'EXECUTION_TIMEOUT',CANCELLED:'USER_CANCELLED',OUTPUT_LIMIT:'OUTPUT_LIMIT',AUTH_REQUIRED:'AUTH_REQUIRED',PROTOCOL:'PROTOCOL_ERROR',EXECUTION:'PROCESS_FAILED',CONFIG:'PROCESS_FAILED'};
    const recordedReason = ExecutionService.snapshot(options.runId)?.stopReason;
    result.stopReason=recordedReason || (result.errorCode ? reasons[result.errorCode] : undefined);
    if(result.stopReason==='PROCESS_FAILED' && result.cancelled) {result.cancelled=false;result.errorCode='EXECUTION';result.error='执行日志保存失败，已停止执行并保留部分输出。';}
    result.cleanupConfirmed ??= true;
    if (!result.cleanupConfirmed) result.stopReason = "CLEANUP_FAILED";
    if (result.errorCode && (!result.failureKind || recordedReason || !result.cleanupConfirmed)) result.failureKind = 'infrastructure';
    if (!options.deferFinish) await ExecutionService.finish(options.runId,result.stopReason ?? null,result.exitCode,result.cleanupConfirmed);
    return result;
  }

  private static async runProcess(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();
    const runId = options.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskId = options.taskId;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if(options.signal?.aborted) return {runId,taskId,exitCode:null,signal:null,stdout:'',stderr:'',timedOut:false,cancelled:true,durationMs:0,errorCode:'CANCELLED',error:'执行已取消',cleanupConfirmed:true};

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

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || this.activeRuns.has(runId) || db.getRun(runId)!==null) {
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

    ExecutionService.start(runId,taskId,timeoutMs,options.kind ?? (options.shell ? 'test' : taskId ? 'worker' : 'probe'),options.roundId,()=>{void this.abort(runId);});
    const controller = new AbortController();
    const args = options.args || [];
    const env = { ...process.env, ...options.env };

    return new Promise<CliRunResult>((resolve) => {
      let child: ChildProcess;
      let timedOut = false;
      let cancelled = false;
      let callbackError: any;
      let outputLimitExceeded = false;
      let settled = false;

      const decoders = {stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalStdoutBytes = 0;
      let totalStderrBytes = 0;

      let timer: NodeJS.Timeout | null = null;
      let cleanupTimer: NodeJS.Timeout | null = null;

      const finishOnce = (result: CliRunResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (result.cleanupConfirmed !== false) this.activeRuns.delete(runId);
        else {const record=this.activeRuns.get(runId);if(record)record.cleanupFailed=true;}
        resolve(result);
      };

      try {
        child = spawn(options.executable, args, {
          cwd: options.cwd,
          env,
          shell: options.shell ?? false,
          windowsHide: true,
          detached: process.platform !== 'win32',
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
      controller.signal.addEventListener('abort', () => {
        try { ExecutionService.stopping(runId,timedOut?'EXECUTION_TIMEOUT':outputLimitExceeded?'OUTPUT_LIMIT':callbackError ? (callbackError.errorCode==='PROTOCOL'?'PROTOCOL_ERROR':callbackError.errorCode==='OUTPUT_LIMIT'?'OUTPUT_LIMIT':'PROCESS_FAILED') : 'USER_CANCELLED'); } catch {}
        cleanupTimer = setTimeout(() => {
          finishOnce({runId,taskId,exitCode:null,signal:null,
            stdout:Buffer.concat(stdoutChunks).toString('utf8'),stderr:Buffer.concat(stderrChunks).toString('utf8'),
            timedOut,cancelled,durationMs:Date.now()-startTime,errorCode:timedOut?'TIMEOUT':outputLimitExceeded?'OUTPUT_LIMIT':'CANCELLED',
            error:'CLEANUP_FAILED: 未能确认进程树回收，禁止启动新任务。',cleanupConfirmed:false});
        },10000);
      }, {once:true});
      const cancel = () => { controller.abort(); void this.cleanup(activeRecord); };
      options.signal?.addEventListener('abort', cancel, { once: true });

      child.once('close', () => options.signal?.removeEventListener('abort', cancel));

      // 设置超时定时器
      timer = setTimeout(async () => {
        if (cancelled || outputLimitExceeded || settled) return;
        timedOut = true;
        controller.abort();
        await this.cleanup(activeRecord);
      }, timeoutMs);

      // 处理中断监听
      controller.signal.addEventListener('abort', () => {
        if (!timedOut && !outputLimitExceeded) {
          cancelled = true;
        }
      });

      if (options.signal?.aborted) cancel();

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
        if (settled || outputLimitExceeded || timedOut || cancelled) return;
        totalStdoutBytes += chunk.length;
        if (totalStdoutBytes + totalStderrBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          controller.abort();
          this.cleanup(activeRecord);
          return;
        }
        stdoutChunks.push(chunk);
        try { options.onChunk?.({stream:'stdout',text:decoders.stdout.write(chunk)}); } catch (error) { callbackError=error; controller.abort(); void this.cleanup(activeRecord); }
      });

      // 累积 stderr 原始 Buffer
      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled || outputLimitExceeded || timedOut || cancelled) return;
        totalStderrBytes += chunk.length;
        if (totalStdoutBytes + totalStderrBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          controller.abort();
          this.cleanup(activeRecord);
          return;
        }
        stderrChunks.push(chunk);
        try { options.onChunk?.({stream:'stderr',text:decoders.stderr.write(chunk)}); } catch (error) { callbackError=error; controller.abort(); void this.cleanup(activeRecord); }
      });

      child.on('error', (err: any) => {
        if(child.pid!==undefined) {
          callbackError=Object.assign(err,{errorCode:'EXECUTION'});
          controller.abort();void this.cleanup(activeRecord);return;
        }
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

      child.on('close', async (code, signal) => {
        const cleanupConfirmed = activeRecord.cleanup ? await activeRecord.cleanup : true;
        let stdout: string;
        let stderr: string;
        try {
          // 普通 shell 测试可能使用系统编码，不能把合法退出误判成厂商协议损坏。
          const decoder = new TextDecoder('utf-8', { fatal: !options.shell });
          stdout = decoder.decode(Buffer.concat(stdoutChunks));
          stderr = decoder.decode(Buffer.concat(stderrChunks));
        } catch {
          return finishOnce({ runId, taskId, exitCode: code, signal: signal ? String(signal) : null,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), timedOut, cancelled, cleanupConfirmed, durationMs: Date.now() - startTime,
            errorCode: timedOut ? 'TIMEOUT' : outputLimitExceeded ? 'OUTPUT_LIMIT' : cancelled ? 'CANCELLED' : 'PROTOCOL',
            error: 'CLI 输出不是完整有效的 UTF-8。' });
        }
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          return finishOnce({
            runId,
            taskId,
            exitCode: code,
            signal: signal ? String(signal) : null,
            stdout,
            stderr,
            cleanupConfirmed,
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
            cleanupConfirmed,
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
            cleanupConfirmed,
            cancelled: !callbackError,
            durationMs,
            errorCode: callbackError ? (callbackError.errorCode || 'EXECUTION') : 'CANCELLED',
            error: callbackError ? String(callbackError) : 'CLI 任务已被用户或系统取消',
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
          failureKind: errorCode && !signal ? 'exit-code' : undefined,
          error: errorMsg,
        });
      });
    });
  }

  /**
   * 安全回收子进程树 (Windows 使用 taskkill /PID <pid> /T /F)
   */
  private static async killProcessTree(pid?: number): Promise<boolean> {
    if (!pid) return true;
    return new Promise(resolve => {
      let settled=false;
      let forceTimer:NodeJS.Timeout|undefined;
      let poll:NodeJS.Timeout|undefined;
      const killers:ChildProcess[]=[];
      const done=(confirmed:boolean)=>{
        if(settled)return;settled=true;
        clearTimeout(deadline);if(forceTimer)clearTimeout(forceTimer);if(poll)clearInterval(poll);
        for(const killer of killers) {if(killer.exitCode===null && killer.signalCode===null)killer.kill();}
        resolve(confirmed);
      };
      const absent=()=>{
        try {process.kill(process.platform==='win32'?pid:-pid,0);return false;}
        catch(error:any) {return error.code==='ESRCH';}
      };
      const verify=()=>{if(absent())done(true);else if(!poll)poll=setInterval(()=>{if(absent())done(true);},50);};
      const terminate=(force:boolean)=>{
        if(settled)return;
        if(process.platform!=='win32') {
          try {process.kill(-pid,force?'SIGKILL':'SIGTERM');verify();} catch(error:any) {done(error.code==='ESRCH');}
          return;
        }
        const killer=spawn('taskkill',['/pid',String(pid),'/T',...(force?['/F']:[])],{windowsHide:true,shell:false,stdio:'ignore'});
        killers.push(killer);
        killer.once('error',()=>{if(force)done(false);});
        killer.once('close',code=>{if(code===0)verify();else if(force)done(false);});
      };
      const deadline=setTimeout(()=>done(false),10000);
      // Windows 控制台没有可靠的软停止；延迟强杀可能丢失已退出父进程的后代关系。
      if(process.platform!=='win32')forceTimer=setTimeout(()=>terminate(true),5000);
      terminate(process.platform==='win32');
    });
  }
}
