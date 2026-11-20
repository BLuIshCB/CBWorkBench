import type { StopReason } from './executionService.ts';
import { CliRunner } from './cliRunner.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_EXECUTION_TIMEOUT_MS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

export interface TestCaseItem {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  reportPath?: string;
  isRequired?: boolean;
}

export interface SingleTestResult {
  testCaseId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  reportPath?: string;
  reportContent?: string;
  passed: boolean;
  durationMs: number;
  terminationReason?: StopReason;
  runId?: string;
}

export interface AggregateTestResult {
  interrupted?: boolean;
  allPassed: boolean;
  testRuns: SingleTestResult[];
  failureSummary: string | null;
}

export class TestRunner {
  static async runSingleTest(
    tc: TestCaseItem,
    workspaceDir: string,
    timeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
    options?: { taskId: string; roundId?: number; signal?: AbortSignal }
  ): Promise<SingleTestResult> {
    const runCwd = tc.cwd ? path.resolve(workspaceDir, tc.cwd) : workspaceDir;

    const result = await CliRunner.run({
      runId: randomUUID(),
      taskId: options?.taskId,
      roundId: options?.roundId,
      executable: tc.command,
      cwd: runCwd,
      shell: true,
      timeoutMs,
      signal: options?.signal,
    });
    // 退出码非零也可能来自日志保存失败后的终止，只有执行器明确标记的普通退出才允许返修。
    const assertionFailure =
      result.failureKind === 'exit-code' &&
      result.cleanupConfirmed === true &&
      result.stopReason === 'PROCESS_FAILED';
    const terminationReason = assertionFailure ? undefined : result.stopReason;
    let reportContent: string | undefined;
    let reportExists = true;
    if (tc.reportPath) {
      try {
        reportContent = fs.readFileSync(path.resolve(runCwd, tc.reportPath), 'utf8');
      } catch {
        reportExists = false;
      }
    }
    return {
      testCaseId: tc.id,
      command: tc.command,
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout,
      stderr: result.stderr + (result.error ? '\n' + result.error : ''),
      reportPath: tc.reportPath,
      reportContent,
      passed: !result.errorCode && !terminationReason && result.exitCode === 0 && reportExists,
      durationMs: result.durationMs,
      runId: result.runId,
      terminationReason,
    };
  }

  static async runAllTests(
    testCases: TestCaseItem[],
    workspaceDir: string,
    timeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
    options?: { taskId: string; roundId?: number; signal?: AbortSignal }
  ): Promise<AggregateTestResult> {
    if (testCases.length === 0) {
      logger.info('[TestRunner] No explicit commands provided to execute.');
      return {
        allPassed: false,
        testRuns: [],
        failureSummary: '命令节点未配置可执行的命令。',
      };
    }

    const testRuns: SingleTestResult[] = [];
    let allPassed = true;
    const failures: string[] = [];

    for (const tc of testCases) {
      if (options?.signal?.aborted) {
        return { allPassed: false, testRuns, interrupted: true, failureSummary: 'Execution cancelled' };
      }
      logger.info(`[TestRunner] Executing command ${tc.id}: ${tc.command}`);
      const result = await this.runSingleTest(tc, workspaceDir, timeoutMs, options);
      testRuns.push(result);
      if (result.terminationReason) {
        return { allPassed: false, testRuns, interrupted: true, failureSummary: result.stderr };
      }

      if (!result.passed) {
        allPassed = false;
        failures.push(
          `Command ${tc.id} (${tc.command}) failed with exit code ${result.exitCode}.\nStderr:\n${result.stderr.trim() || result.stdout.trim()}`
        );
      }
    }

    return {
      allPassed,
      testRuns,
      failureSummary: failures.length > 0 ? failures.join('\n\n---\n\n') : null,
    };
  }
}
