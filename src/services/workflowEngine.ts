import { resolveExecutionTimeout } from './executionPolicy.ts';
import { db, type TaskRecord, type TaskRevisionRecord } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from './gitService.ts';
import { TestRunner, type TestCaseItem } from './testRunner.ts';
import { CliRunner } from './cliRunner.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import { AcceptanceService } from './acceptanceService.ts';
import { TaskStatus, RoundStage, DEFAULT_BUDGET_MAX_ROUNDS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

export class WorkflowEngine {
  private static instance: WorkflowEngine;
  private taskController: AbortController | null = null;
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
    return this.isProcessing || CliRunner.hasCleanupFailure();
  }

  /**
   * Called by Web UI to manually confirm and start a task (Gate 2).
   */
  async confirmAndStartTask(
    taskId: string,
    confirmedCwd?: string,
    options?: {
      executionTimeoutMs?: number;
      workerExecutor?: string;
      workerModel?: string;
      reviewerExecutor?: string;
      reviewerModel?: string;
    }
  ): Promise<{ success: boolean; message: string }> {
    const task = db.getTask(taskId);
    if (!task) {
      return { success: false, message: `Task not found: ${taskId}` };
    }

    if (task.status !== TaskStatus.PENDING_CONFIRM && task.status !== TaskStatus.BLOCKED) {
      return { success: false, message: `Cannot start task with status: ${task.status}` };
    }

    if (this.isProcessing || CliRunner.hasCleanupFailure()) {
      return { success: false, message: `Workbench is currently executing another task: ${this.activeTaskId}` };
    }

    const targetCwd = confirmedCwd ? confirmedCwd.trim() : task.target_cwd;
    let gitInfo;
    try {
      gitInfo = GitService.inspectWorkspace(targetCwd);
    } catch (e: any) {
      return { success: false, message: `Invalid workspace path: ${e.message}` };
    }

    const workerExecutor = options?.workerExecutor || task.worker_executor || 'workbuddy';
    const reviewerExecutor = options?.reviewerExecutor || task.reviewer_executor || 'workbuddy';
    let workerModel: string;
    let reviewerModel: string;
    try {
      const worker = adapterRegistry.getAdapter(workerExecutor);
      const reviewer = adapterRegistry.getAdapter(reviewerExecutor);
      workerModel = options?.workerModel || (workerExecutor === task.worker_executor ? task.worker_model : undefined) || worker.defaultModel;
      reviewerModel = options?.reviewerModel || (reviewerExecutor === task.reviewer_executor ? task.reviewer_model : undefined) || reviewer.defaultModel;
    } catch (error) {
      return { success: false, message: String(error) };
    }

    const executionTimeoutMs = resolveExecutionTimeout(options?.executionTimeoutMs, task.execution_timeout_ms);
    // 在排队前占用执行槽，避免异步调度之前重复确认。
    this.isProcessing = true;
    this.activeTaskId = taskId;
    // 切换 CLI 时使用新厂商默认模型，不能沿用上一家保存的模型名。
    try {
    db.updateTaskStatus(taskId, TaskStatus.QUEUED, {
      execution_timeout_ms: executionTimeoutMs,
      stop_requested: 0,
      blocked_reason: null,
      confirmed_cwd: targetCwd,
      started_at: Date.now(),
      worker_executor: workerExecutor,
      worker_model: workerModel,
      reviewer_executor: reviewerExecutor,
      reviewer_model: reviewerModel,
    });
    } catch (error) {
      this.isProcessing = false;
      this.activeTaskId = null;
      throw error;
    }

    logger.info(
      `[WorkflowEngine] Task ${taskId} confirmed and queued. Development: ${workerExecutor}(${workerModel}), Acceptance: ${reviewerExecutor}(${reviewerModel}), Target cwd: ${targetCwd}`
    );

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
    if (this.activeTaskId === taskId) this.taskController?.abort();
    void CliRunner.abort(taskId);

    if (task.status === TaskStatus.QUEUED || task.status === TaskStatus.PENDING_CONFIRM) {
      db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
    }

    logger.info(`[WorkflowEngine] Stop requested for task ${taskId}`);
    return { success: true, message: 'Stop requested. Current operation will finish or terminate.' };
  }

  /**
   * Handle task deletion during active execution.
   */
  async handleTaskDeleted(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId && !CliRunner.hasTaskRuns(taskId)) return;
    this.stopTask(taskId);
    await CliRunner.abort(taskId);
    const deadline=Date.now()+10000;
    while(this.activeTaskId===taskId && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
    if(this.activeTaskId===taskId || CliRunner.hasTaskRuns(taskId)) throw new Error('CLEANUP_FAILED: 进程回收未确认，保留任务与日志。');
  }
  async handleAllTasksDeleted(): Promise<void> {
    if(this.activeTaskId) await this.handleTaskDeleted(this.activeTaskId);
    if(CliRunner.hasCleanupFailure()) throw new Error('CLEANUP_FAILED: 存在未回收进程，保留任务与日志。'+CliRunner.pendingRunIds().join(','));
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

    if (action === 'reject' && this.isBusy()) {
      return { success: false, message: `Workbench is currently executing another task: ${this.activeTaskId}` };
    }

    db.saveHumanDecision({ task_id: taskId, action, reason });

    if (action === 'approve') {
      db.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        completed_at: Date.now(),
      });
      logger.info(`[WorkflowEngine] Task ${taskId} approved by human reviewer. Completed!`);
      return { success: true, message: 'Task approved and completed.' };
    } else {
      this.isProcessing = true;
      this.activeTaskId = taskId;
      // Rejected with reason: loop back to repair
      logger.info(`[WorkflowEngine] Task ${taskId} rejected by human reviewer. Resuming loop with feedback: ${reason}`);
      try {
        db.updateTaskStatus(taskId, TaskStatus.QUEUED, {
          blocked_reason: null,
          stop_requested: 0,
        });
      } catch (error) {
        this.isProcessing = false;
        this.activeTaskId = null;
        throw error;
      }

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
    this.taskController = new AbortController();

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
        const workerAdapter = adapterRegistry.getAdapter(task.worker_executor || 'workbuddy');
        const workerModel = task.worker_model || workerAdapter.defaultModel;

        const roundDbId = db.createExecutionRound({
          task_id: taskId,
          round_number: currentRound,
          stage: RoundStage.WORKER_DEV,
          worker_id: nextWorkerId,
          adapter_id: workerAdapter.id,
          model_name: workerModel,
          input_prompt: fullWorkerPrompt,
        });

        const workerResult = await workerAdapter.execute({
          taskId,
          roundId:roundDbId,
          model: workerModel,
          prompt: fullWorkerPrompt,
          cwd: confirmedCwd,
          signal: this.taskController.signal,
          timeoutMs: task.execution_timeout_ms || resolveExecutionTimeout(),
        });

        if (!workerResult.ok) {
          db.completeExecutionRound(roundDbId, {
            status: 'failed',
            output_text: workerResult.output,
            error_message: workerResult.error,
            duration_ms: workerResult.durationMs,
          });

          if (db.getTask(taskId)?.stop_requested) {
            db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
            return;
          }

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
          duration_ms: workerResult.durationMs,
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

        const testAggResult = await TestRunner.runAllTests(testCases, confirmedCwd, task.execution_timeout_ms || resolveExecutionTimeout(), { taskId, roundId:testRoundDbId, signal: this.taskController.signal });

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

        if (testAggResult.interrupted || db.getTask(taskId)?.stop_requested) {
          db.completeExecutionRound(testRoundDbId, { status: 'blocked', output_text: testAggResult.failureSummary });
          db.updateTaskStatus(taskId, db.getTask(taskId)?.stop_requested ? TaskStatus.CANCELLED : TaskStatus.BLOCKED, { blocked_reason: testAggResult.failureSummary });
          return;
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

        // --- STAGE 3: REVIEWER ACCEPTANCE (VIA ADAPTER, NO SANDBOX) ---
        const reviewerAdapter = adapterRegistry.getAdapter(task.reviewer_executor || 'workbuddy');
        const reviewerModel = task.reviewer_model || reviewerAdapter.defaultModel;

        logger.info(
          `[WorkflowEngine] Round ${currentRound}: Running acceptance review via ${reviewerAdapter.name} (model: ${reviewerModel})...`
        );
        db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
          current_stage: RoundStage.CODEX_ACCEPTANCE,
        });

        const codexRoundDbId = db.createExecutionRound({
          task_id: taskId,
          round_number: currentRound,
          stage: RoundStage.CODEX_ACCEPTANCE,
          worker_id: null,
          adapter_id: reviewerAdapter.id,
          model_name: reviewerModel,
          input_prompt: `${reviewerAdapter.name} automated acceptance verification (model: ${reviewerModel}).`,
        });

        // Get diff snapshot
        const diffSnapshot = GitService.getDiffSnapshot(confirmedCwd);
        const testSummaryText = testAggResult.testRuns
          .map((t) => `Test ${t.testCaseId} [${t.command}]: Exit code ${t.exitCode}`)
          .join('\n');

        const verification = await new AcceptanceService().execute(reviewerAdapter, {
          taskId,
          timeoutMs: task.execution_timeout_ms || resolveExecutionTimeout(),
          roundId:codexRoundDbId,
          signal:this.taskController.signal,
          roundNumber: currentRound,
          model: reviewerModel,
          revision: revisionRecord.revision,
          confirmedCwd,
          taskPackageDir: taskFileStore.getRevisionDir(taskId, revisionRecord.revision),
          testRunsSummary: testSummaryText,
          gitDiff: diffSnapshot.diff,
          verifierPrompt: revisionRecord.verifier_prompt_md || 'Perform strict acceptance verification.',
          definedWorkerIds,
        });

        if (db.getTask(taskId)?.stop_requested) {
          db.completeExecutionRound(codexRoundDbId, {
            status: 'blocked',
            output_text: verification.rawOutput || verification.summary,
            error_message: 'Execution cancelled by user.',
            duration_ms: verification.durationMs,
          });
          db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
          return;
        }

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
            duration_ms: verification.durationMs,
          });
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
            blocked_reason: `Reviewer acceptance blocked: ${verification.summary}`,
          });
          logger.warn(`[WorkflowEngine] Task ${taskId} blocked by Reviewer: ${verification.summary}`);
          return;
        }

        if (verification.decision === 'needs_changes') {
          db.completeExecutionRound(codexRoundDbId, {
            status: 'failed',
            output_text: verification.summary,
            issues_json: JSON.stringify(verification.issues),
            duration_ms: verification.durationMs,
          });

          // Find target worker assigned by Reviewer or default
          const firstIssue = verification.issues[0];
          if (firstIssue?.targetWorkerId && definedWorkerIds.includes(firstIssue.targetWorkerId)) {
            nextWorkerId = firstIssue.targetWorkerId;
          } else {
            nextWorkerId = defaultWorkerId;
          }

          previousRoundIssues = verification.issues
            .map((i) => `Issue ${i.id}: ${i.description}\nEvidence: ${i.evidence || 'N/A'}`)
            .join('\n\n');

          logger.info(`[WorkflowEngine] Reviewer rejected (needs_changes). Assigned to ${nextWorkerId}. Cycling to next round.`);
          continue;
        }

        // --- STAGE 4: REVIEWER PASSED -> TRANSITION TO FINAL HUMAN REVIEW (GATE 3) ---
        db.completeExecutionRound(codexRoundDbId, {
          status: 'passed',
          output_text: verification.summary,
          duration_ms: verification.durationMs,
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
      this.taskController = null;
    }
  }
}

export const workflowEngine = WorkflowEngine.getInstance();
