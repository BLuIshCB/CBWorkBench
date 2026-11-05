import type { CliErrorCode } from '../services/cliRunner.ts';

export interface AdapterExecutionPolicy {
  transport: 'cli';
  interaction: 'headless';
  promptTransport: 'stdin-utf8';
  sessionPersistence: 'disabled' | 'native';
}

export const MANDATORY_CLI_POLICY: AdapterExecutionPolicy = {
  transport: 'cli', interaction: 'headless', promptTransport: 'stdin-utf8', sessionPersistence: 'disabled',
};

/** 所有用途共用一个请求，用途与业务边界由提示词表达。 */
export type AdapterProgress = {type:'output'|'progress';text:string;stream?:'stdout'|'stderr';toolName?:string};
export interface AgentExecutionContext {
  kind?: 'worker'|'reviewer'|'probe';
  taskId?: string;
  prompt: string;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  runId?: string;
  roundId?: number;
  onEvent?: (event:AdapterProgress)=>void;
  timeoutMs?: number;
}

export interface AgentExecutionResult {
  runId?: string;
  roundId?: number;
  stopReason?: import("../services/executionService.ts").StopReason;
  cleanupConfirmed?: boolean;
  ok: boolean;
  output: string;
  error?: string;
  errorCode?: CliErrorCode;
  timedOut?: boolean;
  durationMs: number;
  modelUsed: string;
  metadata?: Record<string, any>;
}

/** 仅翻译厂商命令行参数与响应协议，不承担业务角色。 */
export interface IAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly defaultModel: string;
  /** 静态模型建议；有原生目录的适配器通过 listModels 获取完整可见列表。 */
  readonly supportedModels: readonly string[];
  readonly progressCapability?: 'raw'|'events';
  readonly connectionType: string;
  readonly executionPolicy: AdapterExecutionPolicy;
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  listModels?(): Promise<string[]>;
  execute(context: AgentExecutionContext): Promise<AgentExecutionResult>;
  abort(taskId: string): Promise<void>;
}

export interface CriterionEvaluation {
  id: string;
  name?: string;
  passed: boolean;
  evidence: string;
}

export interface ReviewIssue {
  id: string;
  criteriaId?: string;
  targetWorkerId?: string;
  description: string;
  evidence?: string;
}

// 以下属于工作流业务协议，不限制 CLI 的调用能力或权限。
export interface ReviewerExecutionContext {
  signal?: AbortSignal;
  runId?: string;
  roundId?: number;
  onEvent?: (event:AdapterProgress)=>void;
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

export interface AdapterMetaDto {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  supportedModels: string[];
  progressCapability?: 'raw'|'events';
  connectionType: string;
  executionPolicy: AdapterExecutionPolicy;
  healthy?: boolean;
  statusMessage?: string;
  modelCatalogSource?: 'cli' | 'defaults' | 'unavailable';
  modelCatalogError?: string;
}
