import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/adapters/codexAdapter.ts';

const saved = { ...process.env };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-model-catalog-'));
const config = path.join(cwd, 'config.json');
const log = path.join(cwd, 'calls.txt');
try {
  delete process.env.CB_MOCK_CODEX;
  const adapter = new CodexAdapter();
  assert.equal(typeof adapter.listModels, 'function', 'Codex must discover its catalog from the configured CLI');
  process.env.CB_AGENT_CLI_CONFIG = config;
  for (const scenario of ['success', 'empty', 'malformed', 'nonzero']) {
    fs.writeFileSync(config, JSON.stringify({ codex: {
      executable: process.execPath, script: path.resolve('tests/fixtures/codex-models.mjs'),
      env: { CATALOG_SCENARIO: scenario, CATALOG_LOG: log },
    } }));
    if (scenario === 'success') {
      const results = await Promise.all([adapter.listModels(), adapter.listModels()]);
      assert.deepEqual(results, [['model-alpha', 'model-beta'], ['model-alpha', 'model-beta']]);
      assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'Concurrent callers must share a single catalog refresh');
      assert.deepEqual(await adapter.listModels(), results[0]);
      assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'Use a short catalog cache');
    } else await assert.rejects(() => adapter.listModels(), undefined, scenario);
  }
  console.log('✅ codexModels.test.ts passed');
} finally { process.env = saved; fs.rmSync(cwd, { recursive: true, force: true }); }
