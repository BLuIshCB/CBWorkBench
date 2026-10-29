// CBWorkBench Frontend Application Controller (Streamlined & Multi-Adapter Debugger)

const API_BASE = window.location.origin;

class App {
  constructor() {
    this.currentFilter = 'all';
    this.currentTaskId = null;
    this.tasks = [];
    this.pollInterval = null;
    this.activeDetailTab = 'overview';
    this.currentMaterialSubtab = 'task';
    this.latestMaterials = null;
    this.availableWorkers = [];
    this.availableReviewers = [];
    this.runtimeClis = [];
    this.currentProbeResult = null;
    this.init();
  }

  async init() {
    this.handleRoute();
    window.addEventListener('popstate', () => this.handleRoute());
    await this.fetchSystemStatus();
    await this.fetchExecutors();
    this.startPolling();
  }

  handleRoute() {
    const path = window.location.pathname;
    if (path === '/runtime') {
      this.showRuntimeView(false);
    } else {
      const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9_\-]+)/);
      if (taskMatch) {
        this.showTaskDetails(taskMatch[1], false);
      } else {
        this.showTaskList(false);
      }
    }
  }

  navigateTo(path) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    this.handleRoute();
  }

  updateNavTabs(activeTab) {
    const tabTasks = document.getElementById('nav-tab-tasks');
    const tabRuntime = document.getElementById('nav-tab-runtime');
    if (tabTasks) tabTasks.classList.toggle('active', activeTab === 'tasks');
    if (tabRuntime) tabRuntime.classList.toggle('active', activeTab === 'runtime');
  }

  startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(() => {
      if (this.currentTaskId) {
        this.fetchTaskDetail(this.currentTaskId, true);
      } else {
        this.fetchTasks();
      }
    }, 2500);
  }

  async fetchSystemStatus() {
    try {
      const res = await fetch(`${API_BASE}/api/system/status`);
      const data = await res.json();
      if (data.success && data.status) {
        const s = data.status;
        const pillNode = document.getElementById('pill-node');
        const pillWb = document.getElementById('pill-wb');
        const pillCodex = document.getElementById('pill-codex');

        if (pillNode) pillNode.textContent = `Node ${s.nodeVersion} SQLite`;
        if (pillWb) pillWb.textContent = `Worker: ${s.workerModel}`;
        if (pillCodex) pillCodex.textContent = `Reviewer: ${s.workerModel}`;
      }
    } catch (e) {
      console.warn('Failed to fetch system status:', e);
    }
  }

  async fetchExecutors() {
    try {
      const res = await fetch(`${API_BASE}/api/system/executors`);
      const data = await res.json();
      if (data.success) {
        this.availableWorkers = data.workers || [];
        this.availableReviewers = data.reviewers || [];
        this.populateExecutorSelects();
      }
    } catch (e) {
      console.warn('Failed to fetch executors:', e);
    }
  }

  populateExecutorSelects(selectedWorker, selectedWorkerModel, selectedReviewer, selectedReviewerModel) {
    const workerSelect = document.getElementById('select-worker-executor');
    const reviewerSelect = document.getElementById('select-reviewer-executor');

    if (workerSelect && this.availableWorkers.length > 0) {
      workerSelect.innerHTML = this.availableWorkers
        .map((w) => `<option value="${w.id}">${this.escapeHtml(w.name)}</option>`)
        .join('');
      if (selectedWorker) workerSelect.value = selectedWorker;
      this.handleWorkerExecutorChange(selectedWorkerModel);
    }

    if (reviewerSelect && this.availableReviewers.length > 0) {
      reviewerSelect.innerHTML = this.availableReviewers
        .map((r) => `<option value="${r.id}">${this.escapeHtml(r.name)}</option>`)
        .join('');
      if (selectedReviewer) reviewerSelect.value = selectedReviewer;
      this.handleReviewerExecutorChange(selectedReviewerModel);
    }
  }

  handleWorkerExecutorChange(preferredModel) {
    const workerSelect = document.getElementById('select-worker-executor');
    const modelSelect = document.getElementById('select-worker-model');
    if (!workerSelect || !modelSelect) return;

    const worker = this.availableWorkers.find((w) => w.id === workerSelect.value);
    const models = worker ? worker.supportedModels : ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-coder'];

    modelSelect.innerHTML = models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join('');

    if (preferredModel && models.includes(preferredModel)) {
      modelSelect.value = preferredModel;
    } else if (worker && worker.defaultModel) {
      modelSelect.value = worker.defaultModel;
    }
  }

  handleReviewerExecutorChange(preferredModel) {
    const reviewerSelect = document.getElementById('select-reviewer-executor');
    const modelSelect = document.getElementById('select-reviewer-model');
    if (!reviewerSelect || !modelSelect) return;

    const reviewer = this.availableReviewers.find((r) => r.id === reviewerSelect.value);
    const models = reviewer ? reviewer.supportedModels : ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-coder'];

    modelSelect.innerHTML = models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join('');

    if (preferredModel && models.includes(preferredModel)) {
      modelSelect.value = preferredModel;
    } else if (reviewer && reviewer.defaultModel) {
      modelSelect.value = reviewer.defaultModel;
    }
  }

  // --- Task List View ---

  showTaskList(pushHistory = true) {
    this.currentTaskId = null;
    if (pushHistory) window.history.pushState({}, '', '/');
    this.updateNavTabs('tasks');
    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'none';
    document.getElementById('view-task-details').style.display = 'none';
    document.getElementById('view-task-list').style.display = 'block';
    this.fetchTasks();
  }

  setFilter(filter) {
    this.currentFilter = filter;
    document.querySelectorAll('.filter-tabs .tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    this.renderTaskGrid();
  }

  async refreshTaskList() {
    await this.fetchTasks();
    await this.fetchSystemStatus();
  }

  async fetchTasks() {
    try {
      const res = await fetch(`${API_BASE}/api/tasks`);
      const data = await res.json();
      if (data.success) {
        this.tasks = data.tasks || [];
        this.updateFilterCounts();
        this.renderTaskGrid();
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    }
  }

  updateFilterCounts() {
    const counts = {
      all: this.tasks.length,
      pending_confirm: 0,
      running: 0,
      human_review: 0,
      blocked: 0,
      completed: 0,
    };

    for (const t of this.tasks) {
      if (counts[t.status] !== undefined) {
        counts[t.status]++;
      }
    }

    const setEl = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setEl('count-all', counts.all);
    setEl('count-pending', counts.pending_confirm);
    setEl('count-running', counts.running);
    setEl('count-review', counts.human_review);
    setEl('count-blocked', counts.blocked);
    setEl('count-completed', counts.completed);
  }

  renderTaskGrid() {
    const grid = document.getElementById('task-grid');
    if (!grid) return;

    let filtered = this.tasks;
    if (this.currentFilter !== 'all') {
      filtered = this.tasks.filter((t) => t.status === this.currentFilter);
    }

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
          <p style="font-size: 15px; margin-bottom: 8px;">暂无相关任务</p>
          <p style="font-size: 12px;">使用配套 Skill <code>cb-flow</code> 制定任务包并通过 MCP 提交，或在聊天中告诉主 Agent 提交开发任务。</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered
      .map((t) => {
        const badgeClass = `badge-${t.status}`;
        const badgeText = this.formatStatus(t.status);
        const cwdDisplay = t.confirmed_cwd || t.target_cwd;
        const commitText = t.git_commit ? `Git: ${t.git_commit}` : 'No Git';
        const roundText = t.current_round > 0 ? `第 ${t.current_round} 轮` : '尚未开始';
        const workerText = `${t.worker_executor || 'workbuddy'}:${t.worker_model || 'deepseek-v4-flash'}`;

        return `
        <div class="task-card" onclick="app.showTaskDetails('${t.id}')">
          <div class="task-card-header">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="badge ${badgeClass}">${badgeText}</span>
              <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">r${t.revision}</span>
            </div>
            <button class="btn-card-delete" title="删除此任务及方案和文件" onclick="app.handleDeleteTask(event, '${t.id}', '${this.escapeHtml(t.title)}')">
              🗑️ 删除
            </button>
          </div>
          <div class="task-card-title">${this.escapeHtml(t.title)}</div>
          <div class="task-card-meta">
            <div>标识：<code>${this.escapeHtml(t.task_key)}</code></div>
            <div>路径：<code>${this.escapeHtml(cwdDisplay)}</code></div>
            <div>模型：<code style="color: #58a6ff;">${this.escapeHtml(workerText)}</code></div>
          </div>
          <div class="task-card-footer">
            <span>${roundText}</span>
            <span>${commitText}</span>
          </div>
        </div>
      `;
      })
      .join('');
  }

  // --- Task Details View ---

  async showTaskDetails(taskId, pushHistory = true) {
    this.currentTaskId = taskId;
    if (pushHistory) window.history.pushState({}, '', `/tasks/${taskId}`);
    this.updateNavTabs('tasks');
    document.getElementById('view-task-list').style.display = 'none';
    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'none';
    document.getElementById('view-task-details').style.display = 'block';
    await this.fetchTaskDetail(taskId, false);
  }

  setDetailTab(tabName) {
    this.activeDetailTab = tabName;
    document.querySelectorAll('.detail-tabs .dtab-btn').forEach((btn) => {
      const match = btn.getAttribute('onclick')?.includes(tabName);
      btn.classList.toggle('active', !!match);
    });
    document.querySelectorAll('.dtab-content').forEach((content) => {
      content.classList.toggle('active', content.id === `dtab-${tabName}`);
    });
  }

  async fetchTaskDetail(taskId, isSilent = false) {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}`);
      const data = await res.json();
      if (!data.success || !data.task) {
        if (!isSilent) alert('获取任务详情失败：' + (data.message || '任务不存在'));
        return;
      }
      this.renderTaskDetail(data);
    } catch (e) {
      console.error('Error fetching task detail:', e);
    }
  }

  renderTaskDetail(data) {
    const { task, latestRevision, workerPrompts, rounds, testRuns, acceptanceRuns } = data;

    // 1. Header line
    document.getElementById('detail-task-title').textContent = task.title;
    document.getElementById('detail-task-key').textContent = task.task_key;
    document.getElementById('detail-task-rev').textContent = `r${task.revision}`;
    document.getElementById('detail-current-round').textContent = task.current_round;
    document.getElementById('detail-max-rounds').textContent = task.budget_max_rounds;
    document.getElementById('detail-created-at').textContent = new Date(task.created_at).toLocaleString();

    const workerEl = document.getElementById('detail-worker-info');
    if (workerEl) {
      workerEl.textContent = `${task.worker_executor || 'workbuddy'}:${task.worker_model || 'deepseek-v4-flash'}`;
    }
    const reviewerEl = document.getElementById('detail-reviewer-info');
    if (reviewerEl) {
      reviewerEl.textContent = `${task.reviewer_executor || 'workbuddy'}:${task.reviewer_model || 'deepseek-v4-flash'}`;
    }

    const badge = document.getElementById('detail-status-badge');
    badge.className = `badge badge-${task.status}`;
    badge.textContent = this.formatStatus(task.status);

    // 2. Action buttons in summary
    const actionsContainer = document.getElementById('detail-actions-container');
    actionsContainer.innerHTML = '';

    if (task.status === 'running') {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn btn-danger';
      stopBtn.textContent = '停止后续执行';
      stopBtn.onclick = () => this.handleStopTask();
      actionsContainer.appendChild(stopBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-outline-danger';
    deleteBtn.innerHTML = '🗑️ 删除任务';
    deleteBtn.title = '删除此任务并一并清理相关方案和文件';
    deleteBtn.onclick = () => this.handleDeleteCurrentTask();
    actionsContainer.appendChild(deleteBtn);

    // 3. Gate 2 Confirmation Card
    const gate2Card = document.getElementById('gate2-card');
    if (task.status === 'pending_confirm') {
      gate2Card.style.display = 'block';
      const inputCwd = document.getElementById('input-confirmed-cwd');
      if (inputCwd && !inputCwd.value) {
        inputCwd.value = task.target_cwd;
      }

      this.populateExecutorSelects(
        task.worker_executor || 'workbuddy',
        task.worker_model || 'deepseek-v4-flash',
        task.reviewer_executor || 'workbuddy',
        task.reviewer_model || 'deepseek-v4-flash'
      );

      document.getElementById('gate2-git-info').innerHTML = `
        <span style="color: var(--text-muted);">提交默认目录：</span> <code>${this.escapeHtml(task.target_cwd)}</code>
        ${task.git_commit ? ` | <span style="color: var(--text-muted);">基准 HEAD：</span> <code>${task.git_commit}</code>` : ''}
      `;
    } else {
      gate2Card.style.display = 'none';
    }

    // 4. Gate 3 Human Review Card
    const gate3Card = document.getElementById('gate3-card');
    gate3Card.style.display = task.status === 'human_review' ? 'flex' : 'none';

    // 5. Blocked Alert
    const blockedAlert = document.getElementById('blocked-alert');
    if (task.status === 'blocked') {
      blockedAlert.style.display = 'flex';
      document.getElementById('blocked-reason-text').textContent = task.blocked_reason || '执行受阻或超出预算';
    } else {
      blockedAlert.style.display = 'none';
    }

    // 6. Stepper States
    this.updateStepper(task.current_stage, task.status);

    // 7. Git Metadata
    document.getElementById('git-root').textContent = task.git_root || '(未识别 Git 根目录)';
    document.getElementById('git-branch').textContent = task.git_branch || 'HEAD';
    document.getElementById('git-commit').textContent = task.git_commit || '(无)';
    document.getElementById('git-status').textContent = task.git_status || 'Clean';

    // 8. Rounds & Evidence Timeline (Model Debugger)
    this.renderRoundsTimeline(rounds, testRuns, acceptanceRuns);

    // 9. Materials Content (Markdown Reader)
    this.latestMaterials = {
      task_md: latestRevision?.task_md || '# 无任务说明',
      development_md: latestRevision?.development_md || '# 无开发清单',
      tests_md: latestRevision?.tests_md || '# 无测试用例',
      acceptance_md: latestRevision?.acceptance_md || '# 无验收标准',
      workerPrompts: workerPrompts || [],
    };
    this.renderCurrentMaterial();
  }

  updateStepper(stage, status) {
    const steps = ['worker', 'tests', 'codex', 'review'];
    steps.forEach((s) => {
      const el = document.getElementById(`step-${s}`);
      if (el) {
        el.classList.remove('active', 'passed');
      }
    });

    if (status === 'completed') {
      steps.forEach((s) => document.getElementById(`step-${s}`)?.classList.add('passed'));
      return;
    }

    const mapping = {
      worker_dev: 'worker',
      worker_review: 'worker',
      running_tests: 'tests',
      codex_acceptance: 'codex',
      human_review: 'review',
    };

    const activeStep = mapping[stage];
    if (activeStep) {
      const activeIdx = steps.indexOf(activeStep);
      for (let i = 0; i < activeIdx; i++) {
        document.getElementById(`step-${steps[i]}`)?.classList.add('passed');
      }
      document.getElementById(`step-${activeStep}`)?.classList.add('active');
    }
  }

  // --- Model Debugger: Rounds & Model Logs ---

  renderRoundsTimeline(rounds, testRuns, acceptanceRuns) {
    const container = document.getElementById('rounds-timeline');
    if (!container) return;

    if (!rounds || rounds.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); padding: 30px; text-align: center;">任务尚未产生执行轮次记录。</div>';
      return;
    }

    // Group by round_number
    const grouped = {};
    for (const r of rounds) {
      if (!grouped[r.round_number]) grouped[r.round_number] = [];
      grouped[r.round_number].push(r);
    }

    const roundNumbers = Object.keys(grouped).sort((a, b) => Number(b) - Number(a));

    container.innerHTML = roundNumbers
      .map((rn) => {
        const roundRounds = grouped[rn];
        const roundTests = (testRuns || []).filter((t) => t.round_number === Number(rn));
        const roundAcceptance = (acceptanceRuns || []).find((a) => a.round_number === Number(rn));

        return `
        <div class="card round-card" style="margin-bottom: 20px;">
          <div class="round-card-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--surface-border); padding-bottom: 10px; margin-bottom: 14px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <h4 style="font-size: 15px; color: #f0f6fc;">第 ${rn} 轮执行与模型调试</h4>
              <span class="dbg-pill" style="color: #79c0ff; border-color: rgba(56, 139, 253, 0.4);">
                Stage: ${this.formatStage(roundRounds[roundRounds.length - 1]?.stage)}
              </span>
            </div>
            <span style="font-size: 12px; color: var(--text-muted);">${new Date(roundRounds[0].started_at).toLocaleTimeString()}</span>
          </div>

          <!-- Round Stages Model Debugger -->
          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${roundRounds
              .map(
                (r, idx) => {
                  const roundDomId = `round-${rn}-step-${idx}`;
                  const durationSec = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : (r.finished_at && r.started_at ? ((r.finished_at - r.started_at)/1000).toFixed(1)+'s' : '--');
                  const adapterLabel = r.adapter_id ? `${r.adapter_id} (${r.model_name || 'default'})` : (r.worker_id || 'workbuddy');

                  return `
              <div style="background: #0d1117; padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: 600; color: #58a6ff; font-size: 13px;">${this.formatStage(r.stage)}</span>
                    <span class="dbg-pill" style="color: #a371f7; background: rgba(163, 113, 247, 0.1);">
                      ${this.escapeHtml(adapterLabel)}
                    </span>
                    <span style="font-size: 11px; color: var(--text-muted);">耗时: ${durationSec}</span>
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <span class="badge ${r.status === 'passed' ? 'badge-completed' : r.status === 'failed' ? 'badge-blocked' : 'badge-running'}">${r.status}</span>
                  </div>
                </div>

                <!-- Debugger Action Controls -->
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                  ${r.input_prompt ? `
                    <button class="dbg-btn" onclick="app.toggleDrawer('${roundDomId}-prompt')">🔍 查看 Prompt 输入</button>
                    <button class="dbg-btn" onclick="app.copyToClipboard('${roundDomId}-prompt-content')">📋 复制 Prompt</button>
                  ` : ''}
                  ${r.output_text ? `
                    <button class="dbg-btn" onclick="app.toggleDrawer('${roundDomId}-output')">📜 查看模型响应 Output</button>
                    <button class="dbg-btn" onclick="app.copyToClipboard('${roundDomId}-output-content')">📋 复制 Response</button>
                  ` : ''}
                </div>

                <!-- Collapsible Input Prompt Drawer -->
                ${r.input_prompt ? `
                  <div id="${roundDomId}-prompt" class="dbg-drawer" style="display: none;">
                    <div style="font-size: 11px; color: #79c0ff; margin-bottom: 4px; font-weight: 600;">模型完整输入提示词 (Prompt)：</div>
                    <pre id="${roundDomId}-prompt-content" class="code-block" style="font-size: 11px; max-height: 260px; overflow-y: auto; white-space: pre-wrap;">${this.escapeHtml(r.input_prompt)}</pre>
                  </div>
                ` : ''}

                <!-- Collapsible Output Drawer -->
                ${r.output_text ? `
                  <div id="${roundDomId}-output" class="dbg-drawer" style="display: block;">
                    <div style="font-size: 11px; color: #56d364; margin-bottom: 4px; font-weight: 600;">模型输出与执行日志：</div>
                    <pre id="${roundDomId}-output-content" class="code-block" style="font-size: 11px; max-height: 220px; overflow-y: auto; white-space: pre-wrap;">${this.escapeHtml(r.output_text)}</pre>
                  </div>
                ` : ''}

                ${r.error_message ? `<div style="color: #ff7b72; font-size: 12px; margin-top: 6px; padding: 6px 10px; background: rgba(255, 123, 114, 0.1); border-radius: 4px;">❌ 错误信息：${this.escapeHtml(r.error_message)}</div>` : ''}
              </div>
            `;
                }
              )
              .join('')}

            <!-- Tests Evidence -->
            ${
              roundTests.length > 0
                ? `
              <div style="background: #0d1117; padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="font-weight: 600; color: #79c0ff; margin-bottom: 8px; font-size: 13px;">独立自动化测试命令执行结果：</div>
                ${roundTests
                  .map(
                    (t) => `
                  <div style="font-size: 12px; margin-bottom: 6px; padding: 6px 10px; background: rgba(255,255,255,0.02); border-radius: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <div>
                        <span style="color: ${t.passed ? '#56d364' : '#ff7b72'}; font-weight: bold;">[${t.passed ? 'PASS' : 'FAIL'}]</span>
                        <code style="margin-left: 6px;">${this.escapeHtml(t.command)}</code>
                      </div>
                      <span style="color: var(--text-muted); font-size: 11px;">Exit: ${t.exit_code}</span>
                    </div>
                    ${t.stderr && !t.passed ? `<pre style="color: #ff7b72; font-size: 11px; background: rgba(255,0,0,0.1); padding: 6px; margin-top: 4px; border-radius: 4px; overflow-x: auto;">${this.escapeHtml(t.stderr)}</pre>` : ''}
                    ${t.stdout && !t.passed ? `<pre style="color: #8b949e; font-size: 11px; padding: 4px; margin-top: 2px; overflow-x: auto;">${this.escapeHtml(t.stdout)}</pre>` : ''}
                  </div>
                `
                  )
                  .join('')}
              </div>
            `
                : ''
            }

            <!-- Reviewer Acceptance Evidence -->
            ${
              roundAcceptance
                ? `
              <div style="background: #0d1117; padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border); border-left: 4px solid #bc8cff;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <span style="font-weight: 600; color: #bc8cff; font-size: 13px;">Reviewer 自动验收评估报告：</span>
                  <span class="badge ${roundAcceptance.decision === 'passed' ? 'badge-completed' : roundAcceptance.decision === 'needs_changes' ? 'badge-pending_confirm' : 'badge-blocked'}">${roundAcceptance.decision}</span>
                </div>
                <div style="font-size: 13px; color: #f0f6fc; margin-bottom: 8px; line-height: 1.5;">${this.escapeHtml(roundAcceptance.summary)}</div>
                ${roundAcceptance.issues_json && roundAcceptance.issues_json !== '[]' ? `
                  <div style="margin-top: 8px; padding: 8px 10px; background: rgba(255, 123, 114, 0.08); border-radius: 4px;">
                    <div style="color: #ff7b72; font-weight: 600; font-size: 12px; margin-bottom: 4px;">待修复 Issues 清单：</div>
                    <pre style="color: #ff7b72; font-size: 11px; white-space: pre-wrap;">${this.escapeHtml(roundAcceptance.issues_json)}</pre>
                  </div>
                ` : ''}
              </div>
            `
                : ''
            }
          </div>
        </div>
      `;
      })
      .join('');
  }

  toggleDrawer(drawerId) {
    const el = document.getElementById(drawerId);
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }

  copyToClipboard(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.innerText || el.textContent || '';
    navigator.clipboard.writeText(text).then(
      () => alert('已成功复制到剪贴板！'),
      () => alert('复制失败，请手动选择复制。')
    );
  }

  // --- Frozen Task Materials: Markdown Reader ---

  setMaterialSubtab(subtab) {
    this.currentMaterialSubtab = subtab;
    const tabs = ['task', 'dev', 'tests', 'acceptance', 'worker'];
    tabs.forEach((t) => {
      const btn = document.getElementById(`mat-btn-${t}`);
      if (btn) btn.classList.toggle('active', t === subtab);
    });
    this.renderCurrentMaterial();
  }

  renderCurrentMaterial() {
    const container = document.getElementById('mat-rendered-content');
    if (!container || !this.latestMaterials) return;

    let mdText = '';
    switch (this.currentMaterialSubtab) {
      case 'task':
        mdText = this.latestMaterials.task_md;
        break;
      case 'dev':
        mdText = this.latestMaterials.development_md;
        break;
      case 'tests':
        mdText = this.latestMaterials.tests_md;
        break;
      case 'acceptance':
        mdText = this.latestMaterials.acceptance_md;
        break;
      case 'worker':
        if (this.latestMaterials.workerPrompts && this.latestMaterials.workerPrompts.length > 0) {
          mdText = this.latestMaterials.workerPrompts
            .map((w) => `### Worker: ${w.worker_id} (${w.role})\n\n${w.prompt_text}`)
            .join('\n\n---\n\n');
        } else {
          mdText = '*未定义独立 Worker 提示词*';
        }
        break;
    }

    container.innerHTML = this.renderMarkdown(mdText);
  }

  /**
   * 极简且强大的 Markdown 渲染器，将 Markdown 文本转换成美观的 HTML 结构
   */
  renderMarkdown(md) {
    if (!md) return '<p style="color: var(--text-muted);">(无内容)</p>';

    // 1. 抽取并临时保护代码块 ``` ... ```
    const codeBlocks = [];
    let text = md.replace(/```([a-zA-Z0-9_\-]*)?\n([\s\S]*?)```/g, (_, lang, code) => {
      const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push({ lang: lang || '', code: this.escapeHtml(code.trim()) });
      return placeholder;
    });

    // 2. 抽取并保护单行代码 `...`
    const inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
      inlineCodes.push(this.escapeHtml(code));
      return placeholder;
    });

    // 3. 转义普通 HTML 字符防止 XSS
    text = this.escapeHtml(text);

    // 4. 标题解析
    text = text.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
    text = text.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
    text = text.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
    text = text.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

    // 5. 分割线
    text = text.replace(/^---+$/gm, '<hr>');

    // 6. 引用块
    text = text.replace(/^>\s+(.*)$/gm, '<blockquote>$1</blockquote>');

    // 7. 加粗与斜体
    text = text.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');

    // 8. 链接
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color: #58a6ff;">$1</a>');

    // 9. Markdown 表格转换
    text = text.replace(/((?:^\|.+?\|\s*$\n?)+)/gm, (tableMatch) => {
      const lines = tableMatch.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return tableMatch;

      // Check if second line is separator like | --- | :--- |
      if (!lines[1].includes('---')) return tableMatch;

      const parseCells = (row) =>
        row
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const headers = parseCells(lines[0]);
      const rows = lines.slice(2).map(parseCells);

      let tableHtml = '<table><thead><tr>';
      headers.forEach((h) => {
        tableHtml += `<th>${h}</th>`;
      });
      tableHtml += '</tr></thead><tbody>';

      rows.forEach((r) => {
        tableHtml += '<tr>';
        r.forEach((cell) => {
          tableHtml += `<td>${cell}</td>`;
        });
        tableHtml += '</tr>';
      });

      tableHtml += '</tbody></table>';
      return tableHtml;
    });

    // 10. 列表 (有序与无序)
    text = text.replace(/^\s*-\s+\[ \]\s+(.*)$/gm, '<li style="list-style-type: none;">☐ $1</li>');
    text = text.replace(/^\s*-\s+\[x\]\s+(.*)$/gm, '<li style="list-style-type: none; color: #56d364;">☑ $1</li>');
    text = text.replace(/^\s*-\s+(.*)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
    text = text.replace(/<\/ul>\s*<ul>/g, ''); // 合并连续列表

    // 11. 段落分行
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => {
        const trimmed = p.trim();
        if (!trimmed) return '';
        if (
          trimmed.startsWith('<h') ||
          trimmed.startsWith('<ul') ||
          trimmed.startsWith('<table') ||
          trimmed.startsWith('<blockquote') ||
          trimmed.startsWith('<hr') ||
          trimmed.startsWith('__CODE_BLOCK')
        ) {
          return trimmed;
        }
        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');

    // 12. 还原代码块与行内代码
    let result = paragraphs;
    inlineCodes.forEach((code, idx) => {
      result = result.replace(new RegExp(`__INLINE_CODE_${idx}__`, 'g'), `<code>${code}</code>`);
    });
    codeBlocks.forEach((block, idx) => {
      result = result.replace(
        new RegExp(`__CODE_BLOCK_${idx}__`, 'g'),
        `<pre><code class="language-${block.lang}">${block.code}</code></pre>`
      );
    });

    return result;
  }

  // --- Actions ---

  async handleConfirmStart() {
    if (!this.currentTaskId) return;
    const inputCwd = document.getElementById('input-confirmed-cwd');
    const confirmedCwd = inputCwd ? inputCwd.value.trim() : undefined;

    const workerSelect = document.getElementById('select-worker-executor');
    const workerModelSelect = document.getElementById('select-worker-model');
    const reviewerSelect = document.getElementById('select-reviewer-executor');
    const reviewerModelSelect = document.getElementById('select-reviewer-model');

    const workerExecutor = workerSelect?.value;
    const workerModel = workerModelSelect?.value;
    const reviewerExecutor = reviewerSelect?.value;
    const reviewerModel = reviewerModelSelect?.value;

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${this.currentTaskId}/confirm-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed_cwd: confirmedCwd,
          worker_executor: workerExecutor,
          worker_model: workerModel,
          reviewer_executor: reviewerExecutor,
          reviewer_model: reviewerModel,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await this.fetchTaskDetail(this.currentTaskId);
      } else {
        alert('启动失败：' + data.message);
      }
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  async handleStopTask() {
    if (!this.currentTaskId) return;
    if (!confirm('确定要停止后续执行吗？当前正在调用的操作返回后将终止派发。')) return;

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${this.currentTaskId}/stop`, {
        method: 'POST',
      });
      const data = await res.json();
      alert(data.message);
      await this.fetchTaskDetail(this.currentTaskId);
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
      `确定要删除任务「${taskTitle || taskId}」吗？\n\n⚠️ 此操作将一并删除该任务相关的方案文档、Worker 提示词和磁盘文件，且无法恢复！`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${taskId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
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
    if (!this.currentTaskId) return;
    const taskTitle = document.getElementById('detail-task-title')?.textContent || this.currentTaskId;
    const confirmed = confirm(
      `确定要删除任务「${taskTitle}」吗？\n\n⚠️ 此操作将一并删除该任务相关的方案文档、Worker 提示词和磁盘文件，且无法恢复！`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${this.currentTaskId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
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
    if (this.tasks.length === 0) {
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
      const res = await fetch(`${API_BASE}/api/tasks/clear-all`, {
        method: 'POST',
      });
      const data = await res.json();
      this.closeClearAllModal();
      if (data.success) {
        alert(data.message || '所有任务及相关方案和文件已成功清空');
        await this.fetchTasks();
      } else {
        alert('清空失败：' + (data.message || '未知错误'));
      }
    } catch (e) {
      alert('请求失败：' + e.message);
    }
  }

  async handleResumeBlocked() {
    if (!this.currentTaskId) return;
    await this.handleConfirmStart();
  }

  async handleHumanDecision(action) {
    if (!this.currentTaskId) return;
    if (action === 'approve') {
      if (!confirm('确认审核通过此任务？任务将被标记为已完成。')) return;
      try {
        const res = await fetch(`${API_BASE}/api/tasks/${this.currentTaskId}/human-review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', reason: '人工审核通过' }),
        });
        const data = await res.json();
        alert(data.message);
        await this.fetchTaskDetail(this.currentTaskId);
      } catch (e) {
        alert('审核失败：' + e.message);
      }
    }
  }

  showRejectModal() {
    document.getElementById('modal-reject').style.display = 'flex';
  }

  closeRejectModal() {
    document.getElementById('modal-reject').style.display = 'none';
    document.getElementById('reject-reason-input').value = '';
  }

  async confirmReject() {
    if (!this.currentTaskId) return;
    const reason = document.getElementById('reject-reason-input').value.trim();
    if (!reason) {
      alert('请填写退回修改原因，以便针对性修复。');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${this.currentTaskId}/human-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', reason }),
      });
      const data = await res.json();
      this.closeRejectModal();
      alert(data.message);
      await this.fetchTaskDetail(this.currentTaskId);
    } catch (e) {
      alert('操作失败：' + e.message);
    }
  }

  // --- Runtime & CLI Diagnostics View ---

  async showRuntimeView(pushHistory = true) {
    this.currentTaskId = null;
    if (pushHistory) window.history.pushState({}, '', '/runtime');
    this.updateNavTabs('runtime');
    document.getElementById('view-task-list').style.display = 'none';
    document.getElementById('view-task-details').style.display = 'none';
    const viewRuntime = document.getElementById('view-runtime');
    if (viewRuntime) viewRuntime.style.display = 'block';
    await this.fetchRuntimeClis();
  }

  async fetchRuntimeClis() {
    try {
      const grid = document.getElementById('runtime-cli-grid');
      if (grid && !this.runtimeClis.length) {
        grid.innerHTML = '<div class="loading-state">正在探测已配置的 CLI 工具...</div>';
      }
      const res = await fetch(`${API_BASE}/api/runtime/clis`);
      const data = await res.json();
      if (data.success && Array.isArray(data.clis)) {
        this.runtimeClis = data.clis;
        this.renderRuntimeClis(data.clis);
        this.populateProbeForm(data.clis);

        const totalEl = document.getElementById('runtime-stat-total');
        if (totalEl) totalEl.textContent = `${data.clis.length} 个`;

        const countEl = document.getElementById('runtime-cli-count');
        if (countEl) countEl.textContent = `共 ${data.clis.length} 个组件`;

        const wbCli = data.clis.find((c) => c.id.startsWith('workbuddy'));
        const wbEl = document.getElementById('runtime-stat-wb');
        if (wbEl && wbCli) {
          wbEl.textContent = wbCli.available ? '就绪 (可用)' : '待配置';
          wbEl.className = wbCli.available ? 'stat-value text-green' : 'stat-value text-muted';
        }

        const codexCli = data.clis.find((c) => c.id === 'codex');
        const codexEl = document.getElementById('runtime-stat-codex');
        if (codexEl && codexCli) {
          codexEl.textContent = codexCli.available ? '就绪 (可用)' : '未找到';
          codexEl.className = codexCli.available ? 'stat-value text-green' : 'stat-value text-muted';
        }

        const nodeCli = data.clis.find((c) => c.id === 'node');
        const nodeEl = document.getElementById('runtime-stat-node');
        if (nodeEl && nodeCli) {
          nodeEl.textContent = nodeCli.version || 'Node 24';
        }
      }
    } catch (e) {
      console.warn('Failed to fetch runtime clis:', e);
      const grid = document.getElementById('runtime-cli-grid');
      if (grid) {
        grid.innerHTML = `<div class="alert alert-blocked">获取 CLI 配置失败: ${this.escapeHtml(e.message)}</div>`;
      }
    }
  }

  renderRuntimeClis(clis) {
    const grid = document.getElementById('runtime-cli-grid');
    if (!grid) return;

    if (!clis || !clis.length) {
      grid.innerHTML = '<div class="empty-state">暂未检测到任何 CLI 配置</div>';
      return;
    }

    const icons = {
      'workbuddy-desktop': '🖥️',
      'workbuddy-cli': '💻',
      'codex': '⚖️',
      'node': '🟢',
      'git': '🐙',
    };

    grid.innerHTML = clis.map((cli) => {
      const icon = icons[cli.id] || '⚡';
      const statusBadge = cli.available
        ? '<span class="badge badge-completed">就绪 / 可用</span>'
        : cli.configured
        ? '<span class="badge badge-pending_confirm">已声明 (待检测)</span>'
        : '<span class="badge badge-secondary">未配置</span>';

      const roleBadge = cli.category === 'agent'
        ? '<span class="badge badge-running">Agent 协同</span>'
        : cli.category === 'verifier'
        ? '<span class="badge badge-human_review">验收者</span>'
        : '<span class="badge badge-secondary">系统宿主</span>';

      const envHtml = cli.environmentPreview && Object.keys(cli.environmentPreview).length > 0
        ? `<div class="cli-env-preview">
            <div class="env-title">关键环境变量：</div>
            ${Object.entries(cli.environmentPreview).map(([k, v]) => `<div><code>${this.escapeHtml(k)}=${this.escapeHtml(v)}</code></div>`).join('')}
           </div>`
        : '';

      const modelsHtml = cli.supportedModels && cli.supportedModels.length > 0
        ? `<div class="cli-meta-item">
             <span class="label">支持模型：</span>
             <span class="value"><code class="code-pill">${this.escapeHtml(cli.supportedModels.join(', '))}</code></span>
           </div>`
        : '';

      const versionHtml = cli.version
        ? `<div class="cli-meta-item">
             <span class="label">检测版本：</span>
             <span class="value font-mono">${this.escapeHtml(cli.version)}</span>
           </div>`
        : '';

      return `
        <div class="card cli-card ${cli.available ? 'cli-card-ready' : ''}" id="cli-card-${cli.id}">
          <div class="cli-card-header">
            <div class="cli-title-box">
              <span class="cli-icon">${icon}</span>
              <div>
                <h4 class="cli-name">${this.escapeHtml(cli.name)}</h4>
                <div class="cli-role">${this.escapeHtml(cli.role)}</div>
              </div>
            </div>
            <div class="cli-status-box">
              ${roleBadge}
              ${statusBadge}
            </div>
          </div>

          <div class="cli-card-body">
            <div class="cli-meta-item">
              <span class="label">可执行路径：</span>
              <span class="value"><code class="path-code" title="${this.escapeHtml(cli.executablePath)}">${this.escapeHtml(cli.executablePath)}</code></span>
            </div>
            <div class="cli-meta-item">
              <span class="label">配置来源：</span>
              <span class="value font-mono text-muted" title="${this.escapeHtml(cli.configSource)}">${this.escapeHtml(cli.configSource)}</span>
            </div>
            ${versionHtml}
            ${modelsHtml}
            <div class="cli-meta-item">
              <span class="label">状态诊断：</span>
              <span class="value ${cli.available ? 'text-green' : 'text-muted'}">${this.escapeHtml(cli.statusMessage || '--')}</span>
            </div>
            ${envHtml}
          </div>

          <div class="cli-card-footer">
            <button class="btn btn-sm btn-primary" onclick="app.selectCliForProbe('${cli.id}')">
              🎯 填入探测台
            </button>
            <button class="btn btn-sm btn-secondary" onclick="app.quickProbeCli('${cli.id}')">
              ⚡ 快速探测
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  populateProbeForm(clis) {
    const cliSelect = document.getElementById('probe-target-cli');
    if (!cliSelect) return;

    const previousValue = cliSelect.value;
    cliSelect.innerHTML = clis.map((c) => {
      return `<option value="${c.id}">${this.escapeHtml(c.name)} (${c.id})</option>`;
    }).join('');

    if (previousValue && clis.some((c) => c.id === previousValue)) {
      cliSelect.value = previousValue;
    } else if (clis.some((c) => c.id === 'workbuddy-desktop')) {
      cliSelect.value = 'workbuddy-desktop';
    }

    const cwdInput = document.getElementById('probe-cwd-input');
    if (cwdInput && !cwdInput.value) {
      cwdInput.value = 'D:\\CODE\\AI\\CBWorkBench';
    }

    this.handleProbeTargetChange();
  }

  handleProbeTargetChange() {
    const cliSelect = document.getElementById('probe-target-cli');
    const modelSelect = document.getElementById('probe-model-select');
    const promptInput = document.getElementById('probe-prompt-input');
    if (!cliSelect) return;

    const selectedId = cliSelect.value;
    const cli = this.runtimeClis.find((c) => c.id === selectedId);

    if (modelSelect) {
      if (cli && cli.supportedModels && cli.supportedModels.length) {
        modelSelect.disabled = false;
        modelSelect.innerHTML = cli.supportedModels
          .map((m) => `<option value="${m}" ${m === cli.defaultModel ? 'selected' : ''}>${m}</option>`)
          .join('');
      } else {
        modelSelect.innerHTML = `<option value="">(无需指定模型)</option>`;
        modelSelect.disabled = true;
      }
    }

    if (promptInput && (!promptInput.value.trim() || promptInput.dataset.autoFilled === 'true')) {
      if (cli && cli.defaultProbePrompt) {
        promptInput.value = cli.defaultProbePrompt;
        promptInput.dataset.autoFilled = 'true';
      }
    }
  }

  setProbePreset(presetKey) {
    const promptInput = document.getElementById('probe-prompt-input');
    if (!promptInput) return;
    promptInput.dataset.autoFilled = 'false';

    switch (presetKey) {
      case 'wb_echo':
        promptInput.value = '只回复 WB_ADAPTER_OK。不要调用工具，不要读写文件。';
        this.selectCliDropdown('workbuddy-desktop');
        break;
      case 'pong':
        promptInput.value = '只回复 PONG';
        break;
      case 'codex':
        promptInput.value = '只回复 CODEX_OK，不要多余字符。';
        this.selectCliDropdown('codex');
        break;
      case 'identity':
        promptInput.value = '请用一句话介绍你自己，说明你的模型版本并回答: 1+1等于几？';
        break;
    }
  }

  selectCliDropdown(cliId) {
    const cliSelect = document.getElementById('probe-target-cli');
    if (cliSelect && this.runtimeClis.some((c) => c.id === cliId)) {
      cliSelect.value = cliId;
      this.handleProbeTargetChange();
    }
  }

  selectCliForProbe(cliId) {
    const cli = this.runtimeClis.find((c) => c.id === cliId);
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
    await this.runCliProbe();
  }

  async runCliProbe() {
    const cliSelect = document.getElementById('probe-target-cli');
    const modelSelect = document.getElementById('probe-model-select');
    const timeoutSelect = document.getElementById('probe-timeout-select');
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
    const model = modelSelect && !modelSelect.disabled ? modelSelect.value : undefined;
    const timeoutMs = timeoutSelect ? parseInt(timeoutSelect.value, 10) : 30000;
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
      const res = await fetch(`${API_BASE}/api/runtime/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliId, prompt, model, timeoutMs, cwd }),
      });
      const data = await res.json();

      if (!data.success || !data.result) {
        throw new Error(data.message || 'Probe request returned failure');
      }

      const r = data.result;
      this.currentProbeResult = r;

      if (r.ok) {
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
        displayOutput += `\n💡 [排查建议]\n- 若使用桌面桥接，请确保 WorkBuddy 桌面客户端已启动且已完成登录。\n- 若使用独立 CLI，请执行: node bin/workbuddy.js login\n`;
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
    const outputBox = document.getElementById('probe-output-box');
    if (outputBox && outputBox.textContent) {
      navigator.clipboard.writeText(outputBox.textContent).then(() => {
        alert('探测结果已复制到剪贴板！');
      }).catch(() => {});
    }
  }

  // --- Helpers ---

  formatStatus(status) {
    const map = {
      pending_confirm: '待启动确认',
      queued: '排队中',
      running: '执行中',
      blocked: '异常待处理',
      human_review: '最终人工审核',
      completed: '已完成',
      cancelled: '已取消',
    };
    return map[status] || status;
  }

  formatStage(stage) {
    const map = {
      worker_dev: 'Worker 开发与修复',
      worker_review: 'Worker 审查准备',
      running_tests: '独立必需测试',
      codex_acceptance: 'Reviewer 自动验收',
      human_review: '人工审核门禁',
    };
    return map[stage] || stage;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

const app = new App();
window.app = app;
