import { performance } from 'node:perf_hooks';
import { db } from '../storage/db.ts';
import { INTERNAL_SILENCE_WARNING_MS } from './executionPolicy.ts';

export type StopReason = 'USER_CANCELLED'|'EXECUTION_TIMEOUT'|'OUTPUT_LIMIT'|'PROCESS_FAILED'|'AUTH_REQUIRED'|'PROTOCOL_ERROR'|'INTERRUPTED'|'CLEANUP_FAILED';
export interface RunSnapshot {
  runId:string; taskId:string|null; roundId:number|null; kind:'worker'|'reviewer'|'test'|'probe';
  state:'starting'|'running'|'stopping'|'succeeded'|'failed'|'cancelled'|'blocked';
  activity:'starting'|'active'|'quiet'|'stopping'|'finished'; toolName:string|null;
  startedAt:number; finishedAt:number|null; lastOutputAt:number|null; elapsedMs:number; remainingMs:number;
  executionTimeoutMs:number; stopReason:StopReason|null; exitCode:number|null; outputTruncated:boolean; cleanupConfirmed:boolean;
}
export interface ExecutionEvent { runId:string;seq:number;at:number;type:'started'|'output'|'progress'|'warning'|'stopping'|'finished'; data:any }

/** 执行记录不依赖浏览器连接；单调时钟用于本次进程的计时。 */
export class ExecutionService {
  private static lastPruneAt=0;
  private static active = new Map<string, {snapshot:RunSnapshot; start:number; last:number; seq:number; bytes:number; taskBytes:number; pending:Map<'stdout'|'stderr',string>; end?:number; timer:NodeJS.Timeout}>();
  static start(runId:string, taskId:string|undefined, timeout:number, kind:RunSnapshot['kind'], roundId?:number, onFailure?:(error:unknown)=>void) {
    if(Date.now()-this.lastPruneAt>3600000){db.pruneProbeRuns();this.lastPruneAt=Date.now();}
    const snapshot:RunSnapshot = {runId, taskId:taskId ?? null, roundId:roundId ?? null, kind, state:'running',activity:'starting',toolName:null,
      startedAt:Date.now(),finishedAt:null,lastOutputAt:null,elapsedMs:0,remainingMs:timeout,executionTimeoutMs:timeout,
      stopReason:null,exitCode:null,outputTruncated:false,cleanupConfirmed:false};
    db.saveRun(snapshot);
    const timer = setInterval(() => {
      const active = this.active.get(runId);
      if(active) {try {this.flush(runId);}catch(error){active.snapshot.stopReason='PROCESS_FAILED';onFailure?.(error);}}
      if (active && !active.end && active.snapshot.activity !== 'quiet' && performance.now() - active.last >= INTERNAL_SILENCE_WARNING_MS) {
        active.snapshot.activity = 'quiet';
        try {this.event(runId,'warning',{warning:'NO_OUTPUT',text:'长时间无新输出，仍在执行'});} catch(error) {active.snapshot.stopReason='PROCESS_FAILED';onFailure?.(error);}
      }
    },10);
    timer.unref();
    this.active.set(runId,{snapshot,start:performance.now(),last:performance.now(),seq:0,bytes:0,pending:new Map(),taskBytes:taskId ? db.taskOutputBytes(taskId) : 0,timer});
    try {this.event(runId,'started',{snapshot});} catch(error) {clearInterval(timer);this.active.delete(runId);throw error;}
  }
  static output(runId:string, data:{stream:'stdout'|'stderr';text:string}) {
    const active=this.active.get(runId);if(!active)return;
    active.last=performance.now();active.snapshot.lastOutputAt=Date.now();
    if(!data.text)return;
    active.bytes+=Buffer.byteLength(data.text,'utf8');
    if(active.bytes+active.taskBytes>200*1024*1024 || active.bytes>20*1024*1024) throw Object.assign(new Error('执行输出达到容量上限'),{errorCode:'OUTPUT_LIMIT'});
    active.last=performance.now();active.snapshot.lastOutputAt=Date.now();active.snapshot.activity='active';
    active.pending.set(data.stream,(active.pending.get(data.stream) || '')+data.text);
  }
  private static flush(runId:string) {
    const active=this.active.get(runId);if(!active)return;
    const entry=active.pending.entries().next().value;
    if(!entry)return;
    const [stream,text]=entry;
    const piece=text.slice(0,16384);
    if(piece.length===text.length)active.pending.delete(stream);else active.pending.set(stream,text.slice(piece.length));
    this.event(runId,'output',{stream,text:piece});
  }
  static event(runId:string,type:ExecutionEvent['type'],data:any) {
    const active = this.active.get(runId);
    if (!active) return;
    if(type==='progress') active.snapshot.toolName=data.toolName ?? null;
    const event:ExecutionEvent={runId,seq:++active.seq,at:Date.now(),type,data};
    db.saveRunEvent(event,this.snapshot(runId)!);
  }
  static snapshot(runId:string):RunSnapshot|null {
    const active=this.active.get(runId);
    if (!active) return db.getRun(runId);
    return {...active.snapshot,elapsedMs:Math.max(0,(active.end ?? performance.now())-active.start),remainingMs:Math.max(0,active.snapshot.executionTimeoutMs-((active.end ?? performance.now())-active.start))};
  }
  static stopping(runId:string, reason:StopReason) {
    const active=this.active.get(runId);if(!active)return;
    if(active.snapshot.stopReason)return;
    Object.assign(active.snapshot,{state:'stopping',activity:'stopping',stopReason:reason});
    this.event(runId,'stopping',{snapshot:this.snapshot(runId)});
  }
  static async finish(runId:string,reason:StopReason|null,exitCode:number|null,cleanupConfirmed:boolean) {
    const active=this.active.get(runId);
    if (!active) return;
    clearInterval(active.timer);
    active.end=performance.now();
    while(active.pending.size) {this.flush(runId);if(active.pending.size) await new Promise(resolve=>setTimeout(resolve,10));}
    Object.assign(active.snapshot,{state:reason==='USER_CANCELLED'?'cancelled':reason==='PROCESS_FAILED' && active.snapshot.kind==='test' && exitCode!==null?'failed':reason?'blocked':'succeeded',activity:'finished',finishedAt:Date.now(),stopReason:reason,exitCode,cleanupConfirmed,outputTruncated:reason==='OUTPUT_LIMIT'});
    if(active.snapshot.roundId!==null) db.updateRoundTermination(active.snapshot.roundId,runId,reason,cleanupConfirmed);
    this.event(runId,'finished',{snapshot:this.snapshot(runId)});
    clearInterval(active.timer);
    this.active.delete(runId);
    if(active.snapshot.taskId===null)db.pruneProbeRuns();
  }
}
