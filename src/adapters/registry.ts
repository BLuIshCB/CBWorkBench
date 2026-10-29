import type {
  IAgentAdapter,
  IWorkerAdapter,
  IReviewerAdapter,
  AdapterMetaDto,
} from './types.ts';
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
   * 注册默认内置适配器 (当前仅保留 WorkBuddy CLI 与 Codex CLI)
   */
  private registerDefaults(): void {
    // 1. WorkBuddy 适配器 (Worker & Reviewer)
    this.register(new WorkBuddyAdapter());

    // 2. Codex 严格只读验收适配器 (Reviewer)
    this.register(new CodexAdapter());
  }

  /**
   * 注册一个适配器实例 (支持动态扩展与热插拔)
   */
  register(adapter: IAgentAdapter): void {
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
   * 获取 Worker 开发适配器 (如果未指定或找不到，回退到默认 workbuddy)
   */
  getWorkerAdapter(id?: string): IWorkerAdapter {
    const targetId = id || 'workbuddy';
    const adapter = this.adapters.get(targetId);

    if (adapter && adapter.supportedRoles.includes('worker') && 'executeDevTask' in adapter) {
      return adapter as IWorkerAdapter;
    }

    // 回退到 workbuddy
    const fallback = this.adapters.get('workbuddy');
    if (fallback && 'executeDevTask' in fallback) {
      return fallback as IWorkerAdapter;
    }

    throw new Error(`No available Worker adapter found for id='${targetId}'`);
  }

  /**
   * 获取 Reviewer 审查适配器 (如果未指定或找不到，回退到默认 workbuddy)
   */
  getReviewerAdapter(id?: string): IReviewerAdapter {
    const targetId = id || 'workbuddy';
    const adapter = this.adapters.get(targetId);

    if (adapter && adapter.supportedRoles.includes('reviewer') && 'executeReview' in adapter) {
      return adapter as IReviewerAdapter;
    }

    // 回退到 workbuddy
    const fallback = this.adapters.get('workbuddy');
    if (fallback && 'executeReview' in fallback) {
      return fallback as IReviewerAdapter;
    }

    throw new Error(`No available Reviewer adapter found for id='${targetId}'`);
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
        connectionType: a.connectionType || '未指定连接协议',
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
          defaultModel: a.defaultModel,
          supportedModels: [...a.supportedModels],
          connectionType: a.connectionType,
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
          defaultModel: a.defaultModel,
          supportedModels: [...a.supportedModels],
          connectionType: a.connectionType,
          isWorker: a.supportedRoles.includes('worker'),
          isReviewer: true,
        });
      }
    }
    return res;
  }
}

export const adapterRegistry = AdapterRegistry.getInstance();
