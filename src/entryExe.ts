process.env.CB_SEA_EXE = 'true';
import { execFile } from 'node:child_process';
import {
  parseCliRuntimeArgs,
  resolveResidentServerForDataDir,
} from './config/dataDir.ts';
import { openBrowser, startInteractiveConsole } from './services/interactiveConsole.ts';

export { openBrowser, startInteractiveConsole };

function tryActivateExistingWindow(title: string): void {
  if (process.platform !== 'win32') return;
  try {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate("${title}")`],
      { windowsHide: true, detached: true, stdio: 'ignore' },
      () => {}
    );
    child?.unref?.();
  } catch {}
}

async function notifyRemoteBrowserOpened(serverUrl: string): Promise<void> {
  try {
    const normalized = serverUrl.replace(/\/+$/, '');
    await fetch(`${normalized}/api/system/ui-open`, { method: 'POST' });
  } catch {}
}

async function main() {
  if (process.argv[2] === 'complete-node') {
    const { completeNode } = await import('./cli/completeNode.ts');
    await completeNode(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === '--mcp-advance') {
    process.env.MCP_MODE = 'true';
    console.log = (...args) => console.error(...args);
    const { startMcpServer } = await import('./server/mcpServer.ts');
    await startMcpServer(true);
    return;
  }
  let cliArgs;
  try {
    cliArgs = parseCliRuntimeArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(`\n[CBWorkBench] 启动参数错误 [${err?.code || 'CONFIG'}]: ${err?.message || err}`);
    process.exit(1);
  }

  if (cliArgs.help) {
    console.log(`
============================================================
  CBWorkBench 单文件独立可执行程序 (Standalone Executable)
============================================================

用法:
  cb-workbench.exe [options]

选项:
  --port <port>              指定服务监听端口 (默认: 3721)
  --host <host>              指定服务绑定主机 (默认: 127.0.0.1)
  --data-dir <absolute_path> 显式指定绝对数据目录 (优先于 CB_DATA_DIR)
  --portable                 启用便携模式，使用 EXE 所在目录/data
  --no-open                  启动后不自动在默认浏览器中打开页面
  --help, -h                 显示此帮助信息
  complete-node              通过 MCP 提交当前节点执行结果
`);
    process.exit(0);
  }

  try {
    const { DEFAULT_PORT, DEFAULT_HOST, DATA_DIR, INSTANCE_ID } = await import('./config/constants.ts');
    // 重复点击只打开已验证的后台，避免再次初始化数据库和恢复任务。
    const existing = await resolveResidentServerForDataDir(DATA_DIR, INSTANCE_ID);
    if (existing) {
      if (existing.has_active_ui) {
        console.log(`[CBWorkBench] 后台已在运行且工作台网页当前已打开 (${existing.url})，跳过重复打开新网页。`);
        tryActivateExistingWindow('CBWorkBench');
      } else if (!cliArgs.noOpen) {
        console.log(`[CBWorkBench] 后台已在运行，检测到网页未打开，正在启动浏览器访问: ${existing.url}`);
        openBrowser(existing.url);
        await notifyRemoteBrowserOpened(existing.url);
      } else {
        console.log(`[CBWorkBench] 后台已运行，使用现有工作台: ${existing.url}`);
      }
      return;
    }

    const { startServer } = await import('./server/httpServer.ts');
    const port = cliArgs.port || Number(process.env.CB_PORT) || DEFAULT_PORT;
    const host = cliArgs.host || process.env.CB_HOST || DEFAULT_HOST;
    const server = await startServer(port, host);
    const url = `http://${host}:${port}/`;

    const { uiActivityTracker } = await import('./services/uiActivityTracker.ts');
    if (!cliArgs.noOpen) {
      openBrowser(url);
      uiActivityTracker.recordBrowserOpen();
    }

    startInteractiveConsole(url, server, uiActivityTracker);
  } catch (err: any) {
    console.error('\n[CBWorkBench] 启动失败:', err?.message || err);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`[CBWorkBench] ${error.message}`);
  process.exitCode = 1;
});
