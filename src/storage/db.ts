import type { RunSnapshot, ExecutionEvent } from '../services/executionService.ts';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, DATA_DIR, TaskStatus, RoundStage } from '../config/constants.ts';
import { resolveExecutionTimeout } from '../services/executionPolicy.ts';
import { logger } from '../utils/logger.ts';
import crypto from 'node:crypto';
import {
  type WorkflowNode,
  type WorkflowNodeType,
  type TaskExecutionMode,
  type TaskResultRule,
  DEFAULT_WORKFLOW_ID,
  DEFAULT_WORKFLOW_NODES,
  DEFAULT_MAX_EXECUTIONS,
} from '../services/workflowDefinition.ts';

export interface WorkflowDefinitionRecord {
  id: string;
  version: number;
  name: string;
  description: string | null;
  nodes_json: string;
  created_at: number;
  updated_at: number;
  is_default: number;
}

export interface TaskWorkflowRecord {
  task_id: string;
  workflow_id: string;
  workflow_version: number;
  nodes_json: string;
  current_node_id: string;
  current_run_id: string | null;
  code_generation: number;
  tests_passed_generation: number;
  acceptance_passed_generation: number;
  updated_at: number;
}

export interface WorkflowNodeRunRecord {
  id: number;
  run_id: string;
  task_id: string;
  node_id: string;
  execution_index: number;
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'waiting_manual' | 'cancelled';
  result_summary: string | null;
  completion_token: string | null;
  request_id: string | null;
  execution_run_id: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface TaskRecord {
  id: string;
  task_key: string;
  revision: number;
  title: string;
  status: TaskStatus;
  target_cwd: string;
  confirmed_cwd: string | null;
  git_root: string | null;
  git_commit: string | null;
  git_status: string | null;
  budget_max_rounds: number;
  budget_timeout_sec: number;
  execution_timeout_ms: number | null;
  current_round: number;
  active_worker_id: string | null;
  current_stage: RoundStage | null;
  stop_requested: number;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  worker_executor?: string;
  worker_model?: string;
  reviewer_executor?: string;
  reviewer_model?: string;
  workflow_id?: string;
  current_node_id?: string;
}

export interface TaskRevisionRecord {
  id: number;
  task_id: string;
  revision: number;
  manifest_json: string;
  task_md: string;
  development_md: string;
  tests_md: string;
  acceptance_md: string;
  verifier_prompt_md: string;
  created_at: number;
}

export interface WorkerPromptRecord {
  id: number;
  task_id: string;
  revision: number;
  worker_id: string;
  role: string;
  prompt_text: string;
}

export interface ExecutionRoundRecord {
  run_id?: string | null;
  termination_reason?: string | null;
  cleanup_confirmed?: number | null;
  id: number;
  task_id: string;
  round_number: number;
  stage: RoundStage;
  worker_id: string | null;
  adapter_id?: string | null;
  model_name?: string | null;
  duration_ms?: number | null;
  input_prompt: string | null;
  output_text: string | null;
  issues_json: string | null;
  status: 'running' | 'passed' | 'failed' | 'blocked';
  error_message: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface TestRunRecord {
  id: number;
  task_id: string;
  round_number: number;
  test_case_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  report_path: string | null;
  report_content: string | null;
  passed: number;
  executed_at: number;
}

export interface AcceptanceRunRecord {
  id: number;
  task_id: string;
  round_number: number;
  decision: 'passed' | 'needs_changes' | 'blocked';
  summary: string;
  criteria_results_json: string | null;
  issues_json: string | null;
  manual_checks_json: string | null;
  code_snapshot_json: string | null;
  raw_output: string;
  executed_at: number;
}

export interface HumanDecisionRecord {
  id: number;
  task_id: string;
  action: 'approve' | 'reject';
  reason: string;
  decided_at: number;
}

export class WorkbenchDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    this.initTables();
  }

