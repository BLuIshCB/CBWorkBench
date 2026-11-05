import assert from 'node:assert/strict';
import { AdapterRegistry } from '../src/adapters/registry.ts';
import { AcceptanceService } from '../src/services/acceptanceService.ts';

const registry = new AdapterRegistry();
assert.deepEqual(registry.listAdapters().map(a => a.id), ['workbuddy', 'codex', 'antigravity']);
assert.throws(() => registry.getAdapter('unknown'), /未找到指定的 CLI/);
assert.throws(() => registry.register(registry.getAdapter('codex')), /重复注册/);
assert.throws(() => registry.register({ id: 'bad', executionPolicy: { transport: 'desktop' } } as any), /未遵守/);
const saved = { ...process.env };
try {
  process.env.CB_MOCK_WORKBUDDY = 'true';
  process.env.CB_MOCK_CODEX = 'true';
  for (const id of ['workbuddy', 'codex']) {
    const adapter = registry.getAdapter(id);
    const result = await adapter.execute({ cwd: process.cwd(), prompt: 'Test conversation' });
    assert.equal(result.ok, true);
    assert.ok(result.output.includes('Test conversation'));
    assert.equal(result.metadata?.backend, 'direct-cli-mock');
    const review = await new AcceptanceService().execute(adapter, {
      taskId: 'adapter-test', roundNumber: 1, revision: 1, model: adapter.defaultModel,
      confirmedCwd: process.cwd(), taskPackageDir: process.cwd(), testRunsSummary: '',
      verifierPrompt: 'Evaluate C1', definedWorkerIds: ['worker-dev'],
    });
    assert.equal(review.decision, 'passed');
  }
} finally { process.env = saved; }
console.log('✅ adapters.test.ts passed');
