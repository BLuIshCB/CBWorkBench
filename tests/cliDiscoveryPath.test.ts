import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeCandidate,
  getExecutableNames,
  isRunnable,
  isRunnableAsync,
  splitPath,
} from '../src/services/cliDiscovery.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-discovery-path-'));
try {
  // splitPath：Windows 去引号、跳空项，保留带空格与中文的目录
  const windowsEntries = splitPath(
    '"C:\\Program Files\\nodejs";;  C:\\工具\\bin  ;;\\\\server\\share\\bin;"D:\\带 空格\\dir\\"',
    'win32',
  );
  assert.deepEqual(windowsEntries, [
    'C:\\Program Files\\nodejs',
    'C:\\工具\\bin',
    '\\\\server\\share\\bin',
    'D:\\带 空格\\dir\\',
  ]);
  assert.deepEqual(splitPath(undefined, 'win32'), []);
  assert.deepEqual(splitPath('', 'linux'), []);

  // splitPath：POSIX 空项按 cwd 解析，相对项转绝对
  const posixEntries = splitPath('/usr/bin::relative/bin:/opt/x', 'linux', '/home/cb');
  assert.deepEqual(posixEntries, ['/usr/bin', '/home/cb', '/home/cb/relative/bin', '/opt/x']);

  // getExecutableNames：Windows 顺序固定，已带扩展名不叠加
  assert.deepEqual(getExecutableNames('win32', 'codex'), ['codex.cmd', 'codex.exe', 'codex.bat', 'codex']);
  assert.deepEqual(getExecutableNames('win32', 'agy.exe'), ['agy.exe']);
  assert.deepEqual(getExecutableNames('linux', 'codex'), ['codex']);

  // isRunnable：目录与不存在的路径都不算可运行
  const file = path.join(root, 'tool.exe');
  fs.writeFileSync(file, '');
  assert.equal(isRunnable(file).runnable, true, '0 字节文件在 Windows 判通过，由 --version 兜住');
  assert.equal(isRunnable(root).runnable, false);
  assert.equal(isRunnable(root).reason, '不是文件');
  assert.equal(isRunnable(path.join(root, 'missing.exe')).reason, 'ENOENT');
  // Windows 不区分 ENOTDIR，父级是文件时同样报 ENOENT
  assert.ok(['ENOENT', 'ENOTDIR'].includes(isRunnable(path.join(root, 'tool.exe', 'nested')).reason!));
  assert.equal((await isRunnableAsync(file)).runnable, true);
  assert.equal((await isRunnableAsync(root)).reason, '不是文件');

  // describeCandidate：保留来源与失败原因
  const described = describeCandidate(path.join(root, 'missing.exe'), 'install-dir');
  assert.equal(described.source, 'install-dir');
  assert.equal(described.runnable, false);
  assert.equal(described.reason, 'ENOENT');

  // 中文与空格路径全程不 encode/decode
  const unicodeDir = path.join(root, '中文 目录');
  fs.mkdirSync(unicodeDir);
  const unicodeFile = path.join(unicodeDir, 'codex.cmd');
  fs.writeFileSync(unicodeFile, '@echo off');
  assert.equal(isRunnable(unicodeFile).runnable, true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('✅ cliDiscoveryPath.test.ts passed');
