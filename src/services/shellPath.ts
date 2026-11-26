import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type HydrationFailureReason = 'no_shell' | 'spawn_error' | 'timeout' | 'empty_path';

export interface HydrationResult {
  ok: boolean;
  /** 水合新引入的 PATH 段，用于诊断「是不是水合救回来的」 */
  added: string[];
  failureReason?: HydrationFailureReason;
  shell?: string;
}

export interface ShellSpec {
  command: string;
  kind: 'powershell' | 'posix';
}

/** 探测执行器可注入，供单测覆盖超时/空 PATH，不必真的起 shell。 */
export type ShellRunner = (
  shell: ShellSpec,
  args: string[],
) => Promise<{ ok: true; stdout: string } | { ok: false; failureReason: HydrationFailureReason }>;

const PROBE_TIMEOUT_MS = 10000;
const BEGIN_MARKER = '__CB_PATH_BEGIN__';
const END_MARKER = '__CB_PATH_END__';

/** GUI 启动继承的是资源管理器 PATH，不是用户 shell 的 PATH；水合用于补齐 shell profile 里的段。 */
let hydrationVersion = 0;
let hydrationRun = 0;
let lastResult: HydrationResult | null = null;
let inFlight: Promise<HydrationResult> | null = null;
/** 累计由 shell 引入的段：重新水合时这些段已在 PATH 里，仍要能被标记为 shell-path。 */
let introducedSegments: string[] = [];

export function readEnvPath(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

/** Windows 按分号切分并剥离成对双引号，POSIX 空项按 cwd 解析，复刻 execvp 语义。 */
export function splitPath(
  pathEnv: string | undefined,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string[] {
  if (!pathEnv) return [];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const separator = platform === 'win32' ? ';' : ':';
  const entries: string[] = [];
  for (const raw of pathEnv.split(separator)) {
    let entry = raw.trim();
    if (platform === 'win32') {
      entry = entry.replace(/^"(.*)"$/, '$1').trim();
      if (entry) entries.push(entry);
    } else if (!entry) {
      entries.push(cwd);
    } else {
      entries.push(pathApi.isAbsolute(entry) ? entry : pathApi.resolve(cwd, entry));
    }
  }
  return entries;
}

/** 去重键：Windows 大小写不敏感，并忽略末尾分隔符。 */
export function pathKey(entry: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = entry.replace(/[\\/]+$/, '') || entry;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** shell 顺序优先；只追加会让 shell 里的版本目录排在旧路径之后而被抢占。 */
export function mergePathSegments(
  segments: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const current = splitPath(readEnvPath(env), platform);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const segment of [...segments, ...current]) {
    if (!segment) continue;
    const key = pathKey(segment, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(segment);
  }
  return merged;
}

export function applyMergedPath(
  segments: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (platform === 'win32') {
    // 同时存在 Path / PATH 两个 key 会互相覆盖，写回前先清掉大小写变体。
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
    }
  }
  env.PATH = segments.join(platform === 'win32' ? ';' : ':');
}

export function getHydrationState(): { version: number; result: HydrationResult | null; added: string[] } {
  return { version: hydrationVersion, result: lastResult, added: introducedSegments };
}

export function resolveProfileShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellSpec | null {
  return resolveProfileShellCandidates(platform, env)[0] ?? null;
}

/** Windows PowerShell 在 Constrained Language 下可能失败，保留 pwsh 作为备选（cmd 不加载 profile）。 */
export function resolveProfileShellCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellSpec[] {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    const seen = new Set<string>();
    const candidates: ShellSpec[] = [];
    for (const candidate of [
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      findOnPath('powershell.exe', platform, env),
      findOnPath('pwsh.exe', platform, env),
    ]) {
      if (!candidate || !isFile(candidate)) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ command: candidate, kind: 'powershell' });
    }
    return candidates;
  }

  const configured = env.SHELL;
  if (configured && path.isAbsolute(configured) && isFile(configured)) return [{ command: configured, kind: 'posix' }];
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return isFile(fallback) ? [{ command: fallback, kind: 'posix' }] : [];
}

