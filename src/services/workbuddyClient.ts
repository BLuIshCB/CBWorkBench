import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WORKER_FIXED_MODEL, DEFAULT_WORKER_TIMEOUT_MS } from '../config/constants.ts';
import { logger } from '../utils/logger.ts';
import { resolveSupportedNode } from '../utils/nodeResolver.js';

export interface WorkerExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
  timedOut?: boolean;
}

export class WorkBuddyClient {
  private static resolvedConfig: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
  } | null = null;

  private static activeTransport: StdioClientTransport | null = null;
  private static stopRequested: boolean = false;

  /**
   * Resolves the startup configuration for the WorkBuddy MCP server.
   * Auto-detects from ~/.codex/config.toml or local known paths.
   */
  static resolveMcpServerConfig(): {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
  } {
    if (this.resolvedConfig) {
      return this.resolvedConfig;
    }

    const home = os.homedir();
    const nodeExec = resolveSupportedNode();

    // Default fallback config
    let serverScript = path.join(home, 'Documents', 'Codex', 'integrations', 'workbuddy-mcp', 'server.js');
    let cliScript = 'D:\\CODE\\TOOL\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy';
    let configDir = path.join(home, '.workbuddy');
    let workDir = path.join(home, 'Documents', 'Codex', 'WorkBuddyTasks');

    // Attempt to read ~/.codex/config.toml if present
    const codexConfigToml = path.join(home, '.codex', 'config.toml');
    if (fs.existsSync(codexConfigToml)) {
      try {
        const tomlContent = fs.readFileSync(codexConfigToml, 'utf8');
        const scriptMatch = tomlContent.match(/args\s*=\s*\[.*?"([^"]*server\.js)"/);
        if (scriptMatch && fs.existsSync(scriptMatch[1])) {
          serverScript = scriptMatch[1];
        }
        const cliMatch = tomlContent.match(/WB_CLI_SCRIPT\s*=\s*"([^"]+)"/);
        if (cliMatch && fs.existsSync(cliMatch[1])) {
          cliScript = cliMatch[1];
        }
      } catch (err) {
        logger.warn('[WorkBuddyClient] Error reading ~/.codex/config.toml:', err);
      }
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      WB_COMMAND: nodeExec,
      WB_CLI_SCRIPT: cliScript,
      WB_TIMEOUT: String(DEFAULT_WORKER_TIMEOUT_MS),
      WB_SKIP_PERMISSIONS: 'true',
      CODEBUDDY_CONFIG_DIR: configDir,
      CODEBUDDY_DISABLE_IDE: '1',
      // Ensure proxy variables that cause axios EAI_FAIL are neutralized
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
    };

    if (process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE) {
      env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE;
    } else {
      env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
    }

    this.resolvedConfig = {
      command: nodeExec,
      args: [serverScript],
      cwd: fs.existsSync(workDir) ? workDir : undefined,
      env,
    };

    return this.resolvedConfig;
  }

  /**
   * Request that the active execution be stopped.
   */
  static requestStop(): void {
    this.stopRequested = true;
    logger.info('[WorkBuddyClient] Stop requested for WorkBuddy execution.');
    if (this.activeTransport) {
      try {
        this.activeTransport.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Executes a task using the WorkBuddy MCP server.
   */
  static async runTask(params: {
    prompt: string;
    cwd: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<WorkerExecutionResult> {
    this.stopRequested = false;

    // Simulation / Mock mode for testing
    if (process.env.CB_MOCK_WORKBUDDY === 'true') {
      logger.info('[WorkBuddyClient] Mock mode active: simulating WorkBuddy execution.');
      return {
        ok: true,
        output: `[MOCK WORKBUDDY RESULT]\nCompleted prompt for cwd: ${params.cwd}\nChanges applied successfully.`,
      };
    }

    const config = this.resolveMcpServerConfig();
    const timeoutMs = params.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    const model = params.model ?? WORKER_FIXED_MODEL;

    logger.info(`[WorkBuddyClient] Starting WorkBuddy MCP client with model=${model}, timeoutMs=${timeoutMs}...`);

    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    try {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        stderr: 'inherit',
      });

      this.activeTransport = transport;

      client = new Client(
        {
          name: 'cb-workbench-client',
          version: '0.1.0',
        },
        {
          capabilities: {},
        }
      );

      await client.connect(transport);
      logger.info('[WorkBuddyClient] Connected to WorkBuddy MCP server. Calling run_workbuddy_task...');

      if (this.stopRequested) {
        return {
          ok: false,
          output: '',
          error: 'Task execution stopped by user before call dispatch.',
        };
      }

      // Call tool run_workbuddy_task
      const response = await client.callTool(
        {
          name: 'run_workbuddy_task',
          arguments: {
            prompt: params.prompt,
            cwd: params.cwd,
            model,
            timeoutMs,
          },
        },
        undefined,
        {
          timeout: timeoutMs + 10000,
        }
      );

      if (this.stopRequested) {
        return {
          ok: false,
          output: '',
          error: 'Execution cancelled by user request.',
        };
      }

      const content = response.content as Array<{ type: string; text: string }>;
      const text = content?.map((c) => c.text).join('\n') || '';

      if (response.isError) {
        return {
          ok: false,
          output: text,
          error: text || 'WorkBuddy MCP reported an error.',
        };
      }

      return {
        ok: true,
        output: text,
      };
    } catch (err: any) {
      if (this.stopRequested) {
        return {
          ok: false,
          output: '',
          error: 'Execution stopped by user.',
        };
      }
      logger.error('[WorkBuddyClient] Execution error:', err);
      return {
        ok: false,
        output: '',
        error: err?.message || String(err),
      };
    } finally {
      this.activeTransport = null;
      if (client) {
        try {
          await client.close();
        } catch {}
      }
    }
  }
}
