import { WorkBuddyAdapter } from '../adapters/workbuddyAdapter.ts';
import { CliRunner } from './cliRunner.ts';
import type { AgentExecutionContext, AgentExecutionResult } from '../adapters/types.ts';

/** 旧命令行入口的兼容层；实际执行统一交给 Adapter。 */
export class WorkBuddyClient {
  static requestStop(taskId?: string): Promise<void> { return CliRunner.abort(taskId); }
  static healthCheck() { return new WorkBuddyAdapter().healthCheck(); }
  static async runTask(params: AgentExecutionContext): Promise<AgentExecutionResult & { backend?: string }> {
    const result = await new WorkBuddyAdapter().execute(params);
    return { ...result, backend: result.metadata?.backend };
  }
}
