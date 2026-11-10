import { createHash } from 'node:crypto';
import { resolveCliConfig } from './cliConfig.ts';
import { ROOT_DIR } from '../config/constants.ts';
import { adapterRegistry } from '../adapters/registry.ts';


export interface CliConfigInfo {
  id: string;
  name: string;
  category: 'agent';
  role: string;
  connectionType: string;
  configured: boolean;
  available: boolean;
  defaultModel?: string;
  supportedModels?: string[];
  defaultProbePrompt: string;
  statusMessage?: string;
  description?: string;
  discovery?: {source:'config'|'path'|'npm'|'project';entry:string;version:string|null;compatible:boolean;reason:string|null};
  verification?: {state:'unknown'|'passed'|'failed';checkedAt:number|null;model:string|null;message:string|null};
  extraInfo?: Record<string, any>;
}

export interface CliProbeRequest {
  cliId: string;
  verify?: boolean;
  prompt?: string;
  model?: string;
  cwd?: string;
}

export interface CliProbeResult {
  ok: boolean;
  cliId: string;
  cliName: string;
  connectionType: string;
  prompt: string;
  output: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
  modelUsed?: string;
  backend?: string;
  sessionId?: string;
  exitCode?: number | null;
  timestamp: string;
  commandPreview?: string;
  verified?: boolean;
  markerMatched?: boolean;
}

export class RuntimeService {
  private checks=new Map<string,{fingerprint:string;state:'passed'|'failed';checkedAt:number;model:string;message:string}>();
  private fingerprint(id:string,model:string):string {return createHash('sha256').update(JSON.stringify({config:resolveCliConfig(id),model})).digest('hex');}

  /** 版本探测仅说明入口可启动，真实对话由 probeCli 验证。 */
  async listConfiguredClis(): Promise<CliConfigInfo[]> {
    return (await adapterRegistry.listAllAdapters()).map(a => {
      let entry='';let discoverySource: 'config'|'path'|'npm'|'project'='path';let state:CliConfigInfo['verification']={state:'unknown',checkedAt:null,model:null,message:null};
      try {const config=resolveCliConfig(a.id);discoverySource=config.discoverySource || (process.env.CB_AGENT_CLI_CONFIG?'config':'path');entry=[config.executable,config.script].filter(Boolean).join(' ');const check=this.checks.get(a.id);if(check && check.fingerprint===this.fingerprint(a.id,check.model))state={state:check.state,checkedAt:check.checkedAt,model:check.model,message:check.message};} catch {}
      return ({
      id: a.id, name: a.name, category: 'agent', role: 'CLI 对话',
      connectionType: a.connectionType, configured: Boolean(a.healthy), available: Boolean(a.healthy),
      defaultModel: a.defaultModel, supportedModels: a.supportedModels,
      defaultProbePrompt: '只回复 CLI_中文对话_OK。不要调用工具，不要读写文件。',
      statusMessage: a.statusMessage, description: a.description,
      discovery:{source:discoverySource,entry,version:a.statusMessage?.match(/codex-cli\s+([^;；\s]+)/)?.[1] ?? null,compatible:Boolean(a.healthy),reason:a.healthy?null:a.statusMessage ?? null},
      verification:state,
      extraInfo: { executionPolicy: a.executionPolicy, modelCatalogSource: a.modelCatalogSource, modelCatalogError: a.modelCatalogError },
    });});
  }

  async probeCli(params: CliProbeRequest): Promise<CliProbeResult> {
    const adapter = adapterRegistry.getAdapter(params.cliId);
    if(params.verify && params.prompt !== undefined) throw new Error('verify=true 不允许提供 prompt');
    const marker='CB_VERIFY_'+crypto.randomUUID();
    const prompt = params.verify ? '只回复 '+marker+'。不要调用工具，不要读写文件。' : params.prompt?.trim() || '只回复 CLI_中文对话_OK。不要调用工具，不要读写文件。';
    const result = await adapter.execute({
      prompt,
      cwd: params.cwd || ROOT_DIR, model: params.model || adapter.defaultModel,
      timeoutMs: 180000,
    });
    if(params.verify) this.checks.set(adapter.id,{fingerprint:this.fingerprint(adapter.id,result.modelUsed),state:result.ok && result.output.trim()===marker?'passed':'failed',checkedAt:Date.now(),model:result.modelUsed,message:result.ok && result.output.trim()===marker?'marker 严格匹配':result.error || 'marker 未严格匹配'});
    return {
      ok: result.ok, cliId: adapter.id, cliName: adapter.name, connectionType: adapter.connectionType,
      prompt, output: result.output, error: result.error, errorCode: result.errorCode,
      durationMs: result.durationMs, modelUsed: result.modelUsed,
      backend: result.metadata?.backend, timestamp: new Date().toISOString(),
      markerMatched: params.verify ? result.ok && result.output.trim()===marker : undefined,
      verified: Boolean(params.verify && result.ok && result.output.trim()===marker),
      commandPreview: `${adapter.connectionType} [${result.modelUsed}] 实际检查时限 180000ms`,
    };
  }
}

export const runtimeService = new RuntimeService();
