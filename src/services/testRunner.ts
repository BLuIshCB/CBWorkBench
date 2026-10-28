import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_TEST_TIMEOUT_MS } from '../config/constants.ts';
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
}

export interface AggregateTestResult {
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

    // 2. Parse from testsMd markdown blocks:
    // Looks for:
    // `command` or code blocks with commands or lines like:
    // - 命令: `npm test` or **执行命令**: `node ...`
    const regex = /(?:命令|执行命令|Command|cmd)\s*[:：]\s*`([^`]+)`/gi;
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
    timeoutMs: number = DEFAULT_TEST_TIMEOUT_MS
  ): Promise<SingleTestResult> {
    const startTime = Date.now();
    const runCwd = tc.cwd ? path.resolve(workspaceDir, tc.cwd) : workspaceDir;

    return new Promise((resolve) => {
      // Use shell: true on Windows to handle commands like npm or node
      const child = spawn(tc.command, {
        cwd: runCwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
      }, timeoutMs);

      child.stdout.on('data', (d) => stdoutChunks.push(Buffer.from(d)));
      child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        let stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (timedOut) {
          stderr += `\n[TestRunner] Command timed out after ${timeoutMs}ms.`;
        }

        let reportContent: string | undefined;
        let reportExists = true;

        if (tc.reportPath) {
          const resolvedReport = path.resolve(runCwd, tc.reportPath);
          if (fs.existsSync(resolvedReport)) {
            try {
              reportContent = fs.readFileSync(resolvedReport, 'utf8');
            } catch {
              reportContent = '(Report file exists but could not be read)';
            }
          } else {
            reportExists = false;
          }
        }

        const passed = !timedOut && code === 0 && reportExists;

        resolve({
          testCaseId: tc.id,
          command: tc.command,
          exitCode: code ?? -1,
          stdout,
          stderr,
          reportPath: tc.reportPath,
          reportContent,
          passed,
          durationMs,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          testCaseId: tc.id,
          command: tc.command,
          exitCode: -1,
          stdout: '',
          stderr: `[TestRunner] Process spawn error: ${err.message}`,
          reportPath: tc.reportPath,
          passed: false,
          durationMs,
        });
      });
    });
  }

  static async runAllTests(
    testCases: TestCaseItem[],
    workspaceDir: string,
    timeoutMs: number = DEFAULT_TEST_TIMEOUT_MS
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
      logger.info(`[TestRunner] Executing test ${tc.id}: ${tc.command}`);
      const result = await this.runSingleTest(tc, workspaceDir, timeoutMs);
      testRuns.push(result);

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
