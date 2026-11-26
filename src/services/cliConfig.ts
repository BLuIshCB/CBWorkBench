import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR, ROOT_DIR } from '../config/constants.ts';
import {
  declareCli,
  discoverCli,
  discoverCliAsync,
  getDiscoveryDiagnostics,
  type CliDeclaration,
  type DiscoveryResult,
  type DiscoverySource,
} from './cliDiscovery.ts';
import { getHydrationState } from './shellPath.ts';

export type { CliDeclaration, DiscoveryCandidate, DiscoveryResult, DiscoverySource } from './cliDiscovery.ts';

export interface AgentCliConfig {
  discoverySource?: DiscoverySource;
  executable: string;
  script?: string;
  /** Windows 下只有 .cmd/.bat 且无配对脚本时，执行期用 cmd.exe 包裹 */
  needsShellWrap?: boolean;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkbenchCliConfigs {
  workbuddy?: AgentCliConfig;
  codex?: AgentCliConfig;
  antigravity?: AgentCliConfig;
}

const agentCliSchema = z.object({
  executable: z.string().min(1, 'executable 不能为空'),
  script: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const workbenchCliConfigsSchema = z.object({
  workbuddy: agentCliSchema.optional(),
  codex: agentCliSchema.optional(),
  antigravity: agentCliSchema.optional(),
});

const RESOLVE_CACHE_TTL_MS = 30000;

/** 三个 adapter 的唯一 CLI 声明：探测层不出现任何具体 CLI 名字，名字只在这里出现一次。 */
export const CLI_DECLARATIONS: Record<string, CliDeclaration> = {
  codex: declareCli({
    id: 'codex',
    commands: ['codex'],
    requiredCommands: ['node'],
    explicitEnv: ['CODEX_CMD_PATH'],
    scriptRelativePath: '@openai/codex/bin/codex.js',
    requiredFlags: ['--json', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    extraInstallDirs: (home) => [
      path.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin'),
      path.join(ROOT_DIR, 'data', 'runtimes', 'native', 'node_modules', '.bin'),
    ],
  }),
  workbuddy: declareCli({
    id: 'workbuddy',
    commands: ['codebuddy'],
    requiredCommands: ['node'],
    explicitEnv: ['WB_COMMAND', 'WB_CLI_SCRIPT'],
    // WB_COMMAND 与 WB_CLI_SCRIPT 共同构成一个入口，不能当成两个独立的可执行路径。
    envEntry: (env) => {
      if (!env.WB_COMMAND && !env.WB_CLI_SCRIPT) return undefined;
      return { executable: env.WB_COMMAND || process.execPath, script: env.WB_CLI_SCRIPT };
    },
    scriptRelativePath: '@tencent-ai/codebuddy-code/bin/codebuddy',
    extraInstallDirs: (home) => [
      path.join(home, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'bin'),
      path.join(home, '.workbuddy', 'bin'),
      path.join(ROOT_DIR, 'data', 'runtimes', 'native', 'node_modules', '.bin'),
    ],
    baseEnv: () => ({
      CODEBUDDY_CONFIG_DIR: path.join(DATA_DIR, 'workbuddy-cli'),
      ACC_PRODUCT_CONFIG_PATH: path.join(DATA_DIR, 'runtimes', 'workbuddy-product.json'),
    }),
  }),
  antigravity: declareCli({
    id: 'antigravity',
    commands: ['agy'],
    explicitEnv: ['ANTIGRAVITY_CLI_PATH'],
    extraInstallDirs: (home) => [
      path.join(home, 'AppData', 'Local', 'agy', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(ROOT_DIR, 'data', 'runtimes', 'antigravity'),
    ],
  }),
};

interface CachedResolution {
  signature: string;
  config: AgentCliConfig;
  discovery: DiscoveryResult;
  expiresAt: number;
}

const resolutionCache = new Map<string, CachedResolution>();
const inFlight = new Map<string, Promise<{ config: AgentCliConfig; discovery: DiscoveryResult }>>();
let configsCache: { key: string; data: WorkbenchCliConfigs } | null = null;
/** 清缓存时递增，避免清空后仍把清空前发起的探测结果写回缓存。 */
let cacheEpoch = 0;

export function resolveAgentCliConfigPath(): string {
  return process.env.CB_AGENT_CLI_CONFIG || path.join(ROOT_DIR, 'data', 'agent-cli.json');
}

/** 解析 CB_AGENT_CLI_CONFIG 独立配置文件；文件未变更时不再重复 parse。 */
export function resolveAgentCliConfigs(): WorkbenchCliConfigs {
  const configFile = resolveAgentCliConfigPath();
  if (!process.env.CB_AGENT_CLI_CONFIG && !fs.existsSync(configFile)) return {};
  if (!fs.existsSync(configFile)) {
    throw new Error(`CB_AGENT_CLI_CONFIG 指定的配置文件不存在: '${configFile}'`);
  }

  const stat = fs.statSync(configFile);
  const cacheKey = `${configFile}|${stat.mtimeMs}|${stat.size}`;
  if (configsCache?.key === cacheKey) return configsCache.data;

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configFile, 'utf8');
  } catch (err: any) {
    throw new Error(`无法读取 CB_AGENT_CLI_CONFIG 配置文件: ${err.message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (err: any) {
    throw new Error(`CB_AGENT_CLI_CONFIG 配置文件包含无效 JSON: ${err.message}`);
  }

  const validation = workbenchCliConfigsSchema.safeParse(parsedJson);
  if (!validation.success) {
    throw new Error(`CB_AGENT_CLI_CONFIG 配置格式不符合规范: ${validation.error.message}`);
  }

  configsCache = { key: cacheKey, data: validation.data };
  return validation.data;
}

export function resolveDeclaredCli(declaration: CliDeclaration): { config: AgentCliConfig; discovery: DiscoveryResult } {
  const signature = cacheSignature();
  const cached = readResolutionCache(declaration.id, signature);
  if (cached) return cached;
  const stale = resolutionCache.get(declaration.id);
  // 配置或 PATH 变了必须同步重扫；只是 TTL 过期时先返回旧值，后台刷新。
  if (stale && stale.signature === signature) {
    void resolveDeclaredCliAsync(declaration).catch(() => {});
    return { config: stale.config, discovery: stale.discovery };
  }
  const discovery = discoverCli(declaration, { explicitConfig: readExplicitConfig(declaration.id) });
  return cacheResolution(declaration, signature, discovery);
}

export async function resolveDeclaredCliAsync(
  declaration: CliDeclaration,
): Promise<{ config: AgentCliConfig; discovery: DiscoveryResult }> {
  const signature = cacheSignature();
  const cached = readResolutionCache(declaration.id, signature);
  if (cached) return cached;
  // 并发请求共享同一次探测，避免冷启动时重复扫 PATH
  const pending = inFlight.get(declaration.id);
  if (pending) return pending;

  const epoch = cacheEpoch;
  const task = discoverCliAsync(declaration, { explicitConfig: readExplicitConfig(declaration.id) })
    .then((discovery) => (epoch === cacheEpoch
      ? cacheResolution(declaration, signature, discovery)
      : { config: toAgentCliConfig(declaration, discovery), discovery }));
  inFlight.set(declaration.id, task);
  try {
    return await task;
  } finally {
    inFlight.delete(declaration.id);
  }
}

export function resolveDeclaredCliConfig(declaration: CliDeclaration): AgentCliConfig {
  return resolveDeclaredCli(declaration).config;
}

export function resolveDeclaredCliDiscovery(declaration: CliDeclaration): DiscoveryResult {
  return resolveDeclaredCli(declaration).discovery;
}

/** 配置写入、PATH 重探后必须清空，避免下一次读到旧入口。 */
export function invalidateCliConfigCache(): void {
  cacheEpoch += 1;
  resolutionCache.clear();
  configsCache = null;
  inFlight.clear();
}

function readResolutionCache(id: string, signature: string): { config: AgentCliConfig; discovery: DiscoveryResult } | null {
  const cached = resolutionCache.get(id);
  if (!cached) return null;
  if (cached.signature !== signature || cached.expiresAt <= Date.now()) return null;
  return { config: cached.config, discovery: cached.discovery };
}

function cacheResolution(
  declaration: CliDeclaration,
  signature: string,
  discovery: DiscoveryResult,
): { config: AgentCliConfig; discovery: DiscoveryResult } {
  const config = toAgentCliConfig(declaration, discovery);
  resolutionCache.set(declaration.id, {
    signature,
    config,
    discovery,
    expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS,
  });
  return { config, discovery };
}

export function diagnoseCli(declaration: CliDeclaration): DiscoveryResult {
  return getDiscoveryDiagnostics(declaration, { explicitConfig: readExplicitConfig(declaration.id) });
}

/** 解析并获取 WorkBuddy CLI 的独立启动配置 */
export function resolveWorkBuddyCliConfig(): AgentCliConfig {
  const config = resolveDeclaredCliConfig(CLI_DECLARATIONS.workbuddy);
  applyLiteWbBundleDetection(config);
  return config;
}

/** 解析并获取 Codex CLI 的独立启动配置 */
export function resolveCodexCliConfig(): AgentCliConfig {
  return resolveDeclaredCliConfig(CLI_DECLARATIONS.codex);
}

/** agy 是独立 CLI，不能用 Antigravity.exe 或 IDE 的启动命令代替。 */
export function resolveAntigravityCliConfig(): AgentCliConfig {
  return resolveDeclaredCliConfig(CLI_DECLARATIONS.antigravity);
}

/** 交互登录与非交互调用必须使用完全相同的入口及配置。 */
export function resolveCliConfig(id: string): AgentCliConfig {
  const declaration = CLI_DECLARATIONS[id];
  if (!declaration) throw new Error(`未知 CLI: ${id}`);
  if (id === 'workbuddy') return resolveWorkBuddyCliConfig();
  return resolveDeclaredCliConfig(declaration);
}

/** 为 lite-only 安装自动打上环境变量标记（不修改全局环境，仅子进程生效） */
function applyLiteWbBundleDetection(config: AgentCliConfig): void {
  if (!config.script) return;
  config.env ??= {};
  if (config.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE) return;

  try {
    const dist = path.resolve(path.dirname(config.script), '..', 'dist');
    if (
      fs.existsSync(path.join(dist, 'codebuddy-lite-wb.mjs')) &&
      !fs.existsSync(path.join(dist, 'codebuddy-headless.js'))
    ) {
      config.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
    }
  } catch {}
}

function readExplicitConfig(id: string): { executable: string; script?: string } | undefined {
  const configs = resolveAgentCliConfigs();
  const item = configs[id as keyof WorkbenchCliConfigs];
  if (!item) return undefined;
  return { executable: item.executable, script: item.script };
}

function toAgentCliConfig(declaration: CliDeclaration, discovery: DiscoveryResult): AgentCliConfig {
  const fileConfig = resolveAgentCliConfigs()[declaration.id as keyof WorkbenchCliConfigs] ?? {};
  const baseEnv = declaration.baseEnv?.({ home: os.homedir(), rootDir: ROOT_DIR, dataDir: DATA_DIR }) ?? {};
  const config: AgentCliConfig = {
    executable: discovery.executable,
    script: discovery.script,
    needsShellWrap: discovery.needsShellWrap,
    args: fileConfig.args,
    cwd: fileConfig.cwd,
    discoverySource: discovery.source,
    env: { ...(process.env as Record<string, string>), ...baseEnv, ...fileConfig.env },
  };
  return config;
}

/** 缓存签名含配置文件的 mtime/size 与水合版本号：文件被改、PATH 被水合都会自然失效。 */
function cacheSignature(): string {
  const configFile = resolveAgentCliConfigPath();
  let stamp = 'missing';
  try {
    const stat = fs.statSync(configFile);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {}
  return `${process.env.CB_AGENT_CLI_CONFIG ?? ''}|${configFile}|${stamp}|${getHydrationState().version}`;
}
