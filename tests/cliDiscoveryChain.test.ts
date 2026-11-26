import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declareCli, discoverCli, discoverCliAsync } from '../src/services/cliDiscovery.ts';

const platform = process.platform;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-discovery-chain-'));
const home = path.join(root, 'home');
const pathDir = path.join(root, 'path-dir');
const installDir = path.join(home, '.volta', 'bin');
const emptyEnv: NodeJS.ProcessEnv = { PATH: '' };

function toolName(name: string): string {
  return platform === 'win32' ? `${name}.cmd` : name;
}

function writeTool(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, toolName(name));
  fs.writeFileSync(file, 'fixture');
  return file;
}

const declaration = declareCli({ id: 'fake', commands: ['faketool'] });

try {
  writeTool(pathDir, 'faketool');
  writeTool(installDir, 'faketool');

  // L1 显式配置
  const explicitFile = writeTool(path.join(root, 'explicit'), 'faketool');
  const fromConfig = discoverCli(declaration, {
    explicitConfig: { executable: explicitFile },
    env: emptyEnv,
    home,
    hydration: { added: [], result: null },
  });
  assert.equal(fromConfig.source, 'config');
  assert.equal(fromConfig.runnable, true);
  assert.equal(fromConfig.executable, explicitFile);

  // L2 环境变量
  const envDeclaration = declareCli({ id: 'fake', commands: ['faketool'], explicitEnv: ['CB_FAKE_CLI'] });
  const fromEnv = discoverCli(envDeclaration, {
    env: { PATH: '', CB_FAKE_CLI: explicitFile },
    home,
    hydration: { added: [], result: null },
  });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.executable, explicitFile);

  // L3 当前 PATH
  const fromPath = discoverCli(declaration, {
    env: { PATH: pathDir },
    home,
    hydration: { added: [], result: null },
  });
  assert.equal(fromPath.source, 'path');
  assert.ok(fromPath.scanned > 0);

  // L3 命中水合新增段时标记为 shell-path
  const fromShellPath = discoverCli(declaration, {
    env: { PATH: pathDir },
    home,
    hydration: { added: [pathDir], result: { ok: true, added: [pathDir] } },
  });
  assert.equal(fromShellPath.source, 'shell-path');
  assert.equal(fromShellPath.pathHydrated, true);

  // L4 安装目录
  const fromInstallDir = discoverCli(declaration, { env: emptyEnv, home, hydration: { added: [], result: null } });
  assert.equal(fromInstallDir.source, 'install-dir');
  assert.equal(fromInstallDir.executable, path.join(installDir, toolName('faketool')));

  // L5 裸名兜底
  const fallback = discoverCli(declaration, {
    env: emptyEnv,
    home: path.join(root, 'empty-home'),
    hydration: { added: [], result: null },
  });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.executable, 'faketool');
  assert.equal(fallback.runnable, false);
  assert.ok(fallback.reason);

  // 依赖缺失：命中但判不可用，并在候选里说明原因
  const depDeclaration = declareCli({ id: 'fake', commands: ['faketool'], requiredCommands: ['absent-dep-xyz'] });
  const blocked = discoverCli(depDeclaration, { env: { PATH: pathDir }, home, hydration: { added: [], result: null } });
  assert.equal(blocked.runnable, false);
  assert.equal(blocked.source, 'path');
  assert.deepEqual(blocked.missingDependencies, ['absent-dep-xyz']);
  assert.match(blocked.reason!, /缺少依赖/);
  assert.ok(blocked.candidates.some((candidate) => candidate.reason?.includes('absent-dep-xyz')));

  // 异步与同步结论一致
  const asyncResult = await discoverCliAsync(declaration, {
    env: { PATH: pathDir },
    home,
    hydration: { added: [], result: null },
  });
  assert.equal(asyncResult.source, 'path');
  assert.equal(asyncResult.executable, fromPath.executable);

  // 候选只记录真实存在的路径，不把几百条 ENOENT 组合吐给 UI
  assert.ok(fromPath.candidates.every((candidate) => !candidate.reason || candidate.reason !== 'ENOENT'));
  assert.equal(fromInstallDir.candidates.some((candidate) => candidate.source === 'path'), false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('✅ cliDiscoveryChain.test.ts passed');
