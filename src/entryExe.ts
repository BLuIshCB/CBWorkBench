process.env.CB_SEA_EXE = 'true';
import { execFile } from 'node:child_process';
import { parseCliRuntimeArgs, resolveResidentServerForDataDir } from './config/dataDir.ts';

async function main() {
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
`);
    process.exit(0);
  }

  try {
    const { DEFAULT_PORT, DEFAULT_HOST, DATA_DIR, INSTANCE_ID } = await import('./config/constants.ts');
    // 重复点击只打开已验证的后台，避免再次初始化数据库和恢复任务。
    const existing = await resolveResidentServerForDataDir(DATA_DIR, INSTANCE_ID);
    let url: string;
    if (existing) {
      url = existing.url;
      console.log(`[CBWorkBench] 后台已运行，使用现有工作台: ${url}`);
    } else {
      const { startServer } = await import('./server/httpServer.ts');
      const port = cliArgs.port || Number(process.env.CB_PORT) || DEFAULT_PORT;
      const host = cliArgs.host || process.env.CB_HOST || DEFAULT_HOST;
      await startServer(port, host);
      url = `http://${host}:${port}/`;
    }
    if (!cliArgs.noOpen && process.platform === 'win32') {
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (err) => {
        if (err) console.error(`[CBWorkBench] 无法自动打开浏览器，请手动访问 ${url}: ${err.message}`);
      });
    }
  } catch (err: any) {
    console.error('\n[CBWorkBench] 启动失败:', err?.message || err);
    process.exit(1);
  }
}

main();
