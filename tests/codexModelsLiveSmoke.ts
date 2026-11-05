import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../src/adapters/codexAdapter.ts';

// 显式调用全部可见模型，不属于离线测试。
if (process.env.CB_MOCK_CODEX === 'true') throw new Error('Disable Codex mock for live validation.');
const adapter = new CodexAdapter();
const models = await adapter.listModels();
const reportPath = path.resolve('data', `codex-model-validation-${Date.now()}.json`);
const report: any = { startedAt: new Date().toISOString(), models, results: [] };
for (let index = 0; index < models.length; index += 2) {
  await Promise.all(models.slice(index, index + 2).map(async model => {
    const marker = `MODEL_OK_${randomUUID()}`;
    const result = await adapter.execute({ model, cwd: process.cwd(), timeoutMs: 120000,
      prompt: `只输出以下 JSON 字符串解码后的文本，不加标点、解释，不读写文件或调用工具：${JSON.stringify(marker)}` });
    const verified = result.ok && result.output.trim() === marker;
    report.results.push({ model, verified, ...result });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`${verified ? 'PASS' : 'FAIL'} ${model} (${result.durationMs}ms)${result.error ? ': ' + result.error : ''}`);
  }));
}
report.finishedAt = new Date().toISOString();
report.verified = report.results.length === models.length && report.results.every((r: any) => r.verified);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verified: report.verified, reportPath }));
process.exitCode = report.verified ? 0 : 1;
