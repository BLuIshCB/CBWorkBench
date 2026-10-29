import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { VERIFIER_DEFAULT_MODEL, DEFAULT_VERIFIER_TIMEOUT_MS } from '../config/constants.ts';
import { resolveCodexCliConfig } from './workbuddyConfig.ts';
import { CliRunner } from './cliRunner.ts';
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
    // 检查 mock 模式
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

    const codexConfig = resolveCodexCliConfig();
    const model = params.model || VERIFIER_DEFAULT_MODEL;
    const timeoutMs = params.timeoutMs || DEFAULT_VERIFIER_TIMEOUT_MS;
    const schemaPath = this.getCodexSchemaPath();

    const outputFilePath = path.join(
      os.tmpdir(),
      `codex_output_${params.taskId}_r${params.revision}_${Date.now()}.json`
    );

    // 确保运行前清理旧文件，防止复用上轮遗留结果
    if (fs.existsSync(outputFilePath)) {
      try {
        fs.unlinkSync(outputFilePath);
      } catch {}
    }

    // 组装 Codex 完整提示词
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

    const codexArgs = [
      ...(codexConfig.script ? [codexConfig.script] : []),
      'exec',
      '-m',
      model,
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--output-schema',
      schemaPath,
      '-o',
      outputFilePath,
      '-C',
      params.confirmedCwd,
      '-',
    ];

    const runResult = await CliRunner.run({
      runId: `codex-${params.taskId}-r${params.revision}-${Date.now()}`,
      taskId: params.taskId,
      executable: codexConfig.executable,
      args: codexArgs,
      cwd: params.confirmedCwd,
      env: codexConfig.env,
      stdin: fullPrompt,
      timeoutMs,
    });

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

    if (runResult.timedOut) {
      return {
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
        rawOutput: runResult.stderr,
      };
    }

    if (runResult.cancelled) {
      return {
        decision: 'blocked',
        revision: params.revision,
        summary: 'Codex verification was cancelled.',
        criteriaResults: [],
        issues: [
          {
            id: 'ERR-CANCELLED',
            description: 'Verification cancelled by user or engine.',
          },
        ],
        manualChecksPending: [],
        rawOutput: runResult.stderr,
      };
    }

    if (parsed && parsed.decision) {
      // 验证 targetWorkerIds 是否属于 definedWorkerIds
      if (Array.isArray(parsed.issues)) {
        for (const issue of parsed.issues) {
          if (issue.targetWorkerId && !params.definedWorkerIds.includes(issue.targetWorkerId)) {
            issue.targetWorkerId = params.definedWorkerIds[0] || 'worker-dev';
          }
        }
      }

      // 安全门禁：若判定为 passed 但存在 issues，自动降级为 needs_changes
      if (parsed.decision === 'passed' && parsed.issues && parsed.issues.length > 0) {
        parsed.decision = 'needs_changes';
        parsed.summary += ' (Downgraded to needs_changes because unresolved issues were reported).';
      }

      return parsed;
    }

    // 进程非零退出或未生成结构化判定文件
    logger.error(
      `[CodexVerifier] Non-zero exit or unparseable output (code=${runResult.exitCode}):\n${
        runResult.stderr || runResult.stdout
      }`
    );

    return {
      decision: 'blocked',
      revision: params.revision,
      summary: `Codex verification failed (exit code ${runResult.exitCode}): ${
        runResult.stderr.slice(0, 300) || runResult.stdout.slice(0, 300) || runResult.error || 'Unknown error'
      }`,
      criteriaResults: [],
      issues: [
        {
          id: 'ERR-CODEX-EXEC',
          description:
            runResult.stderr.slice(0, 500) ||
            runResult.error ||
            'Codex verification process failed to produce structured verdict.',
        },
      ],
      manualChecksPending: [],
      rawOutput: runResult.stderr || runResult.stdout,
    };
  }
}
