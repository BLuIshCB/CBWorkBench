import { NativeCliAdapter } from './nativeCliAdapter.ts';
import { resolveCodexCliConfig } from '../services/cliConfig.ts';
import { VERIFIER_DEFAULT_MODEL } from '../config/constants.ts';
import { MANDATORY_CLI_POLICY } from './types.ts';
import { CliRunner } from '../services/cliRunner.ts';
import { ROOT_DIR } from '../config/constants.ts';
import { createHash, randomUUID } from 'node:crypto';

export class CodexAdapter extends NativeCliAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly description = '原生 codex exec 对话，无沙箱与交互审批，不依赖客户端。';
  readonly defaultModel = VERIFIER_DEFAULT_MODEL;
  readonly supportedModels = [VERIFIER_DEFAULT_MODEL];
  readonly connectionType = 'codex exec --dangerously-bypass-approvals-and-sandbox';
  readonly executionPolicy = MANDATORY_CLI_POLICY;
  protected resolveConfig = resolveCodexCliConfig;
  private catalog?: { key: string; expiresAt: number; models: Promise<string[]> };

  async healthCheck(): Promise<{healthy:boolean;message?:string}> {
    const version=await super.healthCheck();
    if(!version.healthy || process.env.CB_MOCK_CODEX==='true')return version;
    try {
      const config=this.resolveConfig();
      const help=await CliRunner.run({runId:randomUUID(),executable:config.executable,args:[...(config.script?[config.script]:[]),...(config.args || []),'exec','--help'],cwd:ROOT_DIR,env:config.env,timeoutMs:10000});
      const required=['--json','--ephemeral','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox'];
      if(help.errorCode || !required.every(flag=>help.stdout.includes(flag))) return {healthy:false,message:'Codex 版本或入口不兼容：exec --help 缺少所需参数。'+(help.error || '')};
      return version;
    } catch(error) {return {healthy:false,message:String(error)};}
  }

  /** 使用同一 CLI 和账户刷新目录，不把默认模型当成完整列表。 */
  async listModels(): Promise<string[]> {
    if (process.env.CB_MOCK_CODEX === 'true') return [...this.supportedModels];
    const config = this.resolveConfig();
    const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    if (this.catalog?.key === key && this.catalog.expiresAt > Date.now()) return [...await this.catalog.models];
    const models = (async () => {
      const result = await CliRunner.run({
        runId: randomUUID(), executable: config.executable,
        args: [...(config.script ? [config.script] : []), ...(config.args || []), 'debug', 'models'],
        env: config.env, cwd: ROOT_DIR, timeoutMs: 20000,
      });
      if (result.errorCode || result.exitCode !== 0) throw new Error(result.error || result.stderr || 'Codex 模型目录读取失败');
      const catalog = JSON.parse(result.stdout);
      if (!Array.isArray(catalog.models)) throw new Error('Codex 模型目录缺少 models 数组');
      const visible = [...new Set<string>(catalog.models.filter((model: any) => model.visibility === 'list')
        .map((model: any) => model.slug).filter((slug: unknown): slug is string => typeof slug === 'string' && slug.trim().length > 0))];
      if (!visible.length) throw new Error('Codex 未返回可见模型');
      return visible;
    })();
    const entry = { key, expiresAt: Date.now() + 5 * 60000, models };
    this.catalog = entry;
    try { return [...await models]; }
    catch (error) { if (this.catalog === entry) this.catalog = undefined; throw error; }
  }

  protected buildArgs(model: string): string[] {
    return ['exec', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json',
      ...(model && model !== 'default' ? ['-m', model] : []), '-'];
  }

  protected parseOutput(stdout: string): string {
    const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const failure = events.find(e => e.type === 'turn.failed' || e.type === 'error');
    if (failure) throw new Error(failure.error?.message || failure.message || 'Codex turn failed');
    if (!events.some(e => e.type === 'turn.completed')) throw new Error('Codex 缺少 turn.completed 事件');
    return events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message')
      .map(e => e.item.text).join('\n');
  }
}
