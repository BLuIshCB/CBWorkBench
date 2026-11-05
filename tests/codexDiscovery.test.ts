import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexCliConfig } from '../src/services/cliConfig.ts';
import { CodexAdapter } from '../src/adapters/codexAdapter.ts';

const saved={...process.env};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cb-中文 prefix-'));
try {
  const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,'{}');
  process.env.CB_AGENT_CLI_CONFIG=configPath;delete process.env.CODEX_CMD_PATH;
  if(process.platform==='win32') {
    const prefix=path.join(root,'custom prefix');fs.mkdirSync(prefix,{recursive:true});
    const script=path.join(prefix,'node_modules','@openai','codex','bin','codex.js');fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,'// Discovery fixture: never executed');
    fs.writeFileSync(path.join(prefix,'codex.cmd'),'@echo wrapper must not execute');
    process.env.PATH=prefix;
    const fromPath=resolveCodexCliConfig();assert.equal(fromPath.script,script);assert.equal(fromPath.executable,process.execPath);assert.equal(fromPath.discoverySource,'path');
    fs.renameSync(path.join(prefix,'codex.cmd'),path.join(prefix,'codex.ps1'));
    assert.equal(resolveCodexCliConfig().script,script);
    const explicit=path.join(root,'explicit codex.exe');fs.writeFileSync(explicit,'fixture');
    fs.writeFileSync(configPath,JSON.stringify({codex:{executable:explicit}}));
    assert.equal(resolveCodexCliConfig().executable,explicit);assert.equal(resolveCodexCliConfig().discoverySource,'config');
    fs.writeFileSync(configPath,'{}');process.env.PATH=path.join(root,'missing');process.env.NPM_CONFIG_PREFIX=prefix;
    assert.equal(resolveCodexCliConfig().script,script);assert.equal(resolveCodexCliConfig().discoverySource,'npm');
    const unsupported=path.join(root,'unknown.ps1');fs.writeFileSync(unsupported,'throw "must not execute"');process.env.CODEX_CMD_PATH=unsupported;
    assert.throws(()=>resolveCodexCliConfig(),/实际 exe/);
  }
  const adapter=new CodexAdapter();assert.equal(adapter.defaultModel,'default');assert.equal((adapter as any).buildArgs('default').includes('-m'),false);
} finally {process.env=saved;fs.rmSync(root,{recursive:true,force:true});}
console.log('✅ codexDiscovery.test.ts passed');
