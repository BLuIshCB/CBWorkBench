import { NativeCliAdapter } from './nativeCliAdapter.ts';
import { resolveAntigravityCliConfig } from '../services/cliConfig.ts';
import { MANDATORY_CLI_POLICY } from './types.ts';

export class AntigravityAdapter extends NativeCliAdapter {
  readonly id = 'antigravity';
  readonly name = 'Antigravity CLI';
  readonly description = 'Google agy 独立 CLI，使用 CLI 原生凭据与历史机制。';
  readonly defaultModel = process.env.CB_ANTIGRAVITY_MODEL || 'default';
  readonly supportedModels = [this.defaultModel];
  readonly connectionType = 'agy --input-format stream-json --dangerously-skip-permissions';
  // agy 没有已核验的禁用历史参数，不能把独立进程误报为无持久化。
  readonly executionPolicy = { ...MANDATORY_CLI_POLICY, sessionPersistence: 'native' as const };
  protected resolveConfig = resolveAntigravityCliConfig;

  protected buildArgs(model: string): string[] {
    return ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions',
      ...(model && model !== 'default' ? ['--model', model] : [])];
  }

  protected encodePrompt(prompt: string): string {
    return JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
  }

  protected parseOutput(stdout: string): string {
    const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const results = events.filter(e => e.event === 'result').map(e => e.result);
    if (results.length !== 1) throw new Error('Antigravity 必须返回一个终态 result');
    const result = results[0];
    if (result?.status !== 'SUCCESS') throw new Error(result?.error || `Antigravity 状态: ${result?.status}`);
    return result.response;
  }
}
