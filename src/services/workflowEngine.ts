import { db, TaskRecord, TaskRevisionRecord } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from './gitService.ts';
import { TestRunner, TestCaseItem } from './testRunner.ts';
import { WorkBuddyClient } from './workbuddyClient.ts';
import { CodexVerifier, VerificationOutput } from './codexVerifier.ts';
import { TaskStatus, RoundStage, DEFAULT_BUDGET_MAX_ROUNDS, DEFAULT_BUDGET_TIMEOUT_SECONDS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

export class WorkflowEngine {
  private static instance: WorkflowEngine;
  private isProcessing: boolean = false;
  private activeTaskId: string | null = null;

  static getInstance(): WorkflowEngine {
    if (!this.instance) {
      this.instance = new WorkflowEngine();
    }
    return this.instance;
  }

  getActiveTaskId(): string | null {
    return this.activeTaskId;
  }

  isBusy(): boolean {
    return this.isProcessing;
  }

  /**
   * Called by Web UI to manually confirm and start a task (Gate 2).
   */
  async confirmAndStartTask(taskId: string, confirmedCwd?: string): Promise<{ success: boolean; message: string }> {
    const task = db.getTask(taskId);
    if (!task) {
      return { success: false, message: `Task not found: ${taskId}` };
    }

    if (task.status !== TaskStatus.PENDING_CONFIRM && task.status !== TaskStatus.BLOCKED) {
      return { success: false, message: `Cannot start task with status: ${task.status}` };
    }

    if (this.isProcessing && this.activeTaskId !== taskId) {
      return { success: false, message: `Workbench is currently executing another task: ${this.activeTaskId}` };
    }

    const targetCwd = confirmedCwd ? confirmedCwd.trim() : task.target_cwd;
    let gitInfo;
    try {
      gitInfo = GitService.inspectWorkspace(targetCwd);
    } catch (e: any) {
      return { success: false, message: `Invalid workspace path: ${e.message}` };
    }

    // Update confirmed cwd and git info in DB
    db.updateTaskStatus(taskId, TaskStatus.QUEUED, {
      confirmed_cwd: targetCwd,
      started_at: Date.now(),
    });

    logger.info(`[WorkflowEngine] Task ${taskId} confirmed and queued for execution. Target cwd: ${targetCwd}`);

    // Trigger execution asynchronously
    setImmediate(() => {
      this.runTaskLoop(taskId).catch((err) => {
        logger.error(`[WorkflowEngine] Unhandled error in task loop for ${taskId}:`, err);
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: `Internal execution error: ${err.message}`,
        });
      });
    });

    return { success: true, message: 'Task confirmed and started successfully.' };
  }

  /**
   * Request that the task stop further execution.
   */
  stopTask(taskId: string): { success: boolean; message: string } {
    const task = db.getTask(taskId);
    if (!task) return { success: false, message: 'Task not found' };

    db.requestTaskStop(taskId);
    WorkBuddyClient.requestStop();

    if (task.status === TaskStatus.QUEUED || task.status === TaskStatus.PENDING_CONFIRM) {
      db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
    }

    logger.info(`[WorkflowEngine] Stop requested for task ${taskId}`);
    return { success: true, message: 'Stop requested. Current operation will finish or terminate.' };
  }

  /**
   * Submit human review decision (Gate 3).
   */
  async submitHumanDecision(
    taskId: string,
    action: 'approve' | 'reject',
    reason: string
  ): Promise<{ success: boolean; message: string }> {
    const task = db.getTask(taskId);
    if (!task) return { success: false, message: 'Task not found' };

    if (task.status !== TaskStatus.HUMAN_REVIEW) {
      return { success: false, message: `Task is not in human review state (current: ${task.status})` };
    }

    db.saveHumanDecision({ taskId, action, reason });

    if (action === 'approve') {
      db.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        completed_at: Date.now(),
      });
      logger.info(`[WorkflowEngine] Task ${taskId} approved by human reviewer. Completed!`);
      return { success: true, message: 'Task approved and completed.' };
    } else {
      // Rejected with reason: loop back to repair
      logger.info(`[WorkflowEngine] Task ${taskId} rejected by human reviewer. Resuming loop with feedback: ${reason}`);
      db.updateTaskStatus(taskId, TaskStatus.QUEUED, {
        blocked_reason: null,
      });

      setImmediate(() => {
        this.runTaskLoop(taskId, `Human Reviewer Feedback: ${reason}`).catch((err) => {
          logger.error(`[WorkflowEngine] Error resuming task after rejection:`, err);
        });
      });

      return { success: true, message: 'Rework feedback submitted. Resuming execution loop.' };
    }
  }

  /**
   * Main task execution loop.
   */
  private async runTaskLoop(taskId: string, initialReworkFeedback?: string): Promise<void> {
    this.isProcessing = true;
    this.activeTaskId = taskId;

    try {
      const task = db.getTask(taskId);
      if (!task) return;

      const revisionRecord = db.getLatestRevision(taskId);
      if (!revisionRecord) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: 'Task package revision materials not found.',
        });
        return;
      }

      const confirmedCwd = task.confirmed_cwd || task.target_cwd;
      const taskPkg = taskFileStore.loadTaskPackage(taskId, revisionRecord.revision);
      const manifest = revisionRecord.manifest_json ? JSON.parse(revisionRecord.manifest_json) : {};

      // Determine defined workers
      const workerPrompts = db.getWorkerPrompts(taskId, revisionRecord.revision);
      const definedWorkerIds = workerPrompts.map((w) => w.worker_id);
      const defaultWorkerId = definedWorkerIds[0] || 'worker-dev';

      // Parse test cases
      const testCases = TestRunner.parseTestCases(revisionRecord.tests_md, revisionRecord.manifest_json);

      let currentRound = task.current_round || 0;
      let nextWorkerId = defaultWorkerId;
      let previousRoundIssues: string = initialReworkFeedback || '';
      let previousTestFailureSummary: string | null = null;

      const maxRounds = task.budget_max_rounds || DEFAULT_BUDGET_MAX_ROUNDS;
      const timeoutSec = task.budget_timeout_sec || DEFAULT_BUDGET_TIMEOUT_SECONDS;
      const startTime = task.started_at || Date.now();

      db.updateTaskStatus(taskId, TaskStatus.RUNNING);

      // --- LOOP ---
      while (true) {
        // 1. Check stop requested
        const freshTask = db.getTask(taskId);
        if (freshTask?.stop_requested) {
          db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
          logger.info(`[WorkflowEngine] Task ${taskId} cancelled per user request.`);
          return;
        }

        currentRound++;

        // 2. Check budget limits
        if (currentRound > maxRounds) {
          const reason = `Maximum execution budget exceeded (${maxRounds} rounds). Execution paused.`;
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
            blocked_reason: reason,
            current_round: currentRound - 1,
          });
          logger.warn(`[WorkflowEngine] Task ${taskId} blocked: ${reason}`);
          return;
        }

        const elapsedSec = (Date.now() - startTime) / 1000;
        if (elapsedSec > timeoutSec) {
          const reason = `Total execution time budget exceeded (${Math.round(elapsedSec)}s > ${timeoutSec}s).`;
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
            blocked_reason: reason,
            current_round: currentRound,
          });
          logger.warn(`[WorkflowEngine] Task ${taskId} blocked: ${reason}`);
          return;
        }

        logger.info(`[WorkflowEngine] === Starting Round ${currentRound} for Task ${taskId} (Worker: ${nextWorkerId}) ===`);
        db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
          current_round: currentRound,
          active_worker_id: nextWorkerId,
          current_stage: RoundStage.WORKER_DEV,
        });

        // --- STAGE 1: WORKER DEV / FIX ---
        const workerPromptRec = workerPrompts.find((w) => w.worker_id === nextWorkerId) || workerPrompts[0];
        const baseWorkerPrompt = workerPromptRec?.prompt_text || 'You are the developer worker.';

        // Compose full round prompt
        const promptLines = [
          baseWorkerPrompt,
          '',
          '---',
          '## Current Execution Round Context',
          `Round Number: ${currentRound}`,
          `Task Root: ${taskFileStore.getRevisionDir(taskId, revisionRecord.revision)}`,
          `Working Directory: ${confirmedCwd}`,
        ];

        if (previousTestFailureSummary) {
          promptLines.push('', '### Previous Test Failures to Fix', previousTestFailureSummary);
        }
        if (previousRoundIssues) {
          promptLines.push('', '### Previous Acceptance Issues / Feedback', previousRoundIssues);
        }

        const fullWorkerPrompt = promptLines.join('\n');
        const roundDbId = db.createExecutionRound({
          task_id: taskId,
          round_number: currentRound,
          stage: RoundStage.WORKER_DEV,
          worker_id: nextWorkerId,
          input_prompt: fullWorkerPrompt,
        });

        // Run Worker
        const workerResult = await WorkBuddyClient.runTask({
          prompt: fullWorkerPrompt,
          cwd: confirmedCwd,
          timeoutMs: manifest.executionPolicy?.timeoutMs,
        });

        if (!workerResult.ok) {
          db.completeExecutionRound(roundDbId, {
            status: 'failed',
            output_text: workerResult.output,
            error_message: workerResult.error,
          });

          // If auth error or user stop
          const errorMsg = workerResult.error || 'Worker execution failed';
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
            blocked_reason: `Worker execution encountered error: ${errorMsg}`,
          });
          logger.warn(`[WorkflowEngine] Task ${taskId} paused due to worker failure: ${errorMsg}`);
          return;
        }

        db.completeExecutionRound(roundDbId, {
          status: 'passed',
          output_text: workerResult.output,
        });

        // Save worker output artifact
        taskFileStore.saveArtifact(
          taskId,
          revisionRecord.revision,
          `round_${currentRound}_worker_output.txt`,
          workerResult.output
        );

        // Check stop requested after worker run
        if (db.getTask(taskId)?.stop_requested) {
          db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
          return;
        }

        // --- STAGE 2: WORKBENCH INDEPENDENT TESTS ---
        logger.info(`[WorkflowEngine] Round ${currentRound}: Running independent automated tests...`);
        db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
          current_stage: RoundStage.RUNNING_TESTS,
        });

        const testRoundDbId = db.createExecutionRound({
          task_id: taskId,
          round_number: currentRound,
          stage: RoundStage.RUNNING_TESTS,
          input_prompt: `Executing ${testCases.length} automated test commands.`,
        });

        const testAggResult = await TestRunner.runAllTests(testCases, confirmedCwd);

        // Record individual tests in DB
        for (const tr of testAggResult.testRuns) {
          db.saveTestRun({
            task_id: taskId,
            round_number: currentRound,
            test_case_id: tr.testCaseId,
            command: tr.command,
            exit_code: tr.exitCode,
            stdout: tr.stdout,
            stderr: tr.stderr,
            report_path: tr.reportPath,
            report_content: tr.reportContent,
            passed: tr.passed,
          });
        }

        if (!testAggResult.allPassed) {
          db.completeExecutionRound(testRoundDbId, {
            status: 'failed',
            output_text: testAggResult.failureSummary,
            error_message: 'Required automated tests failed.',
          });

          logger.warn(`[WorkflowEngine] Round ${currentRound}: Tests failed. Dispatching repair worker for next round.`);
          previousTestFailureSummary = testAggResult.failureSummary;
          previousRoundIssues = '';
          // Loop back to worker
          continue;
        }

        db.completeExecutionRound(testRoundDbId, {
          status: 'passed',
          output_text: 'All required test commands executed with exit code 0.',
        });
        previousTestFailureSummary = null;

        // Check stop requested after tests
        if (db.getTask(taskId)?.stop_requested) {
          db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
          return;
        }

        // --- STAGE 3: CODEX AUTOMATED ACCEPTANCE ---
        logger.info(`[WorkflowEngine] Round ${currentRound}: Running Codex automated acceptance...`);
        db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
          current_stage: RoundStage.CODEX_ACCEPTANCE,
        });

        const codexRoundDbId = db.createExecutionRound({
          task_id: taskId,
          round_number: currentRound,
          stage: RoundStage.CODEX_ACCEPTANCE,
          input_prompt: 'Codex CLI automated acceptance verification.',
        });

        // Get diff snapshot
        const diffSnapshot = GitService.getDiffSnapshot(confirmedCwd);
        const testSummaryText = testAggResult.testRuns
          .map((t) => `Test ${t.testCaseId} [${t.command}]: Exit code ${t.exitCode}`)
          .join('\n');

        const verification = await CodexVerifier.verify({
          taskId,
          revision: revisionRecord.revision,
          confirmedCwd,
          taskPackageDir: taskFileStore.getRevisionDir(taskId, revisionRecord.revision),
          testRunsSummary: testSummaryText,
          gitDiff: diffSnapshot.diff,
          verifierPrompt: revisionRecord.verifier_prompt_md || 'Perform strict acceptance verification.',
          definedWorkerIds,
        });

        // Record acceptance run
        db.saveAcceptanceRun({
          task_id: taskId,
          round_number: currentRound,
          decision: verification.decision,
          summary: verification.summary,
          criteria_results_json: JSON.stringify(verification.criteriaResults),
          issues_json: JSON.stringify(verification.issues),
          manual_checks_json: JSON.stringify(verification.manualChecksPending),
          code_snapshot_json: JSON.stringify(diffSnapshot),
          raw_output: verification.rawOutput || JSON.stringify(verification),
        });

        if (verification.decision === 'blocked') {
          db.completeExecutionRound(codexRoundDbId, {
            status: 'blocked',
            output_text: verification.summary,
            issues_json: JSON.stringify(verification.issues),
          });
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
            blocked_reason: `Codex acceptance blocked: ${verification.summary}`,
          });
          logger.warn(`[WorkflowEngine] Task ${taskId} blocked by Codex: ${verification.summary}`);
          return;
        }

        if (verification.decision === 'needs_changes') {
          db.completeExecutionRound(codexRoundDbId, {
            status: 'failed',
            output_text: verification.summary,
            issues_json: JSON.stringify(verification.issues),
          });

          // Find target worker assigned by Codex or default
          const firstIssue = verification.issues[0];
          if (firstIssue?.targetWorkerId && definedWorkerIds.includes(firstIssue.targetWorkerId)) {
            nextWorkerId = firstIssue.targetWorkerId;
          } else {
            nextWorkerId = defaultWorkerId;
          }

          previousRoundIssues = verification.issues
            .map((i) => `Issue ${i.id}: ${i.description}\nEvidence: ${i.evidence || 'N/A'}`)
            .join('\n\n');

          logger.info(`[WorkflowEngine] Codex rejected (needs_changes). Assigned to ${nextWorkerId}. Cycling to next round.`);
          continue;
        }

        // --- STAGE 4: CODEX PASSED -> TRANSITION TO FINAL HUMAN REVIEW (GATE 3) ---
        db.completeExecutionRound(codexRoundDbId, {
          status: 'passed',
          output_text: verification.summary,
        });

        logger.info(`[WorkflowEngine] Codex acceptance passed! Transitioning task ${taskId} to HUMAN_REVIEW (Gate 3).`);
        db.updateTaskStatus(taskId, TaskStatus.HUMAN_REVIEW, {
          current_stage: RoundStage.HUMAN_REVIEW,
          active_worker_id: null,
        });

        // Exit loop and wait for user's approval or rejection in Web UI
        return;
      }
    } finally {
      this.isProcessing = false;
      this.activeTaskId = null;
    }
  }
}

export const workflowEngine = WorkflowEngine.getInstance();
