import type {
  IAgentAdapter,
  IWorkerAdapter,
  IReviewerAdapter,
  AdapterMetaDto,
} from './types.ts';
import { WorkBuddyAdapter } from './workbuddyAdapter.ts';
import { logger } from '../utils/logger.ts';

/**
 * 适配器注册中心与工厂 (类似 Java 中的 AdapterRegistry / ServiceFactory)
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
   * 注册默认的内置适配器
   */
  private registerDefaults(): void {
    const workbuddy = new WorkBuddyAdapter();
    this.register(workbuddy);
  }

  /**
   * 注册一个适配器实例
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
        });
      }
    }
    return res;
  }
}

export const adapterRegistry = AdapterRegistry.getInstance();
