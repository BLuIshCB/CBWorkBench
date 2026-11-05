import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { CliRunner } from '../src/services/cliRunner.ts';
import { ExecutionService } from '../src/services/executionService.ts';
import { db } from '../src/storage/db.ts';

async function waitFor(predicate:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!predicate() && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(predicate());
}
const descriptor=Object.getOwnPropertyDescriptor(performance,'now');
let clock=performance.now();
Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
const quietId=randomUUID();
const controller=new AbortController();
const run=CliRunner.run({runId:quietId,executable:process.execPath,args:['-e','process.stdout.write("first");setTimeout(()=>process.stdout.write("second"),500);setInterval(()=>{},1000)'],cwd:process.cwd(),timeoutMs:3600000,signal:controller.signal});
try {
  await waitFor(()=>db.runEvents(quietId,0,500).some(e=>e.type==='output'));
  const last=ExecutionService.snapshot(quietId)!.lastOutputAt;
  clock+=300001;
  await waitFor(()=>ExecutionService.snapshot(quietId)?.activity==='quiet');
  for(let index=0;index<10;index++)ExecutionService.snapshot(quietId);
  assert.equal(ExecutionService.snapshot(quietId)?.lastOutputAt,last,'Snapshot sampling must not count as CLI output');
  assert.equal(ExecutionService.snapshot(quietId)?.finishedAt,null,'Silence only warns');
  assert.ok(db.runEvents(quietId,0,500).some(e=>e.type==='warning' && e.data.warning==='NO_OUTPUT'));
  await waitFor(()=>db.runEvents(quietId,0,500).some(e=>e.data.text==='second'));
  assert.equal(ExecutionService.snapshot(quietId)?.activity,'active');
  assert.ok(ExecutionService.snapshot(quietId)!.remainingMs<3600000-300000,'Output must not extend the hard deadline');
} finally {
  controller.abort();await run;
  if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete (performance as any).now;
}

const failureId=randomUUID();
const original=db.saveRunEvent;
db.saveRunEvent=function(event,snapshot){if(event.runId===failureId && event.type==='output')throw new Error('Injected durable output failure');return original.call(this,event,snapshot);};
try {
  const failed=await CliRunner.run({runId:failureId,executable:process.execPath,args:['-e','process.stdout.write("partial evidence");setInterval(()=>{},1000)'],cwd:process.cwd(),timeoutMs:15000});
  assert.equal(failed.stopReason,'PROCESS_FAILED');
  assert.equal(failed.cleanupConfirmed,true);
  assert.ok(failed.stdout.includes('partial evidence'));
  assert.equal(ExecutionService.snapshot(failureId)?.state,'blocked');
} finally {db.saveRunEvent=original;}
assert.equal(CliRunner.hasUncleanRuns(),false);
console.log('✅ executionActivity.test.ts passed');
