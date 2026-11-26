import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readExecutableKind, withCliRuntimeOnPath } from '../src/utils/executableKind.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-executable-kind-'));

function writeWithHeader(name: string, header: number[]): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.from([...header, 0, 0, 0, 0]));
  return file;
}

try {
  assert.equal(readExecutableKind(writeWithHeader('app.exe', [0x4d, 0x5a, 0x90, 0x00])), 'pe');
  assert.equal(readExecutableKind(writeWithHeader('app.elf', [0x7f, 0x45, 0x4c, 0x46])), 'elf');
  assert.equal(readExecutableKind(writeWithHeader('app.macho64', [0xcf, 0xfa, 0xed, 0xfe])), 'macho');
  assert.equal(readExecutableKind(writeWithHeader('app.macho32', [0xce, 0xfa, 0xed, 0xfe])), 'macho');
  assert.equal(readExecutableKind(writeWithHeader('app.universal', [0xca, 0xfe, 0xba, 0xbe])), 'macho');
  assert.equal(readExecutableKind(writeWithHeader('app.sh', [0x23, 0x21, 0x2f, 0x62])), 'script');
  assert.equal(readExecutableKind(path.join(root, 'missing')), 'script', '读不到文件按脚本处理');
  assert.equal(readExecutableKind(writeWithHeader('short.bin', [])), 'script', '不足 4 字节按脚本处理');

  // 原生二进制不动 PATH
  const native = writeWithHeader('native.exe', [0x4d, 0x5a, 0x90, 0x00]);
  const nativeEnv = withCliRuntimeOnPath({ executable: native, env: { PATH: 'C:\\other' } }, 'win32');
  assert.equal(nativeEnv.PATH, 'C:\\other');

  // 脚本型 CLI：自身目录前插，且不重复
  const scriptDir = path.join(root, 'script runtime');
  fs.mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, 'cli.js');
  fs.writeFileSync(script, '#!/usr/bin/env node\n');
  const scriptEnv = withCliRuntimeOnPath(
    { executable: script, env: { PATH: `C:\\other;${scriptDir}` } },
    'win32',
  );
  assert.equal(scriptEnv.PATH, `${scriptDir};C:\\other`);

  // 相对可执行名不碰 PATH
  const relativeEnv = withCliRuntimeOnPath({ executable: 'codex', env: { PATH: 'C:\\other' } }, 'win32');
  assert.equal(relativeEnv.PATH, 'C:\\other');

  // Windows 的 Path / PATH 双 key 只保留一个
  const caseEnv: Record<string, string | undefined> = { Path: 'C:\\stale', PATH: 'C:\\keep' };
  const cleaned = withCliRuntimeOnPath({ executable: script, env: caseEnv }, 'win32');
  assert.equal(cleaned.Path, undefined);
  assert.equal(cleaned.PATH, `${scriptDir};C:\\keep`);

  console.log('✅ executableKind.test.ts passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
