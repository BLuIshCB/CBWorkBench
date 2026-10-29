import assert from 'node:assert';
import { runtimeService } from '../src/services/runtimeService.ts';

// Mock mode for fast testing
process.env.CB_MOCK_WORKBUDDY = 'true';
process.env.CB_MOCK_CODEX = 'true';

console.log('[Test] Running runtimeService.test.ts...');

// 1. List configured adapters from AdapterRegistry
const clis = await runtimeService.listConfiguredClis();
assert.ok(Array.isArray(clis), 'clis should be an array');
assert.strictEqual(clis.length, 2, 'should detect exactly 2 registered adapters: workbuddy and codex');

const workbuddy = clis.find(c => c.id === 'workbuddy');
assert.ok(workbuddy, 'workbuddy adapter should be in the list');
assert.strictEqual(workbuddy.category, 'worker');

const codex = clis.find(c => c.id === 'codex');
assert.ok(codex, 'codex adapter should be in the list');
assert.strictEqual(codex.category, 'verifier');

// Ensure system tools (node, git) are NOT in the adapter list
assert.strictEqual(clis.some(c => c.id === 'node'), false, 'node should not be in the adapter list');
assert.strictEqual(clis.some(c => c.id === 'git'), false, 'git should not be in the adapter list');

// 2. Probe WorkBuddy in mock mode
const wbProbe = await runtimeService.probeCli({
  cliId: 'workbuddy',
  prompt: '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。',
});
assert.strictEqual(wbProbe.ok, true);
assert.ok(wbProbe.output.includes('MOCK WORKBUDDY RESULT'));
assert.ok(wbProbe.connectionType.length > 0);

// 3. Probe Codex in mock mode
const codexProbe = await runtimeService.probeCli({
  cliId: 'codex',
  prompt: '只回复 CODEX_OK',
});
assert.strictEqual(codexProbe.ok, true);
assert.strictEqual(codexProbe.verified, true);
assert.ok(codexProbe.output.length > 0);

console.log('✅ runtimeService.test.ts passed successfully!');
