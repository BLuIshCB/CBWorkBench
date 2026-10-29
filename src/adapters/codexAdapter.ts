import { execFile } from 'node:child_process';
import type { IReviewerAdapter, ReviewerExecutionContext, ReviewerExecutionResult } from './types.ts';
import { CodexVerifier } from '../services/codexVerifier.ts';
import { VERIFIER_DEFAULT_MODEL, DEFAULT_VERIFIER_TIMEOUT_MS } from '../config/constants.ts';

/**
 * Codex 自动验收适配器
 * 基于 OpenAI Codex CLI 严格只读沙箱执行项目代码变更验收与审查。
 */
export class CodexAdapter implements IReviewerAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI 验收者 (只读沙箱)';
  readonly description = '基于 OpenAI Codex CLI 执行 -s read-only 只读沙箱自动化验收。';
  readonly supportedRoles = ['reviewer'] as const;
  readonly defaultModel = VERIFIER_DEFAULT_MODEL;
  readonly supportedModels = [VERIFIER_DEFAULT_MODEL, 'gpt-5-turbo', 'o3-mini', 'o1'] as const;
  readonly connectionType = '只读沙箱子进程 (codex exec -s read-only)';

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const bin = CodexVerifier.resolveCodexExecutable();
    return new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 3000, windowsHide: true, shell: true }, (err, stdout) => {
        if (err) {
          resolve({ healthy: false, message: `Codex CLI 不可用: ${err.message}` });
        } else {
          resolve({ healthy: true, message: `已检测到 ${stdout.trim()}` });
        }
      });
    });
  }

  async executeReview(context: ReviewerExecutionContext): Promise<ReviewerExecutionResult> {
    const startTime = Date.now();
    const modelUsed = context.model || this.defaultModel;
    const res = await CodexVerifier.verify({
      taskId: context.taskId,
      revision: context.revision,
      confirmedCwd: context.confirmedCwd,
      taskPackageDir: context.taskPackageDir,
      testRunsSummary: context.testRunsSummary,
      gitDiff: context.gitDiff,
      verifierPrompt: context.verifierPrompt,
      definedWorkerIds: context.definedWorkerIds,
      model: modelUsed,
      timeoutMs: context.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS,
    });
    return {
      decision: res.decision,
      revision: res.revision,
      summary: res.summary,
      criteriaResults: res.criteriaResults,
      issues: res.issues,
      manualChecksPending: res.manualChecksPending,
      rawOutput: res.rawOutput,
      durationMs: Date.now() - startTime,
      modelUsed,
    };
  }
}
