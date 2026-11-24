import fs from 'node:fs';
import path from 'node:path';
import type { AgentExecutionContext, AgentExecutionResult } from '../../src/adapters/types.ts';
import { TestRunner } from '../../src/services/testRunner.ts';
import { callLocalAdvance } from '../../src/cli/completeNode.ts';
import type { AdvanceInput } from '../../src/services/nodeCompletion.ts';

export function readFixtureRuntime(context: AgentExecutionContext) {
  const contextPath = context.prompt.match(/^Context Manifest: (.+)$/m)?.[1].trim();
  return contextPath ? JSON.parse(fs.readFileSync(contextPath, 'utf8')) : undefined;
}

export async function reportFixtureCompletion(context: AgentExecutionContext, options: {
  outcome?: 'passed' | 'failed';
  summary?: string;
  acceptance?: object;
  rework?: string[];
} = {}) {
  const runtime = readFixtureRuntime(context);
  const files = (options.rework || []).map((content, index) => {
    const filePath = `outputs/rework/issue-${index + 1}.md`;
    fs.writeFileSync(path.join(runtime.paths.attempt_dir, filePath), content, 'utf8');
    return filePath;
  });
  if (options.acceptance) {
    fs.writeFileSync(path.join(runtime.paths.outputs_dir, 'acceptance-report.json'), JSON.stringify(options.acceptance), 'utf8');
  }
  const input: AdvanceInput = {
    ...runtime.completion_protocol, outcome: options.outcome || 'passed',
    summary: options.summary || 'Fixture completed', rework_paths: files,
  };
  return callLocalAdvance(input);
}

export const passedAcceptanceFixture = {
  decision: 'passed',
  summary: 'All checks passed',
  criteriaResults: [{ id: 'C1', passed: true, evidence: 'Verified' }],
  issues: [],
  manualChecksPending: [],
};

/** 模拟测试 Agent 自行选择命令并执行，工作流定义不提供命令。 */
export async function runVerificationAgent(context: AgentExecutionContext, exitCode = 0): Promise<AgentExecutionResult | undefined> {
  const runtime = readFixtureRuntime(context);
  if (runtime?.node.result_rule !== 'verification') return;
  const command = `"${process.execPath}" -e "console.log('node-owned-test');process.exit(${exitCode})"`;
  const test = await TestRunner.runSingleTest({ id: runtime.node.id, command }, context.cwd, context.timeoutMs, {
    taskId: context.taskId!, roundId: context.roundId, signal: context.signal,
  });
  if (test.terminationReason) {
    return { ok: false, output: test.stdout, error: test.stderr, errorCode: 'EXECUTION', durationMs: test.durationMs, modelUsed: context.model || 'default' };
  }
  fs.writeFileSync(path.join(runtime.paths.outputs_dir, 'test_report.json'), JSON.stringify({
    tests: [{ command, cwd: context.cwd, exit_code: test.exitCode, stdout: test.stdout, stderr: test.stderr }],
  }));
  const summary = test.exitCode === 0 ? '测试通过' : `退出码 ${test.exitCode}`;
  await reportFixtureCompletion(context, {
    outcome: test.exitCode === 0 ? 'passed' : 'failed',
    summary,
    rework: test.exitCode !== 0 && runtime.completion_protocol.rework_target_node_id ? [summary] : [],
  });
  return { ok: true, output: '测试节点已执行命令并保存证据。', durationMs: test.durationMs, modelUsed: context.model || 'default' };
}
