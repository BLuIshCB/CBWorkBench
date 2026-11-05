import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpServer } from '../src/server/httpServer.ts';

const saved = { ...process.env };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-model-api-'));
const config = path.join(cwd, 'config.json');
const server = createHttpServer();
try {
  delete process.env.CB_MOCK_CODEX;
  process.env.CB_MOCK_WORKBUDDY = 'true';
  process.env.CB_AGENT_CLI_CONFIG = config;
  const fixture = { executable: process.execPath, script: path.resolve('tests/fixtures/codex-models.mjs'),
    env: { CATALOG_SCENARIO: 'success', CATALOG_LOG: path.join(cwd, 'calls.txt') } };
  fs.writeFileSync(config, JSON.stringify({ codex: fixture, antigravity: fixture }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const executors = await (await fetch(origin + '/api/system/executors')).json();
  for (const key of ['agents', 'workers', 'reviewers']) {
    assert.deepEqual(executors[key].find((a: any) => a.id === 'codex').supportedModels, ['model-alpha', 'model-beta']);
  }
  const runtime = await (await fetch(origin + '/api/runtime/clis')).json();
  const codex = runtime.clis.find((a: any) => a.id === 'codex');
  assert.deepEqual(codex.supportedModels, ['model-alpha', 'model-beta']);
  assert.equal(codex.extraInfo.modelCatalogSource, 'cli');
  fixture.env.CATALOG_SCENARIO = 'nonzero';
  fs.writeFileSync(config, JSON.stringify({ codex: fixture, antigravity: fixture }));
  const failed = await (await fetch(origin + '/api/runtime/clis')).json();
  const failedCodex = failed.clis.find((a: any) => a.id === 'codex');
  assert.deepEqual(failedCodex.supportedModels, []);
  assert.equal(failedCodex.extraInfo.modelCatalogSource, 'unavailable');
  assert.match(failedCodex.statusMessage, /模型目录不可用/);
  console.log('✅ codexModelsApi.test.ts passed');
} finally {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  process.env = saved;
  fs.rmSync(cwd, { recursive: true, force: true });
}
