import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, DATA_DIR, TaskStatus, RoundStage } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

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
  current_round: number;
  active_worker_id: string | null;
  current_stage: RoundStage | null;
  stop_requested: number;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
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
  id: number;
  task_id: string;
  round_number: number;
  stage: RoundStage;
  worker_id: string | null;
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
    this.initTables();
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
        completed_at INTEGER
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

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_revisions_task_id ON task_revisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_execution_rounds_task_id ON execution_rounds(task_id);
    `);
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
  }): TaskRecord {
    const now = Date.now();
    const revision = data.revision ?? 1;
    const status = data.status ?? TaskStatus.PENDING_CONFIRM;
    const budgetRounds = data.budget_max_rounds ?? 10;
    const budgetTimeout = data.budget_timeout_sec ?? 1800;

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, task_key, revision, title, status, target_cwd,
        git_root, git_commit, git_status,
        budget_max_rounds, budget_timeout_sec, current_round,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
      now
    );

    return this.getTask(data.id)!;
  }

  getTask(id: string): TaskRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const row = stmt.get(id) as unknown as TaskRecord | undefined;
    return row ?? null;
  }

  listTasks(statusFilter?: TaskStatus): TaskRecord[] {
    if (statusFilter) {
      const stmt = this.db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC`);
      return stmt.all(statusFilter) as unknown as TaskRecord[];
    }
    const stmt = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`);
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
    input_prompt?: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO execution_rounds (
        task_id, round_number, stage, worker_id, input_prompt,
        status, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?)
    `);
    const result = stmt.run(
      data.task_id,
      data.round_number,
      data.stage,
      data.worker_id || null,
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
    }
  ): void {
    const stmt = this.db.prepare(`
      UPDATE execution_rounds
      SET status = ?, output_text = ?, issues_json = ?, error_message = ?, finished_at = ?
      WHERE id = ?
    `);
    stmt.run(
      data.status,
      data.output_text || null,
      data.issues_json || null,
      data.error_message || null,
      Date.now(),
      roundId
    );
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
}

export const db = new WorkbenchDatabase();
