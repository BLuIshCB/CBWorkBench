let source;
let currentRun;
let selectedTask;
let latestStartedAt = 0;

export function closeExecution() {
  source?.close();
  source = null;
  currentRun = null;
  selectedTask = null;
  latestStartedAt = 0;
}

/**
 * 极简实时执行进度面板：
 * 不再展示任何 CLI 样式的黑色控制台面板，不再展示任何模型输出；
 * 保留已运行时间、模型上次回答时间、超时剩余以及当前执行器与状态。
 */
export async function refreshExecution(taskId, task) {
  if (selectedTask !== taskId) closeExecution();
  selectedTask = taskId;

  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/execution');
  const data = await response.json();
  if (selectedTask !== taskId || !data.success) return;

  let panel = document.getElementById('execution-live-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'execution-live-panel';
    panel.className = 'card live-progress-card';
    panel.innerHTML = `
      <div class="live-progress-header">
        <div class="live-progress-title-wrap">
          <span class="pulse-dot"></span>
          <strong id="live-stage-title" style="font-size: 14px; color: #0f172a;">任务执行推进中</strong>
          <span class="badge badge-running" id="live-kind-badge">执行中</span>
        </div>
        <div class="live-executor-info">
          <span style="font-size: 12px; color: var(--text-muted);">执行器:</span>
          <code id="live-executor-name" style="font-weight: 600;">--</code>
          <span class="badge badge-gray" id="live-model-name" style="margin-left: 4px;">default</span>
        </div>
      </div>
      <div class="live-metrics-grid">
        <div class="live-metric-item">
          <span class="live-metric-label">⏱️ 已执行时间</span>
          <span class="live-metric-val" id="live-elapsed-time">0 秒</span>
        </div>
        <div class="live-metric-item">
          <span class="live-metric-label">💬 模型上次回答时间</span>
          <span class="live-metric-val" id="live-last-output-time">等待回答...</span>
        </div>
        <div class="live-metric-item">
          <span class="live-metric-label">⏳ 超时剩余</span>
          <span class="live-metric-val" id="live-remaining-time">--</span>
        </div>
        <div class="live-metric-item">
          <span class="live-metric-label">📡 活跃状态</span>
          <span class="live-metric-val" id="live-activity-state">正在执行</span>
        </div>
      </div>
      <div id="live-cleanup-row" style="margin-top: 10px; display: none;">
        <button id="execution-cleanup" class="btn btn-sm btn-secondary">重试清理</button>
      </div>
    `;
    const anchor = document.getElementById('gate2-launch-card') || document.querySelector('.task-summary-card');
    if (anchor) anchor.after(panel);
    else document.getElementById('view-task-details')?.prepend(panel);
  }

  const run = data.run;
  if (!run) {
    source?.close();
    currentRun = null;
    panel.hidden = true;
    return;
  }

  if (run.startedAt < latestStartedAt) return;
  latestStartedAt = run.startedAt;
  panel.hidden = false;

  const stageMap = {
    worker: 'Worker 编码与开发',
    test: '独立自动化测试',
    acceptance: 'Reviewer 自动化验收',
  };
  const stageName = stageMap[run.kind] || (run.kind ? `阶段: ${run.kind}` : '任务执行推进中');
  const stageTitleEl = document.getElementById('live-stage-title');
  if (stageTitleEl) stageTitleEl.textContent = stageName;

  const kindBadgeEl = document.getElementById('live-kind-badge');
  if (kindBadgeEl) kindBadgeEl.textContent = run.state === 'running' ? '执行中' : run.state;

  const executor = run.adapterId || run.executor || 'codebuddycli';
  const execNameEl = document.getElementById('live-executor-name');
  if (execNameEl) execNameEl.textContent = executor;

  const model = run.modelName || run.model || 'default';
  const modelNameEl = document.getElementById('live-model-name');
  if (modelNameEl) modelNameEl.textContent = model === 'default' ? '沿用CLI默认模型' : model;

  const elapsedSec = Math.floor(run.elapsedMs / 1000);
  const elapsedText = elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)} 分 ${elapsedSec % 60} 秒` : `${elapsedSec} 秒`;
  const elapsedEl = document.getElementById('live-elapsed-time');
  if (elapsedEl) elapsedEl.textContent = elapsedText;

  const lastOutputText = run.lastOutputAt ? new Date(run.lastOutputAt).toLocaleTimeString() : '等待首次回答...';
  const lastOutputEl = document.getElementById('live-last-output-time');
  if (lastOutputEl) lastOutputEl.textContent = lastOutputText;

  const remainingSec = Math.max(0, Math.ceil(run.remainingMs / 1000));
  const remainingText = remainingSec >= 60 ? `${Math.floor(remainingSec / 60)} 分 ${remainingSec % 60} 秒` : `${remainingSec} 秒`;
  const remainingEl = document.getElementById('live-remaining-time');
  if (remainingEl) remainingEl.textContent = remainingText;

  const activityText = run.activity === 'quiet' ? '静默执行中（长时间无输出）' : (run.stopReason ? `已停止: ${run.stopReason}` : '正在活跃执行');
  const activityEl = document.getElementById('live-activity-state');
  if (activityEl) activityEl.textContent = activityText;

  const cleanupRow = document.getElementById('live-cleanup-row');
  const cleanupBtn = document.getElementById('execution-cleanup');
  const needCleanup = run.stopReason === 'CLEANUP_FAILED' && !run.cleanupConfirmed;
  if (cleanupRow) cleanupRow.style.display = needCleanup ? 'block' : 'none';
  if (cleanupBtn && needCleanup) {
    cleanupBtn.onclick = async () => {
      const result = await fetch('/api/runs/' + encodeURIComponent(run.runId) + '/cleanup', { method: 'POST' }).then((r) => r.json());
      alert(result.message);
    };
  }

  if (currentRun === run.runId) return;
  source?.close();
  currentRun = run.runId;

  // SSE 仅用于实时更新模型上次回答时间与捕获完成信号，绝不展示或缓存任何模型输出文本
  const connection = new EventSource('/api/runs/' + encodeURIComponent(run.runId) + '/stream?after=0');
  source = connection;
  let seq = 0;
  connection.addEventListener('execution', (message) => {
    const event = JSON.parse(message.data);
    if (currentRun !== event.runId || event.seq <= seq) return;
    seq = event.seq;

    if (event.type === 'output') {
      const outputTimeEl = document.getElementById('live-last-output-time');
      if (outputTimeEl) {
        outputTimeEl.textContent = new Date().toLocaleTimeString();
      }
    }
    if (event.type === 'finished') {
      connection.close();
      if (window.app?.fetchTaskDetail) {
        window.app.fetchTaskDetail(taskId, true);
      }
    }
  });
}
