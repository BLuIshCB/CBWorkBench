import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { adapterRegistry } from '../adapters/registry.ts';
import { diagnoseCli, resolveAgentCliConfigPath, resolveCliConfig } from '../services/cliConfig.ts';
import { ensurePathHydrated } from '../services/shellPath.ts';

const [action = 'list', id, cwdArg, model] = process.argv.slice(2);
try {
  if (action === 'list') console.log(JSON.stringify(await adapterRegistry.listAllAdapters(), null, 2));
  else {
    const adapter = adapterRegistry.getAdapter(id);
    const cwd = path.resolve(cwdArg || process.cwd());
    if (action === 'doctor') {
      const declaration = adapter.cliDeclaration;
      if (!declaration) throw new Error(`适配器 ${id} 未声明 CLI`);
      // 诊断结论必须建立在真实水合后的 PATH 上，否则与 exe 启动时的行为不一致。
      const hydration = await ensurePathHydrated();
      const discovery = diagnoseCli(declaration);
      console.log(JSON.stringify({
        cli: id,
        platform: process.platform,
        home: os.homedir(),
        configFile: resolveAgentCliConfigPath(),
        declaration: {
          commands: declaration.commands,
          requiredCommands: declaration.requiredCommands ?? [],
          explicitEnv: declaration.explicitEnv ?? [],
        },
        pathHydrated: hydration.ok,
        hydrationFailure: hydration.failureReason ?? null,
        hydrationAdded: hydration.added,
        entry: {
          executable: discovery.executable,
          script: discovery.script ?? null,
          needsShellWrap: discovery.needsShellWrap ?? false,
        },
        runnable: discovery.runnable,
        source: discovery.source,
        reason: discovery.reason ?? null,
        missingDependencies: discovery.missingDependencies ?? [],
        scanned: discovery.scanned,
        candidates: discovery.candidates,
      }, null, 2));
    } else if (action === 'login') {
      const config = resolveCliConfig(id);
      const args = [...(config.script ? [config.script] : []), ...(config.args || [])];
      if (id === 'codex') args.push('login');
      // WorkBuddy 和 agy 由原生交互入口负责登录，不通过桌面 Bridge。
      const child = spawn(config.executable, args, { cwd, env: { ...process.env, ...config.env },
        shell: false, stdio: 'inherit', windowsHide: false });
      child.once('error', error => { console.error(error.message); process.exitCode = 1; });
      child.once('close', code => { process.exitCode = code ?? 1; });
    } else if (action === 'verify' || action === 'chat') {
      if (process.env.CB_MOCK_WORKBUDDY === 'true' || process.env.CB_MOCK_CODEX === 'true') throw new Error('请关闭 mock 开关后执行真实 CLI 对话。');
      const marker = `CLI_中文对话_OK_${randomUUID()}`;
      let prompt = `只回复 ${marker}。不要调用工具，不要读写文件。`;
      if (action === 'chat') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        prompt = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      }
      const result = await adapter.execute({ cwd, prompt, model, timeoutMs: 180000 });
      const verified = action === 'verify' ? result.ok && result.output.trim() === marker : result.ok;
      console.log(JSON.stringify({ ...result, verified }, null, 2));
      process.exitCode = verified ? 0 : 1;
    } else throw new Error('Usage: node bin/agent.js list | doctor <id> | verify|chat|login <workbuddy|codex|antigravity> [cwd] [model]');
  }
} catch (error) { console.error(String(error)); process.exitCode = 1; }
