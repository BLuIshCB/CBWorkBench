import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VERIFIER_DEFAULT_MODEL, DEFAULT_VERIFIER_TIMEOUT_MS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

export interface CriterionResult {
  id: string;
  name?: string;
  passed: boolean;
  evidence: string;
}

export interface VerificationIssue {
  id: string;
  criteriaId?: string;
  targetWorkerId?: string;
  description: string;
  evidence?: string;
}

export interface VerificationOutput {
  decision: 'passed' | 'needs_changes' | 'blocked';
  revision: number;
  summary: string;
  criteriaResults: CriterionResult[];
  issues: VerificationIssue[];
  manualChecksPending: Array<{ id: string; description: string }>;
  rawOutput?: string;
}

export class CodexVerifier {
  private static codexCommand: string | null = null;

  static resolveCodexExecutable(): string {
    if (this.codexCommand) return this.codexCommand;

    // Check custom env
    if (process.env.CODEX_CMD_PATH && fs.existsSync(process.env.CODEX_CMD_PATH)) {
      this.codexCommand = process.env.CODEX_CMD_PATH;
      return this.codexCommand;
    }

    const home = os.homedir();
    const candidates = [
      path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.cmd'),
      'codex.cmd',
      'codex',
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.codexCommand = c;
        return c;
      }
    }

