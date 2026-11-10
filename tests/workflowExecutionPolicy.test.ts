import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/storage/db.ts';
import { workflowEngine } from '../src/services/workflowEngine.ts';
import { adapterRegistry } from '../src/adapters/registry.ts';
import { MANDATORY_CLI_POLICY, type AgentExecutionContext } from '../src/adapters/types.ts';
import { TestRunner } from '../src/services/testRunner.ts';
import { CliRunner } from '../src/services/cliRunner.ts';

const calls:AgentExecutionContext[]=[];
let waitForCancellation:'worker'|'reviewer'|null=null;
adapterRegistry.register({
  id:'policy-fixture',name:'Policy fixture',description:'Offline contract fixture',defaultModel:'default',supportedModels:['default'],connectionType:'fixture',executionPolicy:MANDATORY_CLI_POLICY,
  async healthCheck(){return {healthy:true};},async abort(){},
  async execute(context){
    calls.push(context);
    if(waitForCancellation===(context.kind || 'worker')) {
      await new Promise<void>(resolve=>{if(context.signal?.aborted)resolve();else context.signal?.addEventListener('abort',()=>resolve(),{once:true});});
      return {ok:false,output:'partial output',error:'cancelled fixture',errorCode:'CANCELLED',durationMs:0,modelUsed:'default'};
    }
    return {ok:true,output:context.kind==='reviewer'?JSON.stringify({decision:'passed',revision:1,summary:'fixture evidence',criteriaResults:[{id:'fixture',passed:true,evidence:'Offline adapter contract verified'}],issues:[],manualChecksPending:[]}):'development fixture',durationMs:0,modelUsed:'default'};
  },
});
function createTask(testsMd='') {
  const id='policy-'+randomUUID();
  db.createTask({id,task_key:id,title:'Policy fixture',target_cwd:process.cwd(),budget_max_rounds:1});
  db.saveRevision({task_id:id,revision:1,manifest_json:JSON.stringify({packageVersion:1}),task_md:'# Fixture',development_md:'# Fixture',tests_md:testsMd,acceptance_md:'# Fixture',verifier_prompt_md:'# Fixture'});
  return id;
}
async function waitFor(predicate:()=>boolean) {
  const deadline=Date.now()+10000;
  while(!predicate() && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(predicate(),'Workflow did not reach expected state');
}
const testTimeouts:number[]=[];
const original=TestRunner.runSingleTest;
TestRunner.runSingleTest=async function(tc,cwd,timeout,options){testTimeouts.push(timeout!);return original.call(this,tc,cwd,timeout,options);};
try {
  const id=createTask('- 命令: `node -v`');
  assert.equal((await workflowEngine.confirmAndStartTask(id,undefined,{workerExecutor:'policy-fixture',reviewerExecutor:'policy-fixture',executionTimeoutMs:60000})).success,true);
  await waitFor(()=>db.getTask(id)?.status==='human_review' && !workflowEngine.isBusy());
  assert.deepEqual(calls.map(c=>c.timeoutMs),[60000,60000]);
  assert.deepEqual(testTimeouts,[60000]);
  assert.equal(db.getTask(id)?.execution_timeout_ms,60000);
  const originalRun = CliRunner.run;
  let infrastructureCalls = 0;
  try {
    CliRunner.run = async options => {
      infrastructureCalls++;
      return {runId:options.runId,exitCode:1,signal:null,stdout:'partial evidence',stderr:'',
        timedOut:false,cancelled:false,durationMs:1,errorCode:'EXECUTION',stopReason:'PROCESS_FAILED',
        cleanupConfirmed:true,error:'durable output failure'};
    };
    const failureId=createTask('- 命令: `fixture first`\n- 命令: `fixture must-not-run`');
    const previousCalls=calls.length;
    assert.equal((await workflowEngine.confirmAndStartTask(failureId,undefined,{workerExecutor:'policy-fixture',reviewerExecutor:'policy-fixture'})).success,true);
    await waitFor(()=>db.getTask(failureId)?.status==='blocked' && !workflowEngine.isBusy());
    assert.equal(infrastructureCalls,1,'Infrastructure failures must stop the remaining tests');
    assert.equal(calls.length,previousCalls+1,'Infrastructure failures must not invoke repair or acceptance');
    assert.match(db.getTask(failureId)!.blocked_reason!,/durable output failure/);
  } finally {
    CliRunner.run=originalRun;
  }
  for(const kind of ['worker','reviewer'] as const) {
    waitForCancellation=kind;
    const cancelId=createTask();const start=calls.length;
    assert.equal((await workflowEngine.confirmAndStartTask(cancelId,undefined,{workerExecutor:'policy-fixture',reviewerExecutor:'policy-fixture'})).success,true);
    await waitFor(()=>calls.slice(start).some(c=>(c.kind || 'worker')===kind));
    assert.equal(workflowEngine.stopTask(cancelId).success,true);
    await waitFor(()=>db.getTask(cancelId)?.status==='cancelled' && !workflowEngine.isBusy());
  }
} finally {TestRunner.runSingleTest=original;}
console.log('✅ workflowExecutionPolicy.test.ts passed');
