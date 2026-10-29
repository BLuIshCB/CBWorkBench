import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_PORT = Number(process.env.CB_PORT) || 3721;
export const DEFAULT_HOST = process.env.CB_HOST || '127.0.0.1';

export const WORKER_FIXED_MODEL = 'deepseek-v4-flash';
export const VERIFIER_DEFAULT_MODEL = process.env.CB_VERIFIER_MODEL || 'gpt-5.6-sol';

export const DEFAULT_BUDGET_MAX_ROUNDS = 10;
export const DEFAULT_BUDGET_TIMEOUT_SECONDS = Number(process.env.CB_BUDGET_TIMEOUT_SECONDS) || 3600; // 60 minutes
export const DEFAULT_WORKER_TIMEOUT_MS = Number(process.env.CB_WORKER_TIMEOUT_MS) || 1800000; // 30 minutes
export const DEFAULT_VERIFIER_TIMEOUT_MS = Number(process.env.CB_VERIFIER_TIMEOUT_MS) || 600000; // 10 minutes
export const DEFAULT_TEST_TIMEOUT_MS = Number(process.env.CB_TEST_TIMEOUT_MS) || 180000; // 3 minutes

export const ROOT_DIR = path.resolve(__dirname, '../../');
export const DATA_DIR = path.resolve(process.env.CB_DATA_DIR || path.join(ROOT_DIR, 'data'));
export const TASKS_DATA_DIR = path.join(DATA_DIR, 'tasks');
export const DB_PATH = path.join(DATA_DIR, 'workbench.db');

export const TaskStatus = {
  PENDING_CONFIRM: 'pending_confirm', // 待启动确认 (Gate 2)
  QUEUED: 'queued',                   // 排队中
  RUNNING: 'running',                 // 执行中 (Worker / Tests / Codex loop)
  BLOCKED: 'blocked',                 // 异常待处理 (Budget exceeded, prerequisite missing)
  HUMAN_REVIEW: 'human_review',       // 最终人工审核 (Gate 3, Codex passed)
  COMPLETED: 'completed',             // 已完成 (Human approved)
  CANCELLED: 'cancelled',             // 已停止/取消
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const RoundStage = {
  WORKER_DEV: 'worker_dev',           // WorkBuddy Worker 执行开发或修复
  WORKER_REVIEW: 'worker_review',     // Worker 审查与测试准备
  RUNNING_TESTS: 'running_tests',     // 工作台独立运行必需测试
  CODEX_ACCEPTANCE: 'codex_acceptance', // Codex CLI 自动验收
  HUMAN_REVIEW: 'human_review',       // 人工审核门禁
} as const;
export type RoundStage = (typeof RoundStage)[keyof typeof RoundStage];
