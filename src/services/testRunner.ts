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
  static parseTestCases(testsMd: string, manifestJson?: string): TestCaseItem[] {
    const items: TestCaseItem[] = [];

    // 1. First check manifestJson if testCases with commands are defined
    if (manifestJson) {
      try {
        const manifest = JSON.parse(manifestJson);
        if (Array.isArray(manifest.testCases)) {
          for (const tc of manifest.testCases) {
            if (tc.command && (tc.type === 'automated' || tc.automated !== false)) {
              items.push({
                id: tc.id || `TEST-${items.length + 1}`,
                name: tc.name || tc.title,
                command: tc.command,
                reportPath: tc.reportPath,
                isRequired: tc.isRequired !== false && tc.required !== false,
              });
            }
          }
        }
      } catch {
        // Fallback to markdown parsing
      }
    }

    if (items.length > 0) return items;

    // 2. Parse from testsMd markdown sections (e.g. "### TC-AUTO-01: ..." and "- **执行命令**: `...`")
    const sectionRegex = /###\s+([A-Za-z0-9_-]+)(?::\s*([^\n]+))?([\s\S]*?)(?=(?:###|$))/g;
    let secMatch: RegExpExecArray | null;
    while ((secMatch = sectionRegex.exec(testsMd)) !== null) {
      const tcId = secMatch[1].trim();
      const tcName = secMatch[2]?.trim();
      const tcBody = secMatch[3] || '';
      const cmdMatch = tcBody.match(/(?:\*{0,2})(?:命令|执行命令|Command|cmd)(?:\*{0,2})\s*[:：]\s*`([^`\r\n]+)`/i);
      if (cmdMatch) {
        items.push({
          id: tcId,
          name: tcName,
          command: cmdMatch[1].trim(),
          isRequired: true,
        });
      }
    }

    if (items.length > 0) return items;

    // 3. Fallback: line-by-line regex with support for markdown bold formatting
    const regex = /(?:\*{0,2})(?:命令|执行命令|Command|cmd)(?:\*{0,2})\s*[:：]\s*`([^`\r\n]+)`/gi;
    let match: RegExpExecArray | null;
    let count = 1;
    while ((match = regex.exec(testsMd)) !== null) {
      const command = match[1].trim();
      if (command) {
        items.push({
          id: `TEST-${count++}`,
          command,
          isRequired: true,
        });
      }
    }

    // Also look for code blocks under "### 必需检查" or similar
    if (items.length === 0) {
      const blockRegex = /```(?:bash|sh|cmd|powershell)?\s*\n([^\n]+)\n```/g;
      while ((match = blockRegex.exec(testsMd)) !== null) {
        const cmd = match[1].trim();
        if (cmd && !cmd.startsWith('#') && !cmd.startsWith('//')) {
          items.push({
            id: `TEST-${count++}`,
            command: cmd,
            isRequired: true,
          });
        }
      }
    }

    return items;
  }

  static async runSingleTest(
    tc: TestCaseItem,
    workspaceDir: string,
    timeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
    options?: { taskId: string; roundId?: number; signal?: AbortSignal }
  ): Promise<SingleTestResult> {
    const runCwd = tc.cwd ? path.resolve(workspaceDir, tc.cwd) : workspaceDir;

    const result = await CliRunner.run({ runId: randomUUID(), taskId: options?.taskId, roundId:options?.roundId, executable: tc.command,
      cwd: runCwd, shell: true, timeoutMs, signal: options?.signal });
    // 退出码非零也可能来自日志保存失败后的终止，只有执行器明确标记的普通退出才允许返修。
    const assertionFailure = result.failureKind === 'exit-code' && result.cleanupConfirmed === true && result.stopReason === 'PROCESS_FAILED';
    const terminationReason = assertionFailure ? undefined : result.stopReason;
    let reportContent: string | undefined;
    let reportExists = true;
    if (tc.reportPath) {
      try { reportContent = fs.readFileSync(path.resolve(runCwd, tc.reportPath), 'utf8'); }
      catch { reportExists = false; }
    }
    return { testCaseId: tc.id, command: tc.command, exitCode: result.exitCode ?? -1,
      stdout: result.stdout, stderr: result.stderr + (result.error ? '\n' + result.error : ''),
      reportPath: tc.reportPath, reportContent, passed: !result.errorCode && !terminationReason && result.exitCode === 0 && reportExists,
      durationMs: result.durationMs, runId: result.runId,
      terminationReason };
  }

  static async runAllTests(
    testCases: TestCaseItem[],
    workspaceDir: string,
    timeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
    options?: { taskId: string; roundId?: number; signal?: AbortSignal }
  ): Promise<AggregateTestResult> {
    if (testCases.length === 0) {
      logger.info('[TestRunner] No automated test commands found to execute.');
      return {
        allPassed: true,
        testRuns: [],
        failureSummary: null,
      };
    }

    const testRuns: SingleTestResult[] = [];
    let allPassed = true;
    const failures: string[] = [];

    for (const tc of testCases) {
      if (options?.signal?.aborted) return { allPassed: false, testRuns, interrupted: true, failureSummary: "Execution cancelled" };
      logger.info(`[TestRunner] Executing test ${tc.id}: ${tc.command}`);
      const result = await this.runSingleTest(tc, workspaceDir, timeoutMs, options);
      testRuns.push(result);
      if (result.terminationReason) return { allPassed: false, testRuns, interrupted: true, failureSummary: result.stderr };

      if (!result.passed) {
        allPassed = false;
        failures.push(
          `Test ${tc.id} (${tc.command}) failed with exit code ${result.exitCode}.\nStderr:\n${result.stderr.trim() || result.stdout.trim()}`
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
