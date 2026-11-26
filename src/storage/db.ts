import type { RunSnapshot, ExecutionEvent } from '../services/executionService.ts';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, TaskStatus, RoundStage } from '../config/constants.ts';
import { resolveExecutionTimeout } from '../services/executionPolicy.ts';
import { logger } from '../utils/logger.ts';
import {
  type WorkflowNode,
  DEFAULT_WORKFLOW_ID,
  DEFAULT_WORKFLOW_NODES,
  computeWorkflowDefinitionSha256,
  resolveTaskNodeExecutor,
  toWorkflowDesignNodes,
} from '../services/workflowDefinition.ts';

export interface WorkflowDefinitionRecord {
  id: string;
  name: string;
  description: string | null;
  nodes_json: string;
  created_at: number;
  updated_at: number;
  is_default: number;
}

function readWorkflowDesign({ version, ...record }: WorkflowDefinitionRecord & { version?: number }): WorkflowDefinitionRecord {
  try {
    const nodes = toWorkflowDesignNodes(JSON.parse(record.nodes_json), true);
    return { ...record, nodes_json: JSON.stringify(nodes) };
  } catch {
    return record;
  }
}

export interface TaskWorkflowRecord {
  task_id: string;
  workflow_id: string;
  workflow_sha256: string;
  revision: number;
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
  revision: number;
  node_id: string;
  execution_index: number;
  round_number: number;
  code_generation: number;
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'waiting_manual' | 'cancelled';
  result_summary: string | null;
  reported_outcome: 'passed' | 'failed' | null;
  completion_token: string | null;
  request_id: string | null;
  execution_run_id: string | null;
  attempt_dir: string | null;
  result_json: string | null;
  result_sha256: string | null;
  inputs_json: string | null;
  outputs_json: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface ReworkDocument {
  task_id: string;
  revision: number;
  target_node_id: string;
  sequence: number;
  source_node_id: string;
  source_run_id: string;
  source_path: string;
  sha256: string;
  created_at: number;
  content: string;
}

export interface ReworkSourceFile {
  path: string;
  sha256: string;
  content: string;
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
  workflow_sha256?: string;
  current_node_id?: string;
}

export interface TaskRevisionRecord {
  id: number;
  task_id: string;
  revision: number;
  manifest_json: string;
  manifest_sha256: string;
  package_digest: string;
  workflow_id: string;
  workflow_sha256: string;
  readiness: 'ready' | 'blocked';
  idempotency_key: string | null;
  created_at: number;
}

export interface TaskPackageFileRecord {
  id: number;
  task_id: string;
  revision: number;
  path: string;
  owner_scope: 'shared' | 'node';
  owner_node_id: string | null;
  media_type: string;
  size_bytes: number;
  sha256: string;
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
  private hasLegacyWorkflowDefinitions = false;
  private hasLegacyTaskWorkflows = false;

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

