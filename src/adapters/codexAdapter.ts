import type {
  IReviewerAdapter,
  ReviewerExecutionContext,
  ReviewerExecutionResult,
  AdapterExecutionPolicy,
} from './types.ts';
import { MANDATORY_CLI_POLICY } from './types.ts';
import { CodexVerifier } from '../services/codexVerifier.ts';
import { resolveCodexCliConfig } from '../services/workbuddyConfig.ts';
import { CliRunner } from '../services/cliRunner.ts';
import { VERIFIER_DEFAULT_MODEL, DEFAULT_VERIFIER_TIMEOUT_MS, ROOT_DIR } from '../config/constants.ts';

/**
 * Codex 自动验收适配器
 * 基于 OpenAI Codex CLI 严格只读沙箱与 --ephemeral 执行项目代码变更验收与审查。
 */
export class CodexAdapter implements IReviewerAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI 验收者 (只读沙箱)';
  readonly description = '基于 OpenAI Codex CLI 执行 -s read-only 与 --ephemeral 只读沙箱自动化验收。';
  readonly supportedRoles = ['reviewer'] as const;
  readonly defaultModel = VERIFIER_DEFAULT_MODEL;
  readonly supportedModels = [VERIFIER_DEFAULT_MODEL, 'gpt-5-turbo', 'o3-mini', 'o1'] as const;
  readonly connectionType = '只读沙箱子进程 (codex exec -s read-only --ephemeral)';
  readonly executionPolicy: AdapterExecutionPolicy = MANDATORY_CLI_POLICY;

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      const config = resolveCodexCliConfig();
      const args = [...(config.script ? [config.script] : []), '--version'];

      const runRes = await CliRunner.run({
        runId: `codex-health-${Date.now()}`,
        executable: config.executable,
        args,
        cwd: ROOT_DIR,
        timeoutMs: 5000,
        env: config.env,
      });

      if (runRes.exitCode === 0 && runRes.stdout.trim()) {
        return { healthy: true, message: `已检测到 ${runRes.stdout.trim()} (Direct CLI ephemeral)` };
      }

      return {
        healthy: false,
        message: runRes.error || runRes.stderr || 'Codex CLI 探测失败',
      };
    } catch (err: any) {
      return { healthy: false, message: `Codex CLI 不可用: ${err.message}` };
    }
  }

  async abort(taskId: string): Promise<void> {
    await CliRunner.abort(taskId);
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
      gitDiff: context.gitDiff || '',
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
      metadata: {
        executionPolicy: this.executionPolicy,
      },
    };
  }
}
