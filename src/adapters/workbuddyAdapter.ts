import { z } from 'zod';
import path from 'node:path';
import type {
  IWorkerAdapter, IReviewerAdapter, WorkerExecutionContext, WorkerExecutionResult,
  ReviewerExecutionContext, ReviewerExecutionResult,
} from './types.ts';
import { WorkBuddyClient } from '../services/workbuddyClient.ts';
import { WORKER_FIXED_MODEL, DEFAULT_VERIFIER_TIMEOUT_MS } from '../config/constants.ts';

const nonEmpty = z.string().trim().min(1);
const reviewSchema = z.object({
  decision: z.enum(['passed', 'needs_changes', 'blocked']),
  revision: z.number().int().positive().optional(),
  summary: nonEmpty,
  criteriaResults: z.array(z.object({ id: nonEmpty, name: z.string().optional(), passed: z.boolean(), evidence: nonEmpty })),
  issues: z.array(z.object({ id: nonEmpty, criteriaId: nonEmpty.optional(), targetWorkerId: nonEmpty.optional(), description: nonEmpty, evidence: z.string().optional() })),
  manualChecksPending: z.array(z.object({ id: nonEmpty, description: nonEmpty })),
});

/** 将 Worker 和 Reviewer 上下文转换成 WorkBuddy 调用，失败时保留真实执行结果。 */
export class WorkBuddyAdapter implements IWorkerAdapter, IReviewerAdapter {
  readonly id = 'workbuddy';
  readonly name = 'WorkBuddy 协同执行者';
  readonly description = '通过 WorkBuddy Desktop Bridge 或 CLI MCP 执行开发与验收。';
  readonly supportedRoles = ['worker', 'reviewer'] as const;
  readonly supportedModels = ['deepseek-v4-flash'] as const;
  readonly defaultModel = WORKER_FIXED_MODEL;

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return WorkBuddyClient.healthCheck();
  }

  async abort(taskId: string): Promise<void> {
    WorkBuddyClient.requestStop(taskId);
  }

  async executeDevTask(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    const startTime = Date.now();
    const modelUsed = context.model || this.defaultModel;
    const result = await WorkBuddyClient.runTask({
      taskId: context.taskId, prompt: context.prompt, cwd: context.cwd,
      model: modelUsed, timeoutMs: context.timeoutMs,
    });
    return {
      ok: result.ok, output: result.output, error: result.error, timedOut: result.timedOut,
      durationMs: Date.now() - startTime, modelUsed,
      metadata: { workerId: context.workerId, cwd: context.cwd, backend: result.backend, sessionId: result.sessionId, errorCode: result.errorCode },
    };
  }

  async executeReview(context: ReviewerExecutionContext): Promise<ReviewerExecutionResult> {
    const startTime = Date.now();
    const modelUsed = context.model || this.defaultModel;
    // Mock 仅由 WorkBuddy 自己的显式开关控制，不能受其他验收器开关影响。
    if (process.env.CB_MOCK_WORKBUDDY === 'true') {
      return {
        decision: 'passed', revision: context.revision, summary: 'Mock acceptance passed.',
        criteriaResults: [{ id: 'MOCK-1', passed: true, evidence: 'Explicit CB_MOCK_WORKBUDDY test fixture.' }],
        issues: [], manualChecksPending: [], rawOutput: '[MOCK REVIEW RESULT]', durationMs: 0, modelUsed,
      };
    }
    const result = await WorkBuddyClient.runTask({
      taskId: context.taskId, prompt: this.buildReviewPrompt(context), cwd: context.confirmedCwd,
      model: modelUsed, timeoutMs: context.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS,
    });
    const metadata = { backend: result.backend, sessionId: result.sessionId, errorCode: result.errorCode };
    const base = { revision: context.revision, rawOutput: result.output, durationMs: Date.now() - startTime, modelUsed, metadata };
    if (!result.ok) return {
      ...base, decision: 'blocked', summary: `Reviewer execution failed: ${result.error || 'Unknown error'}`,
      criteriaResults: [], issues: [{ id: 'ISSUE-REV-ERR', description: result.error || 'WorkBuddy execution error' }], manualChecksPending: [],
    };
    try {
      // 只接受最终结构化判定，普通文字中的“通过”不能成为放行依据。
      const blocks = [...result.output.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
      const text = blocks.length ? blocks[blocks.length - 1][1] : result.output.trim();
      const parsed = reviewSchema.parse(JSON.parse(text));
      if (parsed.revision !== undefined && parsed.revision !== context.revision) throw new Error('Reviewer returned a different revision.');
      if (parsed.issues.some(issue => issue.targetWorkerId && !context.definedWorkerIds.includes(issue.targetWorkerId))) throw new Error('Reviewer returned an unknown worker ID.');
      if (new Set(parsed.criteriaResults.map(c => c.id)).size !== parsed.criteriaResults.length) throw new Error('Reviewer returned duplicate criterion IDs.');
      if (parsed.decision === 'passed' && (!parsed.criteriaResults.length || parsed.criteriaResults.some(c => !c.passed) || parsed.issues.length)) throw new Error('Passed verdict contradicts acceptance evidence.');
      return { ...parsed, ...base };
    } catch (error: any) {
      return {
        ...base, decision: 'blocked', summary: 'Reviewer returned an invalid acceptance result.',
        criteriaResults: [], issues: [{ id: 'ISSUE-REV-FORMAT', description: error.message }], manualChecksPending: [],
      };
    }
  }

  private buildReviewPrompt(context: ReviewerExecutionContext): string {
    return [
      context.verifierPrompt || 'You are the quality reviewer and verifier.',
      'Perform independent acceptance. Do not modify project files or fabricate evidence.',
      `Task ID: ${context.taskId}; revision: ${context.revision}; round: ${context.roundNumber}`,
      `Working directory: ${context.confirmedCwd}`,
      `Task package directory: ${context.taskPackageDir}`,
      `Read the task and acceptance requirements from ${path.join(context.taskPackageDir, 'task.md')} and ${path.join(context.taskPackageDir, 'acceptance.md')}.`,
      'If requirements or evidence are unavailable, return blocked with a concrete reason.',
      `Defined Worker IDs: ${context.definedWorkerIds.join(', ')}`,
      'Independent automated test results:', context.testRunsSummary || 'No test runs available.',
      context.gitDiff ? `Git diff snapshot:\n\`\`\`diff\n${context.gitDiff}\n\`\`\`` : '',
      'The following workbench output contract takes precedence over output-format examples above or in task files. Preserve all business acceptance criteria.',
      `Workbench revision is the number ${context.revision}. It is distinct from task-document labels such as r04. If returning a revision field, use exactly ${context.revision} as a JSON number; never copy a task-document revision label.`,
      'Return a final JSON code block using this structure:',
      `{"decision":"passed|needs_changes|blocked","revision":${context.revision},"summary":"verdict","criteriaResults":[{"id":"criterion-id","passed":true,"evidence":"file:line or executed check"}],"issues":[],"manualChecksPending":[]}`,
      'Use one allowed decision value. Evaluate every acceptance criterion. A passed verdict requires nonempty successful criteria and no issues.',
      'For issues use {"id":"issue-id","targetWorkerId":"defined Worker ID","description":"problem","evidence":"file:line"}.',
      'For pending manual checks use {"id":"check-id","description":"required human verification"}.',
    ].join('\n\n');
  }
}
