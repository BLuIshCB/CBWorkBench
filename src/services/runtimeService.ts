import { ROOT_DIR } from '../config/constants.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import type { IWorkerAdapter, IReviewerAdapter } from '../adapters/types.ts';
import { logger } from '../utils/logger.ts';

export interface CliConfigInfo {
  id: string;
  name: string;
  category: 'worker' | 'reviewer' | 'verifier';
  role: string;
  connectionType: string;
  configured: boolean;
  available: boolean;
  defaultModel?: string;
  supportedModels?: string[];
  defaultProbePrompt: string;
  statusMessage?: string;
  description?: string;
  extraInfo?: Record<string, any>;
}

export interface CliProbeRequest {
  cliId: string;
  prompt?: string;
  model?: string;
  timeoutMs?: number;
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
}

export class RuntimeService {
  private static instance: RuntimeService;

  static getInstance(): RuntimeService {
    if (!this.instance) {
      this.instance = new RuntimeService();
    }
    return this.instance;
  }

  /**
   * 汇总从 AdapterRegistry 注册中心中获取所有已注册的 Worker / Reviewer 适配器
   * 每开发并注册一个适配器，此列表即自动增加一个对应的 Worker/Reviewer
   */
  async listConfiguredClis(): Promise<CliConfigInfo[]> {
    const adapters = await adapterRegistry.listAllAdapters();
    const list: CliConfigInfo[] = [];

    for (const a of adapters) {
      const isBoth = a.isWorker && a.isReviewer;
      const roleStr = isBoth
        ? 'Worker / Reviewer (代码开发与审查)'
        : a.isWorker
        ? 'Worker (代码开发与修复)'
        : 'Verifier / Reviewer (质量审查与验收)';

      let defaultPrompt = '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。';
      if (a.id === 'codex') {
        defaultPrompt = '只回复 CODEX_OK，不要多余字符。';
      }

      list.push({
        id: a.id,
        name: a.name,
        category: a.isWorker ? 'worker' : 'verifier',
        role: roleStr,
        connectionType: a.connectionType || '未指定',
        configured: true,
        available: Boolean(a.healthy),
        defaultModel: a.defaultModel,
        supportedModels: a.supportedModels,
        defaultProbePrompt: defaultPrompt,
        statusMessage: a.statusMessage || (a.healthy ? '就绪 / 可用' : '待配置'),
        description: a.description,
        extraInfo: {
          supportedRoles: a.supportedRoles,
        },
      });
    }

    return list;
  }

  /**
   * 对指定的适配器执行统一提示词连通性探测
   */
  async probeCli(params: CliProbeRequest): Promise<CliProbeResult> {
    const startTime = Date.now();
    const cliId = params.cliId;
    const targetCwd = params.cwd || ROOT_DIR;
    const timeoutMs = Math.min(Math.max(params.timeoutMs || 30000, 3000), 120000);
    const timestamp = new Date().toISOString();

    const adapter = adapterRegistry.getAdapter(cliId);
    if (!adapter) {
      throw new Error(`未找到 ID 为 '${cliId}' 的已注册适配器。可在 src/adapters/ 中编写并注册新适配器。`);
    }

    logger.info(`[RuntimeService] Probing Adapter '${cliId}' with prompt: "${(params.prompt || '').slice(0, 50)}..."`);

    // 1. 如果是支持 Worker 的适配器，直接调用标准的 executeDevTask
    if (adapter.supportedRoles.includes('worker') && 'executeDevTask' in adapter) {
      const workerAdapter = adapter as IWorkerAdapter;
      const model = params.model || workerAdapter.defaultModel;
      const prompt = params.prompt?.trim() || '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。';

      const execResult = await workerAdapter.executeDevTask({
        taskId: `probe-${adapter.id}-${Date.now()}`,
        roundNumber: 0,
        workerId: 'worker-probe',
        model,
        prompt,
        cwd: targetCwd,
        timeoutMs,
      });

      const verified = execResult.ok && (execResult.output.length > 0 || execResult.output.includes('OK'));
      return {
        ok: execResult.ok,
        cliId: adapter.id,
        cliName: adapter.name,
        connectionType: adapter.connectionType || 'Adapter Call',
        prompt,
        output: execResult.output || '',
        error: execResult.error,
        errorCode: execResult.metadata?.errorCode,
        durationMs: execResult.durationMs,
        modelUsed: execResult.modelUsed || model,
        backend: execResult.metadata?.backend,
        sessionId: execResult.metadata?.sessionId,
        timestamp,
        verified,
        commandPreview: `${adapter.name} [${model}] -> ${adapter.connectionType}`,
      };
    }

    // 2. 如果是 Reviewer 专用适配器 (如 CodexAdapter)
    if (adapter.supportedRoles.includes('reviewer') && 'executeReview' in adapter) {
      const reviewerAdapter = adapter as IReviewerAdapter;
      const model = params.model || reviewerAdapter.defaultModel;
      const prompt = params.prompt?.trim() || '只回复 CODEX_OK，不要多余字符。';

      // 快速通过 healthCheck 与执行审查探测
      const health = await reviewerAdapter.healthCheck();
      if (!health.healthy) {
        return {
          ok: false,
          cliId: adapter.id,
          cliName: adapter.name,
          connectionType: adapter.connectionType || 'Reviewer Sandbox',
          prompt,
          output: '',
          error: health.message || 'Reviewer health check failed',
          durationMs: Date.now() - startTime,
          modelUsed: model,
          timestamp,
          verified: false,
          commandPreview: `${adapter.name} [${model}] -> ${adapter.connectionType}`,
        };
      }

      // 如果有 mock codex 或者直接通过 review 验证
      const reviewResult = await reviewerAdapter.executeReview({
        taskId: `probe-${adapter.id}-${Date.now()}`,
        roundNumber: 0,
        revision: 1,
        model,
        confirmedCwd: targetCwd,
        taskPackageDir: targetCwd,
        testRunsSummary: 'Health probe',
        gitDiff: '',
        verifierPrompt: prompt,
        definedWorkerIds: ['worker-probe'],
        timeoutMs,
      });

      const ok = reviewResult.decision !== 'blocked';
      return {
        ok,
        cliId: adapter.id,
        cliName: adapter.name,
        connectionType: adapter.connectionType || 'Reviewer Sandbox',
        prompt,
        output: reviewResult.summary || reviewResult.rawOutput || JSON.stringify(reviewResult, null, 2),
        durationMs: reviewResult.durationMs || (Date.now() - startTime),
        modelUsed: reviewResult.modelUsed || model,
        timestamp,
        verified: ok,
        commandPreview: `${adapter.name} [${model}] -> ${adapter.connectionType}`,
      };
    }

    throw new Error(`适配器 '${cliId}' 不支持执行探测`);
  }
}

export const runtimeService = RuntimeService.getInstance();
