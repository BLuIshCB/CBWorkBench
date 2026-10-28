import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { GitService } from '../src/services/gitService.ts';

console.log('[Test] Running gitService.test.ts...');

// 1. Inspect current workspace
const currentInfo = GitService.inspectWorkspace(process.cwd());
assert.strictEqual(currentInfo.isGitRepo, true);
assert.ok(currentInfo.gitRoot);
assert.ok(currentInfo.headCommit);

// 2. Test non-git directory in temp dir
const nonGitDir = path.join(os.tmpdir(), 'cb_test_non_git_' + Date.now());
fs.mkdirSync(nonGitDir, { recursive: true });
try {
  const nonGitInfo = GitService.inspectWorkspace(nonGitDir);
  assert.strictEqual(nonGitInfo.isGitRepo, false);
  assert.strictEqual(nonGitInfo.gitRoot, null);
  assert.strictEqual(nonGitInfo.statusText, 'Not a git repository');
} finally {
  try { fs.rmdirSync(nonGitDir); } catch {}
}

// 3. Test with temporary git directory
const testRepoDir = path.resolve('data/test_git_repo');
if (fs.existsSync(testRepoDir)) {
  fs.rmSync(testRepoDir, { recursive: true, force: true });
}
fs.mkdirSync(testRepoDir, { recursive: true });

try {

  // Init git repo
  execSync('git init -b main', { cwd: testRepoDir });
  execSync('git config user.name "Tester"', { cwd: testRepoDir });
  execSync('git config user.email "tester@example.com"', { cwd: testRepoDir });

  // Add initial file and commit
  fs.writeFileSync(path.join(testRepoDir, 'hello.txt'), 'Hello world\n');
  execSync('git add hello.txt', { cwd: testRepoDir });
  execSync('git commit -m "feat: initial commit"', { cwd: testRepoDir });

  const cleanInfo = GitService.inspectWorkspace(testRepoDir);
  assert.strictEqual(cleanInfo.isGitRepo, true);
  assert.strictEqual(cleanInfo.isDirty, false);
  assert.strictEqual(cleanInfo.uncommittedFiles.length, 0);

  const cleanDiff = GitService.getDiffSnapshot(testRepoDir);
  assert.strictEqual(cleanDiff.isDirty, false);
  assert.strictEqual(cleanDiff.diff, '(No modifications detected)');

  // Modify tracked file
  fs.appendFileSync(path.join(testRepoDir, 'hello.txt'), 'New line added\n');

  // Add untracked file
  fs.writeFileSync(path.join(testRepoDir, 'newfile.js'), 'console.log(123);\n');

  const dirtyInfo = GitService.inspectWorkspace(testRepoDir);
  assert.strictEqual(dirtyInfo.isDirty, true);
  assert.strictEqual(dirtyInfo.uncommittedFiles.length, 2);

  const dirtyDiff = GitService.getDiffSnapshot(testRepoDir);
  assert.strictEqual(dirtyDiff.isDirty, true);
  assert.ok(dirtyDiff.diff.includes('+New line added'));
  assert.ok(dirtyDiff.diff.includes('+console.log(123);'));
  assert.strictEqual(dirtyDiff.changedFiles.length, 2);

  console.log('✅ gitService.test.ts passed successfully!');
} finally {
  // Clean up
  try {
    fs.rmSync(testRepoDir, { recursive: true, force: true });
  } catch {}
}
