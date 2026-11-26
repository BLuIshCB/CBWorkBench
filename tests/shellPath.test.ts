import assert from 'node:assert/strict';
import path from 'node:path';
import {
  applyMergedPath,
  buildProbeArgs,
  mergePathSegments,
  parseProbeOutput,
  pathKey,
  probeShellPath,
  resolveProfileShell,
} from '../src/services/shellPath.ts';

// 哨兵解析：剥离 ANSI（rc 文件的横幅与彩色提示）后取区间
const noisy = [
  '\x1b[32mWelcome to zsh\x1b[0m',
  'some banner text',
  '__CB_PATH_BEGIN__/usr/local/bin:/usr/bin__CB_PATH_END__',
  'after',
].join('\n');
assert.equal(parseProbeOutput(noisy), '/usr/local/bin:/usr/bin');

const osc = 'title\x1b]0;window\x07__CB_PATH_BEGIN__C:\\a;C:\\b__CB_PATH_END__';
assert.equal(parseProbeOutput(osc), 'C:\\a;C:\\b');

assert.equal(parseProbeOutput('no sentinel here'), null);
assert.equal(parseProbeOutput('__CB_PATH_BEGIN__   __CB_PATH_END__'), null, '空 PATH 视为失败');

// 合并：shell 段优先，其余现有段保持顺序，去重忽略大小写与末尾分隔符
const merged = mergePathSegments(
  ['C:\\nvm\\v20', 'C:\\nvm\\v20\\', 'C:\\windows'],
  'win32',
  { PATH: 'C:\\WINDOWS;C:\\nvm\\v20;C:\\other' },
);
assert.deepEqual(merged, ['C:\\nvm\\v20', 'C:\\windows', 'C:\\other']);

const posixMerged = mergePathSegments(['/opt/homebrew/bin', '/usr/bin'], 'linux', { PATH: '/usr/bin:/bin' });
assert.deepEqual(posixMerged, ['/opt/homebrew/bin', '/usr/bin', '/bin']);

// 写回：Windows 先清掉大小写变体，再写单一 key
const winEnv: Record<string, string | undefined> = { Path: 'C:\\stale', PATH: 'C:\\stale' };
applyMergedPath(['C:\\nvm'], 'win32', winEnv);
assert.equal(winEnv.Path, undefined);
assert.equal(winEnv.PATH, 'C:\\nvm');

const posixEnv: Record<string, string | undefined> = { PATH: '/usr/bin' };
applyMergedPath(['/opt/bin', '/usr/bin'], 'linux', posixEnv);
assert.equal(posixEnv.PATH, `/opt/bin${path.posix.delimiter}/usr/bin`);

// pathKey：Windows 大小写不敏感
assert.equal(pathKey('C:\\Tools\\', 'win32'), pathKey('c:\\tools', 'win32'));
assert.notEqual(pathKey('/Tools', 'linux'), pathKey('/tools', 'linux'));

// profile shell 选择：cmd 不加载 profile，没有 PowerShell 时直接判 no_shell
assert.equal(resolveProfileShell('win32', { PATH: '', SystemRoot: 'C:\\not-here' }), null);
if (process.platform === 'win32') {
  const shell = resolveProfileShell('win32', process.env);
  assert.ok(shell, 'Windows 必须能找到 PowerShell');
  assert.equal(shell.kind, 'powershell');
}

// 探测执行器：mock spawner 覆盖成功 / 超时 / 空 PATH，不必真起 shell
const posixShell = { command: '/bin/zsh', kind: 'posix' as const };
const okRun = async () => ({
  ok: true as const,
  stdout: 'profile banner\n\x1b[32mnoise\x1b[0m\n__CB_PATH_BEGIN__/opt/bin:/usr/bin__CB_PATH_END__\n',
});
assert.deepEqual(await probeShellPath(posixShell, okRun), { ok: true, pathValue: '/opt/bin:/usr/bin' });

const timeoutRun = async () => ({ ok: false as const, failureReason: 'timeout' as const });
assert.deepEqual(await probeShellPath(posixShell, timeoutRun), { ok: false, failureReason: 'timeout' });

const emptyRun = async () => ({ ok: true as const, stdout: '__CB_PATH_BEGIN__   __CB_PATH_END__' });
assert.deepEqual(await probeShellPath(posixShell, emptyRun), { ok: false, failureReason: 'empty_path' });

// fish 的 $PATH 是列表，必须用 string join，否则会被按空格拼成一条假 PATH
let fishArgs: string[] = [];
await probeShellPath({ command: '/usr/local/bin/fish', kind: 'posix' }, async (_shell, args) => {
  fishArgs = args;
  return { ok: true, stdout: '__CB_PATH_BEGIN__/opt/bin__CB_PATH_END__' };
});
assert.ok(fishArgs[2].includes('string join'), 'fish 必须用 string join 拼接 PATH');

const bashArgs = buildProbeArgs({ command: '/bin/bash', kind: 'posix' });
assert.equal(bashArgs[2].includes('string join'), false);
// 目的就是加载 profile，不能加 -NoProfile
const powershellArgs = buildProbeArgs({ command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', kind: 'powershell' });
assert.ok(powershellArgs.includes('-Command'));
assert.equal(powershellArgs.includes('-NoProfile'), false);

console.log('✅ shellPath.test.ts passed');
