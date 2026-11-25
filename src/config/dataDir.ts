import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface CliRuntimeArgs {
  dataDir?: string;
  portable: boolean;
  serverUrl?: string;
  port?: number;
  host?: string;
  noOpen: boolean;
  help: boolean;
}

export interface InstanceMetadata {
  instance_id: string;
  created_at: number;
  protocol_version: string;
}

export interface ActiveServerInfo {
  instance_id: string;
  data_dir: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  started_at: number;
  has_active_ui?: boolean;
  last_browser_opened_at?: number;
}

export interface ResolvedDataDir {
  dataDir: string;
  source: 'cli' | 'env' | 'portable' | 'default';
  isExe: boolean;
  instance: InstanceMetadata;
  legacyDataPath: string | null;
}

export class DataDirConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DataDirConfigError';
    this.code = code;
  }
}

export function isStandaloneExe(): boolean {
  if (process.env.CB_SEA_EXE === 'true') return true;
  try {
    const sea = nodeRequire('node:sea');
    return Boolean(sea && typeof sea.isSea === 'function' && sea.isSea());
  } catch {
    return false;
  }
}

export function parseCliRuntimeArgs(argv: string[] = process.argv.slice(2)): CliRuntimeArgs {
  const result: CliRuntimeArgs = {
    portable: false,
    noOpen: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--portable') {
      result.portable = true;
    } else if (arg === '--no-open') {
      result.noOpen = true;
    } else if (arg === '--data-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new DataDirConfigError('INVALID_DATA_DIR', '--data-dir 必须提供绝对目录路径');
      }
      result.dataDir = next;
      i++;
    } else if (arg.startsWith('--data-dir=')) {
      const val = arg.slice('--data-dir='.length);
      if (!val) {
        throw new DataDirConfigError('INVALID_DATA_DIR', '--data-dir 必须提供绝对目录路径');
      }
      result.dataDir = val;
    } else if (arg === '--server-url') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new DataDirConfigError('INVALID_SERVER_URL', '--server-url 必须提供后台服务地址');
      }
      result.serverUrl = next;
      i++;
    } else if (arg.startsWith('--server-url=')) {
      result.serverUrl = arg.slice('--server-url='.length);
    } else if (arg === '--port' && argv[i + 1]) {
      result.port = Number(argv[i + 1]);
      i++;
    } else if (arg === '--host' && argv[i + 1]) {
      result.host = argv[i + 1];
      i++;
    }
  }

  return result;
}

function assertWritableDir(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      throw new DataDirConfigError('DATA_DIR_NOT_WRITABLE', `数据目录路径不是文件夹: ${dirPath}`);
    }
    const probe = path.join(dirPath, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err: any) {
    if (err instanceof DataDirConfigError) throw err;
    throw new DataDirConfigError('DATA_DIR_NOT_WRITABLE', `数据目录不可写 (${dirPath}): ${err?.message || err}`);
  }
}

