import { NativeCliAdapter } from './nativeCliAdapter.ts';
import { MANDATORY_CLI_POLICY } from './types.ts';
import { resolveWorkBuddyCliConfig } from '../services/cliConfig.ts';
import { WORKER_FIXED_MODEL } from '../config/constants.ts';

export class WorkBuddyAdapter extends NativeCliAdapter {
  readonly id = 'workbuddy';
  readonly name = 'WorkBuddy CLI';
  readonly description = '独立 CLI 对话，无需启动 WorkBuddy 客户端。';
  readonly defaultModel = WORKER_FIXED_MODEL;
  readonly supportedModels = [WORKER_FIXED_MODEL];
  readonly connectionType = 'codebuddy -p --dangerously-skip-permissions';
  readonly executionPolicy = MANDATORY_CLI_POLICY;
  protected resolveConfig = resolveWorkBuddyCliConfig;

  protected buildArgs(model: string): string[] {
    return ['-p', '--no-session-persistence', '--output-format', 'json', '--dangerously-skip-permissions',
      ...(model && model !== 'default' ? ['--model', model] : [])];
  }

  protected parseOutput(stdout: string): string {
    const text = stdout.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 部分 CLI 版本会把启动提示写到 stdout，只提取完整的结果对象。
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      parsed = JSON.parse(text.slice(start, end + 1));
    }
    // 完整 CLI 的 json 模式返回事件数组；lite 版本返回单个结果对象。
    if (Array.isArray(parsed)) {
      const results = parsed.filter(event => event?.type === 'result');
      if (results.length !== 1 || parsed.at(-1) !== results[0]) throw new Error('WorkBuddy 缺少唯一终态 result');
      parsed = results[0];
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('WorkBuddy 返回无效结构');
    if (parsed.subtype && parsed.subtype !== 'success') throw new Error(parsed.result || `WorkBuddy 状态: ${parsed.subtype}`);
    if (parsed.is_error || parsed.error) throw new Error(typeof parsed.error === 'string' ? parsed.error : parsed.result || parsed.output || 'WorkBuddy 执行失败');
    return parsed.result ?? parsed.output ?? parsed.answer;
  }
}
