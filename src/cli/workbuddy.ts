import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WorkBuddyClient } from '../services/workbuddyClient.ts';
import { resolveWorkBuddyConfigs } from '../services/workbuddyConfig.ts';

const action = process.argv[2] || 'status';
try {
  if (action === 'status') {
    const health = await WorkBuddyClient.healthCheck();
    console.log(JSON.stringify(health, null, 2));
    process.exitCode = health.healthy ? 0 : 1;
  } else if (action === 'verify') {
    if (process.env.CB_MOCK_WORKBUDDY === 'true') throw new Error('请先关闭 CB_MOCK_WORKBUDDY，连通性验证必须使用真实后端。');
    const result = await WorkBuddyClient.runTask({
      taskId: 'workbuddy-connectivity-check', cwd: path.resolve(process.argv[3] || process.cwd()),
      prompt: '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。', timeoutMs: 60000,
    });
    const verified = result.ok && result.output.trim() === 'WB_ADAPTER_OK';
    console.log(JSON.stringify({ ...result, verified }, null, 2));
    process.exitCode = verified ? 0 : 1;
  } else if (action === 'login') {
    const config = resolveWorkBuddyConfigs().cli;
    const script = config?.env.WB_CLI_SCRIPT;
    if (!config || !script || !fs.existsSync(script)) throw new Error('没有可交互登录的 CLI 路径，请在 WorkBuddy 桌面端登录。');
    const dist = path.resolve(path.dirname(script), '..', 'dist');
    if (fs.existsSync(path.join(dist, 'codebuddy-lite-wb.mjs')) && !fs.existsSync(path.join(dist, 'codebuddy.js'))) {
      throw new Error('当前安装仅包含 WorkBuddy lite-wb，缺少交互式 CLI。请在 WorkBuddy 桌面端登录，再运行 node bin/workbuddy.js verify；独立 CLI 模式需使用支持 /login 的完整 CLI。');
    }
    console.log(`请在交互会话中执行 /login。配置目录：${config.env.CODEBUDDY_CONFIG_DIR || '(CLI default)'}`);
    const child = spawn(config.env.WB_COMMAND || process.execPath, [script], { cwd: process.cwd(), env: config.env, stdio: 'inherit', shell: false, windowsHide: false });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('close', code => { process.exitCode = code ?? 1; });
  } else throw new Error('Usage: node bin/workbuddy.js status|verify [cwd]|login');
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
