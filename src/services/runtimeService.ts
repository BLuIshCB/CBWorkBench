import { createHash } from 'node:crypto';
import { resolveDeclaredCliAsync, resolveDeclaredCliDiscovery } from './cliConfig.ts';
import type { DiscoveryCandidate, DiscoveryResult, DiscoverySource } from './cliDiscovery.ts';
import { ROOT_DIR } from '../config/constants.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import type { IAgentAdapter } from '../adapters/types.ts';

export interface CliDiscoveryInfo {
  source: DiscoverySource;
  /** 实际启动入口，UI 手动指定入口时回填用 */
  executable: string;
  script: string | null;
  entry: string;
  runnable: boolean;
  /** 上次 --version 的结果，未校验时为 null */
  version: string | null;
  /** 上次 --version / exec --help 的校验结论，未校验时为 null */
  compatible: boolean | null;
  reason: string | null;
  candidates: DiscoveryCandidate[];
  scanned: number;
  pathHydrated: boolean;
  hydrationFailure?: string;
  missingDependencies?: string[];
}

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
  discovery?: CliDiscoveryInfo;
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

export interface ListClisOptions {
  /** 需要版本结论时才 spawn --version，冷启动不启动任何子进程 */
  withVersion?: boolean;
  /** 需要动态模型目录时才 spawn CLI，默认只用适配器静态模型 */
  withCatalog?: boolean;
  /** 忽略版本缓存，供「刷新状态」使用 */
  forceVersion?: boolean;
}

interface VersionProbe {
  version: string | null;
  compatible: boolean | null;
  reason: string | null;
  expiresAt: number;
}

const VERSION_CACHE_TTL_MS = 60000;

export class RuntimeService {
  private checks=new Map<string,{fingerprint:string;state:'passed'|'failed';checkedAt:number;model:string;message:string}>();
  private versionCache = new Map<string, VersionProbe>();
  private fingerprint(id:string,model:string,entry:string):string {return createHash('sha256').update(JSON.stringify({id,model,entry})).digest('hex');}

  /** 探测与探活分离：列表只说明入口是否可运行，真实对话由 probeCli 验证。 */
  async listConfiguredClis(options: ListClisOptions = {}): Promise<CliConfigInfo[]> {
    // 动态模型目录要跑 CLI，只在显式刷新时取；默认用适配器静态模型，保证冷启动无子进程。
    const metas = options.withCatalog ? await adapterRegistry.listModelAdapters() : adapterRegistry.listAdapters();
    return Promise.all(metas.map(async (meta) => {
      const adapter = adapterRegistry.getAdapter(meta.id);
      const discovery = await this.discover(adapter);
      const entry = discovery ? [discovery.executable, discovery.script].filter(Boolean).join(' ') : '';
      const probe = await this.readVersion(adapter, options);
      const check = this.checks.get(adapter.id);
      // 入口问题与模型目录问题都要在同一处明说，不能只留一个
      const statusMessage = [discovery?.reason, meta.modelCatalogError].filter(Boolean).join('；') || undefined;
      const verification: CliConfigInfo['verification'] = check && check.fingerprint === this.fingerprint(adapter.id, check.model, entry)
        ? { state: check.state, checkedAt: check.checkedAt, model: check.model, message: check.message }
        : { state: 'unknown', checkedAt: null, model: null, message: null };

      return {
        id: meta.id,
        name: meta.name,
        category: 'agent' as const,
        role: 'CLI 对话',
        connectionType: meta.connectionType,
        configured: Boolean(discovery?.runnable),
        // fallback 表示「没找到但值得一试」，由探活兜住，不能直接判死；配置读取失败不算 fallback。
        available: Boolean(discovery && !discovery.configError && (discovery.runnable || discovery.source === 'fallback')),
        defaultModel: meta.defaultModel,
        supportedModels: [...meta.supportedModels],
        defaultProbePrompt: '只回复 CLI_中文对话_OK。不要调用工具，不要读写文件。',
        statusMessage,
        description: meta.description,
        discovery: discovery && {
          source: discovery.source,
          executable: discovery.executable,
          script: discovery.script ?? null,
          entry,
          runnable: discovery.runnable,
          version: probe.version,
          compatible: probe.compatible,
          reason: discovery.runnable ? null : discovery.reason ?? null,
          candidates: discovery.candidates,
          scanned: discovery.scanned,
          pathHydrated: discovery.pathHydrated,
          hydrationFailure: discovery.hydrationFailure,
          missingDependencies: discovery.missingDependencies,
        },
        verification,
        extraInfo: { executionPolicy: meta.executionPolicy, modelCatalogSource: meta.modelCatalogSource, modelCatalogError: meta.modelCatalogError },
      };
    }));
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
    if(params.verify) this.checks.set(adapter.id,{fingerprint:this.fingerprint(adapter.id,result.modelUsed,this.entryOf(adapter)),state:result.ok && result.output.trim()===marker?'passed':'failed',checkedAt:Date.now(),model:result.modelUsed,message:result.ok && result.output.trim()===marker?'marker 严格匹配':result.error || 'marker 未严格匹配'});
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

  /** 配置写入或 PATH 重探后清空，避免读到旧入口。 */
  invalidate(id?: string): void {
    if (id) this.versionCache.delete(id);
    else this.versionCache.clear();
  }

  private async discover(adapter: IAgentAdapter): Promise<(DiscoveryResult & { configError?: boolean }) | null> {
    if (!adapter.cliDeclaration) return null;
    try {
      return (await resolveDeclaredCliAsync(adapter.cliDeclaration)).discovery;
    } catch (error: any) {
      return {
        command: adapter.cliDeclaration.commands[0] ?? adapter.id,
        executable: adapter.cliDeclaration.id,
        runnable: false,
        source: 'fallback' as DiscoverySource,
        reason: `配置不可用: ${error?.message ?? String(error)}`,
        candidates: [],
        scanned: 0,
        pathHydrated: false,
        configError: true,
      };
    }
  }

  private entryOf(adapter: IAgentAdapter): string {
    if (!adapter.cliDeclaration) return '';
    try {
      const discovery = resolveDeclaredCliDiscovery(adapter.cliDeclaration);
      return [discovery.executable, discovery.script].filter(Boolean).join(' ');
    } catch {
      return '';
    }
  }

  private async readVersion(adapter: IAgentAdapter, options: ListClisOptions): Promise<VersionProbe> {
    const cached = this.versionCache.get(adapter.id);
    const now = Date.now();
    if (cached && cached.expiresAt > now && !options.forceVersion) return cached;
    if (!options.withVersion && !options.forceVersion) {
      // 不主动探版本，但保留上次结论
      return cached ?? { version: null, compatible: null, reason: null, expiresAt: 0 };
    }
    try {
      const check = await adapter.healthCheck();
      const probe: VersionProbe = {
        version: check.version ?? null,
        compatible: check.healthy,
        reason: check.healthy ? null : check.message ?? null,
        expiresAt: now + VERSION_CACHE_TTL_MS,
      };
      this.versionCache.set(adapter.id, probe);
      return probe;
    } catch (error: any) {
      const probe: VersionProbe = { version: null, compatible: false, reason: String(error?.message ?? error), expiresAt: now + VERSION_CACHE_TTL_MS };
      this.versionCache.set(adapter.id, probe);
      return probe;
    }
  }
}

export const runtimeService = new RuntimeService();
