import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkBuddyClient } from '../src/services/workbuddyClient.ts';
import { WorkBuddyAdapter } from '../src/adapters/workbuddyAdapter.ts';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-regression-'));
const originalRun = WorkBuddyClient.runTask;
const savedEnv = { ...process.env };
delete process.env.CB_MOCK_WORKBUDDY;
delete process.env.CB_MOCK_CODEX;
const adapter = new WorkBuddyAdapter();
const context = {
  taskId: 'regular-task', roundNumber: 1, revision: 7, model: 'deepseek-v4-flash',
  confirmedCwd: cwd, taskPackageDir: cwd, testRunsSummary: 'Test T1: Exit code 0',
  verifierPrompt: 'Verify acceptance criteria.', definedWorkerIds: ['worker-dev'],
};
try {
  WorkBuddyClient.runTask = async () => ({ ok: false, output: '', error: 'Authentication required' });
  const review = await adapter.executeReview(context);
  assert.equal(review.decision, 'blocked', 'Authentication failure must never pass acceptance based on test summary');
  const dev = await adapter.executeDevTask({
    taskId: 'pelican-task', roundNumber: 1, workerId: 'worker-dev', model: context.model,
    prompt: 'Create pelican-bike.html', cwd,
  });
  assert.equal(dev.ok, false, 'Failed Worker execution must remain failed');
  assert.equal(fs.existsSync(path.join(cwd, 'pelican-bike.html')), false, 'Adapter must not fabricate deliverables');

  for (const output of [
    'All tests passed. 通过',
    '{"decision":"passed"',
    '{"decision":"passed","summary":"ok","criteriaResults":[],"issues":[],"manualChecksPending":[]}',
    '{"decision":"passed","revision":99,"summary":"ok","criteriaResults":[{"id":"C1","passed":true,"evidence":"file:1"}],"issues":[],"manualChecksPending":[]}',
    '{"decision":"passed","summary":"ok","criteriaResults":[{"id":"C1","passed":false,"evidence":"failed"}],"issues":[],"manualChecksPending":[]}',
  ]) {
    WorkBuddyClient.runTask = async () => ({ ok: true, output });
    assert.equal((await adapter.executeReview(context)).decision, 'blocked', `Invalid verdict must block: ${output}`);
  }
  WorkBuddyClient.runTask = async () => ({ ok: true, output: '```json\n' + JSON.stringify({
    decision: 'passed', summary: 'Verified', criteriaResults: [{ id: 'C1', passed: true, evidence: 'file:1' }],
    issues: [], manualChecksPending: [],
  }) + '\n```' });
  const valid = await adapter.executeReview(context);
  assert.equal(valid.decision, 'passed');
  assert.equal(valid.revision, 7);
  // 旧任务的文档版本标签不能覆盖工作台数字版本，也不能放松版本匹配校验。
  let legacyPrompt = '';
  WorkBuddyClient.runTask = async params => {
    legacyPrompt = params.prompt;
    return { ok: true, output: JSON.stringify({
      decision: 'passed', revision: 7, summary: 'Verified',
      criteriaResults: [{ id: 'C1', passed: true, evidence: 'file:1' }], issues: [], manualChecksPending: [],
    }) };
  };
  const legacy = await adapter.executeReview({ ...context, verifierPrompt: 'Legacy task output example: {"revision":"r04"}' });
  assert.equal(legacy.decision, 'passed');
  assert.ok(legacyPrompt.indexOf('workbench output contract takes precedence') > legacyPrompt.indexOf('Legacy task output example'));
  assert.ok(legacyPrompt.includes('"revision":7'));
  console.log('✅ workbuddyRegression.test.ts passed');
} finally {
  WorkBuddyClient.runTask = originalRun;
  process.env = savedEnv;
  fs.rmSync(cwd, { recursive: true, force: true });
}
