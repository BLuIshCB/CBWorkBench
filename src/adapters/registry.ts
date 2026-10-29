import type {
  IAgentAdapter,
  IWorkerAdapter,
  IReviewerAdapter,
  AdapterMetaDto,
} from './types.ts';
import { MANDATORY_CLI_POLICY } from './types.ts';
import { WorkBuddyAdapter } from './workbuddyAdapter.ts';
import { CodexAdapter } from './codexAdapter.ts';
import { logger } from '../utils/logger.ts';

/**
 * 适配器注册中心与工厂 (类似 Java 中的 AdapterRegistry / ServiceFactory)
 * 
 * 工作台的核心设计：每一个已配置或自开发的 Worker / Reviewer 都是此注册中心的一个 Adapter 实现。
 * 上层工作流引擎与 Web 页面完全基于 IAgentAdapter 多态调用。
 */
export class AdapterRegistry {
  private static instance: AdapterRegistry;
  private adapters: Map<string, IAgentAdapter> = new Map();

  private constructor() {
    this.registerDefaults();
  }

  static getInstance(): AdapterRegistry {
    if (!this.instance) {
      this.instance = new AdapterRegistry();
    }
    return this.instance;
  }

  /**
   * 注册默认内置适配器 (当前仅保留 WorkBuddy Direct CLI 与 Codex CLI)
   */
  private registerDefaults(): void {
    // 1. WorkBuddy 适配器 (Worker & Reviewer)
    this.register(new WorkBuddyAdapter());

    // 2. Codex 严格只读验收适配器 (Reviewer)
    this.register(new CodexAdapter());
  }

  /**
   * 注册一个适配器实例 (严格校验统一 CLI 执行策略约束)
   */
  register(adapter: IAgentAdapter): void {
    const policy = adapter.executionPolicy;
    if (
      !policy ||
      policy.transport !== MANDATORY_CLI_POLICY.transport ||
      policy.interaction !== MANDATORY_CLI_POLICY.interaction ||
      policy.promptTransport !== MANDATORY_CLI_POLICY.promptTransport ||
      policy.sessionPersistence !== MANDATORY_CLI_POLICY.sessionPersistence
    ) {
      throw new Error(
        `适配器 '${adapter.id}' 未遵守统一 CLI 执行策略 (必须声明 transport: cli, interaction: headless, promptTransport: stdin-utf8, sessionPersistence: disabled)，拒绝注册。`
      );
    }

    this.adapters.set(adapter.id, adapter);
    logger.info(`[AdapterRegistry] Registered adapter: ${adapter.id} (${adapter.name})`);
  }

  /**
   * 获取指定 ID 的通用适配器
   */
  getAdapter(id: string): IAgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * 获取全部已注册适配器实例
   */
  getAllAdapters(): IAgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * 获取 Worker 开发适配器 (显式指定 ID 失败时直接报错，未指定时默认使用 workbuddy)
   */
  getWorkerAdapter(id?: string): IWorkerAdapter {
    if (id) {
      const adapter = this.adapters.get(id);
      if (adapter && adapter.supportedRoles.includes('worker') && 'executeDevTask' in adapter) {
        return adapter as IWorkerAdapter;
      }
      throw new Error(`未找到指定的 Worker 适配器或该适配器不支持 worker 角色: id='${id}'`);
    }

    const defaultAdapter = this.adapters.get('workbuddy');
    if (defaultAdapter && defaultAdapter.supportedRoles.includes('worker') && 'executeDevTask' in defaultAdapter) {
      return defaultAdapter as IWorkerAdapter;
    }

    throw new Error("默认 Worker 适配器 'workbuddy' 未注册或不可用");
  }

  /**
   * 获取 Reviewer 审查适配器 (显式指定 ID 失败时直接报错，未指定时默认使用 workbuddy)
   */
  getReviewerAdapter(id?: string): IReviewerAdapter {
    if (id) {
      const adapter = this.adapters.get(id);
      if (adapter && adapter.supportedRoles.includes('reviewer') && 'executeReview' in adapter) {
        return adapter as IReviewerAdapter;
      }
      throw new Error(`未找到指定的 Reviewer 适配器或该适配器不支持 reviewer 角色: id='${id}'`);
    }

    const defaultAdapter = this.adapters.get('workbuddy');
    if (defaultAdapter && defaultAdapter.supportedRoles.includes('reviewer') && 'executeReview' in defaultAdapter) {
      return defaultAdapter as IReviewerAdapter;
    }

    throw new Error("默认 Reviewer 适配器 'workbuddy' 未注册或不可用");
  }

  /**
   * 异步获取所有已注册适配器的完整清单及实时健康诊断
   */
  async listAllAdapters(): Promise<AdapterMetaDto[]> {
    const res: AdapterMetaDto[] = [];
    for (const a of this.adapters.values()) {
      let healthy = false;
      let statusMessage = '';
      try {
        const check = await a.healthCheck();
        healthy = check.healthy;
        statusMessage = check.message || (healthy ? '就绪 / 可用' : '检查未通过');
      } catch (err: any) {
        healthy = false;
        statusMessage = err.message || '健康检查异常';
      }

      res.push({
        id: a.id,
        name: a.name,
        description: a.description,
        supportedRoles: [...a.supportedRoles],
        defaultModel: a.defaultModel,
        supportedModels: [...a.supportedModels],
        connectionType: a.connectionType || 'Direct CLI 子进程',
        executionPolicy: a.executionPolicy,
        healthy,
        statusMessage,
        isWorker: a.supportedRoles.includes('worker'),
        isReviewer: a.supportedRoles.includes('reviewer'),
      });
    }
    return res;
  }

  /**
   * 获取所有可用 Worker 适配器元信息列表
   */
  listWorkers(): AdapterMetaDto[] {
    const res: AdapterMetaDto[] = [];
    for (const a of this.adapters.values()) {
      if (a.supportedRoles.includes('worker')) {
        res.push({
          id: a.id,
          name: a.name,
          description: a.description,
          supportedRoles: [...a.supportedRoles],
          defaultModel: a.defaultModel,
          supportedModels: [...a.supportedModels],
          connectionType: a.connectionType,
          executionPolicy: a.executionPolicy,
          isWorker: true,
          isReviewer: a.supportedRoles.includes('reviewer'),
        });
      }
    }
    return res;
  }

  /**
   * 获取所有可用 Reviewer 适配器元信息列表
   */
  listReviewers(): AdapterMetaDto[] {
    const res: AdapterMetaDto[] = [];
    for (const a of this.adapters.values()) {
      if (a.supportedRoles.includes('reviewer')) {
        res.push({
          id: a.id,
          name: a.name,
          description: a.description,
          supportedRoles: [...a.supportedRoles],
          defaultModel: a.defaultModel,
          supportedModels: [...a.supportedModels],
          connectionType: a.connectionType,
          executionPolicy: a.executionPolicy,
          isWorker: a.supportedRoles.includes('worker'),
          isReviewer: true,
        });
      }
    }
    return res;
  }
}

export const adapterRegistry = AdapterRegistry.getInstance();