    this.codexCommand = 'codex.cmd';
    return this.codexCommand;
  }

  static getCodexSchemaPath(): string {
    const tempDir = os.tmpdir();
    const schemaFile = path.join(tempDir, 'codex_acceptance_schema.json');

    const schema = {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['passed', 'needs_changes', 'blocked'],
          description: 'Overall verification decision',
        },
        revision: {
          type: 'number',
          description: 'The task package revision number evaluated',
        },
        summary: {
          type: 'string',
          description: 'Concise explanation of the verification outcome',
        },
        criteriaResults: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              passed: { type: 'boolean' },
              evidence: { type: 'string' },
            },
            required: ['id', 'name', 'passed', 'evidence'],
            additionalProperties: false,
          },
          description: 'Results for each individual automated criterion evaluated',
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              criteriaId: { type: 'string' },
              targetWorkerId: { type: 'string' },
              description: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['id', 'criteriaId', 'targetWorkerId', 'description', 'evidence'],
            additionalProperties: false,
          },
          description: 'Issues found during verification with target worker assignments',
        },
        manualChecksPending: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['id', 'description'],
            additionalProperties: false,
          },
          description: 'Checks explicitly reserved for final human review',
        },
      },
      required: ['decision', 'revision', 'summary', 'criteriaResults', 'issues', 'manualChecksPending'],
      additionalProperties: false,
    };

    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2), 'utf8');
    return schemaFile;
  }

  static async verify(params: {
    taskId: string;
    revision: number;
    confirmedCwd: string;
    taskPackageDir: string;
    testRunsSummary: string;
    gitDiff: string;
    verifierPrompt: string;
    definedWorkerIds: string[];
    model?: string;
    timeoutMs?: number;
  }): Promise<VerificationOutput> {
    // Check mock mode
    if (process.env.CB_MOCK_CODEX === 'true') {
      logger.info('[CodexVerifier] Mock mode active: simulating Codex acceptance pass.');
      return {
        decision: 'passed',
        revision: params.revision,
        summary: 'All automated criteria verified and passed against codebase snapshot.',
        criteriaResults: [
          { id: 'CRIT-AUTO-1', name: 'Automated test suite pass', passed: true, evidence: 'Exit code 0' },
        ],
        issues: [],
        manualChecksPending: [
          { id: 'MANUAL-1', description: 'Confirm visual display in browser' },
        ],
        rawOutput: '{"decision":"passed"}',
      };
    }

    const codexBin = this.resolveCodexExecutable();
    const model = params.model || VERIFIER_DEFAULT_MODEL;
    const timeoutMs = params.timeoutMs || DEFAULT_VERIFIER_TIMEOUT_MS;
    const schemaPath = this.getCodexSchemaPath();

    const outputFilePath = path.join(
      os.tmpdir(),
      `codex_output_${params.taskId}_r${params.revision}_${Date.now()}.json`
    );

    // Build the full prompt for Codex
    const fullPrompt = [
      '# Codex Automated Acceptance Verification',
      '',
      params.verifierPrompt,
      '',
      '---',
      '## Context & Evidence Provided by Workbench',
      `Task ID: ${params.taskId}`,
      `Revision: ${params.revision}`,
      `Confirmed Workspace Directory: ${params.confirmedCwd}`,
      `Task Package Root: ${params.taskPackageDir}`,
      `Allowed Target Worker IDs for issues: ${params.definedWorkerIds.join(', ')}`,
      '',
      '### Independent Test Execution Evidence',
      params.testRunsSummary || '(No test runs reported)',
      '',
      '### Codebase Working Tree Diff',
      '```diff',
      params.gitDiff || '(No modifications detected)',
      '```',
      '',
      'Please inspect the project files and test evidence strictly against acceptance criteria.',
      'Output your verdict strictly conforming to the requested JSON schema.',
    ].join('\n');

    logger.info(`[CodexVerifier] Launching Codex CLI with model=${model}, cwd=${params.confirmedCwd}...`);

    return new Promise((resolve) => {
      const child = spawn(
        codexBin,
        [
          'exec',
          '-m',
          model,
          '-s',
          'read-only',
          '--skip-git-repo-check',
          '--output-schema',
          schemaPath,
          '-o',
          outputFilePath,
          '-C',
          params.confirmedCwd,
          '-',
        ],
        {
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );

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
        } catch {}
      }, timeoutMs);

      child.stdout.on('data', (d) => stdoutChunks.push(Buffer.from(d)));
      child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));

      // Feed prompt via stdin to avoid Windows 8191-character command line limit
      child.stdin.write(fullPrompt, 'utf8');
      child.stdin.end();

      child.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        let parsed: VerificationOutput | null = null;

        if (fs.existsSync(outputFilePath)) {
          try {
            const rawContent = fs.readFileSync(outputFilePath, 'utf8').trim();
            parsed = JSON.parse(rawContent);
            if (parsed) {
              parsed.rawOutput = rawContent;
            }
          } catch (e) {
            logger.warn('[CodexVerifier] Failed to parse output-last-message JSON:', e);
          } finally {
            try {
              fs.unlinkSync(outputFilePath);
            } catch {}
          }
        }

        if (timedOut) {
          resolve({
            decision: 'blocked',
            revision: params.revision,
            summary: `Codex acceptance timed out after ${timeoutMs}ms.`,
            criteriaResults: [],
            issues: [
              {
                id: 'ERR-TIMEOUT',
                description: `Verification execution timed out after ${timeoutMs}ms.`,
              },
            ],
            manualChecksPending: [],
            rawOutput: stderr,
          });
          return;
        }

        if (parsed && parsed.decision) {
          // Validate targetWorkerIds in issues: must belong to definedWorkerIds
          if (Array.isArray(parsed.issues)) {
            for (const issue of parsed.issues) {
              if (issue.targetWorkerId && !params.definedWorkerIds.includes(issue.targetWorkerId)) {
                issue.targetWorkerId = params.definedWorkerIds[0] || 'worker-dev';
              }
            }
          }

          // Safety rule: if decision is passed but there are issues, downgrade to needs_changes
          if (parsed.decision === 'passed' && parsed.issues && parsed.issues.length > 0) {
            parsed.decision = 'needs_changes';
            parsed.summary += ' (Downgraded to needs_changes because unresolved issues were reported).';
          }

          resolve(parsed);
          return;
        }

        // If JSON output was not captured or process failed
        logger.error(`[CodexVerifier] Non-zero exit or unparseable output (code=${code}):\n${stderr || stdout}`);
        resolve({
          decision: 'blocked',
          revision: params.revision,
          summary: `Codex verification failed (exit code ${code}): ${stderr.slice(0, 300) || stdout.slice(0, 300) || 'Unknown error'}`,
          criteriaResults: [],
          issues: [
            {
              id: 'ERR-CODEX-EXEC',
              description: stderr.slice(0, 500) || 'Codex verification process failed to produce structured verdict.',
            },
          ],
          manualChecksPending: [],
          rawOutput: stderr || stdout,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          decision: 'blocked',
          revision: params.revision,
          summary: `Failed to spawn Codex CLI: ${err.message}`,
          criteriaResults: [],
          issues: [{ id: 'ERR-SPAWN', description: err.message }],
          manualChecksPending: [],
        });
      });
    });
  }
}
