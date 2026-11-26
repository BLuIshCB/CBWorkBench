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
import { escapeHtml, copyToClipboard, toggleDrawer, renderMarkdown } from './utils.js';

export class App {
  constructor() {
    this.workflowView = new WorkflowView(this);
    this.resourceCache = new Map();
    this.router = new Router({
      onTaskList: (push) => this.showTaskList(push),
      onTaskDetail: (id, push) => this.showTaskDetails(id, push),
      onWorkflows: (push) => this.showWorkflowView(push),
      onRuntime: (push) => this.showRuntimeView(push),
    });

    this.pollInterval = null;
    this.initHeartbeat();
    this.init();
  }

  async init() {
    try {
      // 加载执行器与工作流
      await this.fetchExecutors();
      await this.workflowView.init();
    } catch (err) {
      console.error('[CBWorkBench] 初始元数据加载失败:', err);
    }

    this.router.handleRoute();

    // 启动智能轮询
    this.startPolling();
  }

  initHeartbeat() {
    const clientId = 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const sendPing = () => {
      fetch('/api/system/ui-heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, action: 'ping' }),
      }).catch(() => {});
    };

    // 立即上报首个心跳确立活跃状态
    sendPing();
    const heartbeatTimer = setInterval(sendPing, 3000);

    // 页面重新可见或获得焦点时立即补发心跳，对抗 Chromium 后台节流 (Timer Throttling)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sendPing();
      }
    });
    window.addEventListener('focus', () => {
      sendPing();
    });

    // 页面关闭或注销时发送离线通知
    window.addEventListener('beforeunload', () => {
      clearInterval(heartbeatTimer);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/system/ui-heartbeat?action=close&clientId=' + encodeURIComponent(clientId));
      }
    });
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

    const currentTab = store.getState().activeDetailTab;
    this.setDetailTab(currentTab === 'rounds' ? 'materials' : (currentTab || 'materials'));

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
      const { availableAdapters, activeDetailTab, currentMaterialSubtab, currentResourcePath } = store.getState();
      refreshExecution(taskId, data.task).catch((error) => console.error('读取执行记录失败', error));
      TaskDetail.render(data, availableAdapters, activeDetailTab, currentMaterialSubtab, currentResourcePath);
    } catch (e) {
      console.error('Error fetching task detail:', e);
    }
  }

  setDetailTab(tabName) {
    const effectiveTab = (!tabName || tabName === 'rounds') ? 'materials' : tabName;
    store.setState({ activeDetailTab: effectiveTab });
    document.querySelectorAll('.detail-tabs .dtab-btn').forEach((btn) => {
      const match = btn.getAttribute('onclick')?.includes(`'${effectiveTab}'`);
      btn.classList.toggle('active', !!match);
    });
    document.querySelectorAll('.dtab-content').forEach((content) => {
      content.classList.toggle('active', content.id === `dtab-${effectiveTab}`);
    });
  }

  setMaterialSubtab(subtab) {
    store.setState({ currentMaterialSubtab: subtab, currentResourcePath: null });
    const currentDetail = store.getState().currentTaskDetail;
    if (currentDetail) {
      TaskDetail.renderMaterialsTabs(currentDetail, subtab, null);
    }
  }

  openSelectedNodeMaterials() {
    this.setDetailTab('materials');
    this.setMaterialSubtab(`node:${TaskDetail.selectedNodeId}`);
    document.getElementById('dtab-materials')?.scrollIntoView({ block: 'start' });
  }

  selectMaterialResource(resourcePath) {
    store.setState({ currentResourcePath: resourcePath });
    const currentDetail = store.getState().currentTaskDetail;
    if (currentDetail) {
      TaskDetail.renderMaterialsTabs(
        currentDetail,
        store.getState().currentMaterialSubtab,
        resourcePath
      );
    }
  }

  invalidateTaskCache(taskId) {
    for (const key of this.resourceCache.keys()) {
      if (key.startsWith(`${taskId}:`)) {
        this.resourceCache.delete(key);
      }
    }
  }

  async loadMaterialResource(taskId, revision, resourcePath, rework) {
    const contentEl = document.getElementById('mat-rendered-content');
    if (!contentEl) return;

    const cacheKey = `${taskId}:r${revision}:${rework ? rework.target_node_id + ':' : ''}${resourcePath}`;
    this.activeMaterialRequest = cacheKey;
    let res = this.resourceCache.get(cacheKey);
    if (!res) {
      contentEl.innerHTML = '<div style="color: var(--text-muted); padding: 16px;">正在读取材料文件...</div>';
      try {
        const fetched = rework
          ? await api.getReworkResource(taskId, revision, rework.target_node_id, rework.sequence)
          : await api.getRevisionResource(taskId, revision, resourcePath, 0, 262144);
        if (this.activeMaterialRequest !== cacheKey) return;
        if (!fetched.success || !fetched.resource) {
          contentEl.innerHTML = `<div class="alert alert-blocked">读取文件失败: ${escapeHtml(fetched.message || '未知错误')}</div>`;
          return;
        }
        res = fetched.resource;
        if (this.resourceCache.size >= 30) {
          const oldestKey = this.resourceCache.keys().next().value;
          this.resourceCache.delete(oldestKey);
        }
        this.resourceCache.set(cacheKey, res);
      } catch (e) {
        if (this.activeMaterialRequest !== cacheKey) return;
        contentEl.innerHTML = `<div class="alert alert-blocked">读取文件异常: ${escapeHtml(e.message)}</div>`;
        return;
      }
    }

    const reworkMeta = rework
      ? `<div class="material-rework-meta">来源 ${escapeHtml(rework.sourceName)}${rework.executionIndex ? ` · 第 ${rework.executionIndex} 次执行` : ''} · ${escapeHtml(new Date(rework.created_at).toLocaleString())}</div>`
      : '';
    const headerHtml = reworkMeta + (res.has_more
      ? `<div style="font-size:12px; color:#d97706; margin-bottom:10px; padding:6px 10px; background:#fffbeb; border:1px solid #fde68a; border-radius:4px;">
           ⚠️ 文件内容过长，仅展示前半部分
         </div>`
      : '');

    if (res.encoding === 'base64') {
      contentEl.innerHTML = `${headerHtml}<p style="color: var(--text-muted);">二进制资源文件</p>`;
      return;
    }

    if (res.path.endsWith('.json')) {
      contentEl.innerHTML = `${headerHtml}<pre class="code-block" style="white-space: pre-wrap;">${escapeHtml(res.content)}</pre>`;
    } else {
      contentEl.innerHTML = `${headerHtml}${renderMarkdown(res.content)}`;
    }
  }

  // --- Task Operations (Gates 2, 3 & Deletions) ---

  async handleConfirmStart() {
    const { currentTaskId } = store.getState();
    if (!currentTaskId) return;

    const inputCwd = document.getElementById('input-confirmed-cwd');
    const confirmedCwd = inputCwd ? inputCwd.value.trim() : undefined;
    const timeoutInput = document.getElementById('execution-timeout-minutes');
    const timeoutMs = timeoutInput ? Number(timeoutInput.value) * 60000 : 3600000;

    try {
      const data = await api.confirmStartTask(currentTaskId, {
        execution_timeout_ms: timeoutMs,
        confirmed_cwd: confirmedCwd,
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
      `确定要删除任务「${taskTitle || taskId}」吗？\n\n⚠️ 此操作将一并删除该任务相关的全部节点材料、历史修订、运行产物和数据库记录，且无法恢复！`
    );
    if (!confirmed) return;

    try {
      const data = await api.deleteTask(taskId);
      if (data.success) {
        this.invalidateTaskCache(taskId);
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
      `确定要删除任务「${taskTitle}」吗？\n\n⚠️ 此操作将一并删除该任务相关的全部节点材料、历史修订、运行产物和数据库记录，且无法恢复！`
    );
    if (!confirmed) return;

    try {
      const data = await api.deleteTask(currentTaskId);
      if (data.success) {
        this.invalidateTaskCache(currentTaskId);
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
        this.resourceCache.clear();
        alert(data.message || '所有任务已成功清空');
        await this.fetchTasks();
      } else {
        alert('清空失败：' + (data.message || '未知错误'));
        await this.fetchTasks();
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

  async fetchRuntimeClis(options = {}) {
    const opts = typeof options === 'boolean' ? { withVersion: options } : options;
    try {
      const grid = document.getElementById('runtime-cli-grid');
      if (grid && !store.getState().runtimeClis.length) {
        grid.innerHTML = '<div class="loading-state">正在探测已配置的 CLI 工具...</div>';
      }
      const data = await api.getRuntimeClis(opts);
      if (data.success && Array.isArray(data.clis)) {
        this.applyRuntimeClis(data.clis, { preferServerModels: Boolean(opts.withVersion || opts.refresh) });
      }
    } catch (e) {
      console.warn('Failed to fetch runtime clis:', e);
      const grid = document.getElementById('runtime-cli-grid');
      if (grid) {
        grid.innerHTML = `<div class="alert alert-blocked">获取 CLI 配置失败: ${escapeHtml(e.message)}</div>`;
      }
    }
  }

  /**
   * 冷启动列表只带静态模型，需要复用初始化时拿到的动态目录；
   * 显式刷新时服务端结果才是最新的，不能再被本地旧列表覆盖。
   */
  applyRuntimeClis(clis, { preferServerModels = false } = {}) {
    const executors = store.getState().availableAdapters || [];
    const merged = clis.map((cli) => {
      const serverModels = Array.isArray(cli.supportedModels) ? cli.supportedModels : [];
      const catalog = executors.find((adapter) => adapter.id === cli.id);
      const localModels = Array.isArray(catalog?.supportedModels) ? catalog.supportedModels : [];
      const models = preferServerModels ? serverModels : (localModels.length ? localModels : serverModels);
      return models.length ? { ...cli, supportedModels: models } : cli;
    });
    store.setState({ runtimeClis: merged });
    RuntimeView.renderClis(merged);
    RuntimeView.populateProbeForm(merged);
    this.handleProbeTargetChange();
  }

  async refreshRuntimePath() {
    try {
      const data = await api.refreshRuntimePath();
      if (data.success !== false && Array.isArray(data.clis)) {
        this.applyRuntimeClis(data.clis);
      }
      const hydration = data.hydration;
      if (hydration && hydration.ok === false) {
        alert(`登录 shell PATH 水合失败：${hydration.failureReason}。已回退到当前 PATH 与已知安装目录。`);
      }
    } catch (e) {
      alert('重新探测 PATH 失败：' + e.message);
    }
  }

  async pickCliFile(cliId, target = 'exe') {
    try {
      const data = await api.pickRuntimeFile();
      if (data.path) {
        const input = document.getElementById(`cli-${target}-input-${cliId}`);
        if (input) input.value = data.path;
      } else if (data.success === false) {
        alert(data.message || '未能取得文件路径，请直接粘贴绝对路径。');
      }
    } catch (e) {
      alert('打开文件选择框失败：' + e.message + '\n请直接粘贴绝对路径。');
    }
  }

  async saveCliPath(cliId) {
    const executable = document.getElementById(`cli-exe-input-${cliId}`)?.value?.trim();
    const script = document.getElementById(`cli-script-input-${cliId}`)?.value?.trim();
    if (!executable) {
      alert('请填写 CLI 入口的绝对路径。');
      return;
    }
    try {
      const data = await api.setRuntimeCliPath({ cliId, executable, script: script || undefined });
      if (data.success === false) {
        alert(data.message || '保存失败');
        return;
      }
      await this.fetchRuntimeClis();
    } catch (e) {
      alert('保存失败：' + e.message);
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

  async fetchExecutors() {
    try {
      const data = await api.getExecutors();
      if (data.success) {
        const availableAdapters = data.agents || data.workers || [];
        store.setState({ availableAdapters, availableWorkers: availableAdapters, availableReviewers: availableAdapters });
      }
    } catch (e) {
      console.warn('Failed to fetch executors:', e);
    }
  }

  selectTaskWorkflowNode(nodeId) {
    TaskDetail.selectedNodeId = nodeId;
    const { currentTaskDetail, availableAdapters } = store.getState();
    if (currentTaskDetail) {
      TaskDetail.renderTaskWorkflow(currentTaskDetail, availableAdapters);
    }
  }

  handleTaskNodeExecutorChange(nodeId, newExecutor) {
    const { availableAdapters } = store.getState();
    const adapter = (availableAdapters || []).find((a) => a.id === newExecutor);
    populateModelPicker('task-node-model-select', adapter, adapter?.defaultModel || 'default');
    this.saveTaskNodeModel(nodeId);
  }

  handleTaskNodeModelSelectionChange(nodeId) {
    updateModelPicker('task-node-model-select');
  }

  async saveTaskNodeModel(nodeId) {
    const { currentTaskId, currentTaskDetail, availableAdapters } = store.getState();
    if (!currentTaskId || !currentTaskDetail) return;
    if (currentTaskDetail.task?.status !== 'pending_confirm') {
      alert('任务已开始执行，节点模型与配置已冻结。');
      return;
    }

    const executorSelect = document.getElementById('task-node-executor-select');
    const executor = executorSelect?.value;
    const model = getModelValue('task-node-model-select');
    const feedbackEl = document.getElementById('task-node-save-feedback');

    try {
      const res = await api.updateTaskWorkflowNode(currentTaskId, nodeId, { executor, model });
      if (res.success) {
        if (feedbackEl) {
          feedbackEl.textContent = '✓ 已保存';
          setTimeout(() => {
            const el = document.getElementById('task-node-save-feedback');
            if (el) el.textContent = '';
          }, 2000);
        }
        if (currentTaskDetail.taskWorkflow) {
          try {
            const nodes = JSON.parse(currentTaskDetail.taskWorkflow.nodes_json);
            const target = nodes.find((n) => n.id === nodeId);
            if (target) {
              if (executor) target.executor = executor;
              if (model) target.model = model;
              currentTaskDetail.taskWorkflow.nodes_json = JSON.stringify(nodes);
            }
          } catch {}
        }
        TaskDetail.renderTaskWorkflow(currentTaskDetail, availableAdapters);
      } else {
        alert('保存模型失败：' + res.message);
      }
    } catch (e) {
      alert('请求异常：' + e.message);
    }
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
