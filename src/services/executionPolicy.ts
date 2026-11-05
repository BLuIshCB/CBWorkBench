import { z } from 'zod';

import { DEFAULT_EXECUTION_TIMEOUT_MS } from '../config/constants.ts';
export { DEFAULT_EXECUTION_TIMEOUT_MS, INTERNAL_SILENCE_WARNING_MS } from '../config/constants.ts';
export const executionTimeoutSchema = z.number().int().safe().min(60000).max(86400000).multipleOf(60000);

export const confirmStartSchema=z.object({confirmed_cwd:z.string().optional(),worker_executor:z.string().optional(),worker_model:z.string().optional(),reviewer_executor:z.string().optional(),reviewer_model:z.string().optional(),execution_timeout_ms:executionTimeoutSchema.optional()});

/** 统一值只在确认时解析；运行中的进程不再读取环境配置。 */
export function resolveExecutionTimeout(explicit?: number, saved?: number | null, manifest?: any): number {
  const policy = manifest?.executionPolicy;
  if(explicit===undefined && saved==null && policy?.executionTimeoutMs!==undefined) return executionTimeoutSchema.parse(policy.executionTimeoutMs);
  if (explicit !== undefined) return executionTimeoutSchema.parse(explicit);
  if (saved != null) return executionTimeoutSchema.parse(saved);
  for (const value of [policy?.executionTimeoutMs, policy?.timeoutMs, process.env.CB_EXECUTION_TIMEOUT_MS ? Number(process.env.CB_EXECUTION_TIMEOUT_MS) : undefined]) {
    if (value === undefined) continue;
    const parsed = executionTimeoutSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    console.warn('[ExecutionPolicy] 忽略不合法的统一执行时限。');
  }
  return DEFAULT_EXECUTION_TIMEOUT_MS;
}
