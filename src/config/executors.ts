import { WORKER_FIXED_MODEL } from './constants.ts';

export const DEFAULT_WORKER_EXECUTOR = process.env.CB_WORKER_EXECUTOR || 'workbuddy';
export const DEFAULT_WORKER_MODEL = process.env.CB_WORKER_MODEL || WORKER_FIXED_MODEL;

export const DEFAULT_REVIEWER_EXECUTOR = process.env.CB_REVIEWER_EXECUTOR || 'workbuddy';
export const DEFAULT_REVIEWER_MODEL = process.env.CB_REVIEWER_MODEL || WORKER_FIXED_MODEL;

export interface ExecutorOption {
  id: string;
  name: string;
  role: 'worker' | 'reviewer';
  defaultModel: string;
  supportedModels: string[];
}

export const KNOWN_EXECUTORS: ExecutorOption[] = [
  {
    id: 'workbuddy',
    name: 'WorkBuddy 协同执行者 (无沙箱直连)',
    role: 'worker',
    defaultModel: 'deepseek-v4-flash',
    supportedModels: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-coder'],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy 协同执行者 (无沙箱直连)',
    role: 'reviewer',
    defaultModel: 'deepseek-v4-flash',
    supportedModels: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-coder'],
  },
];
