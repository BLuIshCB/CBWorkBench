import fs from 'node:fs';
import path from 'node:path';

export type ExecutableKind = 'pe' | 'elf' | 'macho' | 'script';

/** 探测成功不等于调用成功：脚本型 CLI 依赖同目录的 node，需要在执行期前插 PATH。 */
export function readExecutableKind(filePath: string): ExecutableKind {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    if (fs.readSync(fd, header, 0, 4, 0) < 4) return 'script';
    return detectKind(header);
  } catch {
    return 'script';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function detectKind(header: Buffer): ExecutableKind {
  if (header[0] === 0x4d && header[1] === 0x5a) return 'pe';
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return 'elf';
  if (
    (header[0] === 0xcf && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe) ||
    (header[0] === 0xce && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe) ||
    (header[0] === 0xca && header[1] === 0xfe && header[2] === 0xba && header[3] === 0xbe)
  ) {
    return 'macho';
  }
  return 'script';
}

/** 脚本型 CLI 把自己的目录前插到子进程 PATH，保证 shebang / require 找到同目录的 node。 */
export function withCliRuntimeOnPath(
  config: { executable: string; env?: Record<string, string | undefined> },
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const env = { ...(config.env ?? process.env) };
  if (!path.isAbsolute(config.executable)) return env;
  if (readExecutableKind(config.executable) !== 'script') return env;

  const cliDir = path.dirname(config.executable);
  const key = (value: string) => (platform === 'win32' ? value.replace(/[\\/]+$/, '').toLowerCase() : value.replace(/[\\/]+$/, ''));
  const current = env.PATH ?? env.Path ?? '';
  const segments = current ? current.split(platform === 'win32' ? ';' : ':') : [];
  const merged = [cliDir, ...segments.filter((segment) => key(segment) !== key(cliDir))];

  if (platform === 'win32') {
    for (const envKey of Object.keys(env)) {
      if (envKey !== 'PATH' && envKey.toLowerCase() === 'path') delete env[envKey];
    }
  }
  env.PATH = merged.join(platform === 'win32' ? ';' : ':');
  return env;
}
