import fs from 'node:fs';
import path from 'node:path';
import {
  MAINTENANCE_DELETIONS_DIR,
  TASKS_DATA_DIR,
  TaskStatus,
} from '../config/constants.ts';
import { db } from '../storage/db.ts';
import { taskFileStore } from '../storage/fileStore.ts';
import { workflowEngine } from './workflowEngine.ts';
import { logger } from '../utils/logger.ts';

export interface DeletionRecoveryRecord {
  task_id: string;
  state: 'deleting' | 'cleanup_failed';
  step: 'stopping' | 'files' | 'database';
  error: string | null;
  started_at: number;
  updated_at: number;
}

export interface TaskDeleteResult {
  ok: boolean;
  task_id: string;
  alreadyDeleted?: boolean;
  code?: string;
  message: string;
}

export class TaskCleanupService {
  private inFlight = new Map<string, Promise<TaskDeleteResult>>();

  private ensureRecoveryDir(): void {
    if (!fs.existsSync(MAINTENANCE_DELETIONS_DIR)) {
      fs.mkdirSync(MAINTENANCE_DELETIONS_DIR, { recursive: true });
    }
  }

  private getRecoveryFilePath(taskId: string): string {
    if (!taskId || !/^[a-zA-Z0-9._-]+$/.test(taskId) || taskId === '.' || taskId === '..') {
      throw new Error(`非法的任务 ID: ${taskId}`);
    }
    return path.join(MAINTENANCE_DELETIONS_DIR, `${taskId}.json`);
  }

  private writeRecoveryRecord(record: DeletionRecoveryRecord): void {
    this.ensureRecoveryDir();
    const filePath = this.getRecoveryFilePath(record.task_id);
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  }

  private readRecoveryRecord(taskId: string): DeletionRecoveryRecord | null {
    try {
      const filePath = this.getRecoveryFilePath(taskId);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DeletionRecoveryRecord;
    } catch {
      return null;
    }
  }

