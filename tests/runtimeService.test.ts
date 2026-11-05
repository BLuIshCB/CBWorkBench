import assert from 'node:assert';
import { runtimeService } from '../src/services/runtimeService.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';

// Mock mode for fast testing
process.env.CB_MOCK_WORKBUDDY = 'true';
process.env.CB_MOCK_CODEX = 'true';

console.log('[Test] Running runtimeService.test.ts...');

// 1. List configured adapters from AdapterRegistry
const clis = await runtimeService.listConfiguredClis();
assert.ok(Array.isArray(clis), 'clis should be an array');
assert.strictEqual(clis.length, 3, 'should detect all 3 native CLI adapters');

const workbuddy = clis.find(c => c.id === 'workbuddy');
assert.ok(workbuddy, 'workbuddy adapter should be in the list');
assert.strictEqual(workbuddy.category, 'agent');

const codex = clis.find(c => c.id === 'codex');
assert.ok(codex, 'codex adapter should be in the list');
assert.strictEqual(codex.role, 'CLI 对话');

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
assert.strictEqual(codexProbe.verified, false);
assert.ok(codexProbe.output.length > 0);

const adapter=adapterRegistry.getAdapter('codex');
const original=adapter.execute;
let extra='';
adapter.execute=async context=>{
  assert.equal(context.timeoutMs,180000,'Legacy probe timeout must not change the internal limit');
  const marker=context.prompt.match(/CB_VERIFY_[0-9a-f-]+/)![0];
  return {ok:true,output:marker+extra,modelUsed:context.model || 'default',durationMs:0};
};
try {
  const matched=await runtimeService.probeCli({cliId:'codex',verify:true,timeoutMs:1});
  assert.equal(matched.markerMatched,true);assert.equal(matched.verified,true);
  extra=' suffix';
  assert.equal((await runtimeService.probeCli({cliId:'codex',verify:true})).verified,false);
  await assert.rejects(runtimeService.probeCli({cliId:'codex',verify:true,prompt:'custom'}),/不允许/);
} finally {adapter.execute=original;}

console.log('✅ runtimeService.test.ts passed successfully!');
