import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startInteractiveConsole, openBrowser } from '../src/services/interactiveConsole.ts';
import { UiActivityTracker } from '../src/services/uiActivityTracker.ts';

console.log('[Test] Running interactiveConsole.test.ts...');

const capturedLogs: string[] = [];
const originalLog = console.log;
const originalClear = console.clear;
let clearCalled = false;

console.log = (...args: any[]) => {
  capturedLogs.push(args.map(a => String(a)).join(' '));
  originalLog(...args);
};
console.clear = () => {
  clearCalled = true;
};

try {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  const tracker = new UiActivityTracker();
  let serverClosed = false;

  const mockServer = {
    __skipProcessExit: true,
    close: (cb?: () => void) => {
      serverClosed = true;
      if (cb) cb();
    },
  };

  const rl = startInteractiveConsole(
    'http://127.0.0.1:3721/',
    mockServer,
    tracker,
    inputStream,
    outputStream
  );

  assert.ok(rl, 'readline interface should be created for custom stream');
  assert.ok(capturedLogs.some(l => l.includes('控制台交互已就绪')), 'Ready banner printed');

  // 1. 测试 help 指令
  capturedLogs.length = 0;
  inputStream.write('help\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(capturedLogs.some(l => l.includes('可用指令:')), 'help command prints instructions');
  assert.ok(capturedLogs.some(l => l.includes('web') && l.includes('tasks') && l.includes('exit')), 'help lists all 5 commands');
  console.log('  ✓ help command prints instructions');

  // 2. 测试 web 指令
  capturedLogs.length = 0;
  inputStream.write('web\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(capturedLogs.some(l => l.includes('正在打开工作台新网页')), 'web command triggers browser launch');
  assert.ok(tracker.getLastBrowserOpenedAt() > 0, 'web command records browser open timestamp');
  console.log('  ✓ web command triggers open and updates tracker');

  // 3. 测试 tasks 指令
  capturedLogs.length = 0;
  inputStream.write('tasks\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(capturedLogs.some(l => l.includes('任务列表') || l.includes('暂无任何任务')), 'tasks command executes successfully');
  console.log('  ✓ tasks command displays task status');

  // 4. 测试 clear 指令
  clearCalled = false;
  inputStream.write('clear\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clearCalled, true, 'clear command calls console.clear()');
  console.log('  ✓ clear command clears the screen');

  // 5. 测试未知指令与空行
  capturedLogs.length = 0;
  inputStream.write('\n');
  inputStream.write('unknown-cmd\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(capturedLogs.some(l => l.includes("未知命令: 'unknown-cmd'")), 'Unknown command prints hint');
  console.log('  ✓ unknown command handles gracefully');

  // 6. 测试 exit 指令
  capturedLogs.length = 0;
  inputStream.write('exit\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(serverClosed, true, 'exit command closes server cleanly');
  assert.ok(capturedLogs.some(l => l.includes('正在安全停止服务')), 'exit command logs shutdown message');
  console.log('  ✓ exit command triggers graceful shutdown');

  // 7. 测试 openBrowser 健壮性与无异常抛出
  assert.doesNotThrow(() => {
    openBrowser('http://127.0.0.1:3721/');
  }, 'openBrowser executes without throwing uncaught exceptions');
  console.log('  ✓ openBrowser handles platform invocation safely');

  console.log('✅ interactiveConsole.test.ts passed successfully!');
} finally {
  console.log = originalLog;
  console.clear = originalClear;
}
