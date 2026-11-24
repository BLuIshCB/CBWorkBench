import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isStandaloneExe } from '../config/dataDir.ts';
import type { AdvanceInput } from '../services/nodeCompletion.ts';

const sourceEntry = fileURLToPath(new URL('../../bin/cb-workbench.js', import.meta.url));
const mcpEntry = fileURLToPath(new URL('../../bin/cb-workbench-mcp.js', import.meta.url));

export function completionCommand(contextPath: string): string {
  const parts = [process.execPath, ...(isStandaloneExe() ? [] : [sourceEntry]), 'complete-node', '--context', contextPath];
  const quote = (part: string) => process.platform === 'win32'
    ? "'" + part.replaceAll("'", "''") + "'"
    : "'" + part.replaceAll("'", "'\\''") + "'";
  return (process.platform === 'win32' ? '& ' : '') + parts.map(quote).join(' ');
}

async function callAdvance(transport: Transport, input: AdvanceInput) {
  const client = new Client({ name: 'cb-workbench-complete-node', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 12000 });
    const result = await client.callTool({ name: 'workbench_advance_workflow', arguments: input }, undefined, { timeout: 15000 });
    const response = Array.isArray(result.content) ? result.content.find(item => item.type === 'text') : undefined;
    if (!response || response.type !== 'text') throw new Error('MCP 未返回完成回执');
    const parsed = JSON.parse(response.text);
    if (result.isError || !parsed.ok) {
      const files = parsed.error?.details?.map((detail: { path: string; reason: string }) => `${detail.path} (${detail.reason})`).join('，');
      throw new Error([parsed.error?.message || response.text, files].filter(Boolean).join('。'));
    }
    if (parsed.attemptId !== input.attempt_id || parsed.requestId !== input.request_id) {
      throw new Error('MCP 回执与本次节点执行不匹配');
    }
    return parsed;
  } finally {
    await client.close();
  }
}

/** 执行器无法自行报告时，通过同一个 MCP 工具记录技术失败。 */
export async function callLocalAdvance(input: AdvanceInput) {
  const { createWorkbenchMcpServer } = await import('../server/mcpServer.ts');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWorkbenchMcpServer(true);
  try {
    await server.connect(serverTransport);
    return await callAdvance(clientTransport, input);
  } finally {
    await server.close();
  }
}

/** 从只读运行上下文获取本次执行身份，避免在命令和日志里传递完成凭据。 */
export async function completeNode(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv, options: {
      context: { type: 'string' }, outcome: { type: 'string' }, summary: { type: 'string' },
      'failure-kind': { type: 'string' }, 'rework-path': { type: 'string', multiple: true },
    },
  });
  const outcome = values.outcome;
  const failureKind = values['failure-kind'];
  if (!values.context || !values.summary?.trim() || (outcome !== 'passed' && outcome !== 'failed') ||
      (failureKind && failureKind !== 'business' && failureKind !== 'execution')) {
    throw new Error('用法: complete-node --context <context.json> --outcome passed|failed --summary <摘要> [--failure-kind business|execution] [--rework-path <相对路径> ...]');
  }

  const context = JSON.parse(fs.readFileSync(values.context, 'utf8'));
  const { task_id, node_id, attempt_id, completion_token, request_id, data_dir } = context.completion_protocol ?? {};
  if (![task_id, node_id, attempt_id, completion_token, request_id, data_dir].every(value => typeof value === 'string' && value) ||
      !path.isAbsolute(data_dir)) throw new Error('运行上下文缺少有效的完成凭据或数据目录');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(isStandaloneExe() ? [] : [mcpEntry]), '--mcp-advance', '--data-dir', data_dir],
    env: { MCP_MODE: 'true' },
    stderr: 'ignore',
  });
  const response = await callAdvance(transport, {
    task_id, node_id, attempt_id, completion_token, request_id, outcome, summary: values.summary,
    failure_kind: failureKind, rework_paths: values['rework-path'],
  });
  console.log(`MCP 已受理节点结果 (${response.requestId})，请结束当前 CLI 执行。`);
}
