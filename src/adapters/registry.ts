import type { IAgentAdapter, AdapterMetaDto } from './types.ts';
import { WorkBuddyAdapter } from './workbuddyAdapter.ts';
import { CodexAdapter } from './codexAdapter.ts';
import { AntigravityAdapter } from './antigravityAdapter.ts';

export class AdapterRegistry {
  private adapters = new Map<string, IAgentAdapter>();

  constructor() {
    this.register(new WorkBuddyAdapter());
    this.register(new CodexAdapter());
    this.register(new AntigravityAdapter());
  }

  register(adapter: IAgentAdapter): void {
    const policy = adapter.executionPolicy;
    if (policy?.transport !== 'cli' || policy.interaction !== 'headless' || policy.promptTransport !== 'stdin-utf8') {
      throw new Error(`适配器 '${adapter.id}' 未遵守统一 CLI 执行策略。`);
    }
    if (this.adapters.has(adapter.id)) throw new Error(`适配器重复注册: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): IAgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`未找到指定的 CLI 适配器: '${id}'`);
    return adapter;
  }

  getAllAdapters(): IAgentAdapter[] { return [...this.adapters.values()]; }

  listAdapters(): AdapterMetaDto[] {
    return this.getAllAdapters().map(a => ({
      id: a.id, name: a.name, description: a.description, defaultModel: a.defaultModel,
      progressCapability:a.progressCapability, supportedModels: [...a.supportedModels], connectionType: a.connectionType, executionPolicy: a.executionPolicy,
    }));
  }

  async listAllAdapters(): Promise<AdapterMetaDto[]> {
    return Promise.all((await this.listModelAdapters()).map(async meta => {
      try {
        const check = await this.getAdapter(meta.id).healthCheck();
        return { ...meta, healthy: check.healthy, statusMessage: [check.message, meta.modelCatalogError].filter(Boolean).join('；') };
      } catch (error) {
        return { ...meta, healthy: false, statusMessage: String(error) };
      }
    }));
  }

  /** 模型元信息用于所有选择入口；目录失败时保留手动输入并明确说明。 */
  async listModelAdapters(): Promise<AdapterMetaDto[]> {
    return Promise.all(this.listAdapters().map(async meta => {
      const adapter = this.getAdapter(meta.id);
      if (!adapter.listModels) return { ...meta, modelCatalogSource: 'defaults' as const };
      try {
        return { ...meta, supportedModels: await adapter.listModels(), modelCatalogSource: 'cli' as const };
      } catch (error) {
        return { ...meta, supportedModels: [], modelCatalogSource: 'unavailable' as const,
          modelCatalogError: `模型目录不可用，可手动输入模型：${String(error)}` };
      }
    }));
  }
}

export const adapterRegistry = new AdapterRegistry();
