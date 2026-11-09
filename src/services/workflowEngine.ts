import crypto from 'node:crypto';
import { resolveExecutionTimeout } from './executionPolicy.ts';
import { db, type TaskRecord, type TaskRevisionRecord } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { GitService } from './gitService.ts';
import { TestRunner } from './testRunner.ts';
import { CliRunner } from './cliRunner.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import { AcceptanceService } from './acceptanceService.ts';
import { TaskStatus, RoundStage, DEFAULT_BUDGET_MAX_ROUNDS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { type WorkflowNode, DEFAULT_MAX_EXECUTIONS } from './workflowDefinition.ts';

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

      // Ensure task workflow is initialized
      let taskWf = db.getTaskWorkflow(taskId);
      if (!taskWf) {
        taskWf = db.initTaskWorkflow(taskId);
      }
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
    const deadline = Date.now() + 10000;
    while (this.activeTaskId === taskId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.activeTaskId === taskId || CliRunner.hasTaskRuns(taskId)) throw new Error('CLEANUP_FAILED: 进程回收未确认，保留任务与日志。');
  }

  async handleAllTasksDeleted(): Promise<void> {
    if (this.activeTaskId) await this.handleTaskDeleted(this.activeTaskId);
    if (CliRunner.hasCleanupFailure()) throw new Error('CLEANUP_FAILED: 存在未回收进程，保留任务与日志。' + CliRunner.pendingRunIds().join(','));
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

    let taskWf = db.getTaskWorkflow(taskId);
    if (!taskWf) {
      taskWf = db.initTaskWorkflow(taskId);
    }

    let nodes: WorkflowNode[] = [];
    try {
      nodes = JSON.parse(taskWf.nodes_json);
    } catch {}

    const currentNodeId = taskWf.current_node_id;
    let currentNode = nodes.find((n) => n.id === currentNodeId);
    if (!currentNode || currentNode.execution_mode !== 'manual') {
      const manualNode = nodes.find((n) => n.execution_mode === 'manual');
      if (manualNode) currentNode = manualNode;
    }

    const latestRun = db.getLatestNodeRun(taskId, currentNode?.id || currentNodeId);
    if (latestRun && latestRun.status === 'waiting_manual') {
      db.updateNodeRun(latestRun.run_id, {
        status: action === 'approve' ? 'passed' : 'failed',
        result_summary: reason || (action === 'approve' ? '人工审核通过' : '人工审核退回'),
        finished_at: Date.now(),
      });
    }

    const nextNodeId = action === 'approve'
      ? (currentNode?.on_success || 'end')
      : (currentNode?.on_failure || 'development');

    db.updateTaskWorkflow(taskId, { current_node_id: nextNodeId });

    if (action === 'approve') {
      const nextNode = nodes.find((n) => n.id === nextNodeId);
      if (!nextNode || nextNode.type === 'end') {
        db.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
          completed_at: Date.now(),
        });
        logger.info(`[WorkflowEngine] Task ${taskId} approved by human reviewer. Completed!`);
        return { success: true, message: 'Task approved and completed.' };
      }
    }

    this.isProcessing = true;
    this.activeTaskId = taskId;
    logger.info(`[WorkflowEngine] Task ${taskId} human review decision [${action}]. Resuming loop with feedback: ${reason}`);

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
      this.runTaskLoop(taskId, reason ? `Human Reviewer Feedback: ${reason}` : undefined).catch((err) => {
        logger.error(`[WorkflowEngine] Error resuming task after rejection:`, err);
      });
    });

    return { success: true, message: 'Rework feedback submitted. Resuming execution loop.' };
  }

  /**
   * Main task execution loop (State Machine).
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

      let taskWorkflow = db.getTaskWorkflow(taskId);
      if (!taskWorkflow) {
        taskWorkflow = db.initTaskWorkflow(taskId);
      }

      let nodes: WorkflowNode[];
      try {
        nodes = JSON.parse(taskWorkflow.nodes_json);
      } catch (e: any) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: `工作流节点解析失败: ${e.message}`,
        });
        return;
      }

      const confirmedCwd = task.confirmed_cwd || task.target_cwd;
      const workerPrompts = db.getWorkerPrompts(taskId, revisionRecord.revision);
      const definedWorkerIds = workerPrompts.map((w) => w.worker_id);
      let nextWorkerId = definedWorkerIds[0] || 'worker-dev';

      let previousRoundIssues = initialReworkFeedback || '';
      let previousTestFailureSummary: string | null = null;
      let currentRound = task.current_round || 0;
      const maxRounds = task.budget_max_rounds || DEFAULT_BUDGET_MAX_ROUNDS;

      db.updateTaskStatus(taskId, TaskStatus.RUNNING);

      // --- STATE MACHINE LOOP ---
      while (true) {
        // 1. Check stop request
        const freshTask = db.getTask(taskId);
        if (freshTask?.stop_requested) {
          db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
          logger.info(`[WorkflowEngine] Task ${taskId} cancelled per user request.`);
          return;
        }

        taskWorkflow = db.getTaskWorkflow(taskId)!;
        const currentNodeId = taskWorkflow.current_node_id;
        const currentNode = nodes.find((n) => n.id === currentNodeId);

        if (!currentNode) {
          const reason = `未找到当前工作流节点: ${currentNodeId}`;
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
          logger.error(`[WorkflowEngine] ${reason}`);
          return;
        }

        // Start node: direct advance
        if (currentNode.type === 'start') {
          const targetId = currentNode.on_success;
          if (!targetId || !nodes.some((n) => n.id === targetId)) {
            const reason = `开始节点的后继节点无效: ${targetId}`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
            return;
          }
          db.updateTaskWorkflow(taskId, { current_node_id: targetId });
          continue;
        }

        // End node: completion
        if (currentNode.type === 'end') {
          // Check final gate prerequisite: tests and acceptance must match current code generation
          if (
            taskWorkflow.code_generation > 0 &&
            (taskWorkflow.tests_passed_generation !== taskWorkflow.code_generation ||
              taskWorkflow.acceptance_passed_generation !== taskWorkflow.code_generation)
          ) {
            const reason = `流程到达结束节点，但测试或验收代次未对齐当前代码代次 (代码: ${taskWorkflow.code_generation}, 测试: ${taskWorkflow.tests_passed_generation}, 验收: ${taskWorkflow.acceptance_passed_generation})。`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
            return;
          }

          db.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
            completed_at: Date.now(),
          });
          logger.info(`[WorkflowEngine] Task ${taskId} completed successfully at end node.`);
          return;
        }

        // Task node
        if (currentNode.type === 'task') {
          const runCount = db.getNodeRunCount(taskId, currentNode.id);
          const maxExecutions = currentNode.max_executions || DEFAULT_MAX_EXECUTIONS;

          // Increment current round when returning to developer
          if (currentNode.id === 'development' || !currentNode.on_failure) {
            currentRound++;
          } else if (currentRound === 0) {
            currentRound = 1;
          }

          // Check budget max rounds limit
          if (task.budget_max_rounds && currentRound > maxRounds) {
            const reason = `Maximum execution budget exceeded (${maxRounds} rounds). Execution paused.`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
              blocked_reason: reason,
              current_round: currentRound - 1,
            });
            logger.warn(`[WorkflowEngine] Task ${taskId} blocked: ${reason}`);
            return;
          }

          // 用户明确要求：每个节点不做次数限制（节点可随状态机路由多次循环，仅受全局任务轮数预算限制）
          // 节点执行序号（runCount + 1）正常递增并持久化，供执行追踪与审计
          const currentExecIndex = runCount + 1;
          const runId = `run-${crypto.randomUUID()}`;
          const completionToken = crypto.randomBytes(16).toString('hex');

          // Branch 1: Manual confirmation node
          if (currentNode.execution_mode === 'manual') {
            db.createNodeRun({
              run_id: runId,
              task_id: taskId,
              node_id: currentNode.id,
              execution_index: currentExecIndex,
              status: 'waiting_manual',
              completion_token: completionToken,
            });

            db.updateTaskStatus(taskId, TaskStatus.HUMAN_REVIEW, {
              current_stage: RoundStage.HUMAN_REVIEW,
              active_worker_id: null,
              current_round: currentRound,
            });

            logger.info(`[WorkflowEngine] Task ${taskId} reached manual node [${currentNode.name}]. Waiting for human review.`);
            return; // Loop pauses until manual decision submitted
          }

          let outcome: 'passed' | 'failed' = 'passed';
          let summary = '';

          // Branch 2: Command execution node (e.g. independent testing)
          if (currentNode.execution_mode === 'command') {
            db.createNodeRun({
              run_id: runId,
              task_id: taskId,
              node_id: currentNode.id,
              execution_index: currentExecIndex,
              status: 'running',
              completion_token: completionToken,
            });

            db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
              current_stage: RoundStage.RUNNING_TESTS,
              current_round: currentRound,
            });

            const testRoundDbId = db.createExecutionRound({
              task_id: taskId,
              round_number: currentRound,
              stage: RoundStage.RUNNING_TESTS,
              input_prompt: currentNode.command ? `Executing command: ${currentNode.command}` : 'Running automated test commands.',
            });

            const testCases = (currentNode.command && currentNode.command.trim())
              ? [{ id: 'TEST-CMD', command: currentNode.command.trim(), required: true }]
              : TestRunner.parseTestCases(revisionRecord.tests_md, revisionRecord.manifest_json);

            const testAggResult = await TestRunner.runAllTests(
              testCases,
              confirmedCwd,
              task.execution_timeout_ms || resolveExecutionTimeout(),
              { taskId, roundId: testRoundDbId, signal: this.taskController.signal }
            );

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
              db.updateNodeRun(runId, { status: 'blocked', result_summary: testAggResult.failureSummary, finished_at: Date.now() });
              db.updateTaskStatus(taskId, db.getTask(taskId)?.stop_requested ? TaskStatus.CANCELLED : TaskStatus.BLOCKED, {
                blocked_reason: testAggResult.failureSummary,
              });
              return;
            }

            if (!testAggResult.allPassed) {
              outcome = 'failed';
              summary = testAggResult.failureSummary || 'Automated tests failed.';
              previousTestFailureSummary = summary;
              db.completeExecutionRound(testRoundDbId, {
                status: 'failed',
                output_text: summary,
                error_message: 'Required automated tests failed.',
              });
            } else {
              outcome = 'passed';
              summary = 'All required test commands executed with exit code 0.';
              previousTestFailureSummary = null;
              db.completeExecutionRound(testRoundDbId, { status: 'passed', output_text: summary });
              db.updateTaskWorkflow(taskId, { tests_passed_generation: taskWorkflow.code_generation });
              taskWorkflow.tests_passed_generation = taskWorkflow.code_generation;
            }
          }
          // Branch 3: Agent execution node
          else if (currentNode.execution_mode === 'agent' || !currentNode.execution_mode) {
            const isAcceptance = currentNode.result_rule === 'acceptance' || currentNode.id === 'acceptance';

            // If developer node: increment code generation
            if (!isAcceptance) {
              taskWorkflow.code_generation += 1;
              db.updateTaskWorkflow(taskId, { code_generation: taskWorkflow.code_generation });
            }

            // Prerequisite check for acceptance: tests must be passed on the current code generation
            if (isAcceptance && taskWorkflow.code_generation > 0 && taskWorkflow.tests_passed_generation !== taskWorkflow.code_generation) {
              logger.warn(`[WorkflowEngine] Acceptance requires valid tests for code generation ${taskWorkflow.code_generation}, but tests passed generation is ${taskWorkflow.tests_passed_generation}. Routing to tests.`);
              // Route to test node if exists
              const testNode = nodes.find((n) => n.id === 'test' || n.execution_mode === 'command');
              if (testNode) {
                db.updateTaskWorkflow(taskId, { current_node_id: testNode.id });
                continue;
              }
            }

            db.createNodeRun({
              run_id: runId,
              task_id: taskId,
              node_id: currentNode.id,
              execution_index: currentExecIndex,
              status: 'running',
              completion_token: completionToken,
            });

            const executorName = (isAcceptance ? (task.reviewer_executor || currentNode.executor) : (task.worker_executor || currentNode.executor)) || 'workbuddy';
            const adapter = adapterRegistry.getAdapter(executorName);
            const modelName = (isAcceptance ? (task.reviewer_model || currentNode.model) : (task.worker_model || currentNode.model)) || adapter.defaultModel;

            const roundStage = isAcceptance ? RoundStage.CODEX_ACCEPTANCE : RoundStage.WORKER_DEV;

            let basePrompt = currentNode.prompt || '';
            if (!basePrompt) {
              if (isAcceptance) {
                basePrompt = revisionRecord.verifier_prompt_md || 'Perform strict acceptance verification.';
              } else {
                const promptRec = workerPrompts.find((w) => w.worker_id === nextWorkerId) || workerPrompts[0];
                basePrompt = promptRec?.prompt_text || 'Develop the requested changes.';
              }
            }

            const promptLines = [
              basePrompt,
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

            const fullPrompt = promptLines.join('\n');

            const roundDbId = db.createExecutionRound({
              task_id: taskId,
              round_number: currentRound,
              stage: roundStage,
              worker_id: isAcceptance ? null : nextWorkerId,
              adapter_id: adapter.id,
              model_name: modelName,
              input_prompt: fullPrompt,
            });

            db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
              current_stage: roundStage,
              active_worker_id: isAcceptance ? null : nextWorkerId,
              current_round: currentRound,
            });

            if (isAcceptance) {
              const diffSnapshot = GitService.getDiffSnapshot(confirmedCwd);
              const testRuns = db.getTestRuns(taskId, currentRound);
              const testSummaryText = testRuns.map((t) => `Test ${t.test_case_id} [${t.command}]: Exit code ${t.exit_code}`).join('\n');

              const verification = await new AcceptanceService().execute(adapter, {
                taskId,
                timeoutMs: task.execution_timeout_ms || resolveExecutionTimeout(),
                roundId: roundDbId,
                signal: this.taskController.signal,
                roundNumber: currentRound,
                model: modelName,
                revision: revisionRecord.revision,
                confirmedCwd,
                taskPackageDir: taskFileStore.getRevisionDir(taskId, revisionRecord.revision),
                testRunsSummary: testSummaryText,
                gitDiff: diffSnapshot.diff,
                verifierPrompt: basePrompt,
                definedWorkerIds,
              });

              if (db.getTask(taskId)?.stop_requested) {
                db.completeExecutionRound(roundDbId, { status: 'blocked', output_text: verification.rawOutput });
                db.updateNodeRun(runId, { status: 'cancelled', finished_at: Date.now() });
                db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
                return;
              }

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
                db.completeExecutionRound(roundDbId, { status: 'blocked', output_text: verification.summary });
                db.updateNodeRun(runId, { status: 'blocked', result_summary: verification.summary, finished_at: Date.now() });
                db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
                  blocked_reason: `Reviewer acceptance blocked: ${verification.summary}`,
                });
                return;
              }

              if (verification.decision === 'needs_changes') {
                outcome = 'failed';
                summary = verification.summary;
                const firstIssue = verification.issues[0];
                if (firstIssue?.targetWorkerId && definedWorkerIds.includes(firstIssue.targetWorkerId)) {
                  nextWorkerId = firstIssue.targetWorkerId;
                } else {
                  nextWorkerId = definedWorkerIds[0] || 'worker-dev';
                }

                previousRoundIssues = verification.issues.map((i) => `Issue ${i.id}: ${i.description}\nEvidence: ${i.evidence || 'N/A'}`).join('\n\n') || summary;
                db.completeExecutionRound(roundDbId, { status: 'failed', output_text: summary, issues_json: JSON.stringify(verification.issues), duration_ms: verification.durationMs });
              } else {
                outcome = 'passed';
                summary = verification.summary;
                previousRoundIssues = '';
                db.completeExecutionRound(roundDbId, { status: 'passed', output_text: summary, duration_ms: verification.durationMs });
                db.updateTaskWorkflow(taskId, { acceptance_passed_generation: taskWorkflow.code_generation });
                taskWorkflow.acceptance_passed_generation = taskWorkflow.code_generation;
              }
            } else {
              // Regular worker execution
              const workerResult = await adapter.execute({
                taskId,
                roundId: roundDbId,
                model: modelName,
                prompt: fullPrompt,
                cwd: confirmedCwd,
                signal: this.taskController.signal,
                timeoutMs: task.execution_timeout_ms || resolveExecutionTimeout(),
                kind: 'worker',
              });

              if (!workerResult.ok) {
                db.completeExecutionRound(roundDbId, {
                  status: 'failed',
                  output_text: workerResult.output,
                  error_message: workerResult.error,
                  duration_ms: workerResult.durationMs,
                });
                db.updateNodeRun(runId, {
                  status: 'blocked',
                  result_summary: workerResult.error || 'Worker execution failed',
                  finished_at: Date.now(),
                });

                if (db.getTask(taskId)?.stop_requested) {
                  db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
                  return;
                }

                const errorMsg = workerResult.error || 'Worker execution failed';
                db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
                  blocked_reason: `Worker execution encountered error: ${errorMsg}`,
                });
                return;
              }

              db.completeExecutionRound(roundDbId, {
                status: 'passed',
                output_text: workerResult.output,
                duration_ms: workerResult.durationMs,
              });

              taskFileStore.saveArtifact(
                taskId,
                revisionRecord.revision,
                `round_${currentRound}_worker_output.txt`,
                workerResult.output
              );

              const updatedRun = db.getNodeRunByRunId(runId);
              summary = updatedRun?.result_summary || 'Worker execution completed successfully.';
              outcome = 'passed';
            }
          }

          // Advance logic
          const nextTargetId = outcome === 'passed' ? currentNode.on_success : currentNode.on_failure;

          db.updateNodeRun(runId, {
            status: outcome,
            result_summary: summary,
            finished_at: Date.now(),
          });

          if (!nextTargetId) {
            const pauseReason = `节点 [${currentNode.name}] ${outcome === 'failed' ? '失败' : '完成'}后未配置去向，已暂停。`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: pauseReason });
            logger.warn(`[WorkflowEngine] Task ${taskId} paused: ${pauseReason}`);
            return;
          }

          db.updateTaskWorkflow(taskId, {
            current_node_id: nextTargetId,
            current_run_id: runId,
          });

          logger.info(`[WorkflowEngine] Node [${currentNode.name}] ${outcome}. Transitioning to node [${nextTargetId}].`);
        }
      }
    } finally {
      this.isProcessing = false;
      this.activeTaskId = null;
      this.taskController = null;
    }
  }
}

export const workflowEngine = WorkflowEngine.getInstance();
