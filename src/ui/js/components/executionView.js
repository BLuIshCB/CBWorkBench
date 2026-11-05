let source;
let currentRun;
let selectedTask;
let latestStartedAt=0;
export function closeExecution() {source?.close();source=null;currentRun=null;selectedTask=null;latestStartedAt=0;}


/** 每次刷新任务时发现当前 run，SSE 断线沿用事件游标补读。 */
export async function refreshExecution(taskId,task) {
  if(selectedTask!==taskId)closeExecution();
  selectedTask=taskId;
  const response=await fetch('/api/tasks/'+encodeURIComponent(taskId)+'/execution');
  const data=await response.json();
  if(selectedTask!==taskId || !data.success) return;
  let panel=document.getElementById('execution-live-panel');
  if(!panel) {
    panel=document.createElement('div');panel.id='execution-live-panel';panel.className='card';
    const status=document.createElement('p');status.id='execution-live-status';panel.append(status);
    const logs=document.createElement('pre');logs.id='execution-live-logs';logs.style.cssText='max-height:400px;overflow:auto;white-space:pre-wrap';panel.append(logs);
    document.getElementById('gate2-card').after(panel);
  }
  const run=data.run;
  if(!run){source?.close();currentRun=null;panel.hidden=true;return;}
  if(run.startedAt<latestStartedAt)return;latestStartedAt=run.startedAt;
  panel.hidden=false;
  document.getElementById('execution-live-status').textContent=run.kind+' · '+run.state+' · 已运行 '+Math.floor(run.elapsedMs/1000)+' 秒 · 剩余 '+Math.ceil(run.remainingMs/1000)+' 秒 · 最近输出 '+(run.lastOutputAt?new Date(run.lastOutputAt).toLocaleTimeString():'暂无')+(run.activity==='quiet'?' · 长时间无新输出，仍在执行':'')+(run.stopReason?' · '+run.stopReason:'')+' · 回收确认 '+run.cleanupConfirmed;
  let cleanup=document.getElementById('execution-cleanup');
  if(!cleanup){cleanup=document.createElement('button');cleanup.id='execution-cleanup';cleanup.textContent='重试清理';panel.append(cleanup);}
  cleanup.hidden=run.stopReason!=='CLEANUP_FAILED' || run.cleanupConfirmed;
  cleanup.onclick=async()=>{const result=await fetch('/api/runs/'+encodeURIComponent(run.runId)+'/cleanup',{method:'POST'}).then(r=>r.json());alert(result.message);};
  const executor=run.kind==='reviewer'?task?.reviewer_executor:task?.worker_executor;
  const model=run.kind==='reviewer'?task?.reviewer_model:task?.worker_model;
  document.getElementById('execution-live-status').textContent+=' · '+(executor || '')+' · '+(model==='default'?'沿用CLI配置':model || '')+(run.toolName?' · '+run.toolName:'');
  if(currentRun===run.runId) return;
  source?.close();currentRun=run.runId;
  const logs=document.getElementById('execution-live-logs');logs.textContent='';
  const connection=new EventSource('/api/runs/'+encodeURIComponent(run.runId)+'/stream?after=0');source=connection;
  let seq=0;
  connection.addEventListener('execution',message=>{
    const event=JSON.parse(message.data);
    if(currentRun!==event.runId || event.seq<=seq)return;seq=event.seq;
    if(event.type==='output') {
      logs.append(document.createTextNode(event.data.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')));
      while(logs.textContent.length>262144 && logs.firstChild) logs.firstChild.remove();
      logs.scrollTop=logs.scrollHeight;
    }
    if(event.type==='finished') connection.close();
  });
}