  recoverPendingTasks(): { recoveredCount: number; taskIds: string[] } {
    for (const row of this.db.prepare('SELECT snapshot_json FROM execution_runs').all() as any[]) {
      const run = JSON.parse(row.snapshot_json) as RunSnapshot;
      if (['starting', 'running', 'stopping'].includes(run.state)) {
        Object.assign(run, {
          state: 'blocked',
          activity: 'finished',
          stopReason: 'INTERRUPTED',
          finishedAt: Date.now(),
          cleanupConfirmed: false,
        });
        this.saveRun(run);
        const last = this.db.prepare('SELECT MAX(seq) AS seq FROM execution_events WHERE run_id=?').get(run.runId) as any;
        this.saveRunEvent({ runId: run.runId, seq: (last.seq || 0) + 1, at: Date.now(), type: 'finished', data: { snapshot: run } });
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
        const reason = `服务意外终止或重启：任务在第 ${t.current_round || 1} 轮 [${t.current_stage || t.status}] 中断。系统已安全挂起现场，请核对工作区状态后重新确认开始。`;
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
        execution_timeout_ms INTEGER,
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
        manifest_sha256 TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_sha256 TEXT NOT NULL,
        readiness TEXT NOT NULL DEFAULT 'ready',
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(task_id, revision)
      );

      CREATE TABLE IF NOT EXISTS task_package_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        path TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        owner_node_id TEXT,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        UNIQUE(task_id, revision, path)
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
        run_id TEXT,
        termination_reason TEXT,
        cleanup_confirmed INTEGER,
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
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        nodes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS task_workflows (
        task_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_sha256 TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
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
        revision INTEGER NOT NULL DEFAULT 1,
        node_id TEXT NOT NULL,
        execution_index INTEGER NOT NULL,
        round_number INTEGER NOT NULL DEFAULT 1,
        code_generation INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        result_summary TEXT,
        reported_outcome TEXT,
        completion_token TEXT,
        request_id TEXT,
        execution_run_id TEXT,
        attempt_dir TEXT,
        result_json TEXT,
        result_sha256 TEXT,
        inputs_json TEXT,
        outputs_json TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(task_id, node_id, execution_index)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_revisions_task_id ON task_revisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_revisions_idem ON task_revisions(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_task_package_files_rev ON task_package_files(task_id, revision);
      CREATE INDEX IF NOT EXISTS idx_execution_rounds_task_id ON execution_rounds(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_workflows_task ON task_workflows(task_id);
      CREATE INDEX IF NOT EXISTS idx_wf_node_runs_task ON workflow_node_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_wf_node_runs_token ON workflow_node_runs(completion_token);
      CREATE INDEX IF NOT EXISTS idx_wf_node_runs_req ON workflow_node_runs(request_id);

      CREATE TABLE IF NOT EXISTS workflow_completion_receipts (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_rework_documents (
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        target_node_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        source_node_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        content TEXT NOT NULL,
        pending INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (task_id, revision, target_node_id, sequence),
        UNIQUE (source_run_id, source_path)
      );
    `);

    this.migrateWorkflowTables();

    try {
      const defRow = this.db.prepare('SELECT id FROM workflow_definitions WHERE id = ?').get('default');
      if (!defRow) {
        const now = Date.now();
        this.db.prepare(`
          INSERT INTO workflow_definitions (id, name, description, nodes_json, created_at, updated_at, is_default)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(
          DEFAULT_WORKFLOW_ID,
          '默认开发交付流程',
          '经典流程：开始 -> 开发实现 -> 独立测试 -> 整体验收 -> 人工确认 -> 结束',
          JSON.stringify(DEFAULT_WORKFLOW_NODES),
          now,
          now
        );
      }
    } catch {}

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_runs (run_id TEXT PRIMARY KEY, task_id TEXT, snapshot_json TEXT NOT NULL, output_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS execution_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE INDEX IF NOT EXISTS idx_runs_task ON execution_runs(task_id);
    `);
  }

  private migrateWorkflowTables(): void {
    this.transaction(() => {
      const definitionColumns = this.tableColumns('workflow_definitions');
      const taskColumns = this.tableColumns('task_workflows');
      const runColumns = this.tableColumns('workflow_node_runs');
      this.hasLegacyWorkflowDefinitions = definitionColumns.has('version');
      this.hasLegacyTaskWorkflows = taskColumns.has('workflow_version');

      if (!taskColumns.has('revision')) {
        this.db.exec(`
          ALTER TABLE task_workflows ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
          UPDATE task_workflows SET revision = COALESCE((
            SELECT revision FROM tasks WHERE id = task_workflows.task_id
          ), 1);
        `);
      }
      if (!taskColumns.has('workflow_sha256')) {
        this.db.exec(`
          ALTER TABLE task_workflows ADD COLUMN workflow_sha256 TEXT NOT NULL DEFAULT '';
          UPDATE task_workflows SET workflow_sha256 = COALESCE((
            SELECT workflow_sha256 FROM task_revisions
            WHERE task_id = task_workflows.task_id AND revision = task_workflows.revision
              AND workflow_id = task_workflows.workflow_id
          ), '');
        `);
      }

      const nextRunColumns = {
        revision: 'INTEGER NOT NULL DEFAULT 1',
        round_number: 'INTEGER NOT NULL DEFAULT 1',
        code_generation: 'INTEGER NOT NULL DEFAULT 0',
        reported_outcome: 'TEXT',
        attempt_dir: 'TEXT',
        result_json: 'TEXT',
        result_sha256: 'TEXT',
        inputs_json: 'TEXT',
        outputs_json: 'TEXT',
      };
      for (const [column, definition] of Object.entries(nextRunColumns)) {
        if (!runColumns.has(column)) this.db.exec(`ALTER TABLE workflow_node_runs ADD COLUMN ${column} ${definition}`);
      }
      if (!runColumns.has('revision')) {
        this.db.exec(`
          UPDATE workflow_node_runs SET revision = COALESCE((
            SELECT revision FROM task_revisions
            WHERE task_id = workflow_node_runs.task_id AND created_at <= workflow_node_runs.created_at
            ORDER BY created_at DESC, revision DESC LIMIT 1
          ), 1);
        `);
      }
    });
  }

  private tableColumns(table: string): Set<string> {
    const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
    return new Set(columns.map(({ name }) => name));
  }

  taskOutputBytes(taskId: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(output_bytes),0) AS bytes FROM execution_runs WHERE task_id=?').get(taskId) as any).bytes;
  }

  pruneProbeRuns(): void {
    let total = (this.db.prepare('SELECT COALESCE(SUM(output_bytes),0) AS bytes FROM execution_runs WHERE task_id IS NULL').get() as any).bytes;
    for (const row of this.db.prepare('SELECT run_id,snapshot_json,output_bytes FROM execution_runs WHERE task_id IS NULL ORDER BY rowid').all() as any[]) {
      const run = JSON.parse(row.snapshot_json);
      if (run.finishedAt === null || (Date.now() - run.finishedAt < 7 * 86400000 && total <= 100 * 1024 * 1024)) continue;
      const size = row.output_bytes;
      this.db.prepare('DELETE FROM execution_events WHERE run_id=?').run(row.run_id);
      this.db.prepare('DELETE FROM execution_runs WHERE run_id=?').run(row.run_id);
      total -= size;
    }
  }

  updateRoundTermination(roundId: number, runId: string, reason: string | null, confirmed: boolean): void {
    this.db.prepare('UPDATE execution_rounds SET run_id=?,termination_reason=?,cleanup_confirmed=? WHERE id=?').run(runId, reason, confirmed ? 1 : 0, roundId);
  }

  recordRunCleanup(runId: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    run.cleanupConfirmed = true;
    this.saveRun(run);
    if (run.roundId !== null) this.updateRoundTermination(run.roundId, runId, run.stopReason, true);
    const last = this.db.prepare('SELECT MAX(seq) AS seq FROM execution_events WHERE run_id=?').get(runId) as any;
    this.saveRunEvent({ runId, seq: (last.seq || 0) + 1, at: Date.now(), type: 'finished', data: { snapshot: run } });
  }

  saveRun(run: RunSnapshot): void {
    this.db.prepare('INSERT INTO execution_runs(run_id,task_id,snapshot_json) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(run.runId, run.taskId, JSON.stringify(run));
  }

  getRun(id: string): RunSnapshot | null {
    const row = this.db.prepare('SELECT snapshot_json FROM execution_runs WHERE run_id=?').get(id) as any;
    return row ? JSON.parse(row.snapshot_json) : null;
  }

  latestRun(taskId: string): RunSnapshot | null {
    const row = this.db.prepare('SELECT snapshot_json FROM execution_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as any;
    return row ? JSON.parse(row.snapshot_json) : null;
  }

  saveRunEvent(event: ExecutionEvent, snapshot?: RunSnapshot): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO execution_events VALUES (?,?,?,?,?)').run(event.runId, event.seq, event.at, event.type, JSON.stringify(event.data));
      if (event.type === 'output') this.db.prepare('UPDATE execution_runs SET output_bytes=output_bytes+? WHERE run_id=?').run(Buffer.byteLength(event.data.text, 'utf8'), event.runId);
      if (snapshot) this.saveRun(snapshot);
    });
  }

  runEvents(id: string, after: number, limit: number): ExecutionEvent[] {
    return (this.db.prepare('SELECT * FROM execution_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit) as any[])
      .map((row) => ({ runId: row.run_id, seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.data_json) }));
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
    execution_timeout_ms?: number;
    worker_executor?: string;
    worker_model?: string;
    reviewer_executor?: string;
    reviewer_model?: string;
    workflow_id?: string;
  }): TaskRecord {
    const now = Date.now();
    const revision = data.revision ?? 1;
    const status = data.status ?? TaskStatus.PENDING_CONFIRM;
    const budgetRounds = data.budget_max_rounds ?? 10;
    const workerExecutor = data.worker_executor || 'codex';
    const workerModel = data.worker_model || (workerExecutor === 'codex' ? 'default' : 'deepseek-v4-flash');
    const reviewerExecutor = data.reviewer_executor || 'codex';
    const reviewerModel = data.reviewer_model || (reviewerExecutor === 'codex' ? 'default' : 'deepseek-v4-flash');
    const executionTimeoutMs = resolveExecutionTimeout(data.execution_timeout_ms);

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, task_key, revision, title, status, target_cwd,
        git_root, git_commit, git_status,
        budget_max_rounds, execution_timeout_ms, current_round,
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
      executionTimeoutMs,
      now,
      now,
      workerExecutor,
      workerModel,
      reviewerExecutor,
      reviewerModel
    );

    if (!this.getTaskWorkflow(data.id)) {
      this.initTaskWorkflow(data.id, { workflowId: data.workflow_id, revision });
    }
    return this.getTask(data.id)!;
  }

  getTask(id: string): TaskRecord | null {
    const stmt = this.db.prepare(`
      SELECT t.*, tw.workflow_id, tw.workflow_sha256, tw.current_node_id
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
        SELECT t.*, tw.workflow_id, tw.workflow_sha256, tw.current_node_id
        FROM tasks t
        LEFT JOIN task_workflows tw ON t.id = tw.task_id
        WHERE t.status = ?
        ORDER BY t.created_at DESC
      `);
      return stmt.all(statusFilter) as unknown as TaskRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT t.*, tw.workflow_id, tw.workflow_sha256, tw.current_node_id
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
      title?: string;
      target_cwd?: string;
      revision?: number;
      blocked_reason?: string | null;
      active_worker_id?: string | null;
      current_stage?: RoundStage | null;
      current_round?: number;
      confirmed_cwd?: string;
      started_at?: number;
      completed_at?: number | null;
      execution_timeout_ms?: number;
      budget_max_rounds?: number;
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

    if (extra?.title !== undefined) { updates.push('title = ?'); params.push(extra.title); }
    if (extra?.target_cwd !== undefined) { updates.push('target_cwd = ?'); params.push(extra.target_cwd); }
    if (extra?.revision !== undefined) { updates.push('revision = ?'); params.push(extra.revision); }
    if (extra?.blocked_reason !== undefined) { updates.push('blocked_reason = ?'); params.push(extra.blocked_reason); }
    if (extra?.active_worker_id !== undefined) { updates.push('active_worker_id = ?'); params.push(extra.active_worker_id); }
    if (extra?.current_stage !== undefined) { updates.push('current_stage = ?'); params.push(extra.current_stage); }
    if (extra?.current_round !== undefined) { updates.push('current_round = ?'); params.push(extra.current_round); }
    if (extra?.confirmed_cwd !== undefined) { updates.push('confirmed_cwd = ?'); params.push(extra.confirmed_cwd); }
    if (extra?.started_at !== undefined) { updates.push('started_at = ?'); params.push(extra.started_at); }
    if (extra?.completed_at !== undefined) { updates.push('completed_at = ?'); params.push(extra.completed_at); }
    if (extra?.worker_executor !== undefined) { updates.push('worker_executor = ?'); params.push(extra.worker_executor); }
    if (extra?.worker_model !== undefined) { updates.push('worker_model = ?'); params.push(extra.worker_model); }
    if (extra?.reviewer_executor !== undefined) { updates.push('reviewer_executor = ?'); params.push(extra.reviewer_executor); }
    if (extra?.reviewer_model !== undefined) { updates.push('reviewer_model = ?'); params.push(extra.reviewer_model); }
    if (extra?.execution_timeout_ms !== undefined) { updates.push('execution_timeout_ms = ?'); params.push(extra.execution_timeout_ms); }
    if (extra?.budget_max_rounds !== undefined) { updates.push('budget_max_rounds = ?'); params.push(extra.budget_max_rounds); }
    if (extra?.stop_requested !== undefined) { updates.push('stop_requested = ?'); params.push(extra.stop_requested); }

    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  requestTaskStop(id: string): void {
    this.db.prepare('UPDATE tasks SET stop_requested = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // --- Task Revisions & Package Files ---

  saveRevision(data: {
    task_id: string;
    revision: number;
    manifest_json: string;
    manifest_sha256: string;
    package_digest: string;
    workflow_id: string;
    workflow_sha256: string;
    readiness?: 'ready' | 'blocked';
    idempotency_key?: string | null;
    files?: Array<{
      path: string;
      owner_scope: 'shared' | 'node';
      owner_node_id: string | null;
      media_type: string;
      size_bytes: number;
      sha256: string;
    }>;
  }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO task_revisions (
        task_id, revision, manifest_json, manifest_sha256, package_digest,
        workflow_id, workflow_sha256, readiness, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.task_id,
      data.revision,
      data.manifest_json,
      data.manifest_sha256,
      data.package_digest,
      data.workflow_id,
      data.workflow_sha256,
      data.readiness || 'ready',
      data.idempotency_key || null,
      now
    );

    if (data.files && data.files.length > 0) {
      const fileStmt = this.db.prepare(`
        INSERT INTO task_package_files (
          task_id, revision, path, owner_scope, owner_node_id, media_type, size_bytes, sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const f of data.files) {
        fileStmt.run(
          data.task_id,
          data.revision,
          f.path,
          f.owner_scope,
          f.owner_node_id || null,
          f.media_type,
          f.size_bytes,
          f.sha256
        );
      }
    }

    this.db.prepare('UPDATE tasks SET revision = ?, updated_at = ? WHERE id = ?').run(
      data.revision,
      now,
      data.task_id
    );
  }

  getRevision(taskId: string, revision: number): TaskRevisionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_revisions WHERE task_id = ? AND revision = ?')
      .get(taskId, revision) as unknown as TaskRevisionRecord | undefined;
    return row ?? null;
  }

  getLatestRevision(taskId: string): TaskRevisionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1')
      .get(taskId) as unknown as TaskRevisionRecord | undefined;
    return row ?? null;
  }

  listRevisions(taskId: string): TaskRevisionRecord[] {
    return this.db
      .prepare('SELECT * FROM task_revisions WHERE task_id = ? ORDER BY revision DESC')
      .all(taskId) as unknown as TaskRevisionRecord[];
  }

  getPackageFiles(taskId: string, revision: number): TaskPackageFileRecord[] {
    return this.db
      .prepare('SELECT * FROM task_package_files WHERE task_id = ? AND revision = ? ORDER BY path ASC')
      .all(taskId, revision) as unknown as TaskPackageFileRecord[];
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
    this.db.prepare(`UPDATE execution_rounds SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  getRounds(taskId: string): ExecutionRoundRecord[] {
    return this.db
      .prepare('SELECT * FROM execution_rounds WHERE task_id = ? ORDER BY round_number ASC, id ASC')
      .all(taskId) as unknown as ExecutionRoundRecord[];
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
    this.db.prepare(`
      INSERT INTO test_runs (
        task_id, round_number, test_case_id, command, exit_code,
        stdout, stderr, report_path, report_content, passed, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      return this.db
        .prepare('SELECT * FROM test_runs WHERE task_id = ? AND round_number = ? ORDER BY executed_at ASC')
        .all(taskId, roundNumber) as unknown as TestRunRecord[];
    }
    return this.db
      .prepare('SELECT * FROM test_runs WHERE task_id = ? ORDER BY executed_at ASC')
      .all(taskId) as unknown as TestRunRecord[];
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
    this.db.prepare(`
      INSERT INTO acceptance_runs (
        task_id, round_number, decision, summary,
        criteria_results_json, issues_json, manual_checks_json, code_snapshot_json,
        raw_output, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    return this.db
      .prepare('SELECT * FROM acceptance_runs WHERE task_id = ? ORDER BY executed_at ASC')
      .all(taskId) as unknown as AcceptanceRunRecord[];
  }

  saveHumanDecision(data: {
    task_id: string;
    action: 'approve' | 'reject';
    reason: string;
  }): void {
    this.db.prepare(`
      INSERT INTO human_decisions (task_id, action, reason, decided_at)
      VALUES (?, ?, ?, ?)
    `).run(data.task_id, data.action, data.reason, Date.now());
  }

  getHumanDecisions(taskId: string): HumanDecisionRecord[] {
    return this.db
      .prepare('SELECT * FROM human_decisions WHERE task_id = ? ORDER BY decided_at ASC')
      .all(taskId) as unknown as HumanDecisionRecord[];
  }

  // --- Workflow Definitions ---

  isWorkflowReferenced(workflowId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM task_workflows WHERE workflow_id = ? LIMIT 1').get(workflowId);
    return Boolean(row);
  }

  getWorkflowReferencingTasks(workflowId: string): { id: string; title: string; status: string }[] {
    return this.db.prepare(`
      SELECT t.id, t.title, t.status
      FROM task_workflows tw
      INNER JOIN tasks t ON tw.task_id = t.id
      WHERE tw.workflow_id = ?
      ORDER BY t.created_at DESC
    `).all(workflowId) as { id: string; title: string; status: string }[];
  }

  getWorkflow(id: string): WorkflowDefinitionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_definitions WHERE id = ?${this.hasLegacyWorkflowDefinitions ? ' ORDER BY version DESC LIMIT 1' : ''}`)
      .get(id) as unknown as WorkflowDefinitionRecord | undefined;
    return row ? readWorkflowDesign(row) : null;
  }

  listWorkflows(): WorkflowDefinitionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM workflow_definitions
      ${this.hasLegacyWorkflowDefinitions ? `WHERE version = (
        SELECT MAX(history.version) FROM workflow_definitions history WHERE history.id = workflow_definitions.id
      )` : ''}
      ORDER BY is_default DESC, id ASC
    `).all() as unknown as WorkflowDefinitionRecord[];
    return rows.map(readWorkflowDesign);
  }

  saveWorkflowDefinition(data: {
    id: string;
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
        WHERE id = ?${this.hasLegacyWorkflowDefinitions ? ' AND version = (SELECT MAX(version) FROM workflow_definitions WHERE id = ?)' : ''}
      `).run(
        data.name,
        data.description || null,
        data.nodes_json,
        now,
        data.is_default ?? existing.is_default,
        data.id,
        ...(this.hasLegacyWorkflowDefinitions ? [data.id] : []),
      );
      return this.getWorkflow(data.id)!;
    }

