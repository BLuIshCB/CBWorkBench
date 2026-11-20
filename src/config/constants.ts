import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveDataDirConfig,
  parseCliRuntimeArgs,
  type InstanceMetadata,
} from './dataDir.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLI_RUNTIME_ARGS = parseCliRuntimeArgs();
export const DEFAULT_PORT = Number(CLI_RUNTIME_ARGS.port || process.env.CB_PORT) || 3721;
export const DEFAULT_HOST = CLI_RUNTIME_ARGS.host || process.env.CB_HOST || '127.0.0.1';

export const WORKER_FIXED_MODEL = 'deepseek-v4-flash';
export const VERIFIER_DEFAULT_MODEL = 'default';

export const DEFAULT_EXECUTION_TIMEOUT_MS = 3600000;
export const INTERNAL_SILENCE_WARNING_MS = 300000;
export const DEFAULT_BUDGET_MAX_ROUNDS = 10;

function resolveRootDir(): string {
  if (process.env.CB_ROOT_DIR) return path.resolve(process.env.CB_ROOT_DIR);
  if (fs.existsSync(path.join(process.cwd(), 'src')) || fs.existsSync(path.join(process.cwd(), 'data'))) {
    return process.cwd();
  }
  if (typeof __dirname !== 'undefined') {
    if (fs.existsSync(path.join(__dirname, 'src')) || fs.existsSync(path.join(__dirname, 'data'))) {
      return __dirname;
    }
    const upTwo = path.resolve(__dirname, '../../');
    if (fs.existsSync(path.join(upTwo, 'src')) || fs.existsSync(path.join(upTwo, 'data'))) {
      return upTwo;
    }
  }
  return process.cwd();
}

export const ROOT_DIR = resolveRootDir();
const resolvedData = resolveDataDirConfig({ rootDir: ROOT_DIR });
export const DATA_DIR = resolvedData.dataDir;
export const DATA_DIR_SOURCE = resolvedData.source;
export const INSTANCE_META: InstanceMetadata = resolvedData.instance;
export const INSTANCE_ID = resolvedData.instance.instance_id;
export const LEGACY_DATA_PATH = resolvedData.legacyDataPath;

export const TASKS_DATA_DIR = path.join(DATA_DIR, 'tasks');
export const MAINTENANCE_DELETIONS_DIR = path.join(DATA_DIR, 'maintenance', 'deletions');
export const DB_PATH = path.join(DATA_DIR, 'workbench.db');

export const TaskStatus = {
  PENDING_CONFIRM: 'pending_confirm', // 待启动确认 (Gate 2)
  QUEUED: 'queued',                   // 排队中
  RUNNING: 'running',                 // 执行中
  BLOCKED: 'blocked',                 // 异常待处理
  HUMAN_REVIEW: 'human_review',       // 人工处理节点等待确认
  COMPLETED: 'completed',             // 已完成
  CANCELLED: 'cancelled',             // 已停止/取消
  DELETING: 'deleting',               // 正在清理删除中
  CLEANUP_FAILED: 'cleanup_failed',   // 清理失败待重试
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const RoundStage = {
  WORKER_DEV: 'worker_dev',
  RUNNING_TESTS: 'running_tests',
  CODEX_ACCEPTANCE: 'codex_acceptance',
  HUMAN_REVIEW: 'human_review',
} as const;
export type RoundStage = (typeof RoundStage)[keyof typeof RoundStage];
