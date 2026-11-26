import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getHydrationState, pathKey, readEnvPath, splitPath, type HydrationResult } from './shellPath.ts';

export { ensurePathHydrated, hydrateShellPath, splitPath } from './shellPath.ts';

/** 探测结果来源。shell-path 不是独立一级，而是命中目录位于水合新增段内时的标记。 */
export type DiscoverySource = 'config' | 'env' | 'path' | 'shell-path' | 'install-dir' | 'fallback';

export interface CliEntry {
  executable: string;
  script?: string;
}

export interface CliDeclaration {
  id: string;
  /** 探测命令名，按顺序尝试，如 ['codex'] */
  commands: readonly string[];
  /** 依赖命令，缺一即判不可用，如 codex 需要 node */
  requiredCommands?: readonly string[];
  /** 单路径型显式环境变量，按顺序尝试 */
  explicitEnv?: readonly string[];
  /** 组合型环境变量入口（多个变量构成一个入口，如 WB_COMMAND + WB_CLI_SCRIPT） */
  envEntry?: (env: NodeJS.ProcessEnv) => CliEntry | undefined;
  /** 该 CLI 专属安装目录，由声明提供 */
  extraInstallDirs?: (home: string, platform: NodeJS.Platform) => string[];
  /** 包装器平级脚本路径，相对 node_modules，如 @openai/codex/bin/codex.js */
  scriptRelativePath?: string;
  /** healthCheck 需要的命令参数，缺一即判版本不兼容 */
  requiredFlags?: readonly string[];
  /** 该 CLI 每次启动都要带的固定环境变量 */
  baseEnv?: (ctx: { home: string; rootDir: string; dataDir: string }) => Record<string, string>;
  /** 仅在这些平台上探测 */
  platforms?: readonly NodeJS.Platform[];
}

export interface DiscoveryCandidate {
  path: string;
  source: DiscoverySource;
  runnable: boolean;
  /** 不可运行的原因：ENOENT / EACCES / 非文件 / 缺依赖 */
  reason?: string;
}

export interface DiscoveryResult {
  command: string;
  executable: string;
  script?: string;
  /** 探测阶段是否确认可运行。source='fallback' 时恒为 false（交给探活验证） */
  runnable: boolean;
  /** Windows 下只有 .cmd/.bat 且没有可配对脚本时，执行期需要用 cmd.exe 包裹 */
  needsShellWrap?: boolean;
  source: DiscoverySource;
  reason?: string;
  /** 只记录真实存在过的候选与显式配置，避免把几百条 PATH 组合全量吐给 UI */
  candidates: DiscoveryCandidate[];
  /** 本次实际探测过的路径数量 */
  scanned: number;
  pathHydrated: boolean;
  hydrationFailure?: string;
  missingDependencies?: string[];
}

export interface DiscoverOptions {
  /** agent-cli.json 中该 id 的显式配置，由 cliConfig 读取后传入，探测层不反向依赖配置层 */
  explicitConfig?: CliEntry;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 水合状态注入，缺省读进程内全局水合结果 */
  hydration?: { added: string[]; result: HydrationResult | null };
}

interface NormalizedEntry extends CliEntry {
  needsShellWrap?: boolean;
}

interface DiscoveryContext {
  declaration: CliDeclaration;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  command: string;
  names: string[];
  pathDirs: string[];
  installDirs: string[];
  hydratedKeys: Set<string>;
  candidates: DiscoveryCandidate[];
  dependencyCache: Map<string, string | null>;
  scanned: number;
  hydration: { added: string[]; result: HydrationResult | null };
  blocked?: { entry: NormalizedEntry; source: DiscoverySource; reason: string; missing: string[] };
}

const UNSUPPORTED_PS1 = '不支持直接执行 .ps1：请配置 node + 脚本路径，或改用 .cmd / .exe';

export function declareCli(declaration: CliDeclaration): CliDeclaration {
  if (!declaration.id?.trim()) throw new Error('CLI 声明缺少 id');
  if (!Array.isArray(declaration.commands)) throw new Error(`CLI 声明 ${declaration.id} 的 commands 必须是数组`);
  return Object.freeze({ ...declaration });
}

/** 目录不算可运行；Windows 只看是否文件，POSIX 还要求可执行位。 */
export function isRunnable(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): { runnable: boolean; reason?: string } {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return { runnable: false, reason: '不是文件' };
    return platform === 'win32' ? { runnable: true } : checkExecutableBits(candidate);
  } catch (error: any) {
    return { runnable: false, reason: error?.code ?? 'STAT_FAILED' };
  }
}