    const now = Date.now();
    this.db.prepare(`
      INSERT INTO workflow_definitions (
        id, name, description, nodes_json, created_at, updated_at, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      data.name,
      data.description || null,
      data.nodes_json,
      now,
      now,
      data.is_default ?? 0
    );

    return this.getWorkflow(data.id)!;
  }

  deleteWorkflow(id: string): boolean {
    const existing = this.getWorkflow(id);
    if (!existing) return false;

    if (existing.id === DEFAULT_WORKFLOW_ID || existing.is_default === 1) {
      throw new Error('系统默认工作流禁止删除');
    }

    if (this.isWorkflowReferenced(id)) {
      throw new Error(`工作流 [${id}] 当前正被任务引用，禁止删除！若需删除请先清理相关任务。`);
    }

    this.transaction(() => {
      this.db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id);
    });
    return true;
  }

  // --- Task Workflows ---

  getTaskWorkflow(taskId: string): TaskWorkflowRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_workflows WHERE task_id = ?')
      .get(taskId) as unknown as TaskWorkflowRecord | undefined;
    return row ?? null;
  }

  initTaskWorkflow(
    taskId: string,
    options?: {
      workflowId?: string;
      workflowSha256?: string;
      revision?: number;
      nodesOverride?: WorkflowNode[];
    }
  ): TaskWorkflowRecord {
    const wfId = options?.workflowId || DEFAULT_WORKFLOW_ID;
    let nodes: WorkflowNode[];
    let wfSha = options?.workflowSha256 || '';

    if (options?.nodesOverride) {
      nodes = JSON.parse(JSON.stringify(options.nodesOverride));
      if (!wfSha) {
        wfSha = computeWorkflowDefinitionSha256({ id: wfId, name: wfId, description: null, nodes });
      }
    } else {
      const def = this.getWorkflow(wfId);
      if (def) {
        nodes = JSON.parse(def.nodes_json);
        if (!wfSha) {
          wfSha = computeWorkflowDefinitionSha256({
            id: def.id,
            name: def.name,
            description: def.description,
            nodes,
          });
        }
      } else {
        nodes = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW_NODES));
        if (!wfSha) {
          wfSha = computeWorkflowDefinitionSha256({
            id: DEFAULT_WORKFLOW_ID,
            name: '默认开发交付流程',
            description: null,
            nodes,
          });
        }
      }
    }

    const revision = options?.revision ?? 1;
    const previous = revision > 1 ? this.getTaskWorkflow(taskId) : null;
    const previousAgentNodes = new Map<string, WorkflowNode>();
    if (previous?.workflow_id === wfId && previous.revision < revision) {
      try {
        const previousNodes = JSON.parse(previous.nodes_json) as WorkflowNode[];
        for (const node of previousNodes) {
          if (node.type === 'task' && node.execution_mode === 'agent') previousAgentNodes.set(node.id, node);
        }
      } catch {
        previousAgentNodes.clear();
      }
    }
    nodes = nodes.map((node) => {
      if (node.type !== 'task' || node.execution_mode !== 'agent') return node;
      const prior = previousAgentNodes.get(node.id);
      const matchingPrior = (prior?.result_rule || 'default') === (node.result_rule || 'default') ? prior : undefined;
      return {
        ...node,
        executor: matchingPrior?.executor || resolveTaskNodeExecutor(node),
        model: matchingPrior?.model ?? node.model,
      };
    });
    const startNode = nodes.find((n) => n.type === 'start') || nodes[0];
    const initialNodeId = startNode ? startNode.id : 'start';
    const now = Date.now();

    const legacyVersion = this.hasLegacyTaskWorkflows && this.hasLegacyWorkflowDefinitions
      ? (this.db.prepare('SELECT MAX(version) AS version FROM workflow_definitions WHERE id = ?').get(wfId)?.version as number | null)
      : null;
    this.db.prepare(`
      INSERT OR REPLACE INTO task_workflows (
        task_id, workflow_id, workflow_sha256, revision, nodes_json,
        current_node_id, current_run_id, code_generation,
        tests_passed_generation, acceptance_passed_generation, updated_at${this.hasLegacyTaskWorkflows ? ', workflow_version' : ''}
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, ?${this.hasLegacyTaskWorkflows ? ', ?' : ''})
    `).run(taskId, wfId, wfSha, revision, JSON.stringify(nodes), initialNodeId, now,
      ...(this.hasLegacyTaskWorkflows ? [legacyVersion ?? 1] : []));

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
      revision: number;
      workflow_sha256: string;
    }>
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];

    if (updates.current_node_id !== undefined) { sets.push('current_node_id = ?'); params.push(updates.current_node_id); }
    if (updates.current_run_id !== undefined) { sets.push('current_run_id = ?'); params.push(updates.current_run_id); }
    if (updates.code_generation !== undefined) { sets.push('code_generation = ?'); params.push(updates.code_generation); }
    if (updates.tests_passed_generation !== undefined) { sets.push('tests_passed_generation = ?'); params.push(updates.tests_passed_generation); }
    if (updates.acceptance_passed_generation !== undefined) { sets.push('acceptance_passed_generation = ?'); params.push(updates.acceptance_passed_generation); }
    if (updates.nodes_json !== undefined) { sets.push('nodes_json = ?'); params.push(updates.nodes_json); }
    if (updates.revision !== undefined) { sets.push('revision = ?'); params.push(updates.revision); }
    if (updates.workflow_sha256 !== undefined) { sets.push('workflow_sha256 = ?'); params.push(updates.workflow_sha256); }

    params.push(taskId);
    this.db.prepare(`UPDATE task_workflows SET ${sets.join(', ')} WHERE task_id = ?`).run(...params);
  }

  // --- Workflow Node Runs ---

  createNodeRun(data: {
    run_id: string;
    task_id: string;
    revision?: number;
    node_id: string;
    execution_index: number;
    round_number?: number;
    code_generation?: number;
    status?: WorkflowNodeRunRecord['status'];
    completion_token?: string | null;
    execution_run_id?: string | null;
    attempt_dir?: string | null;
    inputs_json?: string | null;
    result_summary?: string | null;
  }): WorkflowNodeRunRecord {
    const now = Date.now();
    const status = data.status || 'running';
    this.db.prepare(`
      INSERT INTO workflow_node_runs (
        run_id, task_id, revision, node_id, execution_index, round_number, code_generation, status,
        result_summary, completion_token, request_id,
        execution_run_id, attempt_dir, inputs_json, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)
    `).run(
      data.run_id,
      data.task_id,
      data.revision ?? 1,
      data.node_id,
      data.execution_index,
      data.round_number ?? 1,
      data.code_generation ?? 0,
      status,
      data.result_summary || null,
      data.completion_token || null,
      data.execution_run_id || null,
      data.attempt_dir || null,
      data.inputs_json || null,
      now
    );

    return this.getNodeRunByRunId(data.run_id)!;
  }

  updateNodeRun(
    runId: string,
    updates: Partial<{
      status: WorkflowNodeRunRecord['status'];
      result_summary: string | null;
      completion_token: string | null;
      request_id: string | null;
      execution_run_id: string | null;
      attempt_dir: string | null;
      result_json: string | null;
      result_sha256: string | null;
      inputs_json: string | null;
      outputs_json: string | null;
      finished_at: number | null;
    }>
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.result_summary !== undefined) { sets.push('result_summary = ?'); params.push(updates.result_summary); }
    if (updates.completion_token !== undefined) { sets.push('completion_token = ?'); params.push(updates.completion_token); }
    if (updates.request_id !== undefined) { sets.push('request_id = ?'); params.push(updates.request_id); }
    if (updates.execution_run_id !== undefined) { sets.push('execution_run_id = ?'); params.push(updates.execution_run_id); }
    if (updates.attempt_dir !== undefined) { sets.push('attempt_dir = ?'); params.push(updates.attempt_dir); }
    if (updates.result_json !== undefined) { sets.push('result_json = ?'); params.push(updates.result_json); }
    if (updates.result_sha256 !== undefined) { sets.push('result_sha256 = ?'); params.push(updates.result_sha256); }
    if (updates.inputs_json !== undefined) { sets.push('inputs_json = ?'); params.push(updates.inputs_json); }
    if (updates.outputs_json !== undefined) { sets.push('outputs_json = ?'); params.push(updates.outputs_json); }
    if (updates.finished_at !== undefined) { sets.push('finished_at = ?'); params.push(updates.finished_at); }

    if (sets.length === 0) return;
    params.push(runId);
    this.db.prepare(`UPDATE workflow_node_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...params);
  }

