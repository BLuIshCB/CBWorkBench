import { ExecutionService } from '../services/executionService.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { IAgentAdapter, AgentExecutionContext, AgentExecutionResult, AdapterExecutionPolicy } from './types.ts';
import type { AgentCliConfig } from '../services/cliConfig.ts';
import type { CliDeclaration } from '../services/cliDiscovery.ts';
import { resolveDeclaredCliConfig } from '../services/cliConfig.ts';
import { CliRunner, type CliRunResult } from '../services/cliRunner.ts';
import { withCliRuntimeOnPath } from '../utils/executableKind.ts';
import { ROOT_DIR, DEFAULT_EXECUTION_TIMEOUT_MS } from '../config/constants.ts';

export interface Invocation {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
  windowsVerbatimArguments?: boolean;
}

/** 共用进程执行和失败处理；参数与协议解析留给厂商实现。 */
export abstract class NativeCliAdapter implements IAgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly defaultModel: string;
  abstract readonly supportedModels: readonly string[];
  abstract readonly connectionType: string;
  abstract readonly executionPolicy: AdapterExecutionPolicy;
  /** 只声明 CLI 名称与依赖，探测逻辑统一走 cliDiscovery */
  abstract readonly cliDeclaration: CliDeclaration;
  protected abstract buildArgs(model: string): string[];
  protected abstract parseOutput(stdout: string): string;
  protected encodePrompt(prompt: string): string { return prompt; }

  get progressCapability(): 'raw'|'events' {return this.id==='codex'?'events':'raw';}

  abort(taskId: string) { return CliRunner.abort(taskId); }

  protected resolveConfig(): AgentCliConfig {
    return resolveDeclaredCliConfig(this.cliDeclaration);
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string; version?: string }> {
    if (this.isMockEnabled()) return { healthy: true, message: '显式测试模式，未验证真实 CLI。' };
    try {
      const config = this.resolveConfig();
      const invocation = this.buildInvocation(config, ['--version']);
      const result = await CliRunner.run({
        runId: randomUUID(), executable: invocation.executable,
        args: invocation.args, cwd: ROOT_DIR, env: invocation.env, timeoutMs: 10000,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      const lookupFailure = this.describeLookupFailure(config, result);
      if (lookupFailure) return { healthy: false, message: lookupFailure };
      const version = result.stdout.trim().split(/\r?\n/)[0]?.trim() || undefined;
      return { healthy: !result.errorCode && result.exitCode === 0, version,
        message: result.error || `${result.stdout.trim()}；入口可启动，对话请执行验证。` };
    } catch (error) { return { healthy: false, message: String(error) }; }
  }

  async execute(context: AgentExecutionContext): Promise<AgentExecutionResult> {
    const started = Date.now();
    const modelUsed = context.model || this.defaultModel;
    const base = { modelUsed, metadata: { backend: 'direct-cli', executionPolicy: this.executionPolicy } };
    if (!context.prompt?.trim()) return { ...base, ok: false, output: '', error: '提示词不能为空', errorCode: 'CONFIG', durationMs: 0 };
    if (this.isMockEnabled()) return { ...base, ok: true,
      output: `[MOCK ${this.id.toUpperCase()} RESULT]\n${context.prompt}`, durationMs: 0,
      metadata: { ...base.metadata, backend: 'direct-cli-mock' } };
    try {
      const config = this.resolveConfig();
      const invocation = this.buildInvocation(config, this.buildArgs(modelUsed));
      const runId=context.runId || randomUUID();
      let pending='';
      const result = await CliRunner.run({
        runId, roundId:context.roundId, kind:context.kind, deferFinish:true, taskId: context.taskId,
        executable: invocation.executable, args: invocation.args,
        cwd: context.cwd, env: invocation.env, stdin: this.encodePrompt(context.prompt),
        signal: context.signal,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        onChunk: chunk=>{
          try {context.onEvent?.({type:'output',...chunk});} catch {}
          if(chunk.stream!=='stdout') return;
          pending+=chunk.text;
          let newline;
          while((newline=pending.indexOf('\n'))>=0) {
            const line=pending.slice(0,newline);pending=pending.slice(newline+1);
            if(Buffer.byteLength(line)>1048576) throw Object.assign(new Error('协议行超过1MiB'),{errorCode:'OUTPUT_LIMIT'});
            if(!line.trim())continue;
            if(this.id==='workbuddy')continue;
            let event;try{event=JSON.parse(line);}catch{
              if (context.completionByMcp) continue;
              throw Object.assign(new Error('CLI JSONL 损坏'),{errorCode:'PROTOCOL'});
            }
            if(!event || typeof event!=='object') {
              if (context.completionByMcp) continue;
              throw Object.assign(new Error('CLI 协议事件不是对象'),{errorCode:'PROTOCOL'});
            }
            if(this.id==='codex' && ['item.started','item.completed'].includes(event.type) && event.item?.type==='command_execution') {
              ExecutionService.event(runId,'progress',{text:event.type==='item.started'?'工具开始':'工具结束',toolName:'command_execution'});
            }
          }
          if(Buffer.byteLength(pending)>1048576) throw Object.assign(new Error('协议行超过1MiB'),{errorCode:'OUTPUT_LIMIT'});
        },
        timeoutMs: context.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      });
      if ((!context.completionByMcp || result.errorCode || result.exitCode !== 0) && !result.timedOut && !result.cancelled && result.errorCode!=='OUTPUT_LIMIT' && /^(?:Error:\s*)?(?:authentication required|authentication failed|not authenticated|please (?:use \/login|log\s?in|sign in)|未登录|请(?:先)?登录)/im.test(`${result.stdout}\n${result.stderr}`)) {
        await ExecutionService.finish(runId,'AUTH_REQUIRED',result.exitCode,true);
        return { ...base, runId, stopReason:'AUTH_REQUIRED', cleanupConfirmed:true, ok: false, output: result.stdout, error: `${this.name} 无法恢复登录态，请使用相同 CLI 配置完成登录后重试。`,
          errorCode: 'AUTH_REQUIRED', durationMs: result.durationMs };
      }
      if (result.errorCode || result.exitCode !== 0) {
        await ExecutionService.finish(runId,result.stopReason || "PROCESS_FAILED",result.exitCode,result.cleanupConfirmed ?? false);
        let error = this.describeLookupFailure(config, result) || result.error || result.stderr || 'CLI 执行失败';
        if (!result.timedOut && !result.cancelled && result.stdout.trim()) {
          try { this.parseOutput(result.stdout); } catch (failure) { error = String(failure); }
        }
        return { ...base, runId, stopReason:result.stopReason, cleanupConfirmed:result.cleanupConfirmed, ok: false, output: result.stdout, error,
          errorCode: result.errorCode || 'EXECUTION', timedOut: result.timedOut, durationMs: result.durationMs };
      }
      try {
        let output: string;
        try {
          output = this.parseOutput(result.stdout);
          if (typeof output !== 'string' || !output.trim()) throw new Error('CLI 返回空响应');
        } catch (error) {
          if (!context.completionByMcp) throw error;
          output = result.stdout;
        }
        await ExecutionService.finish(runId,null,result.exitCode,true);
        return { ...base, runId, cleanupConfirmed:true, ok: true, output, durationMs: result.durationMs };
      } catch (error) {
        await ExecutionService.finish(runId,'PROTOCOL_ERROR',result.exitCode,true);
        return { ...base, runId, stopReason:'PROTOCOL_ERROR', cleanupConfirmed:true, ok: false, output: result.stdout, error: String(error), errorCode: 'PROTOCOL', durationMs: result.durationMs };
      }
    } catch (error) {
      return { ...base, ok: false, output: '', error: String(error), errorCode: 'CONFIG', durationMs: Date.now() - started };
    }
  }

  /**
   * 组装实际执行入口：脚本型 CLI 前插自身目录到 PATH，Windows 批处理包装器用 cmd 包裹。
   */
  protected buildInvocation(config: AgentCliConfig, args: string[]): Invocation {
    const env = withCliRuntimeOnPath(config);
    const fullArgs = [...(config.script ? [config.script] : []), ...(config.args || []), ...args];
    if (config.needsShellWrap && process.platform === 'win32') {
      return {
        executable: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${[config.executable, ...fullArgs].map(quoteWindowsArg).join(' ')}"`],
        env,
        windowsVerbatimArguments: true,
      };
    }
    return { executable: config.executable, args: fullArgs, env };
  }

  /** 把「没找到」和「找到但跑不起来」分开，用户才知道下一步做什么。 */
  private describeLookupFailure(config: AgentCliConfig, result: CliRunResult): string | null {
    if (!result.errorCode) return null;
    if (!/ENOENT|EACCES|EPERM/i.test(`${result.error ?? ''}\n${result.stderr ?? ''}`)) return null;
    if (path.isAbsolute(config.executable)) {
      return `${this.name} 已找到但无法启动（${config.executable}），可能缺少 Node.js 运行时。`;
    }
    return `${this.name} 未安装：命令 '${config.executable}' 不在 PATH 中。`;
  }

  private isMockEnabled(): boolean {
    return (this.id === 'workbuddy' && process.env.CB_MOCK_WORKBUDDY === 'true') ||
      (this.id === 'codex' && process.env.CB_MOCK_CODEX === 'true');
  }
}

function quoteWindowsArg(arg: string): string {
  if (!arg) return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  // cmd 不认反斜杠转义，内嵌引号要写成 ""。
  return `"${arg.replace(/"/g, '""')}"`;
}
