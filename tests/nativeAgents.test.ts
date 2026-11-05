import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterRegistry } from '../src/adapters/registry.ts';

const saved = { ...process.env };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-native-agents-'));
const configPath = path.join(dir, 'cli.json');
const log = path.join(dir, 'calls.jsonl');
try {
  for (const id of ['workbuddy', 'codex', 'antigravity']) {
    const adapter = adapterRegistry.getAdapter(id);
    assert.ok(adapter, `${id} must be registered`);
    assert.equal(typeof adapter.execute, 'function', 'Every provider must expose the same conversation interface');
  }
  delete process.env.CB_MOCK_WORKBUDDY;
  delete process.env.CB_MOCK_CODEX;
  process.env.CB_AGENT_CLI_CONFIG = configPath;
  const prompt = '中文多行😀\n$() & | ` " C:\\目录';
  for (const id of ['workbuddy', 'codex', 'antigravity']) {
    for (const scenario of ['success', ...(id === 'workbuddy' ? ['array', 'array-error', 'array-missing-result'] : []), 'nonzero', 'empty', 'failure', 'malformed']) {
      fs.writeFileSync(configPath, JSON.stringify({ [id]: {
        executable: process.execPath,
        script: path.resolve('tests/fixtures/native-agent.mjs'),
        args: ['--fixture-prefix'],
        env: { PROVIDER: id, SCENARIO: scenario, CALL_LOG: log },
      } }));
      const result = await adapterRegistry.getAdapter(id)!.execute({
        taskId: `fixture-${id}`, cwd: dir, prompt, timeoutMs: 5000,
      });
      assert.equal(result.ok, scenario === 'success' || scenario === 'array', `${id}/${scenario}: ${JSON.stringify(result)}`);
      if (result.ok) assert.equal(result.output, prompt);
      const call = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)!);
      assert.ok(call.args.includes('--fixture-prefix'), 'Configured prefix arguments must be honored');
      assert.equal(call.args.includes(prompt), false, 'Prompt must never be interpolated into argv');
      assert.equal(call.prompt, prompt, 'UTF-8 stdin must preserve the complete prompt');
      assert.equal(call.args.includes('read-only'), false);
      assert.equal(call.args.includes('--sandbox'), false);
    }
  }
  console.log('✅ nativeAgents.test.ts passed');
} finally {
  process.env = saved;
  fs.rmSync(dir, { recursive: true, force: true });
}