/** 单飞：同一时刻只跑一次探测；成功或失败都缓存，force 用于「重新探测」。 */
export function hydrateShellPath(force = false): Promise<HydrationResult> {
  if (!force) {
    if (lastResult) return Promise.resolve(lastResult);
    if (inFlight) return inFlight;
  }
  // force 会与进行中的探测并存，只有最后一次的结果允许回写状态。
  const token = ++hydrationRun;
  const run = runHydration()
    .catch((): HydrationResult => ({ ok: false, added: [], failureReason: 'spawn_error' }))
    .then((result) => {
      if (token === hydrationRun) {
        lastResult = result;
        hydrationVersion += 1;
        inFlight = null;
      }
      return result;
    });
  inFlight = run;
  return run;
}

export function ensurePathHydrated(force = false): Promise<HydrationResult> {
  return hydrateShellPath(force);
}

async function runHydration(): Promise<HydrationResult> {
  const shells = resolveProfileShellCandidates();
  if (!shells.length) return { ok: false, added: [], failureReason: 'no_shell' };

  const platform = process.platform;
  let failure: HydrationFailureReason = 'spawn_error';
  for (const shell of shells) {
    const probe = await probeShellPath(shell);
    if (!probe.ok) {
      failure = probe.failureReason;
      // 超时不再重试第二个 shell，否则首屏等待会翻倍
      if (probe.failureReason === 'timeout') return { ok: false, added: [], failureReason: failure, shell: shell.command };
      continue;
    }

    const segments = splitPath(probe.pathValue, platform);
    if (!segments.length) {
      failure = 'empty_path';
      continue;
    }

    const currentKeys = new Set(splitPath(readEnvPath(process.env), platform).map(entry => pathKey(entry, platform)));
    const added = segments.filter(segment => !currentKeys.has(pathKey(segment, platform)));
    const introducedKeys = new Set(introducedSegments.map(entry => pathKey(entry, platform)));
    introducedSegments = [...introducedSegments, ...added.filter((segment) => !introducedKeys.has(pathKey(segment, platform)))];
    applyMergedPath(mergePathSegments(segments, platform));
    return { ok: true, added, shell: shell.command };
  }
  return { ok: false, added: [], failureReason: failure };
}

/** POSIX 下 $PATH 的形态随 shell 不同：fish 里是列表，引号展开会按空格拼接。 */
export function buildProbeArgs(shell: ShellSpec): string[] {
  if (shell.kind === 'powershell') {
    return ['-NoLogo', '-NonInteractive', '-Command', `[Console]::Out.Write('${BEGIN_MARKER}' + $env:PATH + '${END_MARKER}')`];
  }
  if (path.basename(shell.command).toLowerCase() === 'fish') {
    return ['-l', '-c', `printf '${BEGIN_MARKER}%s${END_MARKER}' (string join : $PATH)`];
  }
  return ['-l', '-c', `printf '${BEGIN_MARKER}%s${END_MARKER}' "$PATH"`];
}

function runShell(shell: ShellSpec, args: string[]): ReturnType<ShellRunner> {
  return new Promise((resolve) => {
    execFile(
      shell.command,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, CB_SHELL_PATH_PROBE: '1' } },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, failureReason: (error as any).killed ? 'timeout' : 'spawn_error' });
          return;
        }
        resolve({ ok: true, stdout: String(stdout ?? '') });
      },
    );
  });
}

export async function probeShellPath(
  shell: ShellSpec,
  runner: ShellRunner = runShell,
): Promise<{ ok: true; pathValue: string } | { ok: false; failureReason: HydrationFailureReason }> {
  const result = await runner(shell, buildProbeArgs(shell));
  if (!result.ok) return result;
  const value = parseProbeOutput(result.stdout);
  return value
    ? { ok: true, pathValue: value }
    : { ok: false, failureReason: 'empty_path' };
}

/** rc 文件的横幅与彩色提示会污染输出，先剥离 ANSI 再取哨兵区间。 */
export function parseProbeOutput(output: string): string | null {
  const clean = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const start = clean.indexOf(BEGIN_MARKER);
  const end = clean.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (start < 0 || end < 0) return null;
  const value = clean.slice(start + BEGIN_MARKER.length, end).trim();
  return value || null;
}

function findOnPath(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  for (const dir of splitPath(readEnvPath(env), platform)) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
