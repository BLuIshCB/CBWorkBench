// CBWorkBench Frontend Application Controller

const API_BASE = window.location.origin;

class App {
  constructor() {
    this.currentFilter = 'all';
    this.currentTaskId = null;
    this.tasks = [];
    this.pollInterval = null;
    this.activeDetailTab = 'overview';
    this.init();
  }

  async init() {
    this.handleRoute();
    window.addEventListener('popstate', () => this.handleRoute());
    await this.fetchSystemStatus();
    this.startPolling();
  }

  handleRoute() {
    const path = window.location.pathname;
    const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9_\-]+)/);
    if (taskMatch) {
      this.showTaskDetails(taskMatch[1]);
    } else {
      this.showTaskList();
    }
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
        if (pillCodex) pillCodex.textContent = `Codex: ${s.verifierModel}`;
      }
    } catch (e) {
      console.warn('Failed to fetch system status:', e);
    }
  }

  // --- Task List View ---

  showTaskList() {
    this.currentTaskId = null;
    window.history.pushState({}, '', '/');
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

        return `
        <div class="task-card" onclick="app.showTaskDetails('${t.id}')">
          <div class="task-card-header">
            <span class="badge ${badgeClass}">${badgeText}</span>
            <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">r${t.revision}</span>
          </div>
          <div class="task-card-title">${this.escapeHtml(t.title)}</div>
          <div class="task-card-meta">
            <div>标识：<code>${this.escapeHtml(t.task_key)}</code></div>
            <div>路径：<code>${this.escapeHtml(cwdDisplay)}</code></div>
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

  async showTaskDetails(taskId) {
    this.currentTaskId = taskId;
    window.history.pushState({}, '', `/tasks/${taskId}`);
    document.getElementById('view-task-list').style.display = 'none';
    document.getElementById('view-task-details').style.display = 'block';
    await this.fetchTaskDetail(taskId, false);
  }

  setDetailTab(tabName) {
    this.activeDetailTab = tabName;
    document.querySelectorAll('.detail-tabs .dtab-btn').forEach((btn, idx) => {
      const match = btn.getAttribute('onclick').includes(tabName);
      btn.classList.toggle('active', match);
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
    const { task, latestRevision, workerPrompts, rounds, testRuns, acceptanceRuns, diffSnapshot } = data;

    // 1. Header line
    document.getElementById('detail-task-title').textContent = task.title;
    document.getElementById('detail-task-key').textContent = task.task_key;
    document.getElementById('detail-task-rev').textContent = `r${task.revision}`;
    document.getElementById('detail-current-round').textContent = task.current_round;
    document.getElementById('detail-max-rounds').textContent = task.budget_max_rounds;
    document.getElementById('detail-created-at').textContent = new Date(task.created_at).toLocaleString();

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

    // 3. Gate 2 Confirmation Card
    const gate2Card = document.getElementById('gate2-card');
    if (task.status === 'pending_confirm') {
      gate2Card.style.display = 'block';
      const inputCwd = document.getElementById('input-confirmed-cwd');
      if (inputCwd && !inputCwd.value) {
        inputCwd.value = task.target_cwd;
      }
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
    document.getElementById('git-branch').textContent = diffSnapshot?.branch || 'HEAD';
    document.getElementById('git-commit').textContent = task.git_commit || '(无)';
    document.getElementById('git-status').textContent = task.git_status || 'Clean';

    // 8. Diff Content
    const diffEl = document.getElementById('diff-code-content');
    const changedCountEl = document.getElementById('diff-changed-files');
    if (diffSnapshot && diffSnapshot.diff) {
      diffEl.innerHTML = this.highlightDiff(diffSnapshot.diff);
      changedCountEl.textContent = `${diffSnapshot.changedFiles?.length || 0} 个修改文件`;
    } else {
      diffEl.textContent = '(暂无修改或工作区干净)';
      changedCountEl.textContent = '0 个修改文件';
    }

    // 9. Rounds & Evidence Timeline
    this.renderRoundsTimeline(rounds, testRuns, acceptanceRuns);

    // 10. Materials Content
    if (latestRevision) {
      document.getElementById('mat-task-md').textContent = latestRevision.task_md || '(空)';
      document.getElementById('mat-dev-md').textContent = latestRevision.development_md || '(空)';
      document.getElementById('mat-tests-md').textContent = latestRevision.tests_md || '(空)';
      document.getElementById('mat-acceptance-md').textContent = latestRevision.acceptance_md || '(空)';

      const wpContainer = document.getElementById('mat-worker-prompts');
      if (workerPrompts && workerPrompts.length > 0) {
        wpContainer.innerHTML = workerPrompts
          .map(
            (w) => `
            <div style="margin-bottom: 12px;">
              <h5 style="color: #79c0ff; margin-bottom: 4px;">Worker: ${this.escapeHtml(w.worker_id)} (${this.escapeHtml(w.role)})</h5>
              <div class="markdown-preview">${this.escapeHtml(w.prompt_text)}</div>
            </div>
          `
          )
          .join('');
      } else {
        wpContainer.textContent = '(未定义独立 Worker 提示词)';
      }
    }
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

  renderRoundsTimeline(rounds, testRuns, acceptanceRuns) {
    const container = document.getElementById('rounds-timeline');
    if (!container) return;

    if (!rounds || rounds.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); padding: 20px;">任务尚未产生执行轮次记录。</div>';
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
        <div class="card round-card">
          <div class="round-card-header">
            <h4>第 ${rn} 轮执行详情</h4>
            <span style="font-size: 12px; color: var(--text-muted);">${new Date(roundRounds[0].started_at).toLocaleTimeString()}</span>
          </div>

          <!-- Round Stages Output -->
          <div style="display: flex; flex-direction: column; gap: 10px;">
            ${roundRounds
              .map(
                (r) => `
              <div style="background: #0d1117; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-weight: 600; color: #58a6ff;">阶段：${this.formatStage(r.stage)} ${r.worker_id ? `(${r.worker_id})` : ''}</span>
                  <span class="badge ${r.status === 'passed' ? 'badge-completed' : r.status === 'failed' ? 'badge-blocked' : 'badge-running'}">${r.status}</span>
                </div>
                ${r.output_text ? `<pre class="code-block" style="font-size: 11px; max-height: 180px; overflow-y: auto;">${this.escapeHtml(r.output_text)}</pre>` : ''}
                ${r.error_message ? `<div style="color: #ff7b72; font-size: 12px; margin-top: 4px;">错误：${this.escapeHtml(r.error_message)}</div>` : ''}
              </div>
            `
              )
              .join('')}

            <!-- Tests Evidence -->
            ${
              roundTests.length > 0
                ? `
              <div style="background: #0d1117; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="font-weight: 600; color: #79c0ff; margin-bottom: 6px;">工作台必需测试执行证据：</div>
                ${roundTests
                  .map(
                    (t) => `
                  <div style="font-size: 12px; margin-bottom: 4px;">
                    <span style="color: ${t.passed ? '#56d364' : '#ff7b72'}; font-weight: bold;">[${t.passed ? 'PASS' : 'FAIL'}]</span>
                    <code>${this.escapeHtml(t.command)}</code> (Exit: ${t.exit_code})
                    ${t.stderr && !t.passed ? `<pre style="color: #ff7b72; font-size: 11px; background: rgba(255,0,0,0.1); padding: 4px;">${this.escapeHtml(t.stderr)}</pre>` : ''}
                  </div>
                `
                  )
                  .join('')}
              </div>
            `
                : ''
            }

            <!-- Codex Acceptance Evidence -->
            ${
              roundAcceptance
                ? `
              <div style="background: #0d1117; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--surface-border); border-left: 3px solid #bc8cff;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <span style="font-weight: 600; color: #bc8cff;">Codex 自动验收结论：</span>
                  <span class="badge ${roundAcceptance.decision === 'passed' ? 'badge-completed' : roundAcceptance.decision === 'needs_changes' ? 'badge-pending_confirm' : 'badge-blocked'}">${roundAcceptance.decision}</span>
                </div>
                <div style="font-size: 12px; color: #f0f6fc; margin-bottom: 6px;">${this.escapeHtml(roundAcceptance.summary)}</div>
                ${roundAcceptance.issues_json && roundAcceptance.issues_json !== '[]' ? `<div style="color: #ff7b72; font-size: 11px;">待修复问题：${this.escapeHtml(roundAcceptance.issues_json)}</div>` : ''}
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

  // --- Actions ---

  async handleConfirmStart() {
    if (!this.currentTaskId) return;
    const inputCwd = document.getElementById('input-confirmed-cwd');
    const confirmedCwd = inputCwd ? inputCwd.value.trim() : undefined;

    try {
      const res = await fetch(`${API_BASE}/api/tasks/${this.currentTaskId}/confirm-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed_cwd: confirmedCwd }),
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
      alert('请填写退回修改原因，以便 Worker 针对性修复。');
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
      codex_acceptance: 'Codex 自动验收',
      human_review: '人工审核门禁',
    };
    return map[stage] || stage;
  }

  highlightDiff(diffText) {
    return diffText
      .split('\n')
      .map((line) => {
        const escaped = this.escapeHtml(line);
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return `<span style="color: #56d364;">${escaped}</span>`;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return `<span style="color: #ff7b72;">${escaped}</span>`;
        }
        if (line.startsWith('@@')) {
          return `<span style="color: #79c0ff; font-weight: bold;">${escaped}</span>`;
        }
        return escaped;
      })
      .join('\n');
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
