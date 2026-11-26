import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveExecutionTimeout } from './executionPolicy.ts';
import { db, type ReworkDocument, type TaskRecord, type WorkflowNodeRunRecord } from '../storage/db.ts';
import { taskFileStore, type BoundInputEntry, type MaterializedAttemptPaths } from '../storage/fileStore.ts';
import { GitService } from './gitService.ts';
import { CliRunner } from './cliRunner.ts';
import { adapterRegistry } from '../adapters/registry.ts';
import { reviewEvidenceExample } from './acceptanceService.ts';
import type { AgentExecutionResult } from '../adapters/types.ts';
import { callLocalAdvance, completionCommand } from '../cli/completeNode.ts';
import {
  ACCEPTANCE_REPORT_PATH, REWORK_OUTPUT_DIR, TEST_REPORT_PATH, checkCompletionFiles, resolveReworkTarget, reworkFileName,
  type CompletionPayload,
} from './nodeCompletion.ts';
import { TaskStatus, RoundStage, DEFAULT_BUDGET_MAX_ROUNDS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { type WorkflowNode, DEFAULT_MAX_EXECUTIONS, resolveTaskNodeExecutor, validateWorkflowNodes } from './workflowDefinition.ts';
import {
  NODE_RESULT_SCHEMA_VERSION,
  PACKAGE_LIMITS,
  type TaskPackageManifest,
  type UnifiedNodeResult,
} from './packageProtocol.ts';
import { computeBufferSha256, readRegularFileSafely } from '../utils/pathSecurity.ts';

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

    const revisionDir = taskFileStore.getRevisionDir(taskId, task.revision);
    for (const node of nodes.filter(item => item.type === 'task')) {
      const promptPath = `nodes/${node.id}/prompt.md`;
      try {
        if (!readRegularFileSafely(revisionDir, promptPath).toString('utf8').trim()) throw new Error('提示词为空');
      } catch {
        return { success: false, message: `修订 r${task.revision} 缺少有效的 ${promptPath}，请补齐后提交新修订` };
      }
    }

    // Apply any test/runtime overrides to agent nodes
    let modified = false;
    if (options?.workerExecutor || options?.workerModel || options?.reviewerExecutor || options?.reviewerModel) {
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
    }

    // Validate that every agent node has a registered adapter
    for (const node of nodes) {
      if (node.execution_mode === 'agent') {
        try {
          adapterRegistry.getAdapter(resolveTaskNodeExecutor(node));
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
      if (modified) db.updateTaskWorkflow(taskId, { nodes_json: JSON.stringify(nodes) });
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

    const activeRun = taskWf.current_run_id ? db.getNodeRunByRunId(taskWf.current_run_id) : null;
    const candidateRun = activeRun?.status === 'waiting_manual' ? activeRun : db.getLatestNodeRun(taskId, currentNode?.id || currentNodeId);
    const latestRun = candidateRun?.revision === task.revision && candidateRun.status === 'waiting_manual' &&
      candidateRun.node_id === currentNode?.id ? candidateRun : null;
    const outcome = action === 'approve' ? 'passed' : 'failed';
    const summaryText = reason || (action === 'approve' ? '人工审核通过' : '人工审核退回');
    const nextNodeId = action === 'approve' ? currentNode?.on_success : currentNode?.on_failure;
    const nextNode = nodes.find(node => node.id === nextNodeId);
    const reworkTarget = action === 'reject' && latestRun && currentNode ? resolveReworkTarget(latestRun, currentNode) : undefined;
    if (reworkTarget && !reason.trim()) return { success: false, message: '请填写退回意见' };
    if (reworkTarget && Buffer.byteLength(reason, 'utf8') > PACKAGE_LIMITS.max_read_chunk_bytes) {
      return { success: false, message: '退回意见超过 256 KiB' };
    }
    if (nextNode && nextNode.type !== 'end' && this.isBusy()) {
      return { success: false, message: `Workbench is currently executing another task: ${this.activeTaskId}` };
    }
    const reachedEnd = nextNode?.type === 'end';
    const staleEvidence = reachedEnd && taskWf.code_generation > 0 && nodes.some(node =>
      (node.result_rule === 'verification' && taskWf.tests_passed_generation !== taskWf.code_generation) ||
      (node.result_rule === 'acceptance' && taskWf.acceptance_passed_generation !== taskWf.code_generation));
    const pauseReason = !nextNode
      ? `人工节点 [${currentNode?.name || currentNodeId}] ${action === 'approve' ? '通过' : '退回'}后未配置有效去向`
      : staleEvidence ? '流程到达结束节点，但测试或验收代次未对齐当前代码代次。' : null;

    db.transaction(() => {
      db.saveHumanDecision({ task_id: taskId, action, reason });
      if (latestRun) {
        const attemptDir = latestRun.attempt_dir;
        const result = attemptDir && fs.existsSync(attemptDir) ? this.recordNodeOutputs({
          taskId, revision: task.revision, packageDigest: db.getRevision(taskId, task.revision)?.package_digest || '0'.repeat(64),
          nodeId: latestRun.node_id, attemptId: latestRun.run_id, executionIndex: latestRun.execution_index,
          codeGeneration: latestRun.code_generation, outcome, summary: summaryText,
          issues: action === 'reject' && reason ? [{ id: 'HUMAN-REJECT', description: reason }] : [],
          attemptDir, outputsDir: path.join(attemptDir, 'outputs'),
        }) : null;
        db.updateNodeRun(latestRun.run_id, {
          status: outcome, result_summary: summaryText, result_json: result?.resultJson ?? null,
          result_sha256: result?.resultSha256 ?? null, outputs_json: result ? JSON.stringify(result.outputsMap) : null, finished_at: Date.now(),
        });
        db.consumeReworkDocuments(taskId, task.revision, latestRun.node_id);
        if (reworkTarget) {
          db.appendReworkDocuments(latestRun, reworkTarget, [{
            path: 'manual-decision.md', sha256: computeBufferSha256(Buffer.from(reason, 'utf8')), content: reason,
          }]);
        }
      }
      db.updateTaskWorkflow(taskId, { current_node_id: nextNode?.id, current_run_id: null });
      if (pauseReason) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: pauseReason });
      } else if (reachedEnd) {
        db.updateTaskStatus(taskId, TaskStatus.COMPLETED, { completed_at: Date.now() });
      } else {
        db.updateTaskStatus(taskId, TaskStatus.QUEUED, { blocked_reason: null, stop_requested: 0 });
      }
    });

    if (pauseReason) return { success: false, message: pauseReason };
    if (reachedEnd) return { success: true, message: 'Task approved and completed.' };

    this.isProcessing = true;
    this.activeTaskId = taskId;
    logger.info(`[WorkflowEngine] Task ${taskId} manual decision [${action}]. Transitioning to [${nextNodeId}].`);

    setImmediate(() => {
      this.runTaskLoop(taskId).catch((err) => {
        logger.error('[WorkflowEngine] Error resuming task after manual decision:', err);
        const fresh = db.getTask(taskId);
        if (fresh?.status === TaskStatus.RUNNING || fresh?.status === TaskStatus.QUEUED) {
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: err.message });
        }
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

  private recordCompletionEvidence(run: WorkflowNodeRunRecord, payload: CompletionPayload, result: AgentExecutionResult, diff: ReturnType<typeof GitService.getDiffSnapshot> | null) {
    for (const [index, test] of (payload.verification?.report.tests ?? []).entries()) {
      db.saveTestRun({
        task_id: run.task_id,
        round_number: run.round_number,
        test_case_id: `${run.node_id}-${index + 1}`,
        command: test.command,
        exit_code: test.exit_code,
        stdout: test.stdout,
        stderr: test.stderr,
        report_path: TEST_REPORT_PATH,
        report_content: JSON.stringify(test),
        passed: test.exit_code === 0,
      });
    }
    if (payload.acceptance) {
      const { report } = payload.acceptance;
      db.saveAcceptanceRun({
        task_id: run.task_id,
        round_number: run.round_number,
        decision: report.decision,
        summary: report.summary,
        criteria_results_json: JSON.stringify(report.criteriaResults),
        issues_json: JSON.stringify(report.issues),
        manual_checks_json: JSON.stringify(report.manualChecksPending),
        code_snapshot_json: JSON.stringify(diff),
        raw_output: result.output || JSON.stringify(report),
      });
    }
  }

  private recordNodeOutputs(params: {
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
    resultJson: string;
    resultSha256: string;
    outputsMap: Record<string, { path: string; sha256: string; size_bytes: number }>;
  } {
    const outputsMap: Record<string, { path: string; sha256: string; size_bytes: number }> = {
      ...(params.extraOutputs || {}),
    };

    fs.mkdirSync(params.outputsDir, { recursive: true });
    for (const entry of fs.readdirSync(params.outputsDir, { withFileTypes: true })) {
      const name = entry.name.replace(/\.[^.]+$/, '');
      if (!entry.isFile() || entry.name === 'result.json' || outputsMap[name] || outputsMap[entry.name]) continue;
      const relativePath = `outputs/${entry.name}`;
      try {
        const buffer = readRegularFileSafely(params.attemptDir, relativePath, PACKAGE_LIMITS.max_file_bytes);
        outputsMap[name] = { path: relativePath, sha256: computeBufferSha256(buffer), size_bytes: buffer.length };
      } catch (error) {
        logger.warn(`[WorkflowEngine] 无法登记选填产物 ${relativePath}: ${String(error)}`);
      }
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
    return {
      resultJson,
      resultSha256,
      outputsMap,
    };
  }

  private buildNodePrompt(
    node: WorkflowNode, run: WorkflowNodeRunRecord, paths: MaterializedAttemptPaths, cwd: string,
    digest: string, reworkDocuments: ReworkDocument[], reworkTarget?: string,
  ): string {
    const readOptional = (relativePath: string) => fs.existsSync(path.join(paths.attemptDir, relativePath))
      ? readRegularFileSafely(paths.attemptDir, relativePath).toString('utf8').trim()
      : '';
    const reworkInputs = reworkDocuments.map(document => {
      const name = reworkFileName(document.sequence);
      const buffer = readRegularFileSafely(paths.attemptDir, `inputs/${name}`);
      if (computeBufferSha256(buffer) !== document.sha256) throw new Error(`返工提示词校验失败: ${name}`);
      return `### ${name}\n${buffer.toString('utf8')}`;
    });
    const basePrompt = readRegularFileSafely(paths.attemptDir, 'material/prompt.md').toString('utf8');
    if (!basePrompt.trim()) throw new Error(`节点 [${node.name}] 的 prompt.md 不能为空`);
    const nodeDoc = node.id.toLowerCase() === 'prompt' ? '' : readOptional(`material/${node.id}.md`);
    const developmentDoc = readOptional('shared/development.md');
    const complete = completionCommand(paths.contextPath);
    const sections = [
      `## 节点执行指令\n${basePrompt}`,
      reworkInputs.length ? `## 本次返工指令\n${reworkInputs.join('\n\n')}` : '',
      nodeDoc ? `## 本节点具体工作 (${node.id}.md)\n${nodeDoc}` : '',
      `## 需求文档 (requirements.md)\n${readRegularFileSafely(paths.attemptDir, 'shared/requirements.md').toString('utf8')}`,
      developmentDoc ? `## 开发文档 (development.md)\n${developmentDoc}` : '',
      '## Isolated Node Attempt Runtime Context',
      `Task ID: ${run.task_id} (Revision: r${run.revision}, Digest: ${digest})`,
      `Node ID: ${node.id} (${node.name})`,
      `Attempt ID: ${run.run_id} (Execution #${run.execution_index}, Round ${run.round_number})`,
      `Working Directory: ${cwd}`,
      `Isolated Attempt Directory: ${paths.attemptDir}`,
      `Material Directory: ${paths.materialDir}`,
      `Shared Directory: ${paths.sharedDir}`,
      `Context Manifest: ${paths.contextPath}`,
      `Outputs Dir: ${paths.outputsDir}`,
    ];
    if (node.result_rule === 'verification') {
      sections.push(
        '自行检查项目和任务材料，选择并真实运行测试命令；不修改业务代码。',
        `将证据保存到 ${TEST_REPORT_PATH}（Outputs Dir 下的 test_report.json），格式为 {"tests":[{"command":"实际运行的命令","cwd":"实际工作目录","exit_code":0,"stdout":"实际标准输出","stderr":"实际错误输出"}]}。`,
        'tests 至少包含一条实际执行记录。只要有非零退出码，提交 failed。无法运行或无有效证据时提交 execution 失败。',
      );
    }
    if (node.result_rule === 'acceptance') {
      const roundTests = db.getTestRuns(run.task_id, run.round_number)
        .map(test => `${test.command} [退出码 ${test.exit_code}]`).join('\n');
      sections.push(
        '依据需求和测试证据执行只读验收，不修改项目文件或编造证据。',
        `将验收证据写入 ${ACCEPTANCE_REPORT_PATH}，revision 应为 ${run.revision}。JSON 结构示例 ${reviewEvidenceExample}`,
        'passed 对应验收通过，needs_changes 对应业务失败，blocked 对应 execution 失败。通过时所有验收项必须有证据且 issues 为空。',
        roundTests && `本轮测试记录\n${roundTests}`,
      );
    }
    sections.push(
      '## 工作台完成协议',
      `完成所有工作和证据写入后，必须调用工作台 MCP。执行以下命令并替换结果和摘要\n${complete} --outcome passed --summary '简要执行结果'`,
      '业务失败用 --outcome failed。无法继续执行时加 --failure-kind execution，工作台将登记并暂停。',
      reworkTarget
        ? `若业务失败将退回 ${reworkTarget}。先把问题位置、修改要求和复验条件写到本次执行的 ${REWORK_OUTPUT_DIR}/。调用时为每份 Markdown 附加一个 --rework-path 'outputs/rework/文件名.md'，按交接顺序完整列出。`
        : '',
      'MCP 未受理时按返回原因补齐再提交。收到受理回执后立即结束 CLI，停止修改工作区和输出文件。最终聊天回复仅供阅读。',
    );
    return sections.filter(Boolean).join('\n\n');
  }

  private async runAutomaticNode(params: {
    task: TaskRecord;
    node: WorkflowNode;
    run: WorkflowNodeRunRecord;
    paths: MaterializedAttemptPaths;
    confirmedCwd: string;
    packageDigest: string;
    reworkDocuments: ReworkDocument[];
    reworkTarget?: string;
  }): Promise<boolean> {
    const { task, node, run, paths, confirmedCwd } = params;
    const isAcceptance = node.result_rule === 'acceptance';
    const roundStage = isAcceptance ? RoundStage.CODEX_ACCEPTANCE
      : node.result_rule === 'verification' ? RoundStage.RUNNING_TESTS : RoundStage.WORKER_DEV;
    const adapter = adapterRegistry.getAdapter(resolveTaskNodeExecutor(node));
    const model = node.model && node.model !== 'default' ? node.model : adapter.defaultModel;
    const prompt = this.buildNodePrompt(node, run, paths, confirmedCwd, params.packageDigest, params.reworkDocuments, params.reworkTarget);
    const roundId = db.createExecutionRound({
      task_id: task.id, round_number: run.round_number, stage: roundStage,
      worker_id: node.id, adapter_id: adapter.id, model_name: model, input_prompt: prompt,
    });
    db.updateTaskStatus(task.id, TaskStatus.RUNNING, {
      current_stage: roundStage, active_worker_id: node.id, current_round: run.round_number,
    });

    const diff = isAcceptance ? GitService.getDiffSnapshot(confirmedCwd) : null;
    let result: AgentExecutionResult;
    try {
      result = await adapter.execute({
        taskId: task.id, runId: run.run_id, roundId, model, prompt, cwd: confirmedCwd,
        signal: this.taskController?.signal, timeoutMs: task.execution_timeout_ms || resolveExecutionTimeout(),
        kind: isAcceptance ? 'reviewer' : 'worker', completionByMcp: true,
      });
    } catch (error) {
      result = { ok: false, output: '', error: String(error), modelUsed: model, durationMs: 0 };
    }

    if (this.finishStoppedNode(run, roundId, result)) return false;
    const reported = db.getNodeRunByRunId(run.run_id);
    const storedPayload = db.getAdvancePayload(run.run_id);
    const payload = storedPayload ? JSON.parse(storedPayload) as CompletionPayload : null;
    let blockingReason = '';
    if (!result.ok || result.cleanupConfirmed === false) {
      blockingReason = `CLI 执行异常: ${result.error || '未确认进程正常退出'}`;
    } else if (!payload || !reported?.reported_outcome) {
      blockingReason = `节点 [${node.name}] 已退出，但未收到有效的 MCP 完成回执。`;
    } else if (payload.failureKind === 'execution') {
      blockingReason = payload.summary || '节点报告执行受阻';
    } else {
      try {
        checkCompletionFiles(paths.attemptDir, payload);
      } catch (error) {
        blockingReason = `节点证据校验失败: ${error instanceof Error ? error.message : error}`;
      }
    }

    if (blockingReason) {
      if (!storedPayload) {
        try {
          await callLocalAdvance({
            task_id: task.id, node_id: node.id, attempt_id: run.run_id, completion_token: run.completion_token!,
            request_id: `execution-${run.run_id}`, outcome: 'failed', failure_kind: 'execution', summary: blockingReason.slice(0, 16384),
          });
        } catch (error) {
          blockingReason += ` MCP 补报失败: ${error instanceof Error ? error.message : error}`;
        }
      }
      if (this.finishStoppedNode(run, roundId, result)) return false;
      db.transaction(() => {
        db.completeExecutionRound(roundId, { status: 'blocked', output_text: result.output, error_message: blockingReason, duration_ms: result.durationMs });
        db.updateNodeRun(run.run_id, { status: 'blocked', result_summary: blockingReason, finished_at: Date.now() });
        db.updateTaskStatus(task.id, TaskStatus.BLOCKED, { blocked_reason: blockingReason });
      });
      return false;
    }

    const accepted = payload!;
    const outcome = reported!.reported_outcome!;
    const summary = accepted.summary;
    const issues = accepted.acceptance?.report.issues ??
      (outcome === 'failed' ? [{ id: `REPORT-${node.id}`, description: summary }] : []);
    const extraOutputs: Record<string, { path: string; sha256: string; size_bytes: number }> = {};
    if (accepted.verification) extraOutputs.test_report = accepted.verification.file;
    if (accepted.acceptance) extraOutputs.acceptance_report = accepted.acceptance.file;
    const outputBuffer = Buffer.from(result.output || '', 'utf8');
    fs.writeFileSync(path.join(paths.outputsDir, 'agent-output.txt'), outputBuffer);
    extraOutputs.agent_output = {
      path: 'outputs/agent-output.txt', sha256: computeBufferSha256(outputBuffer), size_bytes: outputBuffer.length,
    };
    const output = this.recordNodeOutputs({
      taskId: task.id, revision: run.revision, packageDigest: params.packageDigest, nodeId: node.id,
      attemptId: run.run_id, executionIndex: run.execution_index, codeGeneration: run.code_generation,
      outcome, summary, issues, attemptDir: paths.attemptDir, outputsDir: paths.outputsDir, extraOutputs,
    });
    const nextNodeId = outcome === 'passed' ? node.on_success : node.on_failure;
    db.transaction(() => {
      this.recordCompletionEvidence(run, accepted, result, diff);
      db.completeExecutionRound(roundId, { status: outcome, output_text: result.output, duration_ms: result.durationMs });
      db.updateNodeRun(run.run_id, {
        status: outcome, result_summary: summary, result_json: output.resultJson,
        result_sha256: output.resultSha256, outputs_json: JSON.stringify(output.outputsMap), finished_at: Date.now(),
      });
      db.consumeReworkDocuments(task.id, run.revision, node.id);
      if (accepted.rework) db.appendReworkDocuments(run, accepted.rework.targetNodeId, accepted.rework.files);
      db.updateTaskWorkflow(task.id, {
        current_node_id: nextNodeId || undefined,
        current_run_id: null,
        tests_passed_generation: outcome === 'passed' && accepted.verification ? run.code_generation : undefined,
        acceptance_passed_generation: outcome === 'passed' && accepted.acceptance ? run.code_generation : undefined,
      });
      if (!nextNodeId) {
        db.updateTaskStatus(task.id, TaskStatus.BLOCKED, { blocked_reason: `节点 [${node.name}] ${outcome === 'failed' ? '失败' : '完成'}后未配置去向。` });
      }
    });
    return Boolean(nextNodeId);
  }

  private finishStoppedNode(run: WorkflowNodeRunRecord, roundId: number, result: AgentExecutionResult): boolean {
    const task = db.getTask(run.task_id);
    if (!task || task.status === TaskStatus.DELETING || task.status === TaskStatus.CLEANUP_FAILED) return true;
    if (!task.stop_requested) return false;
    db.completeExecutionRound(roundId, { status: 'blocked', output_text: result.output });
    db.updateNodeRun(run.run_id, { status: 'cancelled', finished_at: Date.now() });
    db.updateTaskStatus(run.task_id, TaskStatus.CANCELLED);
    return true;
  }

  private async runTaskLoop(taskId: string): Promise<void> {
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
      const workflowValidation = validateWorkflowNodes(nodes, taskWorkflow.workflow_id, { requireMetadata: false });
      if (!workflowValidation.valid) {
        db.updateTaskStatus(taskId, TaskStatus.BLOCKED, {
          blocked_reason: `工作流定义无效，请重新编排后提交任务: ${workflowValidation.errors.join('; ')}`,
        });
        return;
      }
      const hasVerificationNode = nodes.some((n) => n.type === 'task' && n.result_rule === 'verification');
      const hasAcceptanceNode = nodes.some((n) => n.type === 'task' && n.result_rule === 'acceptance');

      const nodeRuns = db.getNodeRuns(taskId);
      const previousRevisionRound = nodeRuns.reduce((latest, run) => run.revision < revisionRecord.revision
        ? Math.max(latest, run.round_number) : latest, 0);
      let currentRound = Math.max(task.current_round || 0, previousRevisionRound);
      const maxRounds = task.budget_max_rounds || DEFAULT_BUDGET_MAX_ROUNDS;
      const nodesExecutedThisRound = new Set<string>();
      if (currentRound > 0) {
        for (const nr of nodeRuns) {
          if (nr.revision === revisionRecord.revision && nr.round_number === currentRound && nr.status !== 'blocked') {
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
          const runCount = db.getNodeRunCount(taskId, currentNode.id);
          const maxExecutions = currentNode.max_executions || DEFAULT_MAX_EXECUTIONS;
          if (maxExecutions > 0 && db.getNodeRunCount(taskId, currentNode.id, revisionRecord.revision) >= maxExecutions) {
            const reason = `节点 [${currentNode.name}] 已达到最大执行次数上限 (${maxExecutions} 次)`;
            db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
            return;
          }

          if (currentRound === previousRevisionRound || nodesExecutedThisRound.has(currentNode.id)) {
            currentRound++;
            nodesExecutedThisRound.clear();
          }
          nodesExecutedThisRound.add(currentNode.id);

          if (task.budget_max_rounds && currentRound - previousRevisionRound > maxRounds) {
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

          const reworkDocuments = db.getPendingReworkDocuments(taskId, revisionRecord.revision, currentNode.id);
          const reworkTarget = resolveReworkTarget({ task_id: taskId, revision: revisionRecord.revision, node_id: currentNode.id }, currentNode);

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
            reworkDocuments,
            reworkTarget,
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
            db.updateTaskWorkflow(taskId, { current_run_id: runId });

            logger.info(`[WorkflowEngine] Task ${taskId} reached manual node [${currentNode.name}]. Waiting for user decision.`);
            return;
          }

          const run = db.transaction(() => {
            const activeRun = db.createNodeRun({
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
            db.updateTaskWorkflow(taskId, { current_run_id: runId });
            return activeRun;
          });
          const advanced = await this.runAutomaticNode({
            task, node: currentNode, run, confirmedCwd, paths: materialized.paths,
            reworkDocuments, reworkTarget, packageDigest: revisionRecord.package_digest,
          });
          if (!advanced) return;
        }
      }
    } catch (error) {
      const task = db.getTask(taskId);
      if (task?.status === TaskStatus.RUNNING || task?.status === TaskStatus.QUEUED) {
        const reason = error instanceof Error ? error.message : String(error);
        const runId = db.getTaskWorkflow(taskId)?.current_run_id;
        db.transaction(() => {
          if (runId && db.getNodeRunByRunId(runId)?.status === 'running') {
            db.updateNodeRun(runId, { status: 'blocked', result_summary: reason, finished_at: Date.now() });
          }
          db.updateTaskStatus(taskId, TaskStatus.BLOCKED, { blocked_reason: reason });
        });
      }
      logger.error(`[WorkflowEngine] Task ${taskId} failed to continue:`, error);
    } finally {
      this.isProcessing = false;
      this.activeTaskId = null;
      this.taskController = null;
    }
  }
}

export const workflowEngine = WorkflowEngine.getInstance();
