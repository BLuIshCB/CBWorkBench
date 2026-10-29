import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkBuddyAdapter } from '../src/adapters/workbuddyAdapter.ts';

// 手动运行：node bin/test-runner.js tests/workbuddyLiveSmoke.ts。此测试实际调用模型，不加入离线套件。
if (process.env.CB_MOCK_WORKBUDDY === 'true') throw new Error('Live smoke test cannot run with CB_MOCK_WORKBUDDY.');
const base = path.resolve('data');
fs.mkdirSync(base, { recursive: true });
const cwd = fs.mkdtempSync(path.join(base, 'workbuddy-live-'));
const target = path.join(cwd, 'smoke.txt');
const expected = 'WB_WORKER_E2E_OK\n';
fs.writeFileSync(path.join(cwd, 'task.md'), '# WorkBuddy adapter smoke test\nCreate smoke.txt with exactly WB_WORKER_E2E_OK followed by one newline.\n');
fs.writeFileSync(path.join(cwd, 'acceptance.md'), '# Acceptance\nC1: smoke.txt must contain exactly WB_WORKER_E2E_OK followed by one newline. No other requirements.\n');
const adapter = new WorkBuddyAdapter();
const report: Record<string, any> = { cwd, startedAt: new Date().toISOString() };
const reportPath = path.join(cwd, 'report.json');
try {
  const worker = await adapter.executeDevTask({
    taskId: 'live-smoke', workerId: 'worker-dev', roundNumber: 1, model: adapter.defaultModel,
    cwd, timeoutMs: 120000,
    prompt: `这是隔离的适配器联通性测试。只允许修改 ${target}，不要修改其他文件。请用文件工具创建该文件，内容精确为 WB_WORKER_E2E_OK 加一个换行符。完成后简短报告。`,
  });
  report.worker = worker;
  assert.equal(worker.ok, true, worker.error);
  assert.equal(fs.readFileSync(target, 'utf8'), expected, 'Independent file check must prove the Worker actually wrote the required result');
  report.independentCheck = { passed: true, actual: fs.readFileSync(target, 'utf8') };
  const context = {
    taskId: 'live-smoke', roundNumber: 1, revision: 1, model: adapter.defaultModel,
    confirmedCwd: cwd, taskPackageDir: cwd, timeoutMs: 120000,
    testRunsSummary: `Independent Node fs.readFileSync assertion: ${target} === ${JSON.stringify(expected)}; Exit code 0.`,
    verifierPrompt: '只读验收。必须使用文件工具实际读取任务说明、验收要求和 smoke.txt；不要修改文件。按真实内容评判 C1，包含文件路径证据。',
    definedWorkerIds: ['worker-dev'],
  };
  const review = await adapter.executeReview(context);
  report.reviewer = review;
  assert.equal(review.decision, 'passed', JSON.stringify(review));
  assert.ok(review.criteriaResults.some(c => c.id === 'C1' && c.passed));
  assert.equal(fs.readFileSync(target, 'utf8'), expected, 'Reviewer must not modify the deliverable');

  // 负向验收：确保 Reviewer 真正读取当前产物，而非复用上一轮的通过结论。
  fs.writeFileSync(target, 'WRONG_CONTENT\n');
  const rejected = await adapter.executeReview({ ...context, roundNumber: 2, testRunsSummary: 'Independent content assertion failed: smoke.txt contains WRONG_CONTENT. Exit code 1.' });
  report.negativeReview = rejected;
  assert.equal(rejected.decision, 'needs_changes', JSON.stringify(rejected));
  assert.ok(rejected.criteriaResults.some(c => c.id === 'C1' && !c.passed));
  assert.equal(fs.readFileSync(target, 'utf8'), 'WRONG_CONTENT\n', 'Negative Reviewer must remain read-only');
  report.verified = true;
  console.log(JSON.stringify({ verified: true, worker: worker.ok, reviewer: review.decision, negativeReview: rejected.decision, reportPath }, null, 2));
} catch (error: any) {
  report.verified = false;
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
