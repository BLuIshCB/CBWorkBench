import readline from 'node:readline';
import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { UiActivityTracker } from './uiActivityTracker.ts';

export interface InteractiveConsoleServer {
  close?: (callback?: (err?: Error) => void) => void | Server;
  __skipProcessExit?: boolean;
}

export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];

    if (process.platform === 'win32') {
      cmd = 'rundll32.exe';
      args = ['url.dll,FileProtocolHandler', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'linux') {
      cmd = 'xdg-open';
      args = [url];
    } else {
      console.log(`[CBWorkBench] 当前系统平台 (${process.platform}) 不支持自动调起浏览器，请在浏览器中访问: ${url}`);
      return;
    }

    const child = execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err) console.error(`[CBWorkBench] 无法自动打开浏览器，请手动访问 ${url}: ${err.message}`);
    });
    child?.unref?.();
  } catch (err: any) {
    console.error(`[CBWorkBench] 无法自动打开浏览器，请手动访问 ${url}: ${err?.message || err}`);
  }
}

export function startInteractiveConsole(
  url: string,
  server: InteractiveConsoleServer | Server | null | undefined,
  uiActivityTracker: UiActivityTracker,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): readline.Interface | undefined {
  if (input === process.stdin && !process.stdin.isTTY) return;

  const rl = readline.createInterface({
    input,
    output,
    prompt: 'cb-workbench> ',
  });

  console.log(`💡 控制台交互已就绪。输入 'help' 查看指令，输入 'web' 打开新网页，输入 'exit' 退出服务。\n`);
  rl.prompt();

  let isClosing = false;
  const gracefulExit = () => {
    if (isClosing) return;
    isClosing = true;
    try { rl.close(); } catch {}
    if (typeof server?.close === 'function') {
      try {
        server.close(() => {
          if (!server.__skipProcessExit) process.exit(0);
        });
        if (!server.__skipProcessExit) {
          setTimeout(() => process.exit(0), 1000).unref();
        }
      } catch {
        if (!server.__skipProcessExit) process.exit(0);
      }
    } else {
      if (!server?.__skipProcessExit) process.exit(0);
    }
  };

  rl.on('line', async (line) => {
    const cmd = line.trim();
    switch (cmd) {
      case 'web':
        console.log(`🌐 正在打开工作台新网页: ${url}`);
        openBrowser(url);
        uiActivityTracker.recordBrowserOpen();
        break;

      case 'tasks':
        try {
          const { db } = await import('../storage/db.ts');
          const tasks = db.listTasks();
          if (tasks.length === 0) {
            console.log('📋 当前暂无任何任务。');
          } else {
            console.log(`\n📋 当前任务列表 (共 ${tasks.length} 项):`);
            console.log('-'.repeat(60));
            console.log(`${'ID'.padEnd(24)} ${'状态'.padEnd(16)} 标题`);
            console.log('-'.repeat(60));
            for (const t of tasks.slice(0, 20)) {
              const displayTitle = (t.title || '').replace(/\r?\n/g, ' ').trim();
              console.log(`${t.id.padEnd(24)} ${t.status.padEnd(16)} ${displayTitle}`);
            }
            if (tasks.length > 20) {
              console.log(`... 还有 ${tasks.length - 20} 项任务，请在 Web 界面查看`);
            }
            console.log('-'.repeat(60) + '\n');
          }
        } catch (err: any) {
          console.error(`[CBWorkBench] 查询任务失败: ${err?.message || err}`);
        }
        break;

      case 'clear':
        console.clear();
        break;

      case 'help':
        console.log(`
可用指令:
  web    - 打开工作台网页 (每次均会打开新页面)
  tasks  - 查看当前任务列表与状态
  clear  - 清空控制台屏幕
  help   - 显示此帮助信息
  exit   - 停止服务并安全退出
`);
        break;

      case 'exit':
        console.log('正在安全停止服务...');
        gracefulExit();
        return;

      case '':
        break;

      default:
        console.log(`未知命令: '${cmd}'。输入 'help' 查看可用指令。`);
        break;
    }
    rl.prompt();
  });

  rl.on('close', () => {
    gracefulExit();
  });

  return rl;
}
