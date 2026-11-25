import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

console.log('[Test] Running entryExe.test.ts...');
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-startup-'));
const executable = process.env.CB_TEST_EXE_PATH || process.execPath;
const entryArgs = process.env.CB_TEST_EXE_PATH ? [] : [path.join(rootDir, 'src', 'entryExe.ts')];
const env = { ...process.env, CB_DATA_DIR: dataDir };
let first: ReturnType<typeof spawn> | undefined;
let second: ReturnType<typeof spawn> | undefined;
let third: ReturnType<typeof spawn> | undefined;
let fourth: ReturnType<typeof spawn> | undefined;
let firstOutput = '';

try {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  first = spawn(executable, [...entryArgs, '--no-open', '--port', String(port)], {
    cwd: rootDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  first.stdout?.on('data', (chunk) => { firstOutput += chunk; });
  first.stderr?.on('data', (chunk) => { firstOutput += chunk; });
  const firstExit = once(first, 'exit');
  const infoFile = path.join(dataDir, 'server.json');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(infoFile)) {
    assert.equal(first.exitCode, null, `First launch failed: ${firstOutput}`);
    assert.ok(Date.now() < deadline, `First launch timed out: ${firstOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const response = await fetch(`${info.url}/api/system/instance`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).pid, first.pid);
  if (process.env.CB_TEST_EXE_PATH) assert.equal((await fetch(info.url)).status, 200);
  console.log('  ✓ First launch starts the server');

  // 重复点击必须复用实际后台地址，即使第二次传入了不同端口。
  second = spawn(executable, [...entryArgs, '--no-open', '--port', '1'], {
    cwd: rootDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let secondOutput = '';
  second.stdout?.on('data', (chunk) => { secondOutput += chunk; });
  second.stderr?.on('data', (chunk) => { secondOutput += chunk; });
  const secondExit = once(second, 'exit');
  let timer: ReturnType<typeof setTimeout>;
  const [code] = await Promise.race([
    secondExit,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Repeated launch did not exit')), 10000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(code, 0, `Repeated launch should reuse the resident server: ${secondOutput}`);
  assert.ok(secondOutput.includes(info.url), 'Repeated launch reports the existing URL');
  assert.equal(JSON.parse(fs.readFileSync(infoFile, 'utf8')).pid, first.pid);
  assert.equal((await fetch(`${info.url}/api/system/instance`)).status, 200);
  console.log('  ✓ Repeated launch exits successfully and preserves the resident server');

  // 模拟网页活跃心跳，验证再次启动时检测到 active_ui 并跳过重复打开新网页
  await fetch(`${info.url}/api/system/ui-heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'test-client-entry', action: 'ping' }),
  });
  const instWithHeartbeat = await (await fetch(`${info.url}/api/system/instance`)).json() as any;
  assert.equal(instWithHeartbeat.has_active_ui, true, 'Instance reports active UI after heartbeat');

  third = spawn(executable, [...entryArgs, '--port', '1'], {
    cwd: rootDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let thirdOutput = '';
  third.stdout?.on('data', (chunk) => { thirdOutput += chunk; });
  third.stderr?.on('data', (chunk) => { thirdOutput += chunk; });
  const thirdExit = once(third, 'exit');
  let thirdTimer: ReturnType<typeof setTimeout>;
  const [thirdCode] = await Promise.race([
    thirdExit,
    new Promise<never>((_, reject) => {
      thirdTimer = setTimeout(() => reject(new Error('Third launch did not exit')), 10000);
    }),
  ]).finally(() => clearTimeout(thirdTimer));
  assert.equal(thirdCode, 0, `Third launch should exit cleanly: ${thirdOutput}`);
  assert.ok(thirdOutput.includes('跳过重复打开新网页'), `Third launch should skip duplicate opening: ${thirdOutput}`);
  console.log('  ✓ Repeated launch with active UI skips duplicate browser popup');

  // 注销心跳并触发 ui-open，验证 8 秒防抖冷却锁依然阻止重复弹窗
  await fetch(`${info.url}/api/system/ui-heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'test-client-entry', action: 'close' }),
  });
  const openRes = await fetch(`${info.url}/api/system/ui-open`, { method: 'POST' });
  assert.equal(openRes.status, 200);
  const openData = await openRes.json() as any;
  assert.equal(openData.success, true);
  assert.ok(openData.last_browser_opened_at > 0);

  const instAfterOpen = await (await fetch(`${info.url}/api/system/instance`)).json() as any;
  assert.equal(instAfterOpen.has_active_ui, true, 'Instance reports active UI during cooldown window');

  fourth = spawn(executable, [...entryArgs, '--port', '1'], {
    cwd: rootDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fourthOutput = '';
  fourth.stdout?.on('data', (chunk) => { fourthOutput += chunk; });
  fourth.stderr?.on('data', (chunk) => { fourthOutput += chunk; });
  const fourthExit = once(fourth, 'exit');
  let fourthTimer: ReturnType<typeof setTimeout>;
  const [fourthCode] = await Promise.race([
    fourthExit,
    new Promise<never>((_, reject) => {
      fourthTimer = setTimeout(() => reject(new Error('Fourth launch did not exit')), 10000);
    }),
  ]).finally(() => clearTimeout(fourthTimer));
  assert.equal(fourthCode, 0, `Fourth launch should exit cleanly: ${fourthOutput}`);
  assert.ok(fourthOutput.includes('跳过重复打开新网页'), `Fourth launch should skip duplicate opening during cooldown: ${fourthOutput}`);
  console.log('  ✓ Repeated launch within cooldown window skips duplicate browser popup');

  first.kill();
  await firstExit;
  console.log('✅ entryExe.test.ts passed successfully!');
} finally {
  for (const child of [fourth, third, second, first]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
