import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveWorkBuddyConfigs } from './workbuddyConfig.ts';
import { WorkBuddyClient } from './workbuddyClient.ts';
import { CodexVerifier } from './codexVerifier.ts';
import { resolveSupportedNode } from '../utils/nodeResolver.js';
import { WORKER_FIXED_MODEL, VERIFIER_DEFAULT_MODEL, ROOT_DIR } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';

export interface CliConfigInfo {
  id: string;
  name: string;
  category: 'agent' | 'verifier' | 'system';
  role: string;
  configured: boolean;
  available: boolean;
  executablePath: string;
  args?: string[];
  version?: string;
  configSource: string;
  defaultModel?: string;
  supportedModels?: string[];
  defaultProbePrompt: string;
  statusMessage?: string;
  environmentPreview?: Record<string, string>;
  extraInfo?: Record<string, any>;
}

export interface CliProbeRequest {
  cliId: string;
  prompt?: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface CliProbeResult {
  ok: boolean;
  cliId: string;
  cliName: string;
  prompt: string;
  output: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
  modelUsed?: string;
  backend?: string;
  sessionId?: string;
  exitCode?: number | null;
  timestamp: string;
  commandPreview?: string;
  verified?: boolean;
}

function safeExec(command: string, args: string[], timeoutMs: number = 3000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, output: (stderr || err.message || '').trim() });
        } else {
          resolve({ ok: true, output: (stdout || '').trim() });
        }
      });
    } catch (e: any) {
      resolve({ ok: false, output: e?.message || String(e) });
    }
  });
}

export class RuntimeService {
  private static instance: RuntimeService;

  static getInstance(): RuntimeService {
    if (!this.instance) {
      this.instance = new RuntimeService();
    }
    return this.instance;
  }

  /**
   * 汇总获取当前工作台已配置和可用的全部 CLI 信息
   */
  async listConfiguredClis(): Promise<CliConfigInfo[]> {
    const list: CliConfigInfo[] = [];

    // 1. WorkBuddy Desktop Bridge
    const wbConfigs = resolveWorkBuddyConfigs();
    const desktopConfig = wbConfigs.desktop;
    const desktopConfigured = Boolean(desktopConfig);
    const desktopExecutable = desktopConfig?.command || 'python';
    const desktopExists = desktopConfig?.command ? fs.existsSync(desktopConfig.command) : false;

    let desktopEnvPreview: Record<string, string> | undefined;
    if (desktopConfig?.env) {
      desktopEnvPreview = {};
      for (const [k, v] of Object.entries(desktopConfig.env)) {
        if (k.startsWith('WORKBUDDY_') || k.startsWith('WB_') || k.startsWith('CODEBUDDY_')) {
          desktopEnvPreview[k] = v;
        }
      }
    }

    list.push({
      id: 'workbuddy-desktop',
      name: 'WorkBuddy Desktop Bridge (桌面直连)',
      category: 'agent',
      role: 'Worker / Reviewer (开发者与审查者)',
      configured: desktopConfigured,
      available: desktopConfigured && (desktopExists || desktopExecutable === 'python'),
      executablePath: desktopExecutable,
      args: desktopConfig?.args || [],
      configSource: process.env.CB_WORKBUDDY_MCP_CONFIG || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml [mcp_servers.workbuddy-desktop]'),
      defaultModel: WORKER_FIXED_MODEL,
      supportedModels: [WORKER_FIXED_MODEL, 'deepseek-chat', 'deepseek-coder'],
      defaultProbePrompt: '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。',
      statusMessage: desktopConfigured ? '已在 Codex / WorkBuddy 配置中声明桌面桥接' : '未检测到桌面桥接配置',
      environmentPreview: desktopEnvPreview,
      extraInfo: {
        backend: 'desktop',
        argsPreview: desktopConfig?.args?.join(' ') || '',
      },
    });

    // 2. WorkBuddy CLI MCP
    const cliConfig = wbConfigs.cli;
    const cliConfigured = Boolean(cliConfig);
    const cliExecutable = cliConfig?.command || 'node';
    const cliScript = cliConfig?.env?.WB_CLI_SCRIPT || '';

    let cliEnvPreview: Record<string, string> | undefined;
    if (cliConfig?.env) {
      cliEnvPreview = {};
      for (const [k, v] of Object.entries(cliConfig.env)) {
        if (k.startsWith('WB_') || k.startsWith('CODEBUDDY_') || k.startsWith('WORKBUDDY_')) {
          cliEnvPreview[k] = v;
        }
      }
    }

    list.push({
      id: 'workbuddy-cli',
      name: 'WorkBuddy CLI MCP (命令行无头服务)',
      category: 'agent',
      role: 'Worker / Reviewer (开发者与审查者)',
      configured: cliConfigured,
      available: cliConfigured && Boolean(cliScript && fs.existsSync(cliScript)),
      executablePath: cliExecutable,
      args: cliConfig?.args || [],
      configSource: process.env.CB_WORKBUDDY_MCP_CONFIG || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml [mcp_servers.workbuddy-cli]'),
      defaultModel: WORKER_FIXED_MODEL,
      supportedModels: [WORKER_FIXED_MODEL, 'deepseek-chat', 'deepseek-coder'],
      defaultProbePrompt: '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。',
      statusMessage: cliConfigured ? `已配置脚本: ${cliScript ? path.basename(cliScript) : '未指定'}` : '未检测到 CLI MCP 配置',
      environmentPreview: cliEnvPreview,
      extraInfo: {
        backend: 'cli',
        scriptPath: cliScript,
      },
    });

    // 3. Codex CLI
    const codexBin = CodexVerifier.resolveCodexExecutable();
    const codexVersionResult = await safeExec(codexBin, ['--version'], 2000);
    const codexAvailable = codexVersionResult.ok;

    list.push({
      id: 'codex',
      name: 'Codex CLI (自动验收者)',
      category: 'verifier',
      role: 'Verifier (只读独立验收与复核)',
      configured: Boolean(codexBin),
      available: codexAvailable,
      executablePath: codexBin,
      version: codexVersionResult.ok ? codexVersionResult.output : undefined,
      configSource: process.env.CODEX_CMD_PATH ? 'CB CODEX_CMD_PATH' : 'System PATH / npm global',
      defaultModel: VERIFIER_DEFAULT_MODEL,
      supportedModels: [VERIFIER_DEFAULT_MODEL, 'gpt-5-turbo', 'o3-mini', 'o1'],
      defaultProbePrompt: '只回复 CODEX_OK，不要多余字符。',
      statusMessage: codexAvailable ? `检测到 Codex CLI (${codexVersionResult.output})` : '未找到可用 Codex CLI 可执行文件',
    });

    // 4. Node.js 运行时
    let nodePath = '';
    try {
      nodePath = resolveSupportedNode();
    } catch {
      nodePath = process.execPath;
    }
    const nodeVersion = process.versions.node;

    list.push({
      id: 'node',
      name: 'Node.js 运行时环境',
      category: 'system',
      role: 'Host / Test Runner (工作台宿主与测试进程)',
      configured: true,
      available: true,
      executablePath: nodePath,
      version: `v${nodeVersion}`,
      configSource: process.env.CB_NODE_PATH ? 'CB_NODE_PATH' : 'nodeResolver (Node 24 / SQLite)',
      defaultProbePrompt: 'console.log("NODE_OK: " + process.version);',
      statusMessage: `Node.js v${nodeVersion} (支持 node:sqlite)`,
    });

    // 5. Git CLI
    const gitVersionResult = await safeExec('git', ['--version'], 2000);
    list.push({
      id: 'git',
      name: 'Git CLI (版本控制工具)',
      category: 'system',
      role: 'VCS (工作区变更与 Diff 生成)',
      configured: gitVersionResult.ok,
      available: gitVersionResult.ok,
      executablePath: 'git',
      version: gitVersionResult.ok ? gitVersionResult.output : undefined,
      configSource: 'System PATH',
      defaultProbePrompt: 'status --short',
      statusMessage: gitVersionResult.ok ? gitVersionResult.output : 'Git 命令行未安装或不可达',
    });

    return list;
  }