  getNodeRuns(taskId: string, nodeId?: string, revision?: number): WorkflowNodeRunRecord[] {
    if (nodeId && revision !== undefined) {
      return this.db
        .prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? AND node_id = ? AND revision = ? ORDER BY execution_index ASC, id ASC')
        .all(taskId, nodeId, revision) as unknown as WorkflowNodeRunRecord[];
    }
    if (nodeId) {
      return this.db
        .prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? AND node_id = ? ORDER BY execution_index ASC, id ASC')
        .all(taskId, nodeId) as unknown as WorkflowNodeRunRecord[];
    }
    return this.db
      .prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as unknown as WorkflowNodeRunRecord[];
  }

  getLatestNodeRun(taskId: string, nodeId?: string): WorkflowNodeRunRecord | null {
    if (nodeId) {
      const row = this.db
        .prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? AND node_id = ? ORDER BY execution_index DESC, id DESC LIMIT 1')
        .get(taskId, nodeId) as unknown as WorkflowNodeRunRecord | undefined;
      return row ?? null;
    }
    const row = this.db
      .prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getLatestCompletedNodeRunForRevision(taskId: string, revision: number, nodeId: string): WorkflowNodeRunRecord | null {
    const row = this.db
      .prepare(`
        SELECT * FROM workflow_node_runs
        WHERE task_id = ? AND revision = ? AND node_id = ? AND status IN ('passed', 'failed')
        ORDER BY execution_index DESC, id DESC LIMIT 1
      `)
      .get(taskId, revision, nodeId) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getNodeRunByRunId(runId: string): WorkflowNodeRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_node_runs WHERE run_id = ?')
      .get(runId) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getNodeRunByToken(taskId: string, token: string): WorkflowNodeRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_node_runs WHERE task_id = ? AND completion_token = ?')
      .get(taskId, token) as unknown as WorkflowNodeRunRecord | undefined;
    return row ?? null;
  }

  getNodeRunCount(taskId: string, nodeId: string, revision?: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM workflow_node_runs WHERE task_id = ? AND node_id = ? AND (? IS NULL OR revision = ?)')
      .get(taskId, nodeId, revision ?? null, revision ?? null) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  hasExecutedNode(taskId: string, revision: number, nodeId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM workflow_node_runs
      WHERE task_id = ? AND revision = ? AND node_id = ? AND status IN ('passed', 'failed') LIMIT 1`
    ).get(taskId, revision, nodeId));
  }

  appendReworkDocuments(run: WorkflowNodeRunRecord, targetNodeId: string, files: ReworkSourceFile[]): void {
    if (!files.length) return;
    const { task_id, revision, node_id, run_id } = run;
    const last = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workflow_rework_documents
      WHERE task_id = ? AND revision = ? AND target_node_id = ?`).get(task_id, revision, targetNodeId) as { sequence: number };
    const insert = this.db.prepare(`INSERT INTO workflow_rework_documents
      (task_id, revision, target_node_id, sequence, source_node_id, source_run_id, source_path, sha256, created_at, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    files.forEach((file, index) => insert.run(task_id, revision, targetNodeId, last.sequence + index + 1,
      node_id, run_id, file.path, file.sha256, now, file.content));
  }

  consumeReworkDocuments(taskId: string, revision: number, nodeId: string): void {
    this.db.prepare(`UPDATE workflow_rework_documents SET pending = 0
      WHERE task_id = ? AND revision = ? AND target_node_id = ? AND pending = 1`).run(taskId, revision, nodeId);
  }

  getPendingReworkDocuments(taskId: string, revision: number, nodeId: string): ReworkDocument[] {
    return this.db.prepare(`SELECT * FROM workflow_rework_documents
      WHERE task_id = ? AND revision = ? AND target_node_id = ? AND pending = 1 ORDER BY sequence`
    ).all(taskId, revision, nodeId) as unknown as ReworkDocument[];
  }

  listReworkDocuments(taskId: string, revision: number): Omit<ReworkDocument, 'content'>[] {
    return this.db.prepare(`SELECT task_id, revision, target_node_id, sequence, source_node_id, source_run_id,
      source_path, sha256, created_at FROM workflow_rework_documents
      WHERE task_id = ? AND revision = ? ORDER BY target_node_id, sequence`
    ).all(taskId, revision) as unknown as Omit<ReworkDocument, 'content'>[];
  }

  getReworkDocument(taskId: string, revision: number, nodeId: string, sequence: number): ReworkDocument | undefined {
    return this.db.prepare(`SELECT * FROM workflow_rework_documents
      WHERE task_id = ? AND revision = ? AND target_node_id = ? AND sequence = ?`
    ).get(taskId, revision, nodeId, sequence) as unknown as ReworkDocument | undefined;
  }

  getAdvancePayload(runId: string): string | undefined {
    return this.db.prepare('SELECT payload_json FROM workflow_completion_receipts WHERE run_id = ?')
      .get(runId)?.payload_json as string | undefined;
  }

  registerAdvanceReport(
    taskId: string,
    nodeId: string,
    attemptId: string,
    completionToken: string,
    requestId: string,
    outcome: 'passed' | 'failed',
    summary: string,
    fingerprint = JSON.stringify([outcome, summary]),
    prepare: (run: WorkflowNodeRunRecord, workflow: TaskWorkflowRecord) => string = () => '{}',
  ): { success: boolean; message: string; duplicate?: boolean; run?: WorkflowNodeRunRecord } {
    return this.transaction(() => {
      const run = this.getNodeRunByRunId(attemptId);
      if (!run) {
        return { success: false, message: `未找到执行记录: ${attemptId}` };
      }
      if (run.task_id !== taskId || run.node_id !== nodeId) {
        return { success: false, message: '执行记录与任务或节点不匹配' };
      }
      if (run.completion_token !== completionToken) {
        return { success: false, message: '完成凭据 (completion_token) 不正确' };
      }
      const task = this.getTask(taskId);
      const workflow = this.getTaskWorkflow(taskId);
      if (!task || !workflow || task.revision !== run.revision || workflow.revision !== run.revision) {
        return { success: false, message: '本次执行的任务修订已失效' };
      }
      if (run.request_id) {
        const receipt = this.db.prepare('SELECT fingerprint FROM workflow_completion_receipts WHERE run_id = ?').get(attemptId);
        if (run.request_id === requestId && receipt?.fingerprint === fingerprint) {
          return { success: true, duplicate: true, message: '报告已接收（幂等处理）', run };
        }
        return { success: false, message: '本次执行已提交不同报告' };
      }
      if (task.status !== TaskStatus.RUNNING || task.stop_requested || run.status !== 'running' ||
          workflow.current_node_id !== nodeId || workflow.current_run_id !== attemptId) {
        return { success: false, message: '当前执行已停止或不再是活动节点' };
      }
      if (this.db.prepare('SELECT 1 FROM workflow_node_runs WHERE request_id = ? LIMIT 1').get(requestId)) {
        return { success: false, message: '请求标识已用于其他执行' };
      }

      const payload = prepare(run, workflow);
      this.db.prepare(`INSERT INTO workflow_completion_receipts (run_id, task_id, fingerprint, payload_json)
        VALUES (?, ?, ?, ?)`).run(attemptId, taskId, fingerprint, payload);

      this.db.prepare(`
        UPDATE workflow_node_runs
        SET request_id = ?, result_summary = ?, reported_outcome = ?
        WHERE run_id = ?
      `).run(requestId, summary, outcome, attemptId);

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
      this.db.prepare('DELETE FROM workflow_completion_receipts WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM workflow_rework_documents WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM execution_events WHERE run_id IN (SELECT run_id FROM execution_runs WHERE task_id=?)').run(taskId);
      this.db.prepare('DELETE FROM execution_runs WHERE task_id=?').run(taskId);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      this.db.prepare('DELETE FROM task_workflows WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM workflow_node_runs WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM task_revisions WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM task_package_files WHERE task_id = ?').run(taskId);
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
      this.db.exec('DELETE FROM workflow_completion_receipts; DELETE FROM workflow_rework_documents;');
      this.db.exec('DELETE FROM workflow_node_runs;');
      this.db.exec('DELETE FROM task_revisions;');
      this.db.exec('DELETE FROM task_package_files;');
      this.db.exec('DELETE FROM execution_rounds;');
      this.db.exec('DELETE FROM test_runs;');
      this.db.exec('DELETE FROM acceptance_runs;');
      this.db.exec('DELETE FROM human_decisions;');
      return { deletedCount };
    });
  }
}

export const db = new WorkbenchDatabase();