  private removeRecoveryRecord(taskId: string): void {
    try {
      const filePath = this.getRecoveryFilePath(taskId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  isTaskDeleting(taskId: string): boolean {
    if (this.inFlight.has(taskId)) return true;
    const rec = this.readRecoveryRecord(taskId);
    if (rec) return true;
    const task = db.getTask(taskId);
    return task?.status === TaskStatus.DELETING || task?.status === TaskStatus.CLEANUP_FAILED;
  }

  async deleteTask(taskId: string): Promise<TaskDeleteResult> {
    const existingFlight = this.inFlight.get(taskId);
    if (existingFlight) {
      return existingFlight;
    }

    const runPromise = this.performDeleteTask(taskId).finally(() => {
      this.inFlight.delete(taskId);
    });
    this.inFlight.set(taskId, runPromise);
    return runPromise;
  }

  private async performDeleteTask(taskId: string): Promise<TaskDeleteResult> {
    let taskDirExists = false;
    try {
      taskDirExists = fs.existsSync(taskFileStore.getTaskRootDir(taskId));
    } catch (err: any) {
      return {
        ok: false,
        task_id: taskId,
        code: 'INVALID_TASK_ID',
        message: err?.message || '非法任务 ID',
      };
    }

    const existingTask = db.getTask(taskId);
    const existingRecovery = this.readRecoveryRecord(taskId);

    if (!existingTask && !taskDirExists && !existingRecovery) {
      return {
        ok: true,
        task_id: taskId,
        alreadyDeleted: true,
        message: `任务 ${taskId} 已删除或不存在`,
      };
    }

    const startedAt = existingRecovery?.started_at ?? Date.now();
    const record: DeletionRecoveryRecord = {
      task_id: taskId,
      state: 'deleting',
      step: 'stopping',
      error: null,
      started_at: startedAt,
      updated_at: Date.now(),
    };

    try {
      // Step 1: Mark deleting in recovery store and DB before touching files or processes
      this.writeRecoveryRecord(record);
      if (existingTask) {
        db.updateTaskStatus(taskId, TaskStatus.DELETING, { blocked_reason: null });
      }
    } catch (err: any) {
      return {
        ok: false,
        task_id: taskId,
        code: 'CLEANUP_FAILED',
        message: `无法记录删除状态: ${err?.message || err}`,
      };
    }

    // Step 2: Stop running processes and release runtime references
    try {
      await workflowEngine.handleTaskDeleted(taskId);
    } catch (err: any) {
      const msg = err?.message || '停止运行进程失败';
      this.markCleanupFailed(taskId, 'stopping', msg, startedAt);
      return {
        ok: false,
        task_id: taskId,
        code: 'CLEANUP_FAILED',
        message: msg,
      };
    }

    // Step 3: Remove disk directory strictly inside TASKS_DATA_DIR
    try {
      record.step = 'files';
      record.updated_at = Date.now();
      this.writeRecoveryRecord(record);
      taskFileStore.deleteTaskFiles(taskId);
    } catch (err: any) {
      const msg = `删除任务磁盘目录失败 (${taskId}): ${err?.message || err}`;
      this.markCleanupFailed(taskId, 'files', msg, startedAt);
      return {
        ok: false,
        task_id: taskId,
        code: 'CLEANUP_FAILED',
        message: msg,
      };
    }

    // Step 4: Only after files are gone, delete DB records atomically
    try {
      record.step = 'database';
      record.updated_at = Date.now();
      this.writeRecoveryRecord(record);
      db.deleteTask(taskId);
    } catch (err: any) {
      const msg = `删除任务数据库记录失败 (${taskId}): ${err?.message || err}`;
      this.markCleanupFailed(taskId, 'database', msg, startedAt);
      return {
        ok: false,
        task_id: taskId,
        code: 'CLEANUP_FAILED',
        message: msg,
      };
    }

    // Step 5: Remove recovery record once everything succeeded
    this.removeRecoveryRecord(taskId);
    logger.info(`[TaskCleanupService] Task ${taskId} and all owned resources deleted cleanly.`);
    return {
      ok: true,
      task_id: taskId,
      message: `任务 ${taskId} 及其全部节点材料、历史修订、运行产物与数据库记录已成功删除`,
    };
  }

  private markCleanupFailed(
    taskId: string,
    step: DeletionRecoveryRecord['step'],
    errorMsg: string,
    startedAt: number
  ): void {
    try {
      this.writeRecoveryRecord({
        task_id: taskId,
        state: 'cleanup_failed',
        step,
        error: errorMsg,
        started_at: startedAt,
        updated_at: Date.now(),
      });
    } catch {}
    try {
      if (db.getTask(taskId)) {
        db.updateTaskStatus(taskId, TaskStatus.CLEANUP_FAILED, { blocked_reason: errorMsg });
      }
    } catch {}
    logger.error(`[TaskCleanupService] Cleanup failed for ${taskId} at step [${step}]: ${errorMsg}`);
  }

  async deleteAllTasks(): Promise<{
    ok: boolean;
    deletedCount: number;
    failedCount: number;
    failures: Array<{ task_id: string; message: string }>;
  }> {
    const idSet = new Set<string>();
    for (const t of db.listTasks()) {
      idSet.add(t.id);
    }
    if (fs.existsSync(TASKS_DATA_DIR)) {
      for (const entry of fs.readdirSync(TASKS_DATA_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) idSet.add(entry.name);
      }
    }
    if (fs.existsSync(MAINTENANCE_DELETIONS_DIR)) {
      for (const entry of fs.readdirSync(MAINTENANCE_DELETIONS_DIR)) {
        if (entry.endsWith('.json')) idSet.add(entry.slice(0, -'.json'.length));
      }
    }

    let deletedCount = 0;
    const failures: Array<{ task_id: string; message: string }> = [];

    for (const taskId of idSet) {
      const res = await this.deleteTask(taskId);
      if (res.ok) {
        if (!res.alreadyDeleted) deletedCount++;
      } else {
        failures.push({ task_id: taskId, message: res.message });
      }
    }

    return {
      ok: failures.length === 0,
      deletedCount,
      failedCount: failures.length,
      failures,
    };
  }

  async recoverPendingDeletions(): Promise<{
    recovered: string[];
    failed: Array<{ task_id: string; message: string }>;
  }> {
    const pendingIds = new Set<string>();

    if (fs.existsSync(MAINTENANCE_DELETIONS_DIR)) {
      for (const file of fs.readdirSync(MAINTENANCE_DELETIONS_DIR)) {
        if (file.endsWith('.json')) {
          pendingIds.add(file.slice(0, -'.json'.length));
        }
      }
    }

    for (const t of db.listTasks(TaskStatus.DELETING)) {
      pendingIds.add(t.id);
    }
    for (const t of db.listTasks(TaskStatus.CLEANUP_FAILED)) {
      pendingIds.add(t.id);
    }

    const recovered: string[] = [];
    const failed: Array<{ task_id: string; message: string }> = [];

    for (const taskId of pendingIds) {
      const res = await this.deleteTask(taskId);
      if (res.ok) {
        recovered.push(taskId);
      } else {
        failed.push({ task_id: taskId, message: res.message });
      }
    }

    if (recovered.length > 0 || failed.length > 0) {
      logger.info(`[TaskCleanupService] Startup deletion recovery: recovered=${recovered.length}, failed=${failed.length}`);
    }

    return { recovered, failed };
  }
}

export const taskCleanupService = new TaskCleanupService();
