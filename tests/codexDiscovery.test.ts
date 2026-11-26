import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI_DECLARATIONS,
  invalidateCliConfigCache,
  resolveCodexCliConfig,
  resolveDeclaredCliDiscovery,
} from '../src/services/cliConfig.ts';
import { declareCli, discoverCli } from '../src/services/cliDiscovery.ts';
import { CodexAdapter } from '../src/adapters/codexAdapter.ts';

const saved = { ...process.env };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-中文 prefix-'));
const codex = CLI_DECLARATIONS.codex;
const noHydration = { added: [], result: null };

/** 造一个 npm 全局布局：codex.<ext> + 平级 node_modules/@openai/codex/bin/codex.js */
function makeWrapperDir(dir: string, extension: string): string {
  const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '// Discovery fixture: never executed');
  fs.writeFileSync(path.join(dir, `codex${extension}`), '@echo wrapper must not execute');
  return script;
}

try {
  const prefix = path.join(root, 'custom prefix');
  const script = makeWrapperDir(prefix, '.cmd');
  const missingDir = path.join(root, 'missing');

  // 1. PATH 命中 .cmd：归一化为 node + codex.js，来源 path
  const fromPath = discoverCli(codex, { env: { PATH: prefix }, home: root, hydration: noHydration });
  assert.equal(fromPath.source, 'path');
  assert.equal(fromPath.script, script);
  assert.equal(fromPath.runnable, true);
  assert.deepEqual(path.basename(fromPath.executable).toLowerCase().replace(/\.exe$/, ''), 'node');

  // 2. Windows 名枚举含 .bat：只有 codex.bat 时同样命中
  if (process.platform === 'win32') {
    const batDir = path.join(root, 'bat-only');
    const batScript = makeWrapperDir(batDir, '.bat');
    const fromBat = discoverCli(codex, { env: { PATH: batDir }, home: root, hydration: noHydration });
    assert.equal(fromBat.source, 'path');
    assert.equal(fromBat.script, batScript);
  }

  // 3. .cmd 没有配对脚本时不抛错，标记执行期用 cmd 包裹
  if (process.platform === 'win32') {
    const bareDir = path.join(root, 'bare-cmd');
    fs.mkdirSync(bareDir, { recursive: true });
    fs.writeFileSync(path.join(bareDir, 'codex.cmd'), '@echo bare');
    const bare = discoverCli(codex, { env: { PATH: bareDir }, home: root, hydration: noHydration });
    assert.equal(bare.runnable, true);
    assert.equal(bare.needsShellWrap, true);
    assert.equal(bare.script, undefined);

    // .ps1 能配对 node 脚本时按 node + script 归一化
    const pairedDir = path.join(root, 'ps1-paired');
    const pairedScript = makeWrapperDir(pairedDir, '.ps1');
    const fromPairedPs1 = discoverCli(codex, {
      explicitConfig: { executable: path.join(pairedDir, 'codex.ps1') },
      env: { PATH: '' },
      home: root,
      hydration: noHydration,
    });
    assert.equal(fromPairedPs1.runnable, true);
    assert.equal(fromPairedPs1.script, pairedScript);
    assert.equal(fromPairedPs1.needsShellWrap, undefined);

    // 配不上脚本的 .ps1 不能套 cmd 包装，必须明确判不可用
    const ps1Dir = path.join(root, 'ps1-only');
    fs.mkdirSync(ps1Dir, { recursive: true });
    const barePs1 = path.join(ps1Dir, 'codex.ps1');
    fs.writeFileSync(barePs1, '# ps1');
    const fromBarePs1 = discoverCli(codex, {
      explicitConfig: { executable: barePs1 },
      env: { PATH: '' },
      home: root,
      hydration: noHydration,
    });
    assert.equal(fromBarePs1.runnable, false);
    assert.match(fromBarePs1.reason!, /\.ps1/);
  }

  // 4. 安装目录兜底：PATH 未命中时扫 ~/AppData/Roaming/npm
  if (process.platform === 'win32') {
    const home = path.join(root, 'home');
    const npmDir = path.join(home, 'AppData', 'Roaming', 'npm');
    fs.mkdirSync(npmDir, { recursive: true });
    const npmScript = makeWrapperDir(npmDir, '.cmd');
    // 用不带项目内安装目录的声明，隔离掉 data/runtimes 的干扰
    const plainDeclaration = declareCli({
      id: 'codex',
      commands: ['codex'],
      scriptRelativePath: '@openai/codex/bin/codex.js',
    });
    const fromInstallDir = discoverCli(plainDeclaration, { env: { PATH: missingDir }, home, hydration: noHydration });
    assert.equal(fromInstallDir.source, 'install-dir');
    assert.equal(fromInstallDir.script, npmScript);
  }

  // 5. 全部落空：裸名兜底，交给探活验证
  const bareDeclaration = declareCli({ id: 'codex', commands: ['codex'] });
  const fallback = discoverCli(bareDeclaration, { env: { PATH: missingDir }, home: path.join(root, 'empty'), hydration: noHydration });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.executable, 'codex');
  assert.equal(fallback.runnable, false);

  // 6. 依赖缺失判「已安装但依赖缺失」，而不是「未安装」
  const depDeclaration = declareCli({ id: 'codex', commands: ['codex'], requiredCommands: ['absent-dep-xyz'] });
  const blocked = discoverCli(depDeclaration, { env: { PATH: prefix }, home: root, hydration: noHydration });
  assert.equal(blocked.source, 'path');
  assert.equal(blocked.runnable, false);
  assert.match(blocked.reason!, /缺少依赖/);
  assert.deepEqual(blocked.missingDependencies, ['absent-dep-xyz']);

  // 7. 显式配置写错时明确报错，绝不静默回退到 PATH 里的其他版本
  const configFile = path.join(root, 'config.json');
  process.env.CB_AGENT_CLI_CONFIG = configFile;
  delete process.env.CODEX_CMD_PATH;
  fs.writeFileSync(configFile, JSON.stringify({ codex: { executable: path.join(root, 'not-there.exe') } }));
  invalidateCliConfigCache();
  const misconfigured = resolveDeclaredCliDiscovery(codex);
  assert.equal(misconfigured.source, 'config');
  assert.equal(misconfigured.runnable, false);
  assert.match(misconfigured.reason!, /配置的入口不存在/);

  // 8. 显式配置生效：discoverySource 为 config
  const explicitExe = path.join(root, 'explicit codex.exe');
  fs.writeFileSync(explicitExe, 'fixture');
  fs.writeFileSync(configFile, JSON.stringify({ codex: { executable: explicitExe } }));
  invalidateCliConfigCache();
  const explicitConfig = resolveCodexCliConfig();
  assert.equal(explicitConfig.executable, explicitExe);
  assert.equal(explicitConfig.discoverySource, 'config');

  // 9. CODEX_CMD_PATH 指向不存在的入口时报错，不回退
  fs.writeFileSync(configFile, '{}');
  invalidateCliConfigCache();
  process.env.CODEX_CMD_PATH = path.join(root, 'ghost.exe');
  const badEnv = resolveDeclaredCliDiscovery(codex);
  assert.equal(badEnv.source, 'env');
  assert.equal(badEnv.runnable, false);
  delete process.env.CODEX_CMD_PATH;

  const adapter = new CodexAdapter();
  assert.equal(adapter.defaultModel, 'default');
  assert.equal(adapter.cliDeclaration.id, 'codex');
  assert.equal((adapter as any).buildArgs('default').includes('-m'), false);
} finally {
  process.env = saved;
  invalidateCliConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('✅ codexDiscovery.test.ts passed');
