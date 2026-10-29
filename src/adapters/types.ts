/**
 * Agent 适配器规范定义 (类似 Java 接口规范)
 * 
 * 本模块使用 TypeScript 严格契约（等价于 Java interface）规范 Worker 和 Reviewer 模型的调用。
 * 每一个具体的模型或客户端适配器必须实现对应的接口，以便在上层工作流引擎中实现多态调度。
 */

export const ADAPTER_VERSION = '1.0.0';

/**
 * 适配器基础能力契约 (类似于 Java: public interface IAgentAdapter)
 */
export interface IAgentAdapter {
  /** 适配器全局唯一标识符，如 'workbuddy', 'mock-adapter' */
  readonly id: string;

  /** 适配器展示名称，如 'WorkBuddy 本地协同开发者' */
  readonly name: string;

  /** 适配器详细描述与说明 */
  readonly description: string;

  /** 该适配器支持的角色列表 ('worker' | 'reviewer') */
  readonly supportedRoles: readonly ('worker' | 'reviewer')[];

  /** 该适配器支持的模型标识列表 */
  readonly supportedModels: readonly string[];

  /** 该适配器的默认推荐模型 */
  readonly defaultModel: string;

  /** 适配器通信与连接方式说明（如 桌面具名管道直连、标准 HTTP API 直连、只读沙箱子进程等） */
  readonly connectionType?: string;

  /**
   * 连通性与健康检查（例如验证 CLI 工具存在、服务端口可达等）
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;

  /**
   * 中断当前任务执行（可选能力）
   */
  abort?(taskId: string): Promise<void>;
}

/**
 * Worker 开发执行上下文入参 (DTO)
 */
export interface WorkerExecutionContext {
  taskId: string;
  roundNumber: number;
  workerId: string;
  model: string;
  prompt: string;
  cwd: string;
  timeoutMs?: number;
}

/**
 * Worker 开发执行结果出参 (DTO)
 */
export interface WorkerExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
  durationMs: number;
  modelUsed: string;
  metadata?: Record<string, any>;
}

/**
 * Worker 专用开发适配器契约 (类似于 Java: public interface IWorkerAdapter extends IAgentAdapter)
 */
export interface IWorkerAdapter extends IAgentAdapter {
  /**
   * 执行业务代码开发或修复任务
   * @param context 执行上下文入参
   * @returns 执行结果输出
   */
  executeDevTask(context: WorkerExecutionContext): Promise<WorkerExecutionResult>;
}

/**
 * 细分验收准则的评判结果
 */
export interface CriterionEvaluation {
  id: string;
  name?: string;
  passed: boolean;
  evidence: string;
}

/**
 * 审查发现的具体问题条目
 */
export interface ReviewIssue {
  id: string;
  criteriaId?: string;
  targetWorkerId?: string;
  description: string;
  evidence?: string;
}

/**
 * Reviewer 验收审查上下文入参 (DTO)
 */
export interface ReviewerExecutionContext {
  timeoutMs?: number;
  taskId: string;
  roundNumber: number;
  model: string;
  revision: number;
  confirmedCwd: string;
  taskPackageDir: string;
  testRunsSummary: string;
  gitDiff?: string;
  verifierPrompt: string;
  definedWorkerIds: string[];
}

/**
 * Reviewer 验收审查结果出参 (DTO)
 */
export interface ReviewerExecutionResult {
  decision: 'passed' | 'needs_changes' | 'blocked';
  revision: number;
  summary: string;
  criteriaResults: CriterionEvaluation[];
  issues: ReviewIssue[];
  manualChecksPending: Array<{ id: string; description: string }>;
  rawOutput?: string;
  durationMs: number;
  modelUsed: string;
  metadata?: Record<string, any>;
}

/**
 * Reviewer 专用验收审查适配器契约 (类似于 Java: public interface IReviewerAdapter extends IAgentAdapter)
 */
export interface IReviewerAdapter extends IAgentAdapter {
  /**
   * 执行任务验收与质量审查（无沙箱直接执行/评审）
   * @param context 审查上下文入参
   * @returns 结构化验收决策与问题列表
   */
  executeReview(context: ReviewerExecutionContext): Promise<ReviewerExecutionResult>;
}

/**
 * 适配器元数据概览，用于前端下拉菜单展示
 */
export interface AdapterMetaDto {
  id: string;
  name: string;
  description: string;
  supportedRoles: ('worker' | 'reviewer')[];
  defaultModel: string;
  supportedModels: string[];
  connectionType?: string;
  healthy?: boolean;
  statusMessage?: string;
  isWorker?: boolean;
  isReviewer?: boolean;
}
