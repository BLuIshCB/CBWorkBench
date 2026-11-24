import { z } from 'zod';
import path from 'node:path';
import type { IAgentAdapter, ReviewerExecutionContext, ReviewerExecutionResult } from '../adapters/types.ts';
import { DEFAULT_EXECUTION_TIMEOUT_MS } from '../config/constants.ts';

const nonEmpty = z.string().trim().min(1);
const reviewSchema = z.object({
  decision: z.enum(['passed', 'needs_changes', 'blocked']),
  revision: z.number().int().positive().optional(),
  summary: nonEmpty,
  criteriaResults: z.array(
    z.object({ id: nonEmpty, name: z.string().optional(), passed: z.boolean(), evidence: nonEmpty })
  ),
  issues: z.array(
    z.object({
      id: nonEmpty,
      criteriaId: nonEmpty.optional(),
      targetWorkerId: nonEmpty.optional(),
      description: nonEmpty,
      evidence: z.string().optional(),
    })
  ),
  manualChecksPending: z.array(z.object({ id: nonEmpty, description: nonEmpty })),
});

export function parseReviewEvidence(raw: unknown, revision: number, nodeIds: string[]) {
  const parsed = reviewSchema.parse(raw);
  if (parsed.revision !== undefined && parsed.revision !== revision) {
    throw new Error('Reviewer returned a different revision.');
  }
  if (nodeIds.length && parsed.issues.some(issue => issue.targetWorkerId && !nodeIds.includes(issue.targetWorkerId))) {
    throw new Error('Reviewer returned an unknown node ID.');
  }
  if (new Set(parsed.criteriaResults.map(criterion => criterion.id)).size !== parsed.criteriaResults.length) {
    throw new Error('Reviewer returned duplicate criterion IDs.');
  }
  if (parsed.decision === 'passed' &&
      (!parsed.criteriaResults.length || parsed.criteriaResults.some(criterion => !criterion.passed) || parsed.issues.length)) {
    throw new Error('Passed verdict contradicts acceptance evidence.');
  }
  return { ...parsed, revision };
}

export const reviewEvidenceExample = '{"decision":"passed|needs_changes|blocked","revision":1,"summary":"verdict","criteriaResults":[{"id":"criterion-id","passed":true,"evidence":"file:line or executed check"}],"issues":[{"id":"issue-id","description":"problem","evidence":"file:line"}],"manualChecksPending":[{"id":"check-id","description":"required human verification"}]}';

