import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, type ReworkSourceFile, type WorkflowNodeRunRecord } from '../storage/db.ts';
import { computeBufferSha256, readRegularFileSafely, validateUtf8NoBom } from '../utils/pathSecurity.ts';
import { parseReviewEvidence } from './acceptanceService.ts';
import { PACKAGE_LIMITS, PackageProtocolError } from './packageProtocol.ts';
import type { WorkflowNode } from './workflowDefinition.ts';

export const advanceInputShape = {
  task_id: z.string().min(1),
  node_id: z.string().min(1),
  attempt_id: z.string().min(1),
  completion_token: z.string().min(1),
  request_id: z.string().min(1).max(128),
  outcome: z.enum(['passed', 'failed']),
  summary: z.string().trim().min(1).max(16384),
  failure_kind: z.enum(['business', 'execution']).optional(),
  rework_paths: z.array(z.string().max(512)).max(32).optional()
    .describe('退回时按交接顺序列出本次 outputs/rework/ 目录下的全部 Markdown 相对路径'),
};

const advanceSchema = z.object(advanceInputShape);
export type AdvanceInput = z.infer<typeof advanceSchema>;

const verificationReportSchema = z.object({
  tests: z.array(z.object({
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    exit_code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })).min(1),
});

export const TEST_REPORT_PATH = 'outputs/test_report.json';
export const ACCEPTANCE_REPORT_PATH = 'outputs/acceptance-report.json';
export const REWORK_OUTPUT_DIR = 'outputs/rework';
const MAX_REWORK_BATCH_BYTES = 1024 * 1024;

