import fs from 'node:fs';
import path from 'node:path';
import type { AgentExecutionContext, AgentExecutionResult } from '../../src/adapters/types.ts';
import { TestRunner } from '../../src/services/testRunner.ts';

/** 模拟测试 Agent 自行选择命令并执行，工作流定义不提供命令。 */
export async function runVerificationAgent(context: AgentExecutionContext, exitCode = 0): Promise<AgentExecutionResult | undefined> {
  const contextPath = context.prompt.match(/^Context Manifest: (.+)$/m)?.[1].trim();
  if (!contextPath) return;
  const runtime = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  if (runtime.node.result_rule !== 'verification') return;
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
  return { ok: true, output: '测试节点已执行命令并保存证据。', durationMs: test.durationMs, modelUsed: context.model || 'default' };
}
