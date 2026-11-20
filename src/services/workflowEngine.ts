import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveExecutionTimeout } from './executionPolicy.ts';
import { db, type WorkflowNodeRunRecord } from '../storage/db.ts';
import { taskFileStore, type BoundInputEntry } from '../storage/fileStore.ts';
import { GitService } from './gitService.ts';
import { z } from 'zod';
import { CliRunner } from './cliRunner.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import { AcceptanceService } from './acceptanceService.ts';
import { TaskStatus, RoundStage, DEFAULT_BUDGET_MAX_ROUNDS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { type WorkflowNode, DEFAULT_MAX_EXECUTIONS, validateWorkflowNodes } from './workflowDefinition.ts';
import {
  NODE_RESULT_SCHEMA_VERSION,
  PackageProtocolError,
  type TaskPackageManifest,
  type UnifiedNodeResult,
} from './packageProtocol.ts';
import { computeBufferSha256, encodeNodeDirName, readRegularFileSafely } from '../utils/pathSecurity.ts';
import { validateJsonAgainstSchema } from '../utils/jsonSchemaValidator.ts';

const verificationReportSchema = z.object({
  tests: z.array(z.object({
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    exit_code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })).min(1),
});

function readNodeOutputMap(run: WorkflowNodeRunRecord): Record<string, { path: string; sha256?: string; size_bytes?: number }> {
  if (!run.outputs_json) return {};
  try {
    return JSON.parse(run.outputs_json);
  } catch {
    return {};
  }
}

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

    if (task.status === TaskStatus.DELETING || task.status === TaskStatus.CLEANUP_FAILED) {
      return { success: false, message: `Task ${taskId} is being deleted (${task.status})` };
    }

    if (task.status !== TaskStatus.PENDING_CONFIRM && task.status !== TaskStatus.BLOCKED) {
      return { success: false, message: `Cannot start task with status: ${task.status}` };
    }

    if (this.isProcessing || CliRunner.hasCleanupFailure()) {
      return { success: false, message: `Workbench is currently executing another task: ${this.activeTaskId}` };
    }

    const revRecord = db.getRevision(taskId, task.revision);
    if (!revRecord) {
      return { success: false, message: `Task package revision r${task.revision} not found` };
    }
    if (revRecord.readiness !== 'ready') {
      return { success: false, message: `Task package revision r${task.revision} is blocked and not ready to start` };
    }

    const targetCwd = confirmedCwd ? confirmedCwd.trim() : task.target_cwd;
    try {
      GitService.inspectWorkspace(targetCwd);
    } catch (e: any) {
      return { success: false, message: `Invalid workspace path: ${e.message}` };
    }

    let taskWf = db.getTaskWorkflow(taskId);
    if (!taskWf) {
      taskWf = db.initTaskWorkflow(taskId, { revision: task.revision });
    }
    let nodes: WorkflowNode[] = [];
    try {
      nodes = JSON.parse(taskWf.nodes_json);
    } catch {
      nodes = [];
    }

    // Apply any test/runtime overrides to agent nodes
    if (options?.workerExecutor || options?.workerModel || options?.reviewerExecutor || options?.reviewerModel) {
      let modified = false;
      for (const node of nodes) {
        if (node.execution_mode === 'agent') {
          if (node.result_rule === 'acceptance') {
            if (options.reviewerExecutor) { node.executor = options.reviewerExecutor; modified = true; }
            if (options.reviewerModel) { node.model = options.reviewerModel; modified = true; }
          } else {
            if (options.workerExecutor) { node.executor = options.workerExecutor; modified = true; }
            if (options.workerModel) { node.model = options.workerModel; modified = true; }
          }
        }
      }
      if (modified) {
        db.updateTaskWorkflow(taskId, { nodes_json: JSON.stringify(nodes) });
      }
    }

    // Validate that every agent node has a registered adapter
    for (const node of nodes) {
      if (node.execution_mode === 'agent' && node.executor) {
        try {
          adapterRegistry.getAdapter(node.executor);
        } catch (error) {
          return { success: false, message: String(error) };
        }
      }
    }

    const workerExecutor = options?.workerExecutor || task.worker_executor || 'workbuddy';
    const reviewerExecutor = options?.reviewerExecutor || task.reviewer_executor || 'workbuddy';
    const workerModel = options?.workerModel || task.worker_model;
    const reviewerModel = options?.reviewerModel || task.reviewer_model;

    const executionTimeoutMs = resolveExecutionTimeout(options?.executionTimeoutMs, task.execution_timeout_ms);
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
    } catch (error) {
      this.isProcessing = false;
      this.activeTaskId = null;
      throw error;
    }

    logger.info(
      `[WorkflowEngine] Task ${taskId} confirmed and queued. Cwd: ${targetCwd}`
    );

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

  async handleTaskDeleted(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId && !CliRunner.hasTaskRuns(taskId)) return;
    this.stopTask(taskId);
    await CliRunner.abort(taskId);
    const deadline = Date.now() + 10000;
    while (this.activeTaskId === taskId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.activeTaskId === taskId || CliRunner.hasTaskRuns(taskId)) {
      throw new Error('CLEANUP_FAILED: 进程回收未确认，保留任务与日志。');
    }
  }

  async handleAllTasksDeleted(): Promise<void> {
    if (this.activeTaskId) await this.handleTaskDeleted(this.activeTaskId);
    if (CliRunner.hasCleanupFailure()) {
      throw new Error('CLEANUP_FAILED: 存在未回收进程，保留任务与日志。' + CliRunner.pendingRunIds().join(','));
    }
  }

  async submitHumanDecision(
    taskId: string,
    action: 'approve' | 'reject',
    reason: string
  ): Promise<{ success: boolean; message: string }> {
    const task = db.getTask(taskId);
    if (!task) return { success: false, message: 'Task not found' };

    if (task.status === TaskStatus.DELETING || task.status === TaskStatus.CLEANUP_FAILED) {
      return { success: false, message: `Task is being deleted (${task.status})` };
    }

    if (task.status !== TaskStatus.HUMAN_REVIEW) {
      return { success: false, message: `Task is not in human review state (current: ${task.status})` };
    }

    if (action === 'reject' && this.isBusy()) {
      return { success: false, message: `Workbench is currently executing another task: ${this.activeTaskId}` };
    }

    db.saveHumanDecision({ task_id: taskId, action, reason });

    let taskWf = db.getTaskWorkflow(taskId);
    if (!taskWf) {
      taskWf = db.initTaskWorkflow(taskId, { revision: task.revision });
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
    const outcome = action === 'approve' ? 'passed' : 'failed';
    const summaryText = reason || (action === 'approve' ? '人工审核通过' : '人工审核退回');

    if (latestRun && latestRun.status === 'waiting_manual') {
      let resultJsonStr: string | null = null;
      let resultSha: string | null = null;
      let outputsJsonStr: string | null = null;

      if (latestRun.attempt_dir && fs.existsSync(latestRun.attempt_dir)) {
        const revRec = db.getRevision(taskId, task.revision);
        const resultObj: UnifiedNodeResult = {
          schema_version: NODE_RESULT_SCHEMA_VERSION,
          task_id: taskId,
          revision: task.revision,
          package_digest: revRec?.package_digest || '0'.repeat(64),
          node_id: latestRun.node_id,
          attempt_id: latestRun.run_id,
          execution_index: latestRun.execution_index,
          code_generation: latestRun.code_generation,
          outcome,
          summary: summaryText,
          issues: action === 'reject' && reason ? [{ id: 'HUMAN-REJECT', description: reason }] : [],
          outputs: {
            result: { path: 'outputs/result.json' },
          },
        };
        const outputsDir = path.join(latestRun.attempt_dir, 'outputs');
        fs.mkdirSync(outputsDir, { recursive: true });
        resultJsonStr = JSON.stringify(resultObj, null, 2) + '\n';
        const resultBuf = Buffer.from(resultJsonStr, 'utf8');
        fs.writeFileSync(path.join(outputsDir, 'result.json'), resultBuf);
        resultSha = computeBufferSha256(resultBuf);
        outputsJsonStr = JSON.stringify({
          result: { path: 'outputs/result.json', sha256: resultSha, size_bytes: resultBuf.length },
        });
      }

      db.updateNodeRun(latestRun.run_id, {
        status: outcome,
        result_summary: summaryText,
        result_json: resultJsonStr,
        result_sha256: resultSha,
        outputs_json: outputsJsonStr,
        finished_at: Date.now(),
      });
    }

    const nextNodeId = action === 'approve' ? currentNode?.on_success : currentNode?.on_failure;
    if (!nextNodeId || !nodes.some((n) => n.id === nextNodeId)) {
      const pauseReason = `人工节点 [${currentNode?.name || currentNodeId}] ${action === 'approve' ? '通过' : '退回'}后未配置有效去向`;
      db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: pauseReason });
      return { success: false, message: pauseReason };
    }

    db.updateTaskWorkflow(taskId, { current_node_id: nextNodeId });

    if (action === 'approve') {
      const nextNode = nodes.find((n) => n.id === nextNodeId);
      if (nextNode && nextNode.type === 'end') {
        const hasVerificationNode = nodes.some((n) => n.type === 'task' && n.result_rule === 'verification');
        const hasAcceptanceNode = nodes.some((n) => n.type === 'task' && n.result_rule === 'acceptance');
        if (
          taskWf.code_generation > 0 &&
          ((hasVerificationNode && taskWf.tests_passed_generation !== taskWf.code_generation) ||
            (hasAcceptanceNode && taskWf.acceptance_passed_generation !== taskWf.code_generation))
        ) {
          const blockMsg = `流程到达结束节点，但测试或验收代次未对齐当前代码代次 (代码: ${taskWf.code_generation}, 测试: ${taskWf.tests_passed_generation}, 验收: ${taskWf.acceptance_passed_generation})。`;
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: blockMsg });
          return { success: false, message: blockMsg };
        }
        db.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
          completed_at: Date.now(),
        });
        logger.info(`[WorkflowEngine] Task ${taskId} approved by human reviewer. Completed!`);
        return { success: true, message: 'Task approved and completed.' };
      }
    }

    this.isProcessing = true;
    this.activeTaskId = taskId;
    logger.info(`[WorkflowEngine] Task ${taskId} manual decision [${action}]. Transitioning to [${nextNodeId}].`);

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
      this.runTaskLoop(taskId, reason ? `Manual Review Feedback: ${reason}` : undefined).catch((err) => {
        logger.error('[WorkflowEngine] Error resuming task after manual decision:', err);
      });
    });

    return { success: true, message: 'Manual decision recorded. Resuming workflow execution.' };
  }

  private resolveInputBindings(
    _taskId: string,
    _revision: number,
    _codeGeneration: number
  ): {
    ok: boolean;
    errorMessage?: string;
    bindings: Array<BoundInputEntry & { sourceAbsPath: string }>;
    inputsSummaryText: string;
  } {
    return {
      ok: true,
      bindings: [],
      inputsSummaryText: '',
    };
  }

  /** 收录测试节点自行执行的证据，非零退出码不能被文字结论覆盖。 */
  private recordVerificationReport(taskId: string, round: number, nodeId: string, attemptDir: string) {
    const reportPath = 'outputs/test_report.json';
    const buffer = readRegularFileSafely(attemptDir, reportPath);
    const report = verificationReportSchema.parse(JSON.parse(buffer.toString('utf8')));
    for (const [index, test] of report.tests.entries()) {
      db.saveTestRun({
        task_id: taskId,
        round_number: round,
        test_case_id: `${nodeId}-${index + 1}`,
        command: test.command,
        exit_code: test.exit_code,
        stdout: test.stdout,
        stderr: test.stderr,
        report_path: reportPath,
        report_content: JSON.stringify(test),
        passed: test.exit_code === 0,
      });
    }
    const failures = report.tests.filter((test) => test.exit_code !== 0);
    return {
      passed: failures.length === 0,
      summary: failures.map((test) => `${test.command} (退出码 ${test.exit_code})\n${test.stderr || test.stdout}`).join('\n\n'),
      output: { path: reportPath, sha256: computeBufferSha256(buffer), size_bytes: buffer.length },
    };
  }

  private validateAndRecordNodeOutputs(params: {
    taskId: string;
    revision: number;
    packageDigest: string;
    nodeId: string;
    attemptId: string;
    executionIndex: number;
    codeGeneration: number;
    outcome: 'passed' | 'failed' | 'blocked';
    summary: string;
    issues: Array<{ id: string; description: string; evidence?: string }>;
    attemptDir: string;
    outputsDir: string;
    extraOutputs?: Record<string, { path: string; sha256: string; size_bytes: number }>;
  }): {
    valid: boolean;
    errorMessage?: string;
    resultJson: string;
    resultSha256: string;
    outputsMap: Record<string, { path: string; sha256: string; size_bytes: number }>;
  } {
    const outputsMap: Record<string, { path: string; sha256: string; size_bytes: number }> = {
      ...(params.extraOutputs || {}),
    };

    // Scan outputsDir for output files if any
    if (fs.existsSync(params.outputsDir)) {
      try {
        const files = fs.readdirSync(params.outputsDir);
        for (const file of files) {
          if (file === 'result.json') continue;
          const nameWithoutExt = file.replace(/\.[^.]+$/, '');
          if (!outputsMap[nameWithoutExt] && !outputsMap[file]) {
            const filePath = path.join(params.outputsDir, file);
            if (fs.statSync(filePath).isFile()) {
              const buf = fs.readFileSync(filePath);
              outputsMap[nameWithoutExt] = {
                path: `outputs/${file}`,
                sha256: computeBufferSha256(buf),
                size_bytes: buf.length,
              };
            }
          }
        }
      } catch {}
    }

    const resultPath = path.join(params.outputsDir, 'result.json');
    const resultObj: UnifiedNodeResult = {
      schema_version: NODE_RESULT_SCHEMA_VERSION,
      task_id: params.taskId,
      revision: params.revision,
      package_digest: params.packageDigest,
      node_id: params.nodeId,
      attempt_id: params.attemptId,
      execution_index: params.executionIndex,
      code_generation: params.codeGeneration,
      outcome: params.outcome,
      summary: params.summary,
      issues: params.issues,
      outputs: {
        ...outputsMap,
        result: { path: 'outputs/result.json' },
      },
    };

    const resultJson = JSON.stringify(resultObj, null, 2) + '\n';
    const resultBuf = Buffer.from(resultJson, 'utf8');
    fs.writeFileSync(resultPath, resultBuf);
    const resultSha256 = computeBufferSha256(resultBuf);

    outputsMap.result = {
      path: 'outputs/result.json',
      sha256: resultSha256,
      size_bytes: resultBuf.length,
    };
    resultObj.outputs.result = outputsMap.result;
    const finalResultJson = JSON.stringify(resultObj, null, 2) + '\n';
    const finalBuf = Buffer.from(finalResultJson, 'utf8');
    fs.writeFileSync(resultPath, finalBuf);
    const finalResultSha = computeBufferSha256(finalBuf);
    outputsMap.result = {
      path: 'outputs/result.json',
      sha256: finalResultSha,
      size_bytes: finalBuf.length,
    };

    return {
      valid: true,
      resultJson: finalResultJson,
      resultSha256: finalResultSha,
      outputsMap,
    };
  }

  private async runTaskLoop(taskId: string, initialReworkFeedback?: string): Promise<void> {
    this.isProcessing = true;
    this.activeTaskId = taskId;
    this.taskController = new AbortController();

    try {
      const task = db.getTask(taskId);
      if (!task) return;

      const revisionRecord = db.getRevision(taskId, task.revision) || db.getLatestRevision(taskId);
      if (!revisionRecord) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: 'Task package revision materials not found.',
        });
        return;
      }

      let manifest: TaskPackageManifest;
      try {
        manifest = JSON.parse(revisionRecord.manifest_json) as TaskPackageManifest;
      } catch (err: any) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: `任务包 Manifest 解析失败: ${err?.message || err}`,
        });
        return;
      }

      let taskWorkflow = db.getTaskWorkflow(taskId);
      if (!taskWorkflow) {
        taskWorkflow = db.initTaskWorkflow(taskId, { revision: revisionRecord.revision });
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
      const workflowValidation = validateWorkflowNodes(nodes, taskWorkflow.workflow_id);
      if (!workflowValidation.valid) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: `工作流定义无效，请重新编排后提交任务: ${workflowValidation.errors.join('; ')}`,
        });
        return;
      }
      const definedTaskNodeIds = nodes.filter((n) => n.type === 'task').map((n) => n.id);
      const hasVerificationNode = nodes.some((n) => n.type === 'task' && n.result_rule === 'verification');
      const hasAcceptanceNode = nodes.some((n) => n.type === 'task' && n.result_rule === 'acceptance');

      let previousRoundIssues = initialReworkFeedback || '';
      let currentRound = task.current_round || 0;
      const maxRounds = task.budget_max_rounds || DEFAULT_BUDGET_MAX_ROUNDS;
      const nodesExecutedThisRound = new Set<string>();
      if (currentRound > 0) {
        for (const nr of db.getNodeRuns(taskId)) {
          if (nr.round_number === currentRound && nr.status !== 'blocked') {
            nodesExecutedThisRound.add(nr.node_id);
          }
        }
      }

      db.updateTaskStatus(taskId, TaskStatus.RUNNING);

      while (true) {
        const freshTask = db.getTask(taskId);
        if (!freshTask || freshTask.status === TaskStatus.DELETING || freshTask.status === TaskStatus.CLEANUP_FAILED) {
          logger.info(`[WorkflowEngine] Task ${taskId} deleted or deleting; halting loop.`);
          return;
        }
        if (freshTask.stop_requested) {
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
          return;
        }

        if (currentNode.type === 'start') {
          const targetId = currentNode.on_success;
          if (!targetId || !nodes.some((n) => n.id === targetId)) {
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
              blocked_reason: `开始节点的后继节点无效: ${targetId}`,
            });
            return;
          }
          db.updateTaskWorkflow(taskId, { current_node_id: targetId });
          continue;
        }

        if (currentNode.type === 'end') {
          if (
            taskWorkflow.code_generation > 0 &&
            ((hasVerificationNode && taskWorkflow.tests_passed_generation !== taskWorkflow.code_generation) ||
              (hasAcceptanceNode && taskWorkflow.acceptance_passed_generation !== taskWorkflow.code_generation))
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

        if (currentNode.type === 'task') {
          const revDir = taskFileStore.getRevisionDir(taskId, revisionRecord.revision);
          const workFilePath = path.join(revDir, 'nodes', currentNode.id, 'work.md');
          if (!fs.existsSync(workFilePath)) {
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
              blocked_reason: `任务包修订材料中缺少节点 [${currentNode.id}] 的 work.md`,
            });
            return;
          }

          const runCount = db.getNodeRunCount(taskId, currentNode.id);
          const maxExecutions = currentNode.max_executions || DEFAULT_MAX_EXECUTIONS;
          if (maxExecutions > 0 && runCount >= maxExecutions) {
            const reason = `节点 [${currentNode.name}] 已达到最大执行次数上限 (${maxExecutions} 次)`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
            return;
          }

          if (currentRound === 0 || nodesExecutedThisRound.has(currentNode.id)) {
            currentRound++;
            nodesExecutedThisRound.clear();
          }
          nodesExecutedThisRound.add(currentNode.id);

          if (task.budget_max_rounds && currentRound > maxRounds) {
            const reason = `Maximum execution budget exceeded (${maxRounds} rounds). Execution paused.`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
              blocked_reason: reason,
              current_round: currentRound - 1,
            });
            logger.warn(`[WorkflowEngine] Task ${taskId} blocked: ${reason}`);
            return;
          }

          const isAcceptance = currentNode.execution_mode === 'agent' && currentNode.result_rule === 'acceptance';
          const isVerification = currentNode.execution_mode === 'agent' && currentNode.result_rule === 'verification';

          // Code generation update for non-acceptance agent execution
          if (currentNode.execution_mode === 'agent' && !isAcceptance && !isVerification) {
            taskWorkflow.code_generation += 1;
            db.updateTaskWorkflow(taskId, { code_generation: taskWorkflow.code_generation });
          }

          // 测试 Agent 的证据必须对应本轮代码，不能沿用返工前的结果。
          if (
            isAcceptance &&
            hasVerificationNode &&
            taskWorkflow.code_generation > 0 &&
            taskWorkflow.tests_passed_generation !== taskWorkflow.code_generation
          ) {
            const testNode = nodes.find((n) => n.type === 'task' && n.result_rule === 'verification');
            if (testNode) {
              logger.warn(
                `[WorkflowEngine] Acceptance requires fresh verification run for code generation ${taskWorkflow.code_generation}. Routing to [${testNode.id}].`
              );
              db.updateTaskWorkflow(taskId, { current_node_id: testNode.id });
              continue;
            }
          }

          // Resolve input_bindings
          const inputResolution = this.resolveInputBindings(
            taskId,
            revisionRecord.revision,
            taskWorkflow.code_generation
          );
          if (!inputResolution.ok) {
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
              blocked_reason: inputResolution.errorMessage || '节点输入绑定未满足',
            });
            return;
          }

          const currentExecIndex = runCount + 1;
          const runId = `run-${crypto.randomUUID()}`;
          const completionToken = crypto.randomBytes(16).toString('hex');

          const feedbackSections: string[] = [];
          if (previousRoundIssues) {
            feedbackSections.push(`### 上游审查 / 退回反馈\n${previousRoundIssues}`);
          }
          const reworkFeedback = feedbackSections.join('\n\n');

          const materialized = taskFileStore.materializeNodeRunDirectory({
            taskId,
            revision: revisionRecord.revision,
            packageDigest: revisionRecord.package_digest,
            workflowId: taskWorkflow.workflow_id,
            workflowSha256: taskWorkflow.workflow_sha256,
            nodeId: currentNode.id,
            nodeName: currentNode.name,
            executionMode: currentNode.execution_mode || 'agent',
            resultRule: currentNode.result_rule,
            attemptId: runId,
            executionIndex: currentExecIndex,
            codeGeneration: taskWorkflow.code_generation,
            targetCwd: confirmedCwd,
            reworkFeedback: reworkFeedback || undefined,
            completionToken,
          });

          const inputsMetaJson = JSON.stringify(
            inputResolution.bindings.map(({ sourceAbsPath, ...rest }) => rest)
          );

          // Branch 1: Manual node
          if (currentNode.execution_mode === 'manual') {
            db.createNodeRun({
              run_id: runId,
              task_id: taskId,
              revision: revisionRecord.revision,
              node_id: currentNode.id,
              execution_index: currentExecIndex,
              round_number: currentRound,
              code_generation: taskWorkflow.code_generation,
              status: 'waiting_manual',
              completion_token: completionToken,
              attempt_dir: materialized.paths.attemptDir,
              inputs_json: inputsMetaJson,
            });

            db.updateTaskStatus(taskId, TaskStatus.HUMAN_REVIEW, {
              current_stage: RoundStage.HUMAN_REVIEW,
              active_worker_id: null,
              current_round: currentRound,
            });

            logger.info(`[WorkflowEngine] Task ${taskId} reached manual node [${currentNode.name}]. Waiting for user decision.`);
            return;
          }

          let outcome: 'passed' | 'failed' = 'passed';
          let summary = '';
          let issuesForResult: Array<{ id: string; description: string; evidence?: string }> = [];
          const extraOutputs: Record<string, { path: string; sha256: string; size_bytes: number }> = {};

          // 自动节点统一由 Agent 按提示词执行。
          {
            db.createNodeRun({
              run_id: runId,
              task_id: taskId,
              revision: revisionRecord.revision,
              node_id: currentNode.id,
              execution_index: currentExecIndex,
              round_number: currentRound,
              code_generation: taskWorkflow.code_generation,
              status: 'running',
              completion_token: completionToken,
              attempt_dir: materialized.paths.attemptDir,
              inputs_json: inputsMetaJson,
            });

            const executorName = currentNode.executor || (isAcceptance ? 'codex' : 'workbuddy');
            const adapter = adapterRegistry.getAdapter(executorName);
            const modelName =
              (currentNode.model && currentNode.model !== 'default')
                ? currentNode.model
                : adapter.defaultModel;

            const roundStage = isAcceptance
              ? RoundStage.CODEX_ACCEPTANCE
              : currentNode.result_rule === 'verification'
              ? RoundStage.RUNNING_TESTS
              : RoundStage.WORKER_DEV;

            let nodePromptContent = '';
            try {
              const pPath = path.join(materialized.paths.materialDir, 'prompt.md');
              if (fs.existsSync(pPath)) {
                nodePromptContent = fs.readFileSync(pPath, 'utf8').trim();
              }
            } catch {}
            // 提示词优先级：优先使用任务包中的 prompt.md；若无或为空，则自动回退至平台工作流模板中该节点的默认提示词
            const effectivePrompt = nodePromptContent || currentNode.prompt?.trim() || '';

            let workMdContent = '';
            try {
              const wPath = path.join(materialized.paths.materialDir, 'work.md');
              if (fs.existsSync(wPath)) {
                workMdContent = fs.readFileSync(wPath, 'utf8').trim();
              }
            } catch {}

            let reqMdContent = '';
            try {
              const rPath = path.join(materialized.paths.sharedDir, 'requirements.md');
              if (fs.existsSync(rPath)) {
                reqMdContent = fs.readFileSync(rPath, 'utf8').trim();
              }
            } catch {}

            let devMdContent = '';
            try {
              const dPath = path.join(materialized.paths.sharedDir, 'development.md');
              if (fs.existsSync(dPath)) {
                devMdContent = fs.readFileSync(dPath, 'utf8').trim();
              }
            } catch {}

            const promptLines = [
              effectivePrompt ? `## 节点执行指令\n${effectivePrompt}` : '',
              workMdContent ? `## 本节点具体工作 (work.md)\n${workMdContent}` : '',
              reqMdContent ? `## 需求文档 (requirements.md)\n${reqMdContent}` : '',
              devMdContent ? `## 开发文档 (development.md)\n${devMdContent}` : '',
              '---',
              '## Isolated Node Attempt Runtime Context',
              `Task ID: ${taskId} (Revision: r${revisionRecord.revision}, Digest: ${revisionRecord.package_digest})`,
              `Node ID: ${currentNode.id} (${currentNode.name})`,
              `Attempt ID: ${runId} (Execution #${currentExecIndex}, Round ${currentRound})`,
              `Working Directory: ${confirmedCwd}`,
              `Isolated Attempt Directory: ${materialized.paths.attemptDir}`,
              `Material Directory: ${materialized.paths.materialDir}`,
              `Shared Directory: ${materialized.paths.sharedDir}`,
              `Context Manifest: ${materialized.paths.contextPath}`,
              `Outputs Dir: ${materialized.paths.outputsDir}`,
            ].filter(Boolean);
            if (isVerification) {
              promptLines.push(
                '自行检查项目和任务材料，选择并真实运行测试命令；不修改业务代码。',
                '将证据保存为 Outputs Dir 下的 test_report.json，格式为 {"tests":[{"command":"实际运行的命令","cwd":"实际工作目录","exit_code":0,"stdout":"实际标准输出","stderr":"实际错误输出"}]}。',
                'tests 至少包含一条实际执行记录；无法运行或缺失证据时如实报告阻塞。工作台根据退出码判定测试结果，不要求用户配置命令。'
              );
            }
            if (reworkFeedback) {
              promptLines.push(reworkFeedback);
            }
            const fullPrompt = promptLines.join('\n\n');

            const roundDbId = db.createExecutionRound({
              task_id: taskId,
              round_number: currentRound,
              stage: roundStage,
              worker_id: currentNode.id,
              adapter_id: adapter.id,
              model_name: modelName,
              input_prompt: fullPrompt,
            });

            db.updateTaskStatus(taskId, TaskStatus.RUNNING, {
              current_stage: roundStage,
              active_worker_id: currentNode.id,
              current_round: currentRound,
            });

            if (isAcceptance) {
              const diffSnapshot = GitService.getDiffSnapshot(confirmedCwd);
              const testRuns = db.getTestRuns(taskId, currentRound);
              const testSummaryText = testRuns
                .map((t) => `Command ${t.test_case_id} [${t.command}]: Exit code ${t.exit_code}`)
                .join('\n');

              const verification = await new AcceptanceService().execute(adapter, {
                taskId,
                nodeId: currentNode.id,
                attemptId: runId,
                timeoutMs: task.execution_timeout_ms || resolveExecutionTimeout(),
                roundId: roundDbId,
                signal: this.taskController.signal,
                roundNumber: currentRound,
                model: modelName,
                revision: revisionRecord.revision,
                confirmedCwd,
                attemptDir: materialized.paths.attemptDir,
                nodePrompt: effectivePrompt,
                materialFiles: ['work.md'],
                sharedFiles: ['requirements.md', 'development.md'],
                boundInputsSummary: '',
                testRunsSummary: testSummaryText,
                gitDiff: diffSnapshot.diff,
                definedNodeIds: definedTaskNodeIds,
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

              const accReportBuf = Buffer.from(JSON.stringify(verification, null, 2) + '\n', 'utf8');
              fs.writeFileSync(path.join(materialized.paths.outputsDir, 'acceptance-report.json'), accReportBuf);
              extraOutputs.acceptance_report = {
                path: 'outputs/acceptance-report.json',
                sha256: computeBufferSha256(accReportBuf),
                size_bytes: accReportBuf.length,
              };

              if (verification.decision === 'blocked') {
                db.completeExecutionRound(roundDbId, { status: 'blocked', output_text: verification.summary });
                db.updateNodeRun(runId, {
                  status: 'blocked',
                  result_summary: verification.summary,
                  finished_at: Date.now(),
                });
                db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
                  blocked_reason: `Reviewer acceptance blocked: ${verification.summary}`,
                });
                return;
              }

              if (verification.decision === 'needs_changes') {
                outcome = 'failed';
                summary = verification.summary;
                issuesForResult = verification.issues.map((i) => ({
                  id: i.id,
                  description: i.description,
                  evidence: i.evidence,
                }));
                previousRoundIssues =
                  verification.issues
                    .map((i) => `Issue ${i.id}: ${i.description}\nEvidence: ${i.evidence || 'N/A'}`)
                    .join('\n\n') || summary;
                db.completeExecutionRound(roundDbId, {
                  status: 'failed',
                  output_text: summary,
                  issues_json: JSON.stringify(verification.issues),
                  duration_ms: verification.durationMs,
                });
              } else {
                outcome = 'passed';
                summary = verification.summary;
                previousRoundIssues = '';
                db.completeExecutionRound(roundDbId, {
                  status: 'passed',
                  output_text: summary,
                  duration_ms: verification.durationMs,
                });
                db.updateTaskWorkflow(taskId, { acceptance_passed_generation: taskWorkflow.code_generation });
                taskWorkflow.acceptance_passed_generation = taskWorkflow.code_generation;
              }
            } else {
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
                  result_summary: workerResult.error || 'Agent execution failed',
                  finished_at: Date.now(),
                });

                if (db.getTask(taskId)?.stop_requested) {
                  db.updateTaskStatus(taskId, TaskStatus.CANCELLED);
                  return;
                }

                const errorMsg = workerResult.error || 'Agent execution failed';
                db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
                  blocked_reason: `Agent execution encountered error: ${errorMsg}`,
                });
                return;
              }

              db.completeExecutionRound(roundDbId, {
                status: 'passed',
                output_text: workerResult.output,
                duration_ms: workerResult.durationMs,
              });

              const outTxtBuf = Buffer.from(workerResult.output || '', 'utf8');
              fs.writeFileSync(path.join(materialized.paths.outputsDir, 'agent-output.txt'), outTxtBuf);
              extraOutputs.agent_output = {
                path: 'outputs/agent-output.txt',
                sha256: computeBufferSha256(outTxtBuf),
                size_bytes: outTxtBuf.length,
              };

              const updatedRun = db.getNodeRunByRunId(runId);
              summary = updatedRun?.result_summary || `Node ${currentNode.name} completed.`;
              if (updatedRun?.reported_outcome === 'failed') {
                outcome = 'failed';
                issuesForResult = [{ id: `REPORT-${currentNode.id}`, description: summary }];
                previousRoundIssues = summary;
              } else {
                outcome = 'passed';
              }
              if (isVerification) {
                try {
                  const report = this.recordVerificationReport(taskId, currentRound, currentNode.id, materialized.paths.attemptDir);
                  extraOutputs.test_report = report.output;
                  if (!report.passed) {
                    outcome = 'failed';
                    summary = report.summary;
                    issuesForResult = [{ id: `TEST-${currentNode.id}`, description: summary }];
                    previousRoundIssues = summary;
                  }
                  db.completeExecutionRound(roundDbId, { status: outcome, output_text: workerResult.output });
                } catch (error: any) {
                  const reason = `测试节点 [${currentNode.name}] 缺少有效执行证据: ${error.message}`;
                  db.completeExecutionRound(roundDbId, { status: 'blocked', output_text: workerResult.output, error_message: reason });
                  db.updateNodeRun(runId, { status: 'blocked', result_summary: reason, finished_at: Date.now() });
                  db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
                  return;
                }
              }
            }
          }

          // Record outputs and persist canonical result.json
          const outputCheck = this.validateAndRecordNodeOutputs({
            taskId,
            revision: revisionRecord.revision,
            packageDigest: revisionRecord.package_digest,
            nodeId: currentNode.id,
            attemptId: runId,
            executionIndex: currentExecIndex,
            codeGeneration: taskWorkflow.code_generation,
            outcome,
            summary,
            issues: issuesForResult,
            attemptDir: materialized.paths.attemptDir,
            outputsDir: materialized.paths.outputsDir,
            extraOutputs,
          });

          if (!outputCheck.valid) {
            const errMsg = outputCheck.errorMessage || '节点输出契约校验失败';
            db.updateNodeRun(runId, {
              status: 'blocked',
              result_summary: errMsg,
              result_json: outputCheck.resultJson,
              result_sha256: outputCheck.resultSha256,
              outputs_json: JSON.stringify(outputCheck.outputsMap),
              finished_at: Date.now(),
            });
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
              blocked_reason: errMsg,
            });
            return;
          }

          db.updateNodeRun(runId, {
            status: outcome,
            result_summary: summary,
            result_json: outputCheck.resultJson,
            result_sha256: outputCheck.resultSha256,
            outputs_json: JSON.stringify(outputCheck.outputsMap),
            finished_at: Date.now(),
          });

          if (isVerification && outcome === 'passed') {
            db.updateTaskWorkflow(taskId, { tests_passed_generation: taskWorkflow.code_generation });
          }

          const nextTargetId = outcome === 'passed' ? currentNode.on_success : currentNode.on_failure;
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
