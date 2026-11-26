import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declareCli, discoverCli } from '../src/services/cliDiscovery.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-discovery-explicit-'));
const noHydration = { added: [], result: null };
const pathDir = path.join(root, 'path-dir');
const toolName = process.platform === 'win32' ? 'faketool.cmd' : 'faketool';

function writeTool(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'fixture');
  return file;
}

try {
  writeTool(pathDir, toolName);

  const declaration = declareCli({ id: 'fake', commands: ['faketool'], explicitEnv: ['CB_FAKE_CLI', 'CB_FAKE_SCRIPT'] });

  // 环境变量写错：直接报错，不回退到 PATH 里的可用版本
  const badEnv = discoverCli(declaration, {
    env: { PATH: pathDir, CB_FAKE_CLI: path.join(root, 'ghost') },
    home: root,
    hydration: noHydration,
  });
  assert.equal(badEnv.source, 'env');
  assert.equal(badEnv.runnable, false);
  assert.match(badEnv.reason!, /环境变量 CB_FAKE_CLI/);

  // 组合型入口：WB_COMMAND + WB_CLI_SCRIPT 是一个入口，不是两个候选
  const combined = declareCli({
    id: 'fake',
    commands: ['faketool'],
    explicitEnv: ['CB_FAKE_CLI', 'CB_FAKE_SCRIPT'],
    envEntry: (env) => (env.CB_FAKE_CLI || env.CB_FAKE_SCRIPT
      ? { executable: env.CB_FAKE_CLI || process.execPath, script: env.CB_FAKE_SCRIPT }
      : undefined),
  });
  const scriptFile = writeTool(path.join(root, 'script-dir'), 'entry.js');
  const fromCombined = discoverCli(combined, {
    env: { PATH: '', CB_FAKE_CLI: process.execPath, CB_FAKE_SCRIPT: scriptFile },
    home: root,
    hydration: noHydration,
  });
  assert.equal(fromCombined.source, 'env');
  assert.equal(fromCombined.runnable, true);
  assert.equal(fromCombined.executable, process.execPath);
  assert.equal(fromCombined.script, scriptFile);

  // 组合入口里脚本缺失同样报错
  const brokenCombined = discoverCli(combined, {
    env: { PATH: '', CB_FAKE_SCRIPT: path.join(root, 'ghost-entry.js') },
    home: root,
    hydration: noHydration,
  });
  assert.equal(brokenCombined.runnable, false);
  assert.equal(brokenCombined.source, 'env');
  assert.match(brokenCombined.reason!, /指定的脚本不存在/);

  // 依赖命令走完整降级：只装在版本管理器目录里也能满足
  const depName = process.platform === 'win32' ? 'nodedep.exe' : 'nodedep';
  const depDeclaration = declareCli({ id: 'fake', commands: ['faketool'], requiredCommands: ['nodedep'] });
  const depHome = path.join(root, 'home');
  const depEnv: NodeJS.ProcessEnv = { PATH: pathDir };
  if (process.platform === 'win32') {
    // nvm-windows：版本目录直接放可执行文件，位置由 NVM_HOME 指定
    const nvmHome = path.join(root, 'nvm-home');
    writeTool(path.join(nvmHome, 'v20.11.1'), depName);
    depEnv.NVM_HOME = nvmHome;
  } else {
    writeTool(path.join(depHome, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'), depName);
  }
  const withDep = discoverCli(depDeclaration, {
    env: depEnv,
    home: depHome,
    hydration: noHydration,
  });
  assert.equal(withDep.runnable, true);
  assert.equal(withDep.source, 'path');

  // 显式入口本身就是依赖时，不再要求 PATH 里另有一份
  const selfExe = writeTool(path.join(root, 'self-dep'), depName);
  const selfDep = discoverCli(depDeclaration, {
    explicitConfig: { executable: selfExe },
    env: { PATH: '' },
    home: path.join(root, 'empty'),
    hydration: noHydration,
  });
  assert.equal(selfDep.runnable, true);
  assert.equal(selfDep.source, 'config');

  // CB_NODE_PATH 是显式的 node 覆盖，与 nodeResolver 一致
  const cbNodeExe = writeTool(path.join(root, 'cb-node'), process.platform === 'win32' ? 'node.exe' : 'node');
  const cbNode = discoverCli(
    declareCli({ id: 'fake', commands: ['faketool'], requiredCommands: ['node'] }),
    { env: { PATH: pathDir, CB_NODE_PATH: cbNodeExe }, home: path.join(root, 'empty'), hydration: noHydration },
  );
  assert.equal(cbNode.runnable, true);

  // 依赖缺失：错误文案区分「已安装但依赖缺失」
  const missingDep = discoverCli(
    declareCli({ id: 'fake', commands: ['faketool'], requiredCommands: ['absent-dep'] }),
    { env: { PATH: pathDir }, home: path.join(root, 'empty'), hydration: noHydration },
  );
  assert.equal(missingDep.runnable, false);
  assert.match(missingDep.reason!, /已找到 .*缺少依赖命令/);

  // 显式配置里的 ~ 前缀展开到用户目录
  const home = path.join(root, 'home');
  const homeTool = writeTool(home, toolName);
  const fromTilde = discoverCli(declaration, {
    explicitConfig: { executable: `~/${toolName}` },
    env: { PATH: '' },
    home,
    hydration: noHydration,
  });
  assert.equal(fromTilde.runnable, true);
  assert.equal(fromTilde.executable, homeTool);

  console.log('✅ cliDiscoveryExplicit.test.ts passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
