import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface WorkspaceInfo {
  targetCwd: string;
  isGitRepo: boolean;
  gitRoot: string | null;
  branch: string | null;
  headCommit: string | null;
  isDirty: boolean;
  uncommittedFiles: string[];
  statusText: string;
}

export interface DiffSnapshot {
  headCommit: string | null;
  isDirty: boolean;
  diff: string;
  changedFiles: string[];
}

export class GitService {
  private static runGit(cmd: string, cwd: string): string {
    try {
      return execSync(`git ${cmd}`, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
    } catch {
      return '';
    }
  }

  static inspectWorkspace(inputPath: string): WorkspaceInfo {
    const targetCwd = path.resolve(inputPath);
    if (!fs.existsSync(targetCwd)) {
      throw new Error(`Workspace path does not exist: ${targetCwd}`);
    }

    const gitRootRaw = this.runGit('rev-parse --show-toplevel', targetCwd);
    if (!gitRootRaw) {
      return {
        targetCwd,
        isGitRepo: false,
        gitRoot: null,
        branch: null,
        headCommit: null,
        isDirty: false,
        uncommittedFiles: [],
        statusText: 'Not a git repository',
      };
    }

    const gitRoot = path.resolve(gitRootRaw);
    const branch = this.runGit('rev-parse --abbrev-ref HEAD', gitRoot) || null;
    const headCommit = this.runGit('rev-parse --short HEAD', gitRoot) || null;

    const statusOutput = this.runGit('status --porcelain', gitRoot);
    const uncommittedFiles: string[] = [];
    if (statusOutput) {
      for (const line of statusOutput.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          // line format: " M path/to/file" or "?? path/to/file"
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            uncommittedFiles.push(parts.slice(1).join(' '));
          }
        }
      }
    }

    const isDirty = uncommittedFiles.length > 0;
    const statusText = isDirty ? `${uncommittedFiles.length} uncommitted changes` : 'Clean working tree';

    return {
      targetCwd,
      isGitRepo: true,
      gitRoot,
      branch,
      headCommit,
      isDirty,
      uncommittedFiles,
      statusText,
    };
  }

  static getDiffSnapshot(cwd: string): DiffSnapshot {
    const info = this.inspectWorkspace(cwd);
    if (!info.isGitRepo || !info.gitRoot) {
      return {
        headCommit: null,
        isDirty: false,
        diff: '(Not a git repository)',
        changedFiles: [],
      };
    }

    const trackedDiff = this.runGit('diff HEAD', info.gitRoot);
    const stagedDiff = this.runGit('diff --staged', info.gitRoot);

    // Also collect untracked files
    const untrackedList = this.runGit('ls-files --others --exclude-standard', info.gitRoot);
    let untrackedDiff = '';
    if (untrackedList) {
      for (const f of untrackedList.split('\n')) {
        const filePath = path.join(info.gitRoot, f.trim());
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            untrackedDiff += `\n--- /dev/null\n+++ b/${f.trim()}\n@@ -0,0 +1,${content.split('\n').length} @@\n`;
            untrackedDiff += content.split('\n').map(l => '+' + l).join('\n') + '\n';
          } catch {
            // Ignore binary or unreadable files
          }
        }
      }
    }

    const fullDiff = [stagedDiff, trackedDiff, untrackedDiff].filter(Boolean).join('\n\n').trim();

    return {
      headCommit: info.headCommit,
      isDirty: info.isDirty,
      diff: fullDiff || '(No modifications detected)',
      changedFiles: info.uncommittedFiles,
    };
  }
}