/** 将结构化验收输出解析与契约校验从厂商 Adapter 中独立出来。 */
export class AcceptanceService {
  async execute(adapter: IAgentAdapter, context: ReviewerExecutionContext): Promise<ReviewerExecutionResult> {
    const startTime = Date.now();
    const modelUsed = context.model || adapter.defaultModel;

    // Mock 仅由当前厂商的显式开关控制，不能受其他验收器开关影响。
    if (
      (adapter.id === 'workbuddy' && process.env.CB_MOCK_WORKBUDDY === 'true') ||
      (adapter.id === 'codex' && process.env.CB_MOCK_CODEX === 'true')
    ) {
      return {
        decision: 'passed',
        revision: context.revision,
        summary: 'Mock acceptance passed.',
        criteriaResults: [{ id: 'MOCK-1', passed: true, evidence: 'Explicit mock test fixture.' }],
        issues: [],
        manualChecksPending: [],
        rawOutput: '[MOCK REVIEW RESULT]',
        durationMs: 0,
        modelUsed,
      };
    }

    const result = await adapter.execute({
      kind: 'reviewer',
      runId: context.runId,
      roundId: context.roundId,
      onEvent: context.onEvent,
      taskId: context.taskId,
      prompt: this.buildReviewPrompt(context),
      cwd: context.confirmedCwd,
      model: modelUsed,
      signal: context.signal,
      timeoutMs: context.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });

    const metadata = {
      backend: result.metadata?.backend || 'direct-cli',
      sessionId: result.metadata?.sessionId,
      errorCode: result.errorCode,
      executionPolicy: adapter.executionPolicy,
    };
    const base = {
      revision: context.revision,
      rawOutput: result.output,
      durationMs: result.durationMs || Date.now() - startTime,
      modelUsed,
      metadata,
    };

    if (!result.ok) {
      return {
        ...base,
        decision: 'blocked',
        summary: `Reviewer execution failed: ${result.error || 'Unknown error'}`,
        criteriaResults: [],
        issues: [{ id: 'ISSUE-REV-ERR', description: result.error || 'CLI execution error' }],
        manualChecksPending: [],
      };
    }

    try {
      const blocks = [...result.output.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
      const text = blocks.length ? blocks[blocks.length - 1][1] : result.output.trim();
      let parsedJson: any;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        const s = text.indexOf('{');
        const e = text.lastIndexOf('}');
        if (s !== -1 && e !== -1 && e > s) {
          parsedJson = JSON.parse(text.slice(s, e + 1));
        } else {
          throw new Error('未找到有效的 JSON 判定内容');
        }
      }
      const parsed = parseReviewEvidence(parsedJson, context.revision, context.definedNodeIds || []);
      return { ...parsed, ...base };
    } catch (error: any) {
      return {
        ...base,
        decision: 'blocked',
        summary: 'Reviewer returned an invalid acceptance result.',
        criteriaResults: [],
        issues: [{ id: 'ISSUE-REV-FORMAT', description: error.message }],
        manualChecksPending: [],
      };
    }
  }

  private buildReviewPrompt(context: ReviewerExecutionContext): string {
    return [
      context.nodePrompt || 'Perform strict read-only acceptance verification based on node materials and evidence.',
      'Perform independent verification. Do not modify project files or fabricate evidence.',
      `Task ID: ${context.taskId}; Node ID: ${context.nodeId}; Attempt ID: ${context.attemptId}; Revision: ${context.revision}; Round: ${context.roundNumber}`,
      `Working Directory: ${context.confirmedCwd}`,
      `Isolated Node Attempt Directory: ${context.attemptDir}`,
      `Read your isolated node context and materials strictly inside ${context.attemptDir}:
- ${path.join(context.attemptDir, 'context.json')}
- ${path.join(context.attemptDir, 'material', 'node.md')}
- ${path.join(context.attemptDir, 'material', 'prompt.md')}
- Node resources: ${(context.materialFiles || []).join(', ') || '(none)'}
- Shared resources: ${(context.sharedFiles || []).join(', ') || '(none)'}`,
      'If required materials or upstream evidence are unavailable, return blocked with a concrete reason.',
      context.boundInputsSummary ? `Bound Upstream Inputs:\n${context.boundInputsSummary}` : '',
      context.testRunsSummary ? `Test Agent Submitted Evidence:\n${context.testRunsSummary}` : '',
      context.gitDiff ? `Git Diff Snapshot:\n\`\`\`diff\n${context.gitDiff}\n\`\`\`` : '',
      'The following workbench output contract takes precedence over output-format examples above. Preserve all business acceptance criteria.',
      `Workbench revision is the number ${context.revision}. If returning a revision field, use exactly ${context.revision} as a JSON number.`,
      'Return a final JSON code block using this structure:',
      `{"decision":"passed|needs_changes|blocked","revision":${context.revision},"summary":"verdict","criteriaResults":[{"id":"criterion-id","passed":true,"evidence":"file:line or executed check"}],"issues":[],"manualChecksPending":[]}`,
      'Use one allowed decision value. Evaluate every acceptance criterion. A passed verdict requires nonempty successful criteria and no issues.',
      'For issues use {"id":"issue-id","description":"problem","evidence":"file:line"}.',
      'For pending manual checks use {"id":"check-id","description":"required human verification"}.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