interface EvidenceFile {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface CompletionPayload {
  summary: string;
  failureKind?: 'business' | 'execution';
  rework?: { targetNodeId: string; files: ReworkSourceFile[] };
  verification?: { report: z.infer<typeof verificationReportSchema>; file: EvidenceFile };
  acceptance?: { report: ReturnType<typeof parseReviewEvidence>; file: EvidenceFile };
}

export function reworkFileName(sequence: number): string {
  return `rework-prompt-${String(sequence).padStart(2, '0')}.md`;
}

export function resolveReworkTarget(run: Pick<WorkflowNodeRunRecord, 'task_id' | 'revision' | 'node_id'>, node: WorkflowNode): string | undefined {
  const target = node.on_failure;
  if (target && target !== run.node_id && db.hasExecutedNode(run.task_id, run.revision, target)) return target;
}

function readReworkFiles(attemptDir: string, paths: string[]): ReworkSourceFile[] {
  const outputDir = path.join(attemptDir, REWORK_OUTPUT_DIR);
  if (!paths.length) {
    throw new PackageProtocolError('REWORK_FILES_REQUIRED', `请列出 ${REWORK_OUTPUT_DIR}/ 中的全部返工 Markdown`);
  }
  if (new Set(paths.map(file => file.toLowerCase())).size !== paths.length ||
      paths.some(file => !/^outputs\/rework\/[^/\\]+\.md$/i.test(file))) {
    throw new PackageProtocolError('INVALID_REWORK_PATH', `返工文档必须是 ${REWORK_OUTPUT_DIR}/ 下互不重复的 Markdown 相对路径`);
  }

  const filesOnDisk = fs.readdirSync(outputDir).map(name => `${REWORK_OUTPUT_DIR}/${name}`);
  const omitted = filesOnDisk.filter(file => !paths.includes(file));
  const missing = paths.filter(file => !filesOnDisk.includes(file));
  if (omitted.length || missing.length) {
    throw new PackageProtocolError('REWORK_FILES_MISMATCH', '返工文档列表与输出目录不一致', [
      ...omitted.map(file => ({ path: file, reason: '未随 MCP 请求提交' })),
      ...missing.map(file => ({ path: file, reason: '文件不存在' })),
    ]);
  }
  let totalBytes = 0;
  return paths.map(file => {
    const buffer = readRegularFileSafely(attemptDir, file, PACKAGE_LIMITS.max_read_chunk_bytes);
    validateUtf8NoBom(buffer, 'text/markdown', file);
    const content = buffer.toString('utf8');
    totalBytes += buffer.length;
    if (!content.trim()) throw new PackageProtocolError('EMPTY_REWORK_FILE', `返工文档不能为空: ${file}`);
    if (totalBytes > MAX_REWORK_BATCH_BYTES) throw new PackageProtocolError('SIZE_LIMIT_EXCEEDED', '本次返工文档合计超过 1 MiB');
    return { path: file, sha256: computeBufferSha256(buffer), content };
  });
}

function readEvidence(attemptDir: string, filePath: string) {
  const buffer = readRegularFileSafely(attemptDir, filePath, PACKAGE_LIMITS.max_file_bytes);
  validateUtf8NoBom(buffer, 'application/json', filePath);
  return {
    raw: JSON.parse(buffer.toString('utf8')),
    file: { path: filePath, sha256: computeBufferSha256(buffer), size_bytes: buffer.length },
  };
}

function prepareCompletion(args: AdvanceInput, run: WorkflowNodeRunRecord, nodes: WorkflowNode[]): CompletionPayload {
  const node = nodes.find(item => item.id === run.node_id);
  if (!node || node.execution_mode !== 'agent' || !run.attempt_dir) {
    throw new PackageProtocolError('ADVANCE_REJECTED', '找不到当前自动节点的运行上下文');
  }
  const failureKind = args.outcome === 'failed' ? args.failure_kind ?? 'business' : undefined;
  const payload: CompletionPayload = { summary: args.summary, failureKind };
  if (args.outcome === 'passed' && args.failure_kind) {
    throw new PackageProtocolError('INVALID_OUTCOME', '成功报告不得包含失败类型');
  }
  const targetNodeId = failureKind === 'business' ? resolveReworkTarget(run, node) : undefined;
  if (targetNodeId) {
    payload.rework = { targetNodeId, files: readReworkFiles(run.attempt_dir, args.rework_paths ?? []) };
  } else if (args.rework_paths?.length) {
    throw new PackageProtocolError('INVALID_REWORK_PATH', '只有向已执行节点发起业务退回时才可提交返工文档');
  }
  if (failureKind === 'execution') return payload;

  try {
    if (node.result_rule === 'verification') {
      const evidence = readEvidence(run.attempt_dir, TEST_REPORT_PATH);
      const report = verificationReportSchema.parse(evidence.raw);
      if (report.tests.every(test => test.exit_code === 0) !== (args.outcome === 'passed')) {
        throw new Error('报告状态与测试退出码不一致');
      }
      payload.verification = { report, file: evidence.file };
    }
    if (node.result_rule === 'acceptance') {
      const evidence = readEvidence(run.attempt_dir, ACCEPTANCE_REPORT_PATH);
      const report = parseReviewEvidence(evidence.raw, run.revision, nodes.filter(item => item.type === 'task').map(item => item.id));
      if (report.decision === 'blocked' || (report.decision === 'passed') !== (args.outcome === 'passed')) {
        throw new Error('报告状态与验收结论不一致。验收受阻请提交 execution 失败');
      }
      payload.acceptance = { report, file: evidence.file };
    }
  } catch (error) {
    throw new PackageProtocolError('INVALID_NODE_EVIDENCE', `缺少有效执行证据: ${error instanceof Error ? error.message : error}`);
  }
  return payload;
}

/** 只登记可核验的结果，流程切换由执行引擎在进程退出后提交。 */
export function reportNodeCompletion(input: AdvanceInput) {
  const args = advanceSchema.parse(input);
  const fingerprint = computeBufferSha256(Buffer.from(JSON.stringify([
    args.outcome, args.summary, args.failure_kind ?? null, args.rework_paths ?? [],
  ])));
  return db.registerAdvanceReport(args.task_id, args.node_id, args.attempt_id, args.completion_token, args.request_id,
    args.outcome, args.summary, fingerprint, (run, workflow) =>
      JSON.stringify(prepareCompletion(args, run, JSON.parse(workflow.nodes_json))));
}

export function checkCompletionFiles(attemptDir: string, payload: CompletionPayload): void {
  for (const evidence of [payload.verification, payload.acceptance]) {
    if (evidence && readEvidence(attemptDir, evidence.file.path).file.sha256 !== evidence.file.sha256) {
      throw new Error(`提交回执后证据发生变化: ${evidence.file.path}`);
    }
  }
  if (payload.rework) {
    const current = readReworkFiles(attemptDir, payload.rework.files.map(file => file.path));
    if (current.some((file, index) => file.sha256 !== payload.rework!.files[index].sha256)) {
      throw new Error('提交回执后返工文档发生变化');
    }
  }
}
