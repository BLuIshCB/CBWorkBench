import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInstallDirs } from '../src/services/cliDiscovery.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-install-dirs-'));
const home = path.join(root, 'home');
const platform = process.platform;
const isWindows = platform === 'win32';

try {
  // 空 home：只按平台给出目录，不抛错
  const baseline = getInstallDirs(home, platform, [], { PATH: '' });
  assert.ok(baseline.length > 0);
  assert.equal(new Set(baseline.map((dir) => dir.toLowerCase())).size, baseline.length, '目录必须去重');
  if (isWindows) {
    assert.ok(baseline.includes(path.join(home, '.volta', 'bin')));
    assert.ok(baseline.includes(path.join(home, 'AppData', 'Roaming', 'npm')));
    assert.ok(baseline.includes(path.join(home, 'AppData', 'Local', 'agy', 'bin')));
  } else {
    assert.ok(baseline.includes('/usr/local/bin'));
  }

  // declaration 专属目录排在通用管理器之前，且与公共目录去重
  const extraDir = path.join(home, '.volta', 'bin');
  const withExtra = getInstallDirs(home, platform, [extraDir], { PATH: '' });
  assert.ok(withExtra.indexOf(extraDir) < withExtra.indexOf(path.join(home, '.asdf', 'shims')));
  assert.equal(withExtra.filter((dir) => dir === extraDir).length, 1);

  // npm 自定义 prefix：Windows 是 shim 根目录，POSIX 在 bin 下
  const npmPrefix = path.join(root, 'npm-prefix');
  const withPrefix = getInstallDirs(home, platform, [], { PATH: '', NPM_CONFIG_PREFIX: npmPrefix });
  assert.ok(withPrefix.includes(isWindows ? npmPrefix : path.join(npmPrefix, 'bin')));

  if (isWindows) {
    // nvm-windows：版本目录由 NVM_HOME 指定，node.exe 直接放在版本目录下
    const nvmHome = path.join(root, 'nvm-home');
    fs.mkdirSync(path.join(nvmHome, 'v20.11.1'), { recursive: true });
    fs.mkdirSync(path.join(nvmHome, 'v18.20.4'), { recursive: true });
    const withNvm = getInstallDirs(home, platform, [], { PATH: '', NVM_HOME: nvmHome });
    assert.ok(withNvm.includes(path.join(nvmHome, 'v20.11.1')));
    assert.ok(withNvm.includes(path.join(nvmHome, 'v18.20.4')));
    assert.equal(withNvm.some((dir) => dir.includes(`${path.sep}v20.11.1${path.sep}bin`)), false);

    // NVM_SYMLINK 是当前启用版本的软链目录
    const symlink = path.join(root, 'nvm-symlink');
    assert.ok(getInstallDirs(home, platform, [], { PATH: '', NVM_SYMLINK: symlink }).includes(symlink));
  } else {
    // nvm：默认版本目录排在其他已装版本之前
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    fs.mkdirSync(path.join(nvmVersions, 'v18.20.4', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(nvmVersions, 'v20.11.1', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'v20.11.1\n');
    const withNvm = getInstallDirs(home, platform, [], { PATH: '' });
    const nvmDirs = withNvm.filter((dir) => dir.includes(`${path.sep}.nvm${path.sep}versions`));
    assert.deepEqual(nvmDirs, [
      path.join(nvmVersions, 'v20.11.1', 'bin'),
      path.join(nvmVersions, 'v18.20.4', 'bin'),
    ]);

    // nvm alias 走别名链，且 system 不参与排序
    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'lts'), '../versions/node/v18.20.4');
    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'lts');
    const chained = getInstallDirs(home, platform, [], { PATH: '' })
      .filter((dir) => dir.includes(`${path.sep}.nvm${path.sep}versions`));
    assert.equal(chained[0], path.join(nvmVersions, 'v18.20.4', 'bin'));

    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'system');
    const systemAlias = getInstallDirs(home, platform, [], { PATH: '' })
      .filter((dir) => dir.includes(`${path.sep}.nvm${path.sep}versions`));
    assert.equal(systemAlias.length, 2);
  }

  // fnm：按 FNM_DIR → APPDATA → ~/.fnm 顺序，Windows 没有 bin 子目录
  const fnmRoot = path.join(root, 'fnm-data');
  const fnmDefault = isWindows
    ? path.join(fnmRoot, 'aliases', 'default')
    : path.join(fnmRoot, 'aliases', 'default', 'bin');
  fs.mkdirSync(fnmDefault, { recursive: true });
  const withFnm = getInstallDirs(home, platform, [], { PATH: '', FNM_DIR: fnmRoot });
  assert.ok(withFnm.includes(fnmDefault));

  console.log('✅ cliDiscoveryInstallDirs.test.ts passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