  /**
   * 使用简单提示词对指定 CLI 发起可用性探测
   */
  async probeCli(params: CliProbeRequest): Promise<CliProbeResult> {
    const startTime = Date.now();
    const cliId = params.cliId;
    const targetCwd = params.cwd && fs.existsSync(params.cwd) ? params.cwd : ROOT_DIR;
    const timeoutMs = Math.min(Math.max(params.timeoutMs || 30000, 3000), 120000);
    const timestamp = new Date().toISOString();

    logger.info(`[RuntimeService] Probing CLI '${cliId}' with prompt: "${(params.prompt || '').slice(0, 50)}..."`);

    // 1. WorkBuddy Desktop / CLI / auto probe
    if (cliId === 'workbuddy-desktop' || cliId === 'workbuddy-cli' || cliId === 'workbuddy') {
      const targetBackend = cliId === 'workbuddy-desktop' ? 'desktop' : cliId === 'workbuddy-cli' ? 'cli' : undefined;
      const originalBackendEnv = process.env.CB_WORKBUDDY_BACKEND;

      if (targetBackend) {
        process.env.CB_WORKBUDDY_BACKEND = targetBackend;
      }

      const prompt = params.prompt?.trim() || '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。';
      const model = params.model || WORKER_FIXED_MODEL;

      try {
        const result = await WorkBuddyClient.runTask({
          taskId: `probe-${cliId}-${Date.now()}`,
          prompt,
          cwd: targetCwd,
          model,
          timeoutMs,
        });

        const verified = result.ok && (result.output.trim() === 'WB_ADAPTER_OK' || result.output.length > 0);
        return {
          ok: result.ok,
          cliId,
          cliName: cliId === 'workbuddy-desktop' ? 'WorkBuddy Desktop' : cliId === 'workbuddy-cli' ? 'WorkBuddy CLI' : 'WorkBuddy',
          prompt,
          output: result.output || '',
          error: result.error,
          errorCode: result.errorCode,
          durationMs: Date.now() - startTime,
          modelUsed: model,
          backend: result.backend,
          sessionId: result.sessionId,
          timestamp,
          verified,
          commandPreview: `WorkBuddy ${result.backend || targetBackend || 'auto'} [${model}]`,
        };
      } finally {
        if (targetBackend) {
          if (originalBackendEnv !== undefined) {
            process.env.CB_WORKBUDDY_BACKEND = originalBackendEnv;
          } else {
            delete process.env.CB_WORKBUDDY_BACKEND;
          }
        }
      }
    }

    // 2. Codex CLI probe
    if (cliId === 'codex') {
      const prompt = params.prompt?.trim() || '只回复 CODEX_OK，不要多余字符。';
      const model = params.model || VERIFIER_DEFAULT_MODEL;

      if (process.env.CB_MOCK_CODEX === 'true') {
        return {
          ok: true,
          cliId,
          cliName: 'Codex CLI (Mock)',
          prompt,
          output: 'CODEX_OK (Simulated mock response)',
          durationMs: Date.now() - startTime,
          modelUsed: model,
          timestamp,
          verified: true,
          commandPreview: `codex exec -m ${model} -s read-only -`,
        };
      }

      const codexBin = CodexVerifier.resolveCodexExecutable();
      return new Promise<CliProbeResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const child = spawn(
          codexBin,
          ['exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', targetCwd, '-'],
          {
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          }
        );

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
              child.kill('SIGKILL');
            }
          } catch {}
        }, timeoutMs);

        child.stdout.on('data', (d) => {
          stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d) => {
          stderr += d.toString('utf8');
        });

        // Write prompt to stdin and close
        child.stdin.write(prompt, 'utf8');
        child.stdin.end();

        child.on('close', (code) => {
          clearTimeout(timer);
          const durationMs = Date.now() - startTime;
          const cleanOutput = stdout.trim();
          const cleanErr = stderr.trim();

          const ok = code === 0 && !timedOut;
          resolve({
            ok,
            cliId,
            cliName: 'Codex CLI',
            prompt,
            output: cleanOutput || (ok ? 'CODEX_OK' : ''),
            error: timedOut ? `Codex CLI 超时 (${timeoutMs}ms)` : !ok ? (cleanErr || cleanOutput || `Exit code ${code}`) : undefined,
            exitCode: code,
            durationMs,
            modelUsed: model,
            timestamp,
            verified: ok && (cleanOutput.includes('CODEX_OK') || cleanOutput.length > 0),
            commandPreview: `${codexBin} exec -m ${model} -s read-only`,
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            cliId,
            cliName: 'Codex CLI',
            prompt,
            output: '',
            error: err.message,
            durationMs: Date.now() - startTime,
            modelUsed: model,
            timestamp,
            verified: false,
            commandPreview: `${codexBin} exec`,
          });
        });
      });
    }

    // 3. Node.js runtime probe
    if (cliId === 'node') {
      const prompt = params.prompt?.trim() || 'console.log("NODE_OK: " + process.version);';
      const nodePath = resolveSupportedNode();

      return new Promise<CliProbeResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(nodePath, ['-e', prompt], {
          cwd: targetCwd,
          windowsHide: true,
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));

        child.on('close', (code) => {
          clearTimeout(timer);
          const durationMs = Date.now() - startTime;
          const ok = code === 0;
          resolve({
            ok,
            cliId,
            cliName: 'Node.js 运行时',
            prompt,
            output: stdout.trim(),
            error: ok ? undefined : (stderr.trim() || `Exit code ${code}`),
            exitCode: code,
            durationMs,
            timestamp,
            verified: ok,
            commandPreview: `${nodePath} -e "${prompt.slice(0, 30)}..."`,
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            cliId,
            cliName: 'Node.js 运行时',
            prompt,
            output: '',
            error: err.message,
            durationMs: Date.now() - startTime,
            timestamp,
            verified: false,
          });
        });
      });
    }

    // 4. Git CLI probe
    if (cliId === 'git') {
      const prompt = params.prompt?.trim() || 'status --short';
      const args = prompt.split(/\s+/).filter(Boolean);

      return new Promise<CliProbeResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn('git', args, {
          cwd: targetCwd,
          windowsHide: true,
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));

        child.on('close', (code) => {
          clearTimeout(timer);
          const durationMs = Date.now() - startTime;
          const ok = code === 0;
          resolve({
            ok,
            cliId,
            cliName: 'Git CLI',
            prompt,
            output: stdout.trim() || (ok ? '(Git clean status / output)' : ''),
            error: ok ? undefined : (stderr.trim() || `Exit code ${code}`),
            exitCode: code,
            durationMs,
            timestamp,
            verified: ok,
            commandPreview: `git ${args.join(' ')}`,
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            cliId,
            cliName: 'Git CLI',
            prompt,
            output: '',
            error: err.message,
            durationMs: Date.now() - startTime,
            timestamp,
            verified: false,
          });
        });
      });
    }

    throw new Error(`Unsupported CLI id for probe: '${cliId}'`);
  }
}

export const runtimeService = RuntimeService.getInstance();
