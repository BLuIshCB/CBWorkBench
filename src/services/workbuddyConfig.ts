import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type WorkBuddyBackend = 'desktop' | 'cli';
const serverSchema = z.object({
  command: z.string().min(1), args: z.array(z.string()).default([]),
  cwd: z.string().optional(), env: z.record(z.string()).default({}),
  enabled: z.boolean().optional(),
});
export type WorkBuddyServerConfig = z.infer<typeof serverSchema>;
export type WorkBuddyConfigs = Partial<Record<WorkBuddyBackend, WorkBuddyServerConfig>>;

/** 只读取指定 MCP 表，避免从其他服务误取 server.js 或环境变量。 */
export function parseWorkBuddyToml(content: string): WorkBuddyConfigs {
  const result: Record<string, any> = {};
  let backend = '';
  let isEnv = false;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('[')) {
      const table = line.match(/^\[mcp_servers\.(?:"workbuddy-(desktop|cli)"|workbuddy-(desktop|cli))(\.env)?\]\s*(?:#.*)?$/);
      backend = table ? table[1] || table[2] : '';
      isEnv = !!table?.[3];
      if (backend) result[backend] ??= { env: {} };
      continue;
    }
    if (!backend || !line || line.startsWith('#')) continue;
    const entry = line.match(/^("[^"\r\n]+"|[\w-]+)\s*=\s*(.*)$/);
    if (!entry) throw new Error(`Unsupported WorkBuddy MCP configuration at line ${i + 1}`);
    const key = entry[1].replace(/^"|"$/g, '');
    if (!isEnv && !['command', 'args', 'cwd', 'enabled'].includes(key)) continue;
    let value = entry[2];
    if (value.trimStart().startsWith('[')) {
      while (!/\]\s*(?:#.*)?$/.test(value) && i + 1 < lines.length) value += '\n' + lines[++i];
    }
    const parsed = parseValue(value);
    if (isEnv) result[backend].env[key] = parsed;
    else result[backend][key] = parsed;
  }
  const configs: WorkBuddyConfigs = {};
  for (const backend of ['desktop', 'cli'] as const) {
    if (result[backend] && result[backend].enabled !== false) configs[backend] = serverSchema.parse(result[backend]);
  }
  return configs;
}

// MCP 启动配置只需要字符串、字符串数组和 enabled；其他 TOML 语法显式报错。
function parseValue(value: string): unknown {
  let offset = 0;
  const skip = () => {
    while (offset < value.length) {
      if (/\s/.test(value[offset])) offset++;
      else if (value[offset] === '#') {
        while (offset < value.length && value[offset] !== '\n') offset++;
      } else break;
    }
  };
  const string = () => {
    skip();
    const quote = value[offset++];
    if (quote !== '"' && quote !== "'") throw new Error('Expected a quoted WorkBuddy MCP string');
    let text = '';
    while (offset < value.length) {
      const char = value[offset++];
      if (char === quote) return text;
      if (char === '\\' && quote === '"') {
        const escape = value[offset++];
        const escapes: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (escape === 'u' || escape === 'U') {
          const length = escape === 'u' ? 4 : 8;
          const hex = value.slice(offset, offset + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Error('Invalid TOML unicode escape');
          text += String.fromCodePoint(parseInt(hex, 16)); offset += length;
        } else if (escape in escapes) text += escapes[escape];
        else throw new Error('Invalid TOML string escape in WorkBuddy MCP configuration');
      } else text += char;
    }
    throw new Error('Unterminated WorkBuddy MCP string');
  };
  skip();
  let parsed: unknown;
  if (value[offset] === '[') {
    offset++; const args: string[] = []; skip();
    while (value[offset] !== ']') {
      args.push(string()); skip();
      if (value[offset] === ',') { offset++; skip(); }
      else if (value[offset] !== ']') throw new Error('Invalid WorkBuddy MCP args array');
    }
    offset++; parsed = args;
  } else if (/^(true|false)\b/.test(value.slice(offset))) {
    parsed = value.slice(offset).startsWith('true'); offset += parsed ? 4 : 5;
  } else parsed = string();
  skip();
  if (offset !== value.length) throw new Error('Unsupported WorkBuddy MCP configuration value');
  return parsed;
}

/** 每次调用重新读取配置，登录和配置修复后不必清理静态缓存。 */
export function resolveWorkBuddyConfigs(): WorkBuddyConfigs {
  const configPath = process.env.CB_WORKBUDDY_MCP_CONFIG;
  let configs: WorkBuddyConfigs;
  if (configPath) {
    configs = z.object({ desktop: serverSchema.optional(), cli: serverSchema.optional() })
      .parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } else {
    const codexConfig = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    configs = fs.existsSync(codexConfig) ? parseWorkBuddyToml(fs.readFileSync(codexConfig, 'utf8')) : {};
  }
  for (const backend of ['desktop', 'cli'] as const) {
    const config = configs[backend];
    if (!config || config.enabled === false) { delete configs[backend]; continue; }
    config.env = { ...process.env as Record<string, string>, ...config.env };
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(WB_|WORKBUDDY_|CODEBUDDY_)/.test(key) && value !== undefined) config.env[key] = value;
    }
    const cliScript = config.env.WB_CLI_SCRIPT;
    if (backend === 'cli' && cliScript && !config.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE) {
      const dist = path.resolve(path.dirname(cliScript), '..', 'dist');
      if (fs.existsSync(path.join(dist, 'codebuddy-lite-wb.mjs')) && !fs.existsSync(path.join(dist, 'codebuddy-headless.js'))) {
        config.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
      }
    }
    if (backend === 'desktop' && process.env.CB_WORKBUDDY_IDLE_COMPAT !== 'false') {
      const launcherIndex = config.args.findIndex(arg => path.basename(arg) === 'launch.py');
      const root = launcherIndex >= 0 ? path.dirname(config.args[launcherIndex]) : '';
      if (root && fs.existsSync(path.join(root, 'workbuddy_bridge', 'acp.py'))) {
        config.args = [...config.args.slice(0, launcherIndex), fileURLToPath(new URL('../../bin/workbuddy-desktop-bridge.py', import.meta.url)), '--bridge-root', root];
      }
    }
  }
  return configs;
}
