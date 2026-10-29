import assert from 'node:assert';
import { runtimeService } from '../src/services/runtimeService.ts';

// Mock mode for fast testing
process.env.CB_MOCK_WORKBUDDY = 'true';
process.env.CB_MOCK_CODEX = 'true';

console.log('[Test] Running runtimeService.test.ts...');

// 1. List configured CLIs
const clis = await runtimeService.listConfiguredClis();
assert.ok(Array.isArray(clis), 'clis should be an array');
assert.ok(clis.length >= 4, 'should detect at least 4 CLIs');

const workbuddyDesktop = clis.find(c => c.id === 'workbuddy-desktop');
assert.ok(workbuddyDesktop, 'workbuddy-desktop should be in the list');
assert.strictEqual(workbuddyDesktop.category, 'agent');

const codex = clis.find(c => c.id === 'codex');
assert.ok(codex, 'codex should be in the list');
assert.strictEqual(codex.category, 'verifier');

const node = clis.find(c => c.id === 'node');
assert.ok(node, 'node runtime should be in the list');
assert.strictEqual(node.category, 'system');

const git = clis.find(c => c.id === 'git');
assert.ok(git, 'git should be in the list');

// 2. Probe Node CLI
const nodeProbe = await runtimeService.probeCli({
  cliId: 'node',
  prompt: 'console.log("HELLO_NODE")',
});
assert.strictEqual(nodeProbe.ok, true);
assert.strictEqual(nodeProbe.output, 'HELLO_NODE');
assert.strictEqual(nodeProbe.verified, true);

// 3. Probe WorkBuddy in mock mode
const wbProbe = await runtimeService.probeCli({
  cliId: 'workbuddy-desktop',
  prompt: '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。',
});
assert.strictEqual(wbProbe.ok, true);
assert.ok(wbProbe.output.includes('MOCK WORKBUDDY RESULT'));

// 4. Probe Codex in mock mode
const codexProbe = await runtimeService.probeCli({
  cliId: 'codex',
  prompt: '只回复 CODEX_OK',
});
assert.strictEqual(codexProbe.ok, true);
assert.strictEqual(codexProbe.verified, true);
assert.ok(codexProbe.output.includes('CODEX_OK'));

// 5. Probe Git CLI
const gitProbe = await runtimeService.probeCli({
  cliId: 'git',
  prompt: '--version',
});
assert.strictEqual(gitProbe.ok, true);
assert.ok(gitProbe.output.includes('git version'));

console.log('✅ runtimeService.test.ts passed successfully!');
