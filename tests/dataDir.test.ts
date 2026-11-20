import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHttpServer } from '../src/server/httpServer.ts';
import { DATA_DIR, INSTANCE_ID } from '../src/config/constants.ts';
import {
  resolveDataDirConfig,
  parseCliRuntimeArgs,
  assertServerMatchesLocalInstance,
  DataDirConfigError,
} from '../src/config/dataDir.ts';

console.log('[Test] Running dataDir.test.ts...');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-datadir-test-'));

try {
  // 1. --data-dir overrides CB_DATA_DIR and persists instance_id
  const cliDir = path.join(tmpBase, 'cli-dir');
  const envDir = path.join(tmpBase, 'env-dir');
  const res1 = resolveDataDirConfig({
    argv: ['--data-dir', cliDir],
    env: { CB_DATA_DIR: envDir, LOCALAPPDATA: tmpBase },
    isExe: false,
  });
  assert.equal(res1.dataDir, path.resolve(cliDir));
  assert.equal(res1.source, 'cli');
  assert.ok(fs.existsSync(path.join(cliDir, 'instance.json')));

  const res1Again = resolveDataDirConfig({
    argv: [`--data-dir=${cliDir}`],
    env: { CB_DATA_DIR: envDir, LOCALAPPDATA: tmpBase },
    isExe: false,
  });
  assert.equal(res1Again.instance.instance_id, res1.instance.instance_id);
  console.log('  ✓ --data-dir overrides CB_DATA_DIR and persists stable instance_id');

  // 2. Relative --data-dir and CB_DATA_DIR rejected
  assert.throws(
    () => resolveDataDirConfig({ argv: ['--data-dir', 'relative/path'], env: {}, isExe: false }),
    (e: any) => e instanceof DataDirConfigError && e.code === 'INVALID_DATA_DIR'
  );
  assert.throws(
    () => resolveDataDirConfig({ argv: [], env: { CB_DATA_DIR: './rel' }, isExe: false }),
    (e: any) => e instanceof DataDirConfigError && e.code === 'INVALID_DATA_DIR'
  );
  console.log('  ✓ Relative paths rejected for --data-dir and CB_DATA_DIR');

  // 3. --portable forbidden in source mode, allowed in EXE mode, conflicts with explicit dir
  assert.throws(
    () => resolveDataDirConfig({ argv: ['--portable'], env: {}, isExe: false }),
    (e: any) => e instanceof DataDirConfigError && e.code === 'PORTABLE_NOT_ALLOWED_IN_SOURCE'
  );
  assert.throws(
    () => resolveDataDirConfig({ argv: ['--portable', '--data-dir', cliDir], env: {}, isExe: true }),
    (e: any) => e instanceof DataDirConfigError && e.code === 'DATA_DIR_CONFLICT'
  );
  assert.throws(
    () => resolveDataDirConfig({ argv: ['--portable'], env: { CB_DATA_DIR: envDir }, isExe: true }),
    (e: any) => e instanceof DataDirConfigError && e.code === 'DATA_DIR_CONFLICT'
  );

  const fakeExeDir = path.join(tmpBase, 'portable-app');
  fs.mkdirSync(fakeExeDir, { recursive: true });
  const portableRes = resolveDataDirConfig({
    argv: ['--portable'],
    env: {},
    isExe: true,
    execPath: path.join(fakeExeDir, 'cb-workbench.exe'),
  });
  assert.equal(portableRes.dataDir, path.join(fakeExeDir, 'data'));
  assert.equal(portableRes.source, 'portable');
  console.log('  ✓ --portable EXE rules & conflict detection verified');

  // 4. Default resolution uses LOCALAPPDATA on Windows (never process.cwd()), fails cleanly if missing
  if (process.platform === 'win32') {
    const fakeLocalAppData = path.join(tmpBase, 'LocalAppData');
    const defRes = resolveDataDirConfig({ argv: [], env: { LOCALAPPDATA: fakeLocalAppData }, isExe: false });
    assert.equal(defRes.dataDir, path.join(fakeLocalAppData, 'CBWorkBench', 'data'));
    assert.equal(defRes.source, 'default');

    assert.throws(
      () => resolveDataDirConfig({ argv: [], env: {}, isExe: false }),
      (e: any) => e instanceof DataDirConfigError && e.code === 'DATA_DIR_UNRESOLVED'
    );
    console.log('  ✓ Default Windows %LOCALAPPDATA%/CBWorkBench/data resolution & strict unresolved failure verified');
  }

  // 5. Legacy data detection does not overwrite or remove legacy data
  const fakeRoot = path.join(tmpBase, 'legacy-repo');
  fs.mkdirSync(path.join(fakeRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'data', 'workbench.db'), 'legacy-db-sentinel', 'utf8');
  const legacyRes = resolveDataDirConfig({
    argv: ['--data-dir', path.join(tmpBase, 'new-data')],
    env: {},
    isExe: false,
    rootDir: fakeRoot,
  });
  assert.equal(legacyRes.legacyDataPath, path.join(fakeRoot, 'data'));
  assert.equal(fs.readFileSync(path.join(fakeRoot, 'data', 'workbench.db'), 'utf8'), 'legacy-db-sentinel');
  console.log('  ✓ Legacy data directory preserved untouched');

  // 6. CLI argument parsing (--server-url, --data-dir=, --portable)
  const parsed = parseCliRuntimeArgs(['--data-dir=' + cliDir, '--server-url=http://127.0.0.1:4567/', '--no-open']);
  assert.equal(parsed.dataDir, cliDir);
  assert.equal(parsed.serverUrl, 'http://127.0.0.1:4567/');
  assert.equal(parsed.noOpen, true);

  // 7. Instance binding verification via HTTP /api/system/instance
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const matched = await assertServerMatchesLocalInstance(baseUrl, DATA_DIR, INSTANCE_ID);
    assert.equal(matched.instance_id, INSTANCE_ID);

    await assert.rejects(
      () => assertServerMatchesLocalInstance(baseUrl, path.join(tmpBase, 'wrong-dir'), 'wrong-instance-id'),
      (e: any) => e instanceof DataDirConfigError && e.code === 'INSTANCE_MISMATCH'
    );
    console.log('  ✓ HTTP /api/system/instance matching and INSTANCE_MISMATCH detection verified');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('✅ dataDir.test.ts passed successfully!');
} finally {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
