import { refreshExecution, closeExecution } from './components/executionView.js';
/**
 * CBWorkBench 前端核心应用控制器 (Modern Modular Controller)
 */

import { api } from './api.js';
import { store } from './store.js';
import { Router } from './router.js';
import { TaskList } from './components/taskList.js';
import { TaskDetail } from './components/taskDetail.js';
import { RuntimeView } from './components/runtimeView.js';
import { WorkflowView } from './components/workflowView.js';
import { populateModelPicker, updateModelPicker, getModelValue } from './components/modelPicker.js';
import { escapeHtml, copyToClipboard, toggleDrawer } from './utils.js';

export class App {
  constructor() {
    this.workflowView = new WorkflowView(this);
    this.router = new Router({
      onTaskList: (push) => this.showTaskList(push),
      onTaskDetail: (id, push) => this.showTaskDetails(id, push),
      onWorkflows: (push) => this.showWorkflowView(push),
      onRuntime: (push) => this.showRuntimeView(push),
    });

    this.pollInterval = null;
    this.init();
  }

  async init() {
    // 加载全局状态与工作流
    await this.fetchSystemStatus();
    await this.fetchExecutors();
    await this.workflowView.init();

    this.router.handleRoute();

    // 启动智能轮询
    this.startPolling();
  }

  // --- Navigation & Routing ---

  navigateTo(path) {
    this.router.navigate(path);
  }

  showTaskList(pushHistory = true) {
    closeExecution();
    store.setState({ currentTaskId: null });
    if (pushHistory) window.history.pushState({}, '', '/');
    this.router.updateNavTabs('tasks');

    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'none';
    const viewDetail = document.getElementById('view-task-details');
    if (viewDetail) viewDetail.style.display = 'none';
    const viewWorkflows = document.getElementById('view-workflows');
    if (viewWorkflows) viewWorkflows.style.display = 'none';
    const viewList = document.getElementById('view-task-list');
    if (viewList) viewList.style.display = 'block';

    this.fetchTasks();
  }

  async showTaskDetails(taskId, pushHistory = true) {
    store.setState({ currentTaskId: taskId });
    if (pushHistory) window.history.pushState({}, '', `/tasks/${taskId}`);
    this.router.updateNavTabs('tasks');

    const viewList = document.getElementById('view-task-list');
    if (viewList) viewList.style.display = 'none';
    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'none';
    const viewWorkflows = document.getElementById('view-workflows');
    if (viewWorkflows) viewWorkflows.style.display = 'none';
    const viewDetail = document.getElementById('view-task-details');
    if (viewDetail) viewDetail.style.display = 'block';

    await this.fetchTaskDetail(taskId, false);
  }

  async showWorkflowView(pushHistory = true) {
    closeExecution();
    store.setState({ currentTaskId: null });
    if (pushHistory) window.history.pushState({}, '', '/workflows');
    this.router.updateNavTabs('workflows');

    const viewList = document.getElementById('view-task-list');
    if (viewList) viewList.style.display = 'none';
    const viewDetail = document.getElementById('view-task-details');
    if (viewDetail) viewDetail.style.display = 'none';
    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'none';
    const viewWorkflows = document.getElementById('view-workflows');
    if (viewWorkflows) viewWorkflows.style.display = 'block';

    this.workflowView.render();
  }

  async showRuntimeView(pushHistory = true) {
    store.setState({ currentTaskId: null });
    if (pushHistory) window.history.pushState({}, '', '/runtime');
    this.router.updateNavTabs('runtime');

    const viewList = document.getElementById('view-task-list');
    if (viewList) viewList.style.display = 'none';
    const viewDetail = document.getElementById('view-task-details');
    if (viewDetail) viewDetail.style.display = 'none';
    const viewWorkflows = document.getElementById('view-workflows');
    if (viewWorkflows) viewWorkflows.style.display = 'none';
    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'block';

    await this.fetchRuntimeClis();
  }

  startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(() => {
      const { currentTaskId } = store.getState();
      if (currentTaskId) {
        this.fetchTaskDetail(currentTaskId, true);
      } else {
        const viewList = document.getElementById('view-task-list');
        if (viewList && viewList.style.display !== 'none') {
          this.fetchTasks();
        }
      }
    }, 2500);
  }

  // --- Task Data Fetching ---

  async fetchTasks() {
    try {
      const data = await api.getTasks();
      if (data.success) {
        const tasks = data.tasks || [];
        store.setState({ tasks });
        TaskList.updateFilterCounts(tasks);
        TaskList.render(tasks, store.getState().currentFilter);
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    }
  }

  async refreshTaskList() {
    await this.fetchTasks();
    await this.fetchSystemStatus();
  }

  setFilter(filter) {
    store.setState({ currentFilter: filter });
    document.querySelectorAll('.filter-tabs .tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    TaskList.render(store.getState().tasks, filter);
  }

  async fetchTaskDetail(taskId, isSilent = false) {
    try {
      const data = await api.getTaskDetail(taskId);
      if (!data.success || !data.task) {
        if (!isSilent) alert('获取任务详情失败：' + (data.message || '任务不存在'));
        return;
      }
      store.setState({ currentTaskDetail: data });
      const { availableWorkers, availableReviewers, activeDetailTab, currentMaterialSubtab } = store.getState();
      refreshExecution(taskId,data.task).catch(error=>console.error('读取执行记录失败',error));
      TaskDetail.render(data, availableWorkers, availableReviewers, activeDetailTab, currentMaterialSubtab);
    } catch (e) {
      console.error('Error fetching task detail:', e);
    }
  }

  setDetailTab(tabName) {
    store.setState({ activeDetailTab: tabName });
    document.querySelectorAll('.detail-tabs .dtab-btn').forEach((btn) => {
      const match = btn.getAttribute('onclick')?.includes(tabName);
      btn.classList.toggle('active', !!match);
    });
    document.querySelectorAll('.dtab-content').forEach((content) => {
      content.classList.toggle('active', content.id === `dtab-${tabName}`);
    });
  }

  setMaterialSubtab(subtab) {
    store.setState({ currentMaterialSubtab: subtab });
    const tabs = ['task', 'dev', 'tests', 'acceptance', 'worker'];
    tabs.forEach((t) => {
      const btn = document.getElementById(`mat-btn-${t}`);
      if (btn) btn.classList.toggle('active', t === subtab);
    });
    const currentDetail = store.getState().currentTaskDetail;
    if (currentDetail) {
      TaskDetail.renderCurrentMaterial({
        task_md: currentDetail.latestRevision?.task_md,
        development_md: currentDetail.latestRevision?.development_md,
        tests_md: currentDetail.latestRevision?.tests_md,
        acceptance_md: currentDetail.latestRevision?.acceptance_md,
        workerPrompts: currentDetail.workerPrompts,
      }, subtab);
    }
  }

  // --- Task Operations (Gates 2, 3 & Deletions) ---

  async handleConfirmStart() {
    const { currentTaskId } = store.getState();
    if (!currentTaskId) return;

    const inputCwd = document.getElementById('input-confirmed-cwd');
    const confirmedCwd = inputCwd ? inputCwd.value.trim() : undefined;

    const workerSelect = document.getElementById('select-worker-executor');
    const reviewerSelect = document.getElementById('select-reviewer-executor');

    const workerExecutor = workerSelect?.value;
    const workerModel = getModelValue('select-worker-model');
    const reviewerExecutor = reviewerSelect?.value;
    const reviewerModel = getModelValue('select-reviewer-model');
    if (!workerModel || !reviewerModel) { alert('请填写模型名称。'); return; }

    try {
      const data = await api.confirmStartTask(currentTaskId, {
        execution_timeout_ms: Number(document.getElementById('execution-timeout-minutes').value) * 60000,
        confirmed_cwd: confirmedCwd,
        worker_executor: workerExecutor,
        worker_model: workerModel,
        reviewer_executor: reviewerExecutor,
        reviewer_model: reviewerModel,
      });

      if (data.success) {
        await this.fetchTaskDetail(currentTaskId);
      } else {
        alert('启动失败：' + data.message);
      }
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  async handleStopTask() {
    const { currentTaskId } = store.getState();
    if (!currentTaskId) return;
    if (!confirm('确定停止当前 CLI 或测试进程吗？已产生的文件改动会保留。')) return;

    try {
      const data = await api.stopTask(currentTaskId);
      alert(data.message);
      await this.fetchTaskDetail(currentTaskId);
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  async handleDeleteTask(event, taskId, taskTitle) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    const confirmed = confirm(
      `确定要删除任务「${taskTitle || taskId}」吗？\n\n⚠️ 此操作将一并删除该任务相关的方案文档、Worker 提示词和数据库记录，且无法恢复！`
    );
    if (!confirmed) return;

    try {
      const data = await api.deleteTask(taskId);
      if (data.success) {
        await this.fetchTasks();
      } else {
        alert('删除任务失败：' + (data.message || '未知错误'));
      }
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  async handleDeleteCurrentTask() {
    const { currentTaskId } = store.getState();
    if (!currentTaskId) return;
    const taskTitle = document.getElementById('detail-task-title')?.textContent || currentTaskId;
    const confirmed = confirm(
      `确定要删除任务「${taskTitle}」吗？\n\n⚠️ 此操作将一并删除该任务相关的方案文档、Worker 提示词和数据库记录，且无法恢复！`
    );
    if (!confirmed) return;

    try {
      const data = await api.deleteTask(currentTaskId);
      if (data.success) {
        alert(data.message || '任务已成功删除');
        this.showTaskList();
      } else {
        alert('删除任务失败：' + (data.message || '未知错误'));
      }
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  showClearAllModal() {
    const { tasks } = store.getState();
    if (tasks.length === 0) {
      alert('当前任务看板中暂无任何任务，无需清空。');
      return;
    }
    const modal = document.getElementById('modal-clear-all');
    if (!modal) return;
    const checkbox = document.getElementById('checkbox-confirm-clear');
    const confirmBtn = document.getElementById('btn-confirm-clear-all');
    if (checkbox) checkbox.checked = false;
    if (confirmBtn) confirmBtn.disabled = true;
    modal.style.display = 'flex';
  }

  closeClearAllModal() {
    const modal = document.getElementById('modal-clear-all');
    if (modal) modal.style.display = 'none';
  }

  handleClearCheckboxChange() {
    const checkbox = document.getElementById('checkbox-confirm-clear');
    const confirmBtn = document.getElementById('btn-confirm-clear-all');
    if (confirmBtn && checkbox) {
      confirmBtn.disabled = !checkbox.checked;
    }
  }

  async confirmClearAllTasks() {
    const checkbox = document.getElementById('checkbox-confirm-clear');
    if (!checkbox || !checkbox.checked) {
      alert('请先勾选二次确认复选框');
      return;
    }

    try {
      const data = await api.clearAllTasks();
      this.closeClearAllModal();
      if (data.success) {
        alert(data.message || '所有任务已成功清空');
        await this.fetchTasks();
      } else {
        alert('清空失败：' + (data.message || '未知错误'));
      }
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  async handleResumeBlocked() {
    await this.handleConfirmStart();
  }

  async handleHumanDecision(action) {
    const { currentTaskId } = store.getState();
    if (!currentTaskId) return;

    if (action === 'approve') {
      if (!confirm('确认审核通过此任务？任务将被标记为已完成。')) return;
      try {
        const data = await api.submitHumanReview(currentTaskId, { action: 'approve', reason: '人工审核通过' });
        alert(data.message);
        await this.fetchTaskDetail(currentTaskId);
      } catch (e) {
        alert('审核失败：' + e.message);
      }
    }
  }

  showRejectModal() {
    const modal = document.getElementById('modal-reject');
    if (modal) modal.style.display = 'flex';
  }

  closeRejectModal() {
    const modal = document.getElementById('modal-reject');
    if (modal) modal.style.display = 'none';
    const input = document.getElementById('reject-reason-input');
    if (input) input.value = '';
  }

  async confirmReject() {
    const { currentTaskId } = store.getState();
    if (!currentTaskId) return;
    const input = document.getElementById('reject-reason-input');
    const reason = input ? input.value.trim() : '';
    if (!reason) {
      alert('请填写退回修改原因，以便针对性修复。');
      return;
    }

    try {
      const data = await api.submitHumanReview(currentTaskId, { action: 'reject', reason });
      this.closeRejectModal();
      alert(data.message);
      await this.fetchTaskDetail(currentTaskId);
    } catch (e) {
      alert('操作失败：' + e.message);
    }
  }

  // --- Runtime Diagnostics & Probe View ---

  async fetchRuntimeClis() {
    try {
      const grid = document.getElementById('runtime-cli-grid');
      if (grid && !store.getState().runtimeClis.length) {
        grid.innerHTML = '<div class="loading-state">正在探测已配置的 CLI 工具...</div>';
      }
      const data = await api.getRuntimeClis();
      if (data.success && Array.isArray(data.clis)) {
        store.setState({ runtimeClis: data.clis });
        RuntimeView.renderClis(data.clis);
        RuntimeView.populateProbeForm(data.clis);
        this.handleProbeTargetChange();
      }
    } catch (e) {
      console.warn('Failed to fetch runtime clis:', e);
      const grid = document.getElementById('runtime-cli-grid');
      if (grid) {
        grid.innerHTML = `<div class="alert alert-blocked">获取 CLI 配置失败: ${escapeHtml(e.message)}</div>`;
      }
    }
  }

  handleProbeTargetChange() {
    const cliSelect = document.getElementById('probe-target-cli');
    const promptInput = document.getElementById('probe-prompt-input');
    if (!cliSelect) return;

    const selectedId = cliSelect.value;
    const cli = store.getState().runtimeClis.find((c) => c.id === selectedId);

    populateModelPicker('probe-model-select', cli);

    if (promptInput && (!promptInput.value.trim() || promptInput.dataset.autoFilled === 'true')) {
      if (cli && cli.defaultProbePrompt) {
        promptInput.value = cli.defaultProbePrompt;
        promptInput.dataset.autoFilled = 'true';
      }
    }
  }

  setProbePreset(presetKey) {
    // Presets removed in streamlined UI
  }

  selectCliDropdown(cliId) {
    const cliSelect = document.getElementById('probe-target-cli');
    if (cliSelect && store.getState().runtimeClis.some((c) => c.id === cliId)) {
      cliSelect.value = cliId;
      this.handleProbeTargetChange();
    }
  }

  selectCliForProbe(cliId) {
    const cli = store.getState().runtimeClis.find((c) => c.id === cliId);
    this.selectCliDropdown(cliId);
    if (cli) {
      const promptInput = document.getElementById('probe-prompt-input');
      if (promptInput) {
        promptInput.value = cli.defaultProbePrompt;
        promptInput.dataset.autoFilled = 'true';
      }
    }
    const card = document.getElementById('probe-console-card');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth' });
    }
  }

  async quickProbeCli(cliId) {
    this.selectCliForProbe(cliId);
    await this.runCliProbe(true);
  }

  async runCliProbe(verify = false) {
    const cliSelect = document.getElementById('probe-target-cli');
    const cwdInput = document.getElementById('probe-cwd-input');
    const promptInput = document.getElementById('probe-prompt-input');
    const runBtn = document.getElementById('btn-run-probe');
    const btnIcon = document.getElementById('probe-btn-icon');
    const btnText = document.getElementById('probe-btn-text');
    const resultContainer = document.getElementById('probe-result-container');
    const badge = document.getElementById('probe-result-badge');
    const meta = document.getElementById('probe-result-meta');
    const outputBox = document.getElementById('probe-output-box');

    const cliId = cliSelect?.value;
    if (!cliId) return;

    const prompt = promptInput?.value || '';
    const model = getModelValue('probe-model-select');
    if (!model) { alert('请填写模型名称。'); return; }
    const timeoutMs = 180000;
    const cwd = cwdInput?.value?.trim() || undefined;

    // Loading UI
    if (runBtn) runBtn.disabled = true;
    if (btnIcon) btnIcon.textContent = '⏳';
    if (btnText) btnText.textContent = '正在探测中...';

    if (resultContainer) resultContainer.style.display = 'block';
    if (badge) {
      badge.className = 'badge badge-running';
      badge.textContent = '正在探测...';
    }
    if (meta) meta.textContent = `发送至 ${cliId}，等待回包...`;
    if (outputBox) outputBox.textContent = `[CBWorkBench Probe] 正在向 CLI '${cliId}' 发送请求...\n提示词: "${prompt}"\n超时设置: ${timeoutMs}ms\n\n请稍候...`;

    try {
      const data = await api.probeCli({ cliId, ...(verify ? {verify:true} : {prompt}), model, cwd });
      if (!data.success || !data.result) {
        throw new Error(data.message || 'Probe request returned failure');
      }

      const r = data.result;
      store.setState({ currentProbeResult: r });

      if (r.ok && (!verify || r.markerMatched)) {
        badge.className = 'badge badge-completed';
        badge.textContent = '探测成功 · AVAILABLE';
      } else if (r.errorCode === 'AUTH_REQUIRED') {
        badge.className = 'badge badge-pending_confirm';
        badge.textContent = '需身份验证 · AUTH_REQUIRED';
      } else {
        badge.className = 'badge badge-blocked';
        badge.textContent = '探测失败 · ERROR';
      }

      const metaParts = [`耗时: ${r.durationMs}ms`];
      if (r.backend) metaParts.push(`后端: ${r.backend}`);
      if (r.modelUsed) metaParts.push(`模型: ${r.modelUsed}`);
      if (r.sessionId) metaParts.push(`会话: ${r.sessionId.slice(0, 8)}...`);
      meta.textContent = metaParts.join(' | ');

      let displayOutput = '';
      if (r.commandPreview) {
        displayOutput += `[命令执行] ${r.commandPreview}\n`;
      }
      if (r.connectionType) {
        displayOutput += `[连接通道] ${r.connectionType}\n`;
      }
      displayOutput += `[执行状态] ${r.ok ? '✅ 成功' : '❌ 失败'}`;
      if (r.errorCode) displayOutput += ` (错误代码: ${r.errorCode})`;
      displayOutput += `  [耗时] ${r.durationMs}ms\n`;
      displayOutput += `------------------------------------------------------------\n`;

      if (r.output) {
        displayOutput += `[标准输出 / 回包内容]\n${r.output}\n`;
      }

      if (r.error) {
        displayOutput += `\n[错误信息]\n${r.error}\n`;
      }

      if (r.errorCode === 'AUTH_REQUIRED') {
        displayOutput += `\n💡 [排查建议]\n- 若使用独立 CLI，请执行: node bin/agent.js login workbuddy\n`;
      }

      outputBox.textContent = displayOutput;
    } catch (err) {
      if (badge) {
        badge.className = 'badge badge-blocked';
        badge.textContent = '请求异常';
      }
      if (meta) meta.textContent = '无法连通工作台后端服务';
      if (outputBox) outputBox.textContent = `[Error] ${err.message}`;
    } finally {
      if (runBtn) runBtn.disabled = false;
      if (btnIcon) btnIcon.textContent = '🚀';
      if (btnText) btnText.textContent = '发送提示词探测';
    }
  }

  copyProbeOutput() {
    copyToClipboard('probe-output-box');
  }

  // --- System Metadata & Helpers ---

  async fetchSystemStatus() {
    try {
      const data = await api.getSystemStatus();
      if (data.success && data.status) {
        const s = data.status;
        const pillNode = document.getElementById('pill-node');
        const pillWb = document.getElementById('pill-wb');
        const pillCodex = document.getElementById('pill-codex');

        if (pillNode) pillNode.textContent = `Node ${s.nodeVersion} SQLite`;
        if (pillWb) pillWb.textContent = `Worker: ${s.workerModel==='default'?'沿用CLI配置':s.workerModel}`;
        if (pillCodex) pillCodex.textContent = `Reviewer: ${s.verifierModel==='default'?'沿用CLI配置':s.verifierModel}`;
      }
    } catch (e) {
      console.warn('Failed to fetch system status:', e);
    }
  }

  async fetchExecutors() {
    try {
      const data = await api.getExecutors();
      if (data.success) {
        const availableWorkers = data.workers || [];
        const availableReviewers = data.reviewers || [];
        store.setState({ availableWorkers, availableReviewers });
        this.populateExecutorSelects();
      }
    } catch (e) {
      console.warn('Failed to fetch executors:', e);
    }
  }

  populateExecutorSelects(selectedWorker, selectedWorkerModel, selectedReviewer, selectedReviewerModel) {
    const { availableWorkers, availableReviewers } = store.getState();
    const workerSelect = document.getElementById('select-worker-executor');
    const reviewerSelect = document.getElementById('select-reviewer-executor');

    if (workerSelect && availableWorkers.length > 0) {
      workerSelect.innerHTML = availableWorkers
        .map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`)
        .join('');
      if (selectedWorker) workerSelect.value = selectedWorker;
      this.handleWorkerExecutorChange(selectedWorkerModel);
    }

    if (reviewerSelect && availableReviewers.length > 0) {
      reviewerSelect.innerHTML = availableReviewers
        .map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`)
        .join('');
      if (selectedReviewer) reviewerSelect.value = selectedReviewer;
      this.handleReviewerExecutorChange(selectedReviewerModel);
    }
  }

  handleWorkerExecutorChange(preferredModel) {
    const { availableWorkers } = store.getState();
    const workerSelect = document.getElementById('select-worker-executor');
    if (!workerSelect) return;

    const worker = availableWorkers.find((w) => w.id === workerSelect.value);
    populateModelPicker('select-worker-model', worker, preferredModel);
  }

  handleReviewerExecutorChange(preferredModel) {
    const { availableReviewers } = store.getState();
    const reviewerSelect = document.getElementById('select-reviewer-executor');
    if (!reviewerSelect) return;

    const reviewer = availableReviewers.find((r) => r.id === reviewerSelect.value);
    populateModelPicker('select-reviewer-model', reviewer, preferredModel);
  }

  handleModelSelectionChange(id) { updateModelPicker(id); }

  toggleDrawer(id) {
    toggleDrawer(id);
  }

  copyToClipboard(id) {
    copyToClipboard(id);
  }
}

// 实例化并挂载到 window.app，确保 HTML 中的 onclick 兼容
export const app = new App();
window.app = app;
