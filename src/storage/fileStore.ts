import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TASKS_DATA_DIR } from '../config/constants.ts';

export interface TaskPackageFiles {
  manifest_json: string;
  task_md: string;
  development_md: string;
  tests_md: string;
  acceptance_md: string;
  verifier_prompt_md: string;
  worker_prompts: Record<string, string>; // workerId -> promptText
}

export class TaskFileStore {
  private baseDir: string;

  constructor(baseDir: string = TASKS_DATA_DIR) {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  getRevisionDir(taskId: string, revision: number): string {
    return path.join(this.baseDir, taskId, `r${revision}`);
  }

  getArtifactsDir(taskId: string, revision: number): string {
    return path.join(this.getRevisionDir(taskId, revision), 'artifacts');
  }

  saveTaskPackage(taskId: string, revision: number, files: TaskPackageFiles): string {
    const revDir = this.getRevisionDir(taskId, revision);
    const promptsDir = path.join(revDir, 'prompts');
    const artifactsDir = this.getArtifactsDir(taskId, revision);

    fs.mkdirSync(revDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    fs.writeFileSync(path.join(revDir, 'manifest.json'), files.manifest_json, 'utf8');
    fs.writeFileSync(path.join(revDir, 'task.md'), files.task_md, 'utf8');
    fs.writeFileSync(path.join(revDir, 'development.md'), files.development_md, 'utf8');
    fs.writeFileSync(path.join(revDir, 'tests.md'), files.tests_md, 'utf8');
    fs.writeFileSync(path.join(revDir, 'acceptance.md'), files.acceptance_md, 'utf8');
    fs.writeFileSync(path.join(promptsDir, 'verifier.md'), files.verifier_prompt_md, 'utf8');

    for (const [workerId, promptText] of Object.entries(files.worker_prompts)) {
      fs.writeFileSync(path.join(promptsDir, `worker-${workerId}.md`), promptText, 'utf8');
    }

    return revDir;
  }

  loadTaskPackage(taskId: string, revision: number): TaskPackageFiles | null {
    const revDir = this.getRevisionDir(taskId, revision);
    if (!fs.existsSync(revDir)) return null;

    const promptsDir = path.join(revDir, 'prompts');
    const workerPrompts: Record<string, string> = {};

    if (fs.existsSync(promptsDir)) {
      const promptFiles = fs.readdirSync(promptsDir);
      for (const pf of promptFiles) {
        if (pf.startsWith('worker-') && pf.endsWith('.md')) {
          const workerId = pf.slice('worker-'.length, -'.md'.length);
          workerPrompts[workerId] = fs.readFileSync(path.join(promptsDir, pf), 'utf8');
        }
      }
    }

    return {
      manifest_json: fs.existsSync(path.join(revDir, 'manifest.json')) ? fs.readFileSync(path.join(revDir, 'manifest.json'), 'utf8') : '',
      task_md: fs.existsSync(path.join(revDir, 'task.md')) ? fs.readFileSync(path.join(revDir, 'task.md'), 'utf8') : '',
      development_md: fs.existsSync(path.join(revDir, 'development.md')) ? fs.readFileSync(path.join(revDir, 'development.md'), 'utf8') : '',
      tests_md: fs.existsSync(path.join(revDir, 'tests.md')) ? fs.readFileSync(path.join(revDir, 'tests.md'), 'utf8') : '',
      acceptance_md: fs.existsSync(path.join(revDir, 'acceptance.md')) ? fs.readFileSync(path.join(revDir, 'acceptance.md'), 'utf8') : '',
      verifier_prompt_md: fs.existsSync(path.join(promptsDir, 'verifier.md')) ? fs.readFileSync(path.join(promptsDir, 'verifier.md'), 'utf8') : '',
      worker_prompts: workerPrompts
    };
  }

  saveArtifact(taskId: string, revision: number, filename: string, content: string): string {
    const artifactsDir = this.getArtifactsDir(taskId, revision);
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }
    const filePath = path.join(artifactsDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  getArtifact(taskId: string, revision: number, filename: string): string | null {
    const filePath = path.join(this.getArtifactsDir(taskId, revision), filename);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  }

  deleteTaskFiles(taskId: string): boolean {
    const taskDir = path.join(this.baseDir, taskId);
    if (fs.existsSync(taskDir)) {
      fs.rmSync(taskDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  deleteAllTaskFiles(): void {
    if (fs.existsSync(this.baseDir)) {
      const entries = fs.readdirSync(this.baseDir);
      for (const entry of entries) {
        const fullPath = path.join(this.baseDir, entry);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }

  static computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }
}

export const taskFileStore = new TaskFileStore();