export async function isRunnableAsync(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ runnable: boolean; reason?: string }> {
  try {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) return { runnable: false, reason: '不是文件' };
    if (platform === 'win32') return { runnable: true };
    await fsp.access(candidate, fs.constants.X_OK);
    return { runnable: true };
  } catch (error: any) {
    return { runnable: false, reason: error?.code ?? 'STAT_FAILED' };
  }
}

/** .cmd 排在 .exe 前：npm 全局安装产出 .cmd，两者同时存在时优先 npm shim。 */
export function getExecutableNames(platform: NodeJS.Platform, name: string): string[] {
  if (platform !== 'win32') return [name];
  if (/\.(exe|cmd|bat|ps1)$/i.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

export function describeCandidate(
  candidate: string,
  source: DiscoverySource,
  platform: NodeJS.Platform = process.platform,
): DiscoveryCandidate {
  const check = isRunnable(candidate, platform);
  return { path: candidate, source, runnable: check.runnable, reason: check.reason };
}

/** 全部按 homedir 推导，零盘符硬编码；顺序即探测优先级。 */
export function getInstallDirs(
  home: string,
  platform: NodeJS.Platform = process.platform,
  extra: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs: string[] = [];
  const add = (dir?: string | null) => {
    if (dir && dir.trim()) dirs.push(dir);
  };

  // 顺序：版本管理器默认版本 → 声明专属目录 → 通用管理器 → 系统目录。
  for (const dir of getNvmVersionDirs(home, platform, env)) add(dir);
  add(getFnmDefaultDir(home, platform, env));
  for (const dir of extra) add(dir);

  // 自定义 npm prefix：Windows 直接放 shim，POSIX 在 bin 下。
  for (const key of ['NPM_CONFIG_PREFIX', 'npm_config_prefix']) {
    const prefix = env[key];
    if (prefix) add(platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  }

  add(path.join(home, '.volta', 'bin'));
  add(path.join(home, '.asdf', 'shims'));
  add(path.join(home, '.local', 'share', 'mise', 'shims'));
  add(path.join(home, '.bun', 'bin'));

  if (platform === 'win32') {
    // Claude / Codex / Antigravity / Qwen 官方安装器目录常常不在 GUI 继承的 PATH 里。
    add(env.NVM_SYMLINK);
    add(path.join(home, '.local', 'bin'));
    add(path.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin'));
    add(path.join(home, 'AppData', 'Local', 'agy', 'bin'));
    add(path.join(home, 'AppData', 'Local', 'qwen-code', 'bin'));
    add(path.join(home, 'AppData', 'Roaming', 'npm'));
    add(path.join(home, 'AppData', 'Local', 'pnpm'));
    add(path.join(home, 'AppData', 'Local', 'Yarn', 'bin'));
  } else if (platform === 'darwin') {
    add(path.join(home, 'Library', 'pnpm'));
    add(path.join(home, '.yarn', 'bin'));
    add('/opt/homebrew/bin');
    add('/opt/local/bin');
    add('/usr/local/bin');
  } else {
    add(path.join(home, '.local', 'share', 'pnpm'));
    add(path.join(home, '.yarn', 'bin'));
    add('/usr/local/bin');
    add('/snap/bin');
    add('/home/linuxbrew/.linuxbrew/bin');
  }

  if (platform !== 'win32') {
    // 系统目录只用于 lookup 兜底，不能前插到继承的 PATH，否则会打乱用户自己的优先级。
    add('/nix/var/nix/profiles/default/bin');
    add(path.join(home, '.nix-profile', 'bin'));
    add(path.join(home, '.opencode', 'bin'));
    add(path.join(home, '.vite-plus', 'bin'));
    add(path.join(home, '.grok', 'bin'));
  }

  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = pathKey(dir, platform);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function discoverCli(declaration: CliDeclaration, options: DiscoverOptions = {}): DiscoveryResult {
  const ctx = createContext(declaration, options);
  const unsupported = unsupportedPlatform(ctx);
  if (unsupported) return unsupported;
  const explicit = tryExplicitConfig(ctx, options.explicitConfig);
  if (explicit) return explicit;
  const fromEnv = tryExplicitEnv(ctx);
  if (fromEnv) return fromEnv;

  for (const step of scanOrder(ctx)) {
    ctx.scanned += 1;
    const hit = evaluateStep(ctx, step.candidate, step.source, isRunnable(step.candidate, ctx.platform));
    if (hit) return hit;
  }
  return finalizeMissing(ctx);
}

/** 异步版本只把主扫描改成异步 stat；命中后依赖解析与归一化是常数次探测，复用同步实现。 */
export async function discoverCliAsync(declaration: CliDeclaration, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const ctx = createContext(declaration, options);
  const unsupported = unsupportedPlatform(ctx);
  if (unsupported) return unsupported;
  const explicit = tryExplicitConfig(ctx, options.explicitConfig);
  if (explicit) return explicit;
  const fromEnv = tryExplicitEnv(ctx);
  if (fromEnv) return fromEnv;

  for (const step of scanOrder(ctx)) {
    ctx.scanned += 1;
    const hit = evaluateStep(ctx, step.candidate, step.source, await isRunnableAsync(step.candidate, ctx.platform));
    if (hit) return hit;
  }
  return finalizeMissing(ctx);
}

/** 诊断入口：永不抛出，失败时返回带原因的结果，供 doctor 与 UI 展示。 */
export function getDiscoveryDiagnostics(declaration: CliDeclaration, options: DiscoverOptions = {}): DiscoveryResult {
  try {
    return discoverCli(declaration, options);
  } catch (error: any) {
    return {
      command: declaration.commands[0] ?? declaration.id,
      executable: declaration.id,
      runnable: false,
      source: 'fallback',
      reason: `探测过程异常: ${error?.message ?? String(error)}`,
      candidates: [],
      scanned: 0,
      pathHydrated: false,
    };
  }
}

function createContext(declaration: CliDeclaration, options: DiscoverOptions): DiscoveryContext {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const hydration = options.hydration ?? getHydrationState();
  const pathDirs = splitPath(readEnvPath(env), platform);
  const pathKeys = new Set(pathDirs.map((dir) => pathKey(dir, platform)));
  // 已在 PATH 里的目录不重复扫描，也避免命中后被标错来源。
  const installDirs = getInstallDirs(home, platform, declaration.extraInstallDirs?.(home, platform) ?? [], env)
    .filter((dir) => !pathKeys.has(pathKey(dir, platform)));

  return {
    declaration,
    platform,
    env,
    home,
    command: declaration.commands[0] ?? declaration.id,
    names: declaration.commands.flatMap((command) => getExecutableNames(platform, command)),
    pathDirs,
    installDirs,
    hydratedKeys: new Set(hydration.added.map((dir) => pathKey(dir, platform))),
    candidates: [],
    dependencyCache: new Map(),
    scanned: 0,
    hydration,
  };
}

function tryExplicitConfig(ctx: DiscoveryContext, explicit?: CliEntry): DiscoveryResult | null {
  if (!explicit?.executable) return null;

  const entry: CliEntry = {
    executable: expandHome(explicit.executable, ctx.home),
    script: explicit.script ? expandHome(explicit.script, ctx.home) : undefined,
  };
  const executableCheck = isRunnable(entry.executable, ctx.platform);
  ctx.candidates.push({ path: entry.executable, source: 'config', runnable: executableCheck.runnable, reason: executableCheck.reason });
  let scriptCheck: { runnable: boolean; reason?: string } | undefined;
  if (entry.script) {
    scriptCheck = isRunnable(entry.script, ctx.platform);
    ctx.candidates.push({ path: entry.script, source: 'config', runnable: scriptCheck.runnable, reason: scriptCheck.reason });
  }

  // 显式配置写错时必须明确报错，不能静默回退成 PATH 里的其他版本。
  const reason = !executableCheck.runnable
    ? `配置的入口不存在或不可运行（${executableCheck.reason}）`
    : scriptCheck && !scriptCheck.runnable
      ? `配置的脚本不存在或不可运行（${scriptCheck.reason}）`
      : null;
  if (reason) return buildResult(ctx, entry, 'config', false, { reason });

  const normalized = normalizeEntry(entry.executable, ctx, entry.script);
  if (isUnsupportedWrapper(entry.executable, normalized)) {
    return buildResult(ctx, entry, 'config', false, { reason: UNSUPPORTED_PS1 });
  }
  const missing = findMissingDependencies(ctx, normalized.executable);
  if (missing.length) {
    return buildResult(ctx, normalized, 'config', false, { reason: `缺少依赖命令: ${missing.join(', ')}`, missing });
  }
  return buildResult(ctx, normalized, 'config', true);
}

function tryExplicitEnv(ctx: DiscoveryContext): DiscoveryResult | null {
  const names = ctx.declaration.explicitEnv ?? [];
  if (!names.length) return null;

  const entries: { name: string; entry: CliEntry }[] = [];
  if (ctx.declaration.envEntry) {
    if (!names.some((name) => ctx.env[name])) return null;
    const entry = ctx.declaration.envEntry(ctx.env);
    if (entry) entries.push({ name: names.filter((name) => ctx.env[name]).join(' + '), entry });
  } else {
    for (const name of names) {
      const value = ctx.env[name];
      if (!value) continue;
      entries.push({ name, entry: { executable: value } });
    }
  }

  for (const { name, entry: rawEntry } of entries) {
    // ~ 前缀只在显式配置/环境变量里展开；PATH 里的 ~ 由 shell 自己处理过
    const entry: CliEntry = {
      executable: expandHome(rawEntry.executable, ctx.home),
      script: rawEntry.script ? expandHome(rawEntry.script, ctx.home) : undefined,
    };
    const executableCheck = isRunnable(entry.executable, ctx.platform);
    ctx.candidates.push({ path: entry.executable, source: 'env', runnable: executableCheck.runnable, reason: executableCheck.reason });
    let scriptCheck: { runnable: boolean; reason?: string } | undefined;
    if (entry.script) {
      scriptCheck = isRunnable(entry.script, ctx.platform);
      ctx.candidates.push({ path: entry.script, source: 'env', runnable: scriptCheck.runnable, reason: scriptCheck.reason });
    }
    const reason = !executableCheck.runnable
      ? `环境变量 ${name} 指定的入口不存在或不可运行（${executableCheck.reason}）`
      : scriptCheck && !scriptCheck.runnable
        ? `环境变量 ${name} 指定的脚本不存在或不可运行（${scriptCheck.reason}）`
        : null;
    if (reason) return buildResult(ctx, entry, 'env', false, { reason });

    const normalized = normalizeEntry(entry.executable, ctx, entry.script);
    if (isUnsupportedWrapper(entry.executable, normalized)) {
      return buildResult(ctx, entry, 'env', false, { reason: UNSUPPORTED_PS1 });
    }
    const missing = findMissingDependencies(ctx, normalized.executable);
    if (missing.length) return buildResult(ctx, normalized, 'env', false, { reason: `缺少依赖命令: ${missing.join(', ')}`, missing });
    return buildResult(ctx, normalized, 'env', true);
  }
  return null;
}

/** 只在特定平台存在的 CLI（如仅 Windows 可用的命令行工具）不做任何探测。 */
function unsupportedPlatform(ctx: DiscoveryContext): DiscoveryResult | null {
  const platforms = ctx.declaration.platforms;
  if (!platforms?.length || platforms.includes(ctx.platform)) return null;
  return buildResult(ctx, { executable: ctx.command }, 'fallback', false, {
    reason: `该 CLI 仅支持 ${platforms.join(' / ')}，当前平台为 ${ctx.platform}`,
  });
}

function* scanOrder(ctx: DiscoveryContext): Generator<{ candidate: string; source: DiscoverySource }> {
  for (const dir of ctx.pathDirs) {
    const source: DiscoverySource = ctx.hydratedKeys.has(pathKey(dir, ctx.platform)) ? 'shell-path' : 'path';
    for (const name of ctx.names) yield { candidate: path.join(dir, name), source };
  }
  for (const dir of ctx.installDirs) {
    for (const name of ctx.names) yield { candidate: path.join(dir, name), source: 'install-dir' };
  }
}

function evaluateStep(
  ctx: DiscoveryContext,
  candidate: string,
  source: DiscoverySource,
  check: { runnable: boolean; reason?: string },
): DiscoveryResult | null {
  if (!check.runnable) {
    recordExisting(ctx, candidate, source, check.reason);
    return null;
  }
  return finalizeHit(ctx, candidate, source);
}

function finalizeHit(ctx: DiscoveryContext, candidate: string, source: DiscoverySource): DiscoveryResult | null {
  const entry = normalizeEntry(candidate, ctx);
  if (isUnsupportedWrapper(candidate, entry)) {
    ctx.candidates.push({ path: candidate, source, runnable: false, reason: UNSUPPORTED_PS1 });
    return null;
  }
  const missing = findMissingDependencies(ctx, entry.executable);
  if (missing.length) {
    ctx.candidates.push({ path: candidate, source, runnable: false, reason: `缺少依赖: ${missing.join(', ')}` });
    ctx.blocked ??= { entry, source, reason: `已找到 ${candidate}，但缺少依赖命令: ${missing.join(', ')}`, missing };
    return null;
  }
  ctx.candidates.push({ path: candidate, source, runnable: true });
  return buildResult(ctx, entry, source, true);
}

function finalizeMissing(ctx: DiscoveryContext): DiscoveryResult {
  if (ctx.blocked) {
    return buildResult(ctx, ctx.blocked.entry, ctx.blocked.source, false, {
      reason: ctx.blocked.reason,
      missing: ctx.blocked.missing,
    });
  }
  ctx.candidates.push({ path: ctx.command, source: 'fallback', runnable: false, reason: 'PATH 与已知安装目录均未命中' });
  return buildResult(ctx, { executable: ctx.command }, 'fallback', false, { reason: '未在任何已知位置找到，交由执行期验证' });
}

function buildResult(
  ctx: DiscoveryContext,
  entry: NormalizedEntry,
  source: DiscoverySource,
  runnable: boolean,
  extra: { reason?: string; missing?: string[] } = {},
): DiscoveryResult {
  const result: DiscoveryResult = {
    command: ctx.command,
    executable: entry.executable,
    script: entry.script,
    runnable,
    needsShellWrap: entry.needsShellWrap,
    source,
    reason: extra.reason,
    candidates: [...ctx.candidates],
    scanned: ctx.scanned,
    pathHydrated: ctx.hydration.result?.ok === true,
    hydrationFailure: ctx.hydration.result && !ctx.hydration.result.ok ? ctx.hydration.result.failureReason : undefined,
    missingDependencies: extra.missing,
  };
  return result;
}

/**
 * 入口归一化：.js 交给 node，.cmd/.bat 尝试配对平级脚本，配不上则标记执行期用 cmd 包裹。
 */
function normalizeEntry(candidate: string, ctx: DiscoveryContext, providedScript?: string): NormalizedEntry {
  if (providedScript) return { executable: candidate, script: providedScript };

  if (/\.js$/i.test(candidate)) {
    return { executable: resolveCommand('node', ctx) ?? process.execPath, script: candidate };
  }

  if (/\.(cmd|bat|ps1)$/i.test(candidate) && ctx.declaration.scriptRelativePath) {
    // npm 全局是 <dir>/node_modules/<pkg>，npm 的 .bin 是 <dir>/../<pkg>，两种布局都要认。
    const dir = path.dirname(candidate);
    const scriptPaths = [
      path.join(dir, 'node_modules', ctx.declaration.scriptRelativePath),
      path.join(dir, '..', ctx.declaration.scriptRelativePath),
    ].map((scriptPath) => path.resolve(scriptPath));
    for (const scriptPath of scriptPaths) {
      if (!isRunnable(scriptPath, ctx.platform).runnable) continue;
      const node = resolveCommand('node', ctx);
      if (node) return { executable: node, script: scriptPath };
      break;
    }
    // cmd.exe 能执行 .cmd/.bat，但执行不了 .ps1，不能套同一层包装。
    if (isPowerShellScript(candidate)) return { executable: candidate };
    return { executable: candidate, needsShellWrap: true };
  }

  if (/\.(cmd|bat)$/i.test(candidate)) return { executable: candidate, needsShellWrap: true };
  return { executable: candidate };
}

/** 依赖命令走完整降级：PATH 未命中时继续扫安装目录，node 可能只装在 nvm 目录里。 */
function resolveCommand(name: string, ctx: DiscoveryContext, entryExecutable?: string): string | null {
  const cached = ctx.dependencyCache.get(name);
  if (cached !== undefined) return cached;

  const lower = name.toLowerCase();
  // 显式入口本身就是依赖（如配置里直接写 node.exe），不必再去 PATH 找第二份。
  if (entryExecutable && matchesCommand(entryExecutable, lower)) {
    ctx.dependencyCache.set(name, entryExecutable);
    return entryExecutable;
  }
  // CB_NODE_PATH 是显式的 node 覆盖，与 nodeResolver 的优先级保持一致。
  const explicitNode = ctx.env.CB_NODE_PATH;
  if (lower === 'node' && explicitNode && isRunnable(explicitNode, ctx.platform).runnable) {
    ctx.dependencyCache.set(name, explicitNode);
    return explicitNode;
  }

  const selfBase = path.basename(process.execPath).toLowerCase();
  if (selfBase === lower || selfBase === `${lower}.exe`) {
    ctx.dependencyCache.set(name, process.execPath);
    return process.execPath;
  }

  for (const dir of [...ctx.pathDirs, ...ctx.installDirs]) {
    for (const executableName of getExecutableNames(ctx.platform, name)) {
      const candidate = path.join(dir, executableName);
      if (isRunnable(candidate, ctx.platform).runnable) {
        ctx.dependencyCache.set(name, candidate);
        return candidate;
      }
    }
  }
  ctx.dependencyCache.set(name, null);
  return null;
}

function matchesCommand(candidate: string, name: string): boolean {
  const base = path.basename(candidate).toLowerCase();
  return base === name || base === `${name}.exe` || base === `${name}.cmd` || base === `${name}.bat`;
}

function findMissingDependencies(ctx: DiscoveryContext, entryExecutable?: string): string[] {
  return (ctx.declaration.requiredCommands ?? []).filter(
    (command) => !resolveCommand(command, ctx, entryExecutable),
  );
}

function isPowerShellScript(candidate: string): boolean {
  return /\.ps1$/i.test(candidate);
}

function isUnsupportedWrapper(candidate: string, entry: NormalizedEntry): boolean {
  return isPowerShellScript(candidate) && !entry.script;
}

/** 显式配置里的 ~ 前缀展开到用户目录；PATH 条目不做展开。 */
function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

function recordExisting(ctx: DiscoveryContext, candidate: string, source: DiscoverySource, reason?: string): void {
  // ENOENT 是绝大多数组合的常态，记录它只会淹没真正有用的诊断信息。
  if (!reason || reason === 'ENOENT') return;
  ctx.candidates.push({ path: candidate, source, runnable: false, reason });
}

function getNvmVersionDirs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  // nvm-windows 的版本目录直接放 node.exe（没有 bin），位置由 NVM_HOME 指定。
  if (platform === 'win32') {
    const nvmHome = env.NVM_HOME;
    if (!nvmHome) return [];
    try {
      return fs.readdirSync(nvmHome).filter((name) => /^v\d+/i.test(name)).map((name) => path.join(nvmHome, name));
    } catch {
      return [];
    }
  }

  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  let versions: string[];
  try {
    versions = fs.readdirSync(versionsDir).filter((name) => /^v\d+/i.test(name));
  } catch {
    return [];
  }
  const preferred = resolveNvmDefaultVersion(home);
  const ordered = preferred && versions.includes(preferred)
    ? [preferred, ...versions.filter((name) => name !== preferred)]
    : versions;
  return ordered.map((name) => path.join(versionsDir, name, 'bin'));
}

/** alias/default 可能是版本号，也可能指向另一个别名（含相对路径），最多 10 跳并防环。 */
function resolveNvmDefaultVersion(home: string): string | null {
  const aliasDir = path.join(home, '.nvm', 'alias');
  const seen = new Set<string>();
  let name = 'default';
  for (let hop = 0; hop < 10; hop += 1) {
    if (seen.has(name)) return null;
    seen.add(name);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(aliasDir, name), 'utf8').trim();
    } catch {
      return null;
    }
    if (!raw) return null;
    if (/^v\d+/i.test(raw)) return raw;
    const base = path.basename(raw);
    if (/^v\d+/i.test(base)) return base;
    // system / node / stable 不指向具体版本，不参与排序。
    if (/[\\/]/.test(raw) || raw === 'system' || raw === 'node' || raw === 'stable') return null;
    name = raw;
  }
  return null;
}

function getFnmDefaultDir(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  const roots: string[] = [];
  if (env.FNM_DIR) roots.push(env.FNM_DIR);
  if (platform === 'win32' && env.APPDATA) roots.push(path.join(env.APPDATA, 'fnm'));
  roots.push(path.join(home, '.fnm'));
  for (const root of roots) {
    const dir = platform === 'win32'
      ? path.join(root, 'aliases', 'default')
      : path.join(root, 'aliases', 'default', 'bin');
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // 继续尝试下一处
    }
  }
  return null;
}

function checkExecutableBits(candidate: string): { runnable: boolean; reason?: string } {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return { runnable: true };
  } catch (error: any) {
    return { runnable: false, reason: error?.code ?? 'EACCES' };
  }
}
