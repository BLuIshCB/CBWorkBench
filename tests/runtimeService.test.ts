import assert from 'node:assert';
import { runtimeService } from '../src/services/runtimeService.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';

// Mock mode for fast testing
process.env.CB_MOCK_WORKBUDDY = 'true';
process.env.CB_MOCK_CODEX = 'true';

console.log('[Test] Running runtimeService.test.ts...');

// 1. List configured adapters from AdapterRegistry
// 清掉其他用例可能留下的版本缓存，保证断言的是「列表请求本身不产出版本结论」
runtimeService.invalidate();
const clis = await runtimeService.listConfiguredClis();
assert.ok(Array.isArray(clis), 'clis should be an array');
assert.strictEqual(clis.length, 3, 'should detect all 3 native CLI adapters');

const workbuddy = clis.find(c => c.id === 'workbuddy');
assert.ok(workbuddy, 'workbuddy adapter should be in the list');
assert.strictEqual(workbuddy.category, 'agent');

const codex = clis.find(c => c.id === 'codex');
assert.ok(codex, 'codex adapter should be in the list');
assert.strictEqual(codex.role, 'CLI 对话');

// 列表只做探测，不跑探活：候选与来源必须存在，版本结论在未请求时为空
for (const cli of clis) {
  assert.ok(cli.discovery, `${cli.id} must expose discovery info`);
  assert.ok(Array.isArray(cli.discovery.candidates), `${cli.id} must expose candidates`);
  assert.equal(typeof cli.discovery.scanned, 'number');
  assert.equal(cli.discovery.compatible, null, '版本结论不能在列表请求里顺带产生');
  assert.equal(cli.discovery.version, null);
  assert.equal(
    cli.available,
    Boolean(cli.discovery.runnable || cli.discovery.source === 'fallback'),
    `${cli.id} available 语义应为「入口可运行或待验证」`,
  );
}

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
  assert.equal(context.timeoutMs,180000,'Probe timeout must stay fixed at 180000ms');
  const marker=context.prompt.match(/CB_VERIFY_[0-9a-f-]+/)![0];
  return {ok:true,output:marker+extra,modelUsed:context.model || 'default',durationMs:0};
};
try {
  const matched=await runtimeService.probeCli({cliId:'codex',verify:true});
  assert.equal(matched.markerMatched,true);assert.equal(matched.verified,true);
  extra=' suffix';
  assert.equal((await runtimeService.probeCli({cliId:'codex',verify:true})).verified,false);
  await assert.rejects(runtimeService.probeCli({cliId:'codex',verify:true,prompt:'custom'}),/不允许/);
} finally {adapter.execute=original;}

console.log('✅ runtimeService.test.ts passed successfully!');
