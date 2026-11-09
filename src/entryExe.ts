import { startServer } from './server/httpServer.ts';
import { DEFAULT_PORT, DEFAULT_HOST } from './config/constants.ts';
import { exec } from 'node:child_process';

async function main() {
  const args = process.argv.slice(2);
  let port = Number(process.env.CB_PORT) || DEFAULT_PORT;
  let host = process.env.CB_HOST || DEFAULT_HOST;
  let autoOpen = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    } else if (arg === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (arg === '--no-open') {
      autoOpen = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
============================================================
  CBWorkBench 单文件独立可执行程序 (Standalone Executable)
============================================================

用法:
  cb-workbench.exe [options]

选项:
  --port <port>    指定服务监听端口 (默认: 3721)
  --host <host>    指定服务绑定主机 (默认: 127.0.0.1)
  --no-open        启动后不自动在默认浏览器中打开页面
  --help, -h       显示此帮助信息
`);
      process.exit(0);
    }
  }

  try {
    await startServer(port, host);
    if (autoOpen && process.platform === 'win32') {
      const url = `http://${host}:${port}/`;
      exec(`start ${url}`);
    }
  } catch (err: any) {
    console.error('\n[CBWorkBench] 启动失败:', err?.message || err);
    process.exit(1);
  }
}

main();
