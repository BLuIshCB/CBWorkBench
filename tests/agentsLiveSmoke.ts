import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHttpServer } from '../src/server/httpServer.ts';

// 显式运行，实际调用三家模型，不加入离线测试套件。
if (process.env.CB_MOCK_WORKBUDDY === 'true' || process.env.CB_MOCK_CODEX === 'true') throw new Error('Live smoke requires real CLIs.');
const root = path.resolve('data', `cli-live-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const reportPath = path.join(root, 'report.json');
const report: any = { startedAt: new Date().toISOString(), checks: [] };
const server = createHttpServer();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
try {
  const executors = await (await fetch(`http://127.0.0.1:${port}/api/system/executors`)).json();
  assert.deepEqual(executors.agents.map((a: any) => a.id), ['workbuddy', 'codex', 'antigravity']);
  assert.deepEqual(executors.workers, executors.reviewers, 'All CLIs must be usable in both workflow stages');
  for (const cliId of ['workbuddy', 'codex', 'antigravity']) {
    const cwd = path.join(root, '中文 空格目录', cliId);
    fs.mkdirSync(cwd, { recursive: true });
    const marker = `中文对话成功_${randomUUID()}`;
    for (const kind of ['conversation', 'file']) {
      const content = `真实CLI文件验证_${cliId}_${marker}\n`;
      const prompt = kind === 'conversation'
        ? `只回复 ${marker}。不要调用工具，不要读写文件。`
        : `这是独立CLI文件工具验证。当前工作目录为 ${cwd}。只创建当前目录中的 result.txt，UTF-8内容必须精确等于下面JSON字符串解码后的内容：${JSON.stringify(content)}。请实际使用文件工具写入；不要只解释做法，不要修改其他文件。完成后简短报告。`;
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime/probe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliId, cwd, prompt, timeoutMs: 180000 }),
      });
      const body = await response.json();
      report.checks.push({ cliId, kind, cwd, ...body.result });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.result?.ok, true, JSON.stringify(body));
      if (kind === 'conversation') assert.equal(body.result.output.trim(), marker);
      else assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8'), content);
      console.log(`PASS ${cliId}/${kind} (${body.result.durationMs}ms)`);
    }
  }
  report.verified = true;
  console.log(JSON.stringify({ verified: true, reportPath }));
} catch (error) {
  report.verified = false;
  report.error = String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
