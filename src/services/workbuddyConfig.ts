import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export interface AgentCliConfig {
  executable: string;
  script?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkbenchCliConfigs {
  workbuddy?: AgentCliConfig;
  codex?: AgentCliConfig;
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
});

/**
 * 解析 CB_AGENT_CLI_CONFIG 独立配置文件
 */
export function resolveAgentCliConfigs(): WorkbenchCliConfigs {
  if (process.env.CB_WORKBUDDY_MCP_CONFIG || process.env.CB_WORKBUDDY_BACKEND) {
    throw new Error(
      '检测到已废弃的配置项 CB_WORKBUDDY_MCP_CONFIG / CB_WORKBUDDY_BACKEND。当前工作台已全面采用 Direct CLI 任务分发，请迁移至 CB_AGENT_CLI_CONFIG 独立配置。'
    );
  }

  const configFile = process.env.CB_AGENT_CLI_CONFIG;
  if (configFile) {
    if (!fs.existsSync(configFile)) {
      throw new Error(`CB_AGENT_CLI_CONFIG 指定的配置文件不存在: '${configFile}'`);
    }
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

    return validation.data;
  }

  return {};
}

/**
 * 解析并获取 WorkBuddy CLI 的独立启动配置
 */
export function resolveWorkBuddyCliConfig(): AgentCliConfig {
  const configs = resolveAgentCliConfigs();
  if (configs.workbuddy) {
    const wb = { ...configs.workbuddy };
    wb.env = { ...process.env as Record<string, string>, ...wb.env };
    applyLiteWbBundleDetection(wb);
    return wb;
  }

  // 优先级 2：当前进程显式设置的环境变量 WB_COMMAND / WB_CLI_SCRIPT
  if (process.env.WB_COMMAND || process.env.WB_CLI_SCRIPT) {
    const wb: AgentCliConfig = {
      executable: process.env.WB_COMMAND || process.execPath,
      script: process.env.WB_CLI_SCRIPT,
      env: { ...process.env as Record<string, string> },
    };
    applyLiteWbBundleDetection(wb);
    return wb;
  }

  // 优先级 3：本机已核验的默认安装路径探测
  const defaultScript = 'D:\\CODE\\TOOL\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy';
  if (fs.existsSync(defaultScript)) {
    const wb: AgentCliConfig = {
      executable: process.execPath,
      script: defaultScript,
      env: { ...process.env as Record<string, string> },
    };
    applyLiteWbBundleDetection(wb);
    return wb;
  }

  throw new Error(
    '未找到 WorkBuddy CLI 启动入口。请设置 CB_AGENT_CLI_CONFIG 或 WB_COMMAND / WB_CLI_SCRIPT。'
  );
}

/**
 * 为 lite-only 安装自动打上环境变量标记（不修改全局环境，仅子进程生效）
 */
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

/**
 * 解析并获取 Codex CLI 的独立启动配置
 */
export function resolveCodexCliConfig(): AgentCliConfig {
  const configs = resolveAgentCliConfigs();
  if (configs.codex) {
    return { ...configs.codex, env: { ...process.env as Record<string, string>, ...configs.codex.env } };
  }

  // 检查已知的 Codex 包装脚本与原生路径
  const customCmd = process.env.CODEX_CMD_PATH;
  if (customCmd && fs.existsSync(customCmd)) {
    return resolveCodexExecutableOrNode(customCmd);
  }

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    'codex.cmd',
    'codex',
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return resolveCodexExecutableOrNode(c);
    }
  }

  return { executable: 'codex' };
}

/**
 * Windows 下若为 .cmd 包装器，解析到对应 node.js 脚本以实现 shell: false
 */
function resolveCodexExecutableOrNode(targetPath: string): AgentCliConfig {
  if (targetPath.endsWith('.js')) {
    return {
      executable: process.execPath,
      script: targetPath,
    };
  }

  if (targetPath.endsWith('.cmd')) {
    // 检查是否有平行的 node_modules/@openai/codex/bin/codex.js
    const dir = path.dirname(targetPath);
    const scriptPath = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(scriptPath)) {
      return {
        executable: process.execPath,
        script: scriptPath,
      };
    }
  }

  return { executable: targetPath };
}