export function ensureInstanceMetadata(dataDir: string): InstanceMetadata {
  const instanceFile = path.join(dataDir, 'instance.json');
  if (fs.existsSync(instanceFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
      if (raw && typeof raw.instance_id === 'string' && raw.instance_id.trim()) {
        return {
          instance_id: raw.instance_id.trim(),
          created_at: typeof raw.created_at === 'number' ? raw.created_at : Date.now(),
          protocol_version: typeof raw.protocol_version === 'string' ? raw.protocol_version : 'cb.task-package/2.0',
        };
      }
    } catch (err: any) {
      throw new DataDirConfigError('INSTANCE_METADATA_CORRUPT', `实例标识文件损坏 (${instanceFile}): ${err?.message || err}`);
    }
  }

  const metadata: InstanceMetadata = {
    instance_id: crypto.randomUUID(),
    created_at: Date.now(),
    protocol_version: 'cb.task-package/2.0',
  };
  const tmpFile = `${instanceFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmpFile, instanceFile);
  } catch {
    if (!fs.existsSync(instanceFile)) {
      fs.writeFileSync(instanceFile, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
    }
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  if (fs.existsSync(instanceFile)) {
    const confirmed = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    return confirmed as InstanceMetadata;
  }
  return metadata;
}

export function resolveDataDirConfig(options?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  isExe?: boolean;
  execPath?: string;
  rootDir?: string;
}): ResolvedDataDir {
  const env = options?.env ?? process.env;
  const args = parseCliRuntimeArgs(options?.argv ?? process.argv.slice(2));
  const isExe = options?.isExe ?? isStandaloneExe();
  const execPath = options?.execPath ?? process.execPath;

  const envDataDir = env.CB_DATA_DIR?.trim() || undefined;
  const cliDataDir = args.dataDir?.trim() || undefined;

  if (args.portable && (cliDataDir || envDataDir)) {
    throw new DataDirConfigError(
      'DATA_DIR_CONFLICT',
      '不能同时使用 --portable 便携模式与 --data-dir / CB_DATA_DIR 显式数据目录配置'
    );
  }

  let dataDir: string;
  let source: ResolvedDataDir['source'];

  if (args.portable) {
    if (!isExe) {
      throw new DataDirConfigError(
        'PORTABLE_NOT_ALLOWED_IN_SOURCE',
        '源码运行模式不支持 --portable，请仅在独立 EXE 中使用或改用 --data-dir'
      );
    }
    dataDir = path.resolve(path.dirname(execPath), 'data');
    source = 'portable';
  } else if (cliDataDir) {
    if (!path.isAbsolute(cliDataDir)) {
      throw new DataDirConfigError('INVALID_DATA_DIR', `--data-dir 必须为绝对路径，当前收到: ${cliDataDir}`);
    }
    dataDir = path.resolve(cliDataDir);
    source = 'cli';
  } else if (envDataDir) {
    if (!path.isAbsolute(envDataDir)) {
      throw new DataDirConfigError('INVALID_DATA_DIR', `CB_DATA_DIR 必须为绝对路径，当前收到: ${envDataDir}`);
    }
    dataDir = path.resolve(envDataDir);
    source = 'env';
  } else {
    source = 'default';
    if (process.platform === 'win32') {
      const localAppData = env.LOCALAPPDATA?.trim();
      if (!localAppData || !path.isAbsolute(localAppData)) {
        throw new DataDirConfigError(
          'DATA_DIR_UNRESOLVED',
          '无法解析系统 LOCALAPPDATA 目录，请显式指定 --data-dir <绝对路径> 或设置 CB_DATA_DIR'
        );
      }
      dataDir = path.join(path.resolve(localAppData), 'CBWorkBench', 'data');
    } else {
      const base = env.XDG_DATA_HOME?.trim() || (env.HOME?.trim() ? path.join(env.HOME.trim(), '.local', 'share') : '');
      if (!base || !path.isAbsolute(base)) {
        throw new DataDirConfigError(
          'DATA_DIR_UNRESOLVED',
          '无法解析默认用户应用数据目录，请显式指定 --data-dir <绝对路径> 或设置 CB_DATA_DIR'
        );
      }
      dataDir = path.join(path.resolve(base), 'CBWorkBench', 'data');
    }
  }

  assertWritableDir(dataDir);
  const instance = ensureInstanceMetadata(dataDir);

  let legacyDataPath: string | null = null;
  if (options?.rootDir) {
    const candidateLegacy = path.join(options.rootDir, 'data');
    if (path.resolve(candidateLegacy).toLowerCase() !== path.resolve(dataDir).toLowerCase()) {
      if (fs.existsSync(path.join(candidateLegacy, 'workbench.db'))) {
        legacyDataPath = candidateLegacy;
      }
    }
  }

  return { dataDir, source, isExe, instance, legacyDataPath };
}

export function getServerInfoPath(dataDir: string): string {
  return path.join(dataDir, 'server.json');
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readServerInfoFile(dataDir: string): ActiveServerInfo | null {
  const p = getServerInfoPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.url === 'string' && typeof parsed.instance_id === 'string') {
      return parsed as ActiveServerInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeServerInfoFile(dataDir: string, info: ActiveServerInfo): void {
  const p = getServerInfoPath(dataDir);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

export function removeServerInfoFile(dataDir: string, expectedPid?: number): void {
  const p = getServerInfoPath(dataDir);
  if (!fs.existsSync(p)) return;
  try {
    if (expectedPid !== undefined) {
      const current = readServerInfoFile(dataDir);
      if (current && current.pid !== expectedPid) return;
    }
    fs.unlinkSync(p);
  } catch {}
}

export async function fetchRemoteInstanceInfo(serverUrl: string, timeoutMs: number = 2500): Promise<{
  instance_id: string;
  data_dir: string;
  pid: number;
  host: string;
  port: number;
  has_active_ui?: boolean;
  last_browser_opened_at?: number;
} | null> {
  const normalized = serverUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${normalized}/api/system/instance`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data?.success || !data.instance_id || !data.data_dir) return null;
    return {
      instance_id: String(data.instance_id),
      data_dir: String(data.data_dir),
      pid: Number(data.pid),
      host: String(data.host),
      port: Number(data.port),
      has_active_ui: typeof data.has_active_ui === 'boolean' ? data.has_active_ui : undefined,
      last_browser_opened_at: typeof data.last_browser_opened_at === 'number' ? data.last_browser_opened_at : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveResidentServerForDataDir(dataDir: string, instanceId: string): Promise<ActiveServerInfo | null> {
  const info = readServerInfoFile(dataDir);
  if (!info) return null;
  if (!isPidAlive(info.pid)) {
    removeServerInfoFile(dataDir, info.pid);
    return null;
  }
  const remote = await fetchRemoteInstanceInfo(info.url);
  if (!remote) {
    return null;
  }
  if (remote.instance_id !== instanceId || path.resolve(remote.data_dir).toLowerCase() !== path.resolve(dataDir).toLowerCase()) {
    throw new DataDirConfigError(
      'INSTANCE_MISMATCH',
      `后台服务实例与当前数据目录不一致: 后台(${remote.instance_id}, ${remote.data_dir}) != 本地(${instanceId}, ${dataDir})`
    );
  }
  return {
    ...info,
    has_active_ui: remote.has_active_ui,
    last_browser_opened_at: remote.last_browser_opened_at,
  };
}

export async function assertServerMatchesLocalInstance(
  serverUrl: string,
  localDataDir: string,
  localInstanceId: string
): Promise<{ instance_id: string; data_dir: string; url: string }> {
  const normalized = serverUrl.replace(/\/+$/, '');
  const remote = await fetchRemoteInstanceInfo(normalized);
  if (!remote) {
    throw new DataDirConfigError('SERVER_UNREACHABLE', `无法连接到指定工作台后台服务: ${normalized}`);
  }
  const sameDir = path.resolve(remote.data_dir).toLowerCase() === path.resolve(localDataDir).toLowerCase();
  if (remote.instance_id !== localInstanceId || !sameDir) {
    throw new DataDirConfigError(
      'INSTANCE_MISMATCH',
      `MCP 实例与工作台后台实例不一致！后台实例: (${remote.instance_id}, ${remote.data_dir})，MCP 实例: (${localInstanceId}, ${localDataDir})`
    );
  }
  return { instance_id: remote.instance_id, data_dir: remote.data_dir, url: normalized };
}