  /**
   * Execute operations within a native SQLite transaction
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }

  /**
   * Crash Recovery: on startup, detect and recover any tasks stuck in 'running' or 'queued'
   */
  recoverPendingTasks(): { recoveredCount: number; taskIds: string[] } {
    for (const row of this.db.prepare('SELECT snapshot_json FROM execution_runs').all() as any[]) {
      const run=JSON.parse(row.snapshot_json) as RunSnapshot;
      if(['starting','running','stopping'].includes(run.state)) {
        Object.assign(run,{state:'blocked',activity:'finished',stopReason:'INTERRUPTED',finishedAt:Date.now(),cleanupConfirmed:false});
        this.saveRun(run);
        const last=this.db.prepare('SELECT MAX(seq) AS seq FROM execution_events WHERE run_id=?').get(run.runId) as any;
        this.saveRunEvent({runId:run.runId,seq:(last.seq || 0)+1,at:Date.now(),type:'finished',data:{snapshot:run}});
      }
    }
    const unfinalized = this.db.prepare(`
      SELECT id, status, current_round, current_stage FROM tasks 
      WHERE status IN ('running', 'queued')
    `).all() as unknown as Array<{ id: string; status: string; current_round: number; current_stage: string | null }>;

    if (!unfinalized || unfinalized.length === 0) {
      return { recoveredCount: 0, taskIds: [] };
    }

    const taskIds: string[] = [];
    this.transaction(() => {
      const now = Date.now();
      for (const t of unfinalized) {
        taskIds.push(t.id);
        const reason = `服务意外终止或重启：任务在第 ${t.current_round || 1} 轮 [${t.current_stage || t.status}] 中断。系统已安全挂起现场，请核对工作区 Git 状态后重新确认开始。`;
        this.db.prepare(`
          UPDATE tasks 
          SET status = ?, blocked_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(TaskStatus.BLOCKED, reason, now, t.id);
      }
      this.db.prepare(`
        UPDATE workflow_node_runs
        SET status = 'blocked', result_summary = '服务意外终止或重启：执行已安全挂起', finished_at = ?
        WHERE status = 'running'
      `).run(now);
    });

    logger.info(`[WorkbenchDatabase] Crash recovery check: recovered ${taskIds.length} unfinished tasks: ${taskIds.join(', ')}`);
    return { recoveredCount: taskIds.length, taskIds };
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        target_cwd TEXT NOT NULL,
        confirmed_cwd TEXT,
        git_root TEXT,
        git_commit TEXT,
        git_status TEXT,
        budget_max_rounds INTEGER NOT NULL DEFAULT 10,
        budget_timeout_sec INTEGER NOT NULL DEFAULT 1800,
        current_round INTEGER NOT NULL DEFAULT 0,
        active_worker_id TEXT,
        current_stage TEXT,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        worker_executor TEXT NOT NULL DEFAULT 'codex',
        worker_model TEXT NOT NULL DEFAULT 'default',
        reviewer_executor TEXT NOT NULL DEFAULT 'codex',
        reviewer_model TEXT NOT NULL DEFAULT 'default'
      );

      CREATE TABLE IF NOT EXISTS task_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        task_md TEXT NOT NULL,
        development_md TEXT NOT NULL,
        tests_md TEXT NOT NULL,
        acceptance_md TEXT NOT NULL,
        verifier_prompt_md TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(task_id, revision)
      );

      CREATE TABLE IF NOT EXISTS worker_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        role TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        UNIQUE(task_id, revision, worker_id)
      );

      CREATE TABLE IF NOT EXISTS execution_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        stage TEXT NOT NULL,
        worker_id TEXT,
        adapter_id TEXT,
        model_name TEXT,
        duration_ms INTEGER,
        input_prompt TEXT,
        output_text TEXT,
        issues_json TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        test_case_id TEXT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        stdout TEXT,
        stderr TEXT,
        report_path TEXT,
        report_content TEXT,
        passed INTEGER NOT NULL,
        executed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS acceptance_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        decision TEXT NOT NULL,
        summary TEXT NOT NULL,
        criteria_results_json TEXT,
        issues_json TEXT,
        manual_checks_json TEXT,
        code_snapshot_json TEXT,
        raw_output TEXT NOT NULL,
        executed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS human_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        decided_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_definitions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        description TEXT,
        nodes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, version)
      );

      CREATE TABLE IF NOT EXISTS task_workflows (
        task_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_version INTEGER NOT NULL,
        nodes_json TEXT NOT NULL,
        current_node_id TEXT NOT NULL,
        current_run_id TEXT,
        code_generation INTEGER NOT NULL DEFAULT 0,
        tests_passed_generation INTEGER NOT NULL DEFAULT 0,
        acceptance_passed_generation INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_node_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        execution_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_summary TEXT,
        completion_token TEXT,
        request_id TEXT,
        execution_run_id TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(task_id, node_id, execution_index)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_revisions_task_id ON task_revisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_execution_rounds_task_id ON execution_rounds(task_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_defs_id ON workflow_definitions(id);
      CREATE INDEX IF NOT EXISTS idx_task_workflows_task ON task_workflows(task_id);
      CREATE INDEX IF NOT EXISTS idx_wf_node_runs_task ON workflow_node_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_wf_node_runs_token ON workflow_node_runs(completion_token);
      CREATE INDEX IF NOT EXISTS idx_wf_node_runs_req ON workflow_node_runs(request_id);
    `);

    // Ensure default workflow template exists
    try {
      const defRow = this.db.prepare('SELECT id FROM workflow_definitions WHERE id = ?').get('default');
      if (!defRow) {
        const now = Date.now();
        this.db.prepare(`
          INSERT INTO workflow_definitions (id, version, name, description, nodes_json, created_at, updated_at, is_default)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          DEFAULT_WORKFLOW_ID,
          1,
          '默认开发交付流程',
          '经典流程：开始 -> 开发实现 -> 独立测试 -> 整体验收 -> 人工确认 -> 结束',
          JSON.stringify(DEFAULT_WORKFLOW_NODES),
          now,
          now
        );
      }
    } catch {}

    this.db.exec(`CREATE TABLE IF NOT EXISTS execution_runs (run_id TEXT PRIMARY KEY, task_id TEXT, snapshot_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE INDEX IF NOT EXISTS idx_runs_task ON execution_runs(task_id);`);
    // Gracefully apply schema migrations for existing databases
    const migrations = [
      "ALTER TABLE tasks ADD COLUMN execution_timeout_ms INTEGER",
      "ALTER TABLE execution_runs ADD COLUMN output_bytes INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN worker_executor TEXT NOT NULL DEFAULT 'workbuddy'",
      "ALTER TABLE tasks ADD COLUMN worker_model TEXT NOT NULL DEFAULT 'deepseek-v4-flash'",
      "ALTER TABLE tasks ADD COLUMN reviewer_executor TEXT NOT NULL DEFAULT 'workbuddy'",
      "ALTER TABLE tasks ADD COLUMN reviewer_model TEXT NOT NULL DEFAULT 'deepseek-v4-flash'",
      "ALTER TABLE execution_rounds ADD COLUMN run_id TEXT",
      "ALTER TABLE execution_rounds ADD COLUMN termination_reason TEXT",
      "ALTER TABLE execution_rounds ADD COLUMN cleanup_confirmed INTEGER",
      "ALTER TABLE execution_rounds ADD COLUMN adapter_id TEXT",
      "ALTER TABLE execution_rounds ADD COLUMN model_name TEXT",
      "ALTER TABLE execution_rounds ADD COLUMN duration_ms INTEGER",
    ];

    for (const sql of migrations) {
      try {
        this.db.exec(sql);
        if(sql.includes('execution_runs ADD COLUMN output_bytes')) this.db.exec("UPDATE execution_runs SET output_bytes=COALESCE((SELECT SUM(length(CAST(json_extract(data_json,'$.text') AS BLOB))) FROM execution_events WHERE execution_events.run_id=execution_runs.run_id AND type='output'),0)");
      } catch (error:any) {
        if(!String(error.message).includes('duplicate column name'))throw error;
      }
    }
  }

  taskOutputBytes(taskId:string):number {
    return (this.db.prepare("SELECT COALESCE(SUM(output_bytes),0) AS bytes FROM execution_runs WHERE task_id=?").get(taskId) as any).bytes;
  }
  pruneProbeRuns():void {
    let total=(this.db.prepare('SELECT COALESCE(SUM(output_bytes),0) AS bytes FROM execution_runs WHERE task_id IS NULL').get() as any).bytes;
    for(const row of this.db.prepare('SELECT run_id,snapshot_json,output_bytes FROM execution_runs WHERE task_id IS NULL ORDER BY rowid').all() as any[]) {
      const run=JSON.parse(row.snapshot_json);
      if(run.finishedAt===null || (Date.now()-run.finishedAt<7*86400000 && total<=100*1024*1024))continue;
      const size=row.output_bytes;
      this.db.prepare('DELETE FROM execution_events WHERE run_id=?').run(row.run_id);
      this.db.prepare('DELETE FROM execution_runs WHERE run_id=?').run(row.run_id);total-=size;
    }
  }
  updateRoundTermination(roundId:number,runId:string,reason:string|null,confirmed:boolean):void {
    this.db.prepare('UPDATE execution_rounds SET run_id=?,termination_reason=?,cleanup_confirmed=? WHERE id=?').run(runId,reason,confirmed?1:0,roundId);
  }
  recordRunCleanup(runId:string):void {
    const run=this.getRun(runId);if(!run)return;
    run.cleanupConfirmed=true;this.saveRun(run);
    if(run.roundId!==null)this.updateRoundTermination(run.roundId,runId,run.stopReason,true);
    const last=this.db.prepare('SELECT MAX(seq) AS seq FROM execution_events WHERE run_id=?').get(runId) as any;
    this.saveRunEvent({runId,seq:(last.seq || 0)+1,at:Date.now(),type:'finished',data:{snapshot:run}});
  }
  saveRun(run: RunSnapshot): void {
    this.db.prepare('INSERT INTO execution_runs(run_id,task_id,snapshot_json) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(run.runId,run.taskId,JSON.stringify(run));
  }
  getRun(id: string): RunSnapshot | null {
    const row=this.db.prepare('SELECT snapshot_json FROM execution_runs WHERE run_id=?').get(id) as any;
    return row ? JSON.parse(row.snapshot_json) : null;
  }
  latestRun(taskId: string): RunSnapshot | null {
    const row=this.db.prepare('SELECT snapshot_json FROM execution_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as any;
    return row ? JSON.parse(row.snapshot_json) : null;
  }
  saveRunEvent(event: ExecutionEvent, snapshot?:RunSnapshot): void {
    this.transaction(()=>{
      this.db.prepare('INSERT INTO execution_events VALUES (?,?,?,?,?)').run(event.runId,event.seq,event.at,event.type,JSON.stringify(event.data));
      if(event.type==='output') this.db.prepare('UPDATE execution_runs SET output_bytes=output_bytes+? WHERE run_id=?').run(Buffer.byteLength(event.data.text,'utf8'),event.runId);
      if(snapshot)this.saveRun(snapshot);
    });
  }
  runEvents(id: string, after: number, limit: number): ExecutionEvent[] {
    return (this.db.prepare('SELECT * FROM execution_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit) as any[])
      .map(row=>({runId:row.run_id,seq:row.seq,at:row.at,type:row.type,data:JSON.parse(row.data_json)}));
  }
  // --- Task Methods ---

  createTask(data: {
    id: string;
    task_key: string;
    revision?: number;
    title: string;
    status?: TaskStatus;
    target_cwd: string;
    git_root?: string | null;
    git_commit?: string | null;
    git_status?: string | null;
    budget_max_rounds?: number;
    budget_timeout_sec?: number;
    execution_timeout_ms?: number;
    worker_executor?: string;
    worker_model?: string;
    reviewer_executor?: string;
    reviewer_model?: string;
  }): TaskRecord {
    const now = Date.now();
    const revision = data.revision ?? 1;
    const status = data.status ?? TaskStatus.PENDING_CONFIRM;
    const budgetRounds = data.budget_max_rounds ?? 10;
    const budgetTimeout = data.budget_timeout_sec ?? 1800;
    const workerExecutor = data.worker_executor || 'codex';
    const workerModel = data.worker_model || (workerExecutor === 'codex' ? 'default' : 'deepseek-v4-flash');
    const reviewerExecutor = data.reviewer_executor || 'codex';
    const reviewerModel = data.reviewer_model || (reviewerExecutor === 'codex' ? 'default' : 'deepseek-v4-flash');

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, task_key, revision, title, status, target_cwd,
        git_root, git_commit, git_status,
        budget_max_rounds, budget_timeout_sec, current_round,
        created_at, updated_at,
        worker_executor, worker_model, reviewer_executor, reviewer_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.id,
      data.task_key,
      revision,
      data.title,
      status,
      data.target_cwd,
      data.git_root || null,
      data.git_commit || null,
      data.git_status || null,
      budgetRounds,
      budgetTimeout,
      now,
      now,
      workerExecutor,
      workerModel,
      reviewerExecutor,
      reviewerModel
    );

    this.db.prepare('UPDATE tasks SET execution_timeout_ms = ? WHERE id = ?').run(resolveExecutionTimeout(data.execution_timeout_ms), data.id);
    if (!this.getTaskWorkflow(data.id)) {
      this.initTaskWorkflow(data.id);
    }
    return this.getTask(data.id)!;
  }

  getTask(id: string): TaskRecord | null {
    const stmt = this.db.prepare(`
      SELECT t.*, tw.workflow_id, tw.current_node_id 
      FROM tasks t
      LEFT JOIN task_workflows tw ON t.id = tw.task_id
      WHERE t.id = ?
    `);
    const row = stmt.get(id) as unknown as TaskRecord | undefined;
    return row ?? null;
  }

  listTasks(statusFilter?: TaskStatus): TaskRecord[] {
    if (statusFilter) {
      const stmt = this.db.prepare(`
        SELECT t.*, tw.workflow_id, tw.current_node_id 
        FROM tasks t
        LEFT JOIN task_workflows tw ON t.id = tw.task_id
        WHERE t.status = ? 
        ORDER BY t.created_at DESC
      `);
      return stmt.all(statusFilter) as unknown as TaskRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT t.*, tw.workflow_id, tw.current_node_id 
      FROM tasks t
      LEFT JOIN task_workflows tw ON t.id = tw.task_id
      ORDER BY t.created_at DESC
    `);
    return stmt.all() as unknown as TaskRecord[];
  }

  updateTaskStatus(
    id: string,
    status: TaskStatus,
    extra?: {
      blocked_reason?: string | null;
      active_worker_id?: string | null;
      current_stage?: RoundStage | null;
      current_round?: number;
      confirmed_cwd?: string;
      started_at?: number;
      completed_at?: number;
      execution_timeout_ms?: number;
      stop_requested?: number;
      worker_executor?: string;
      worker_model?: string;
      reviewer_executor?: string;
      reviewer_model?: string;
    }
  ): void {
    const now = Date.now();
    const updates: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra?.blocked_reason !== undefined) {
      updates.push('blocked_reason = ?');
      params.push(extra.blocked_reason);
    }
    if (extra?.active_worker_id !== undefined) {
      updates.push('active_worker_id = ?');
      params.push(extra.active_worker_id);
    }
    if (extra?.current_stage !== undefined) {
      updates.push('current_stage = ?');
      params.push(extra.current_stage);
    }
    if (extra?.current_round !== undefined) {
      updates.push('current_round = ?');
      params.push(extra.current_round);
    }
    if (extra?.confirmed_cwd !== undefined) {
      updates.push('confirmed_cwd = ?');
      params.push(extra.confirmed_cwd);
    }
    if (extra?.started_at !== undefined) {
      updates.push('started_at = ?');
      params.push(extra.started_at);
    }
    if (extra?.completed_at !== undefined) {
      updates.push('completed_at = ?');
      params.push(extra.completed_at);
    }
    if (extra?.worker_executor !== undefined) {
      updates.push('worker_executor = ?');
      params.push(extra.worker_executor);
    }
    if (extra?.worker_model !== undefined) {
      updates.push('worker_model = ?');
      params.push(extra.worker_model);
    }
    if (extra?.reviewer_executor !== undefined) {
      updates.push('reviewer_executor = ?');
      params.push(extra.reviewer_executor);
    }
    if (extra?.reviewer_model !== undefined) {
      updates.push('reviewer_model = ?');
      params.push(extra.reviewer_model);
    }

    if (extra?.execution_timeout_ms !== undefined) { updates.push('execution_timeout_ms = ?'); params.push(extra.execution_timeout_ms); }
    if (extra?.stop_requested !== undefined) { updates.push('stop_requested = ?'); params.push(extra.stop_requested); }
    params.push(id);
    const sql = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...params);
  }

  requestTaskStop(id: string): void {
    this.db.prepare(`UPDATE tasks SET stop_requested = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  // --- Task Revisions & Prompts ---

  saveRevision(data: {
    task_id: string;
    revision: number;
    manifest_json: string;
    task_md: string;
    development_md: string;
    tests_md: string;
    acceptance_md: string;
    verifier_prompt_md: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_revisions (
        task_id, revision, manifest_json, task_md,
        development_md, tests_md, acceptance_md, verifier_prompt_md, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      data.task_id,
      data.revision,
      data.manifest_json,
      data.task_md,
      data.development_md,
      data.tests_md,
      data.acceptance_md,
      data.verifier_prompt_md,
      Date.now()
    );

    // Update revision in tasks table
    this.db.prepare(`UPDATE tasks SET revision = ?, updated_at = ? WHERE id = ?`).run(
      data.revision,
      Date.now(),
      data.task_id
    );
  }

  getLatestRevision(taskId: string): TaskRevisionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1
    `);
    const row = stmt.get(taskId) as unknown as TaskRevisionRecord | undefined;
    return row ?? null;
  }

  saveWorkerPrompt(data: {
    task_id: string;
    revision: number;
    worker_id: string;
    role: string;
    prompt_text: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO worker_prompts (
        task_id, revision, worker_id, role, prompt_text
      ) VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(data.task_id, data.revision, data.worker_id, data.role, data.prompt_text);
  }

  getWorkerPrompts(taskId: string, revision: number): WorkerPromptRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM worker_prompts WHERE task_id = ? AND revision = ?
    `);
    return stmt.all(taskId, revision) as unknown as WorkerPromptRecord[];
  }

  // --- Execution Rounds & History ---

  createExecutionRound(data: {
    task_id: string;
    round_number: number;
    stage: RoundStage;
    worker_id?: string | null;
    adapter_id?: string | null;
    model_name?: string | null;
    duration_ms?: number | null;
    input_prompt?: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO execution_rounds (
        task_id, round_number, stage, worker_id, adapter_id, model_name, duration_ms, input_prompt,
        status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `);
    const result = stmt.run(
      data.task_id,
      data.round_number,
      data.stage,
      data.worker_id || null,
      data.adapter_id || null,
      data.model_name || null,
      data.duration_ms || null,
      data.input_prompt || null,
      Date.now()
    );
    return Number(result.lastInsertRowid);
  }

  completeExecutionRound(
    roundId: number,
    data: {
      status: 'passed' | 'failed' | 'blocked';
      output_text?: string | null;
      issues_json?: string | null;
      error_message?: string | null;
      duration_ms?: number | null;
    }
  ): void {
    const updates: string[] = ['status = ?', 'output_text = ?', 'issues_json = ?', 'error_message = ?', 'finished_at = ?'];
    const params: unknown[] = [
      data.status,
      data.output_text || null,
      data.issues_json || null,
      data.error_message || null,
      Date.now(),
    ];

    if (data.duration_ms !== undefined && data.duration_ms !== null) {
      updates.push('duration_ms = ?');
      params.push(data.duration_ms);
    }

    params.push(roundId);
    const sql = `UPDATE execution_rounds SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...params);
  }

  getRounds(taskId: string): ExecutionRoundRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM execution_rounds WHERE task_id = ? ORDER BY round_number ASC, id ASC
    `);
    return stmt.all(taskId) as unknown as ExecutionRoundRecord[];
  }

  // --- Test & Acceptance Runs ---

  saveTestRun(data: {
    task_id: string;
    round_number: number;
    test_case_id: string;
    command: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    report_path?: string | null;
    report_content?: string | null;
    passed: boolean;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO test_runs (
        task_id, round_number, test_case_id, command, exit_code,
        stdout, stderr, report_path, report_content, passed, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      data.task_id,
      data.round_number,
      data.test_case_id,
      data.command,
      data.exit_code,
      data.stdout,
      data.stderr,
      data.report_path || null,
      data.report_content || null,
      data.passed ? 1 : 0,
      Date.now()
    );
  }

  getTestRuns(taskId: string, roundNumber?: number): TestRunRecord[] {
    if (roundNumber !== undefined) {
      const stmt = this.db.prepare(`
        SELECT * FROM test_runs WHERE task_id = ? AND round_number = ? ORDER BY executed_at ASC
      `);
      return stmt.all(taskId, roundNumber) as unknown as TestRunRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM test_runs WHERE task_id = ? ORDER BY executed_at ASC
    `);
    return stmt.all(taskId) as unknown as TestRunRecord[];
  }

  saveAcceptanceRun(data: {
    task_id: string;
    round_number: number;
    decision: 'passed' | 'needs_changes' | 'blocked';
    summary: string;
    criteria_results_json?: string | null;
    issues_json?: string | null;
    manual_checks_json?: string | null;
    code_snapshot_json?: string | null;
    raw_output: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO acceptance_runs (
        task_id, round_number, decision, summary,
        criteria_results_json, issues_json, manual_checks_json, code_snapshot_json,
        raw_output, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      data.task_id,
      data.round_number,
      data.decision,
      data.summary,
      data.criteria_results_json || null,
      data.issues_json || null,
      data.manual_checks_json || null,
      data.code_snapshot_json || null,
      data.raw_output,
      Date.now()
    );
  }

  getAcceptanceRuns(taskId: string): AcceptanceRunRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM acceptance_runs WHERE task_id = ? ORDER BY executed_at ASC
    `);
    return stmt.all(taskId) as unknown as AcceptanceRunRecord[];
  }

  saveHumanDecision(data: {
    task_id: string;
    action: 'approve' | 'reject';
    reason: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO human_decisions (task_id, action, reason, decided_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(data.task_id, data.action, data.reason, Date.now());
  }

  getHumanDecisions(taskId: string): HumanDecisionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM human_decisions WHERE task_id = ? ORDER BY decided_at ASC
    `);
    return stmt.all(taskId) as unknown as HumanDecisionRecord[];
  }

  // --- Workflow Definitions ---

  isWorkflowReferenced(workflowId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM task_workflows WHERE workflow_id = ? LIMIT 1').get(workflowId);
    return Boolean(row);
  }

  getWorkflowReferencingTasks(workflowId: string): { id: string; title: string; status: string }[] {
    const stmt = this.db.prepare(`
      SELECT t.id, t.title, t.status
      FROM task_workflows tw
      INNER JOIN tasks t ON tw.task_id = t.id
      WHERE tw.workflow_id = ?
      ORDER BY t.created_at DESC
    `);
    return stmt.all(workflowId) as { id: string; title: string; status: string }[];
  }

  getWorkflow(id: string, version?: number): WorkflowDefinitionRecord | null {
    if (version !== undefined) {
      const stmt = this.db.prepare('SELECT * FROM workflow_definitions WHERE id = ? AND version = ?');
      const row = stmt.get(id, version) as unknown as WorkflowDefinitionRecord | undefined;
      if (row) return row;
    }
    const stmt = this.db.prepare('SELECT * FROM workflow_definitions WHERE id = ? ORDER BY updated_at DESC, version DESC LIMIT 1');
    const row = stmt.get(id) as unknown as WorkflowDefinitionRecord | undefined;
    return row ?? null;
  }

  listWorkflows(): WorkflowDefinitionRecord[] {
    const stmt = this.db.prepare(`
      SELECT wd.* FROM workflow_definitions wd
      INNER JOIN (
        SELECT id, MAX(version) AS max_v FROM workflow_definitions GROUP BY id
      ) latest ON wd.id = latest.id AND wd.version = latest.max_v
      ORDER BY wd.is_default DESC, wd.id ASC
    `);
    return stmt.all() as unknown as WorkflowDefinitionRecord[];
  }

  saveWorkflowDefinition(data: {
    id: string;
    version?: number;
    name: string;
    description?: string | null;
    nodes_json: string;
    is_default?: number;
  }): WorkflowDefinitionRecord {
    const existing = this.getWorkflow(data.id);
    if (existing) {
      if (this.isWorkflowReferenced(data.id)) {
        throw new Error(`工作流 [${data.id}] 当前正被任务引用，禁止修改！若需调整请先清理相关任务或新建工作流。`);
      }
      const now = Date.now();
      this.db.prepare(`
        UPDATE workflow_definitions
        SET name = ?, description = ?, nodes_json = ?, updated_at = ?, is_default = ?
        WHERE id = ?
      `).run(
        data.name,
        data.description || null,
        data.nodes_json,
        now,
        data.is_default ?? existing.is_default,
        data.id
      );
      return this.getWorkflow(data.id)!;
    }

    const now = Date.now();
    const version = 1;
    this.db.prepare(`
      INSERT INTO workflow_definitions (
        id, version, name, description, nodes_json, created_at, updated_at, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      version,
      data.name,
      data.description || null,
      data.nodes_json,
      now,
      now,
      data.is_default ?? 0
    );

    return this.getWorkflow(data.id)!;
  }

  // --- Task Workflows ---

  getTaskWorkflow(taskId: string): TaskWorkflowRecord | null {
    const stmt = this.db.prepare('SELECT * FROM task_workflows WHERE task_id = ?');
    const row = stmt.get(taskId) as unknown as TaskWorkflowRecord | undefined;
    return row ?? null;
  }

  initTaskWorkflow(
    taskId: string,
    options?: {
      workflowId?: string;
      workflowVersion?: number;
      nodePrompts?: Record<string, string>;
      nodesOverride?: WorkflowNode[];
    }
  ): TaskWorkflowRecord {
    const wfId = options?.workflowId || DEFAULT_WORKFLOW_ID;
    let nodes: WorkflowNode[];
    let wfVersion = options?.workflowVersion || 1;

    if (options?.nodesOverride) {
      nodes = JSON.parse(JSON.stringify(options.nodesOverride));
    } else {
      const def = this.getWorkflow(wfId, options?.workflowVersion);
      if (def) {
        wfVersion = def.version;
        nodes = JSON.parse(def.nodes_json);
      } else {
        nodes = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW_NODES));
      }
    }

    // Apply node prompts override if provided
    if (options?.nodePrompts) {
      for (const node of nodes) {
        if (node.type === 'task' && node.execution_mode === 'agent' && options.nodePrompts[node.id]) {
          node.prompt = options.nodePrompts[node.id];
        }
      }
    }

    const startNode = nodes.find((n) => n.type === 'start') || nodes[0];
    const initialNodeId = startNode ? startNode.id : 'start';
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO task_workflows (
        task_id, workflow_id, workflow_version, nodes_json,
        current_node_id, current_run_id, code_generation,
        tests_passed_generation, acceptance_passed_generation, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, ?)
    `);

    stmt.run(taskId, wfId, wfVersion, JSON.stringify(nodes), initialNodeId, now);
    return this.getTaskWorkflow(taskId)!;
  }

  updateTaskWorkflow(
    taskId: string,
    updates: Partial<{
      current_node_id: string;
      current_run_id: string | null;
      code_generation: number;
      tests_passed_generation: number;
      acceptance_passed_generation: number;
      nodes_json: string;
    }>
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];

    if (updates.current_node_id !== undefined) {
      sets.push('current_node_id = ?');
      params.push(updates.current_node_id);
    }
    if (updates.current_run_id !== undefined) {
      sets.push('current_run_id = ?');
      params.push(updates.current_run_id);
    }
    if (updates.code_generation !== undefined) {
      sets.push('code_generation = ?');
      params.push(updates.code_generation);
    }
    if (updates.tests_passed_generation !== undefined) {
      sets.push('tests_passed_generation = ?');
      params.push(updates.tests_passed_generation);
    }
    if (updates.acceptance_passed_generation !== undefined) {
      sets.push('acceptance_passed_generation = ?');
      params.push(updates.acceptance_passed_generation);
    }
    if (updates.nodes_json !== undefined) {
      sets.push('nodes_json = ?');
      params.push(updates.nodes_json);
    }

    params.push(taskId);
    this.db.prepare(`UPDATE task_workflows SET ${sets.join(', ')} WHERE task_id = ?`).run(...params);
  }

  // --- Workflow Node Runs ---

  createNodeRun(data: {
    run_id: string;
    task_id: string;
    node_id: string;
    execution_index: number;
    status?: 'running' | 'passed' | 'failed' | 'blocked' | 'waiting_manual' | 'cancelled';
    completion_token?: string | null;
    execution_run_id?: string | null;
    result_summary?: string | null;
  }): WorkflowNodeRunRecord {
    const now = Date.now();
    const status = data.status || 'running';
    const stmt = this.db.prepare(`
      INSERT INTO workflow_node_runs (
        run_id, task_id, node_id, execution_index, status,
        result_summary, completion_token, request_id,
        execution_run_id, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
    `);

    stmt.run(
      data.run_id,
      data.task_id,
      data.node_id,
      data.execution_index,
      status,
      data.result_summary || null,
      data.completion_token || null,
      data.execution_run_id || null,
      now
    );

    return this.getNodeRunByRunId(data.run_id)!;
  }

  updateNodeRun(
    runId: string,
    updates: Partial<{
      status: 'running' | 'passed' | 'failed' | 'blocked' | 'waiting_manual' | 'cancelled';
      result_summary: string | null;
      completion_token: string | null;
      request_id: string | null;
      execution_run_id: string | null;
      finished_at: number | null;
    }>
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.result_summary !== undefined) {
      sets.push('result_summary = ?');
      params.push(updates.result_summary);
    }
    if (updates.completion_token !== undefined) {
      sets.push('completion_token = ?');
      params.push(updates.completion_token);
    }
    if (updates.request_id !== undefined) {
      sets.push('request_id = ?');
      params.push(updates.request_id);
    }
    if (updates.execution_run_id !== undefined) {
      sets.push('execution_run_id = ?');
      params.push(updates.execution_run_id);
    }
    if (updates.finished_at !== undefined) {
      sets.push('finished_at = ?');
      params.push(updates.finished_at);
    }

    if (sets.length === 0) return;
    params.push(runId);
    this.db.prepare(`UPDATE workflow_node_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...params);
  }

  getNodeRuns(taskId: string, nodeId?: string): WorkflowNodeRunRecord[] {
    if (nodeId) {
      const stmt = this.db.prepare(
        'SELECT * FROM workflow_node_runs WHERE task_id = ? AND node_id = ? ORDER BY execution_index ASC, id ASC'
      );
      return stmt.all(taskId, nodeId) as unknown as WorkflowNodeRunRecord[];
    }
    const stmt = this.db.prepare(
      'SELECT * FROM workflow_node_runs WHERE task_id = ? ORDER BY id ASC'
    );
    return stmt.all(taskId) as unknown as WorkflowNodeRunRecord[];
  }

  getLatestNodeRun(taskId: string, nodeId?: string): WorkflowNodeRunRecord | null {
    if (nodeId) {
      const stmt = this.db.prepare(
        'SELECT * FROM workflow_node_runs WHERE task_id = ? AND node_id = ? ORDER BY execution_index DESC, id DESC LIMIT 1'
      );
      const row = stmt.get(taskId, nodeId) as unknown as WorkflowNodeRunRecord | undefined;
      return row ?? null;
    }
    const stmt = this.db.prepare(
      'SELECT * FROM workflow_node_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1'
    );
    const row = stmt.get(taskId) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getNodeRunByRunId(runId: string): WorkflowNodeRunRecord | null {
    const stmt = this.db.prepare('SELECT * FROM workflow_node_runs WHERE run_id = ?');
    const row = stmt.get(runId) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getNodeRunByToken(taskId: string, token: string): WorkflowNodeRunRecord | null {
    const stmt = this.db.prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? AND completion_token = ?');
    const row = stmt.get(taskId, token) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getNodeRunCount(taskId: string, nodeId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM workflow_node_runs WHERE task_id = ? AND node_id = ?');
    const row = stmt.get(taskId, nodeId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  registerAdvanceReport(
    taskId: string,
    nodeId: string,
    attemptId: string,
    completionToken: string,
    requestId: string,
    outcome: 'passed' | 'failed',
    summary: string
  ): { success: boolean; message: string; duplicate?: boolean; run?: WorkflowNodeRunRecord } {
    return this.transaction(() => {
      const existingReq = this.db
        .prepare('SELECT * FROM workflow_node_runs WHERE request_id = ?')
        .get(requestId) as unknown as WorkflowNodeRunRecord | undefined;

      if (existingReq) {
        return {
          success: true,
          duplicate: true,
          message: '请求已接收（幂等处理）',
          run: existingReq,
        };
      }

      const run = this.getNodeRunByRunId(attemptId);
      if (!run) {
        return { success: false, message: `未找到执行记录: ${attemptId}` };
      }
      if (run.task_id !== taskId || run.node_id !== nodeId) {
        return { success: false, message: `执行记录与任务或节点不匹配` };
      }
      if (run.completion_token !== completionToken) {
        return { success: false, message: `完成凭据 (completion_token) 不正确` };
      }
      if (run.request_id && run.request_id !== requestId) {
        return { success: false, message: `本次执行已绑定其他请求标识，不得重复报告` };
      }

      const task = this.getTask(taskId);
      if (!task || task.status !== TaskStatus.RUNNING) {
        return { success: false, message: `任务当前状态不可推进: ${task?.status}` };
      }

      this.db.prepare(`
        UPDATE workflow_node_runs
        SET request_id = ?, result_summary = ?
        WHERE run_id = ?
      `).run(requestId, summary, attemptId);

      const updated = this.getNodeRunByRunId(attemptId)!;
      return {
        success: true,
        message: '报告已登记，等待当前执行退出后统一推进',
        run: updated,
      };
    });
  }

  // --- Delete Tasks ---

  deleteTask(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    return this.transaction(() => {
      this.db.prepare('DELETE FROM execution_events WHERE run_id IN (SELECT run_id FROM execution_runs WHERE task_id=?)').run(taskId);
      this.db.prepare('DELETE FROM execution_runs WHERE task_id=?').run(taskId);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      this.db.prepare('DELETE FROM task_workflows WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM workflow_node_runs WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM task_revisions WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM worker_prompts WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM execution_rounds WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM test_runs WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM acceptance_runs WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM human_decisions WHERE task_id = ?').run(taskId);
      return true;
    });
  }

  deleteAllTasks(): { deletedCount: number } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT count(*) as count FROM tasks').get() as { count: number };
      const deletedCount = row ? Number(row.count) : 0;
      this.db.exec('DELETE FROM execution_events WHERE run_id IN (SELECT run_id FROM execution_runs WHERE task_id IS NOT NULL); DELETE FROM execution_runs WHERE task_id IS NOT NULL; DELETE FROM tasks;');
      this.db.exec('DELETE FROM task_workflows;');
      this.db.exec('DELETE FROM workflow_node_runs;');
      this.db.exec('DELETE FROM task_revisions;');
      this.db.exec('DELETE FROM worker_prompts;');
      this.db.exec('DELETE FROM execution_rounds;');
      this.db.exec('DELETE FROM test_runs;');
      this.db.exec('DELETE FROM acceptance_runs;');
      this.db.exec('DELETE FROM human_decisions;');
      return { deletedCount };
    });
  }
}

export const db = new WorkbenchDatabase();
