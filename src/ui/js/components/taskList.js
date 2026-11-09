/**
 * CBWorkBench 任务列表视图组件
 */

import { escapeHtml, formatStatus, formatTime } from '../utils.js';
import { api } from '../api.js';
import { store } from '../store.js';

export const TaskList = {
  render(tasks, currentFilter, onSelectTask, onDeleteTask) {
    const grid = document.getElementById('task-grid');
    if (!grid) return;

    let filtered = tasks;
    if (currentFilter !== 'all') {
      filtered = tasks.filter((t) => t.status === currentFilter);
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
        const badgeText = formatStatus(t.status);
        const cwdDisplay = t.confirmed_cwd || t.target_cwd;
        const commitText = t.git_commit ? `Git: ${t.git_commit}` : 'No Git';
        const roundText = t.current_round > 0 ? `第 ${t.current_round} 轮` : '尚未开始';
        const workerText = `${t.worker_executor || 'workbuddy'}:${t.worker_model || 'deepseek-v4-flash'}`;
        const wfText = t.workflow_id ? `${t.workflow_id}` : 'default';
        const nodeText = t.current_node_id ? `节点: ${t.current_node_id}` : '就绪';
        const updatedTime = formatTime(t.updated_at);

        return `
        <div class="task-card" onclick="window.app.showTaskDetails('${t.id}')">
          <div class="task-card-header">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="badge ${badgeClass}">${badgeText}</span>
              <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">r${t.revision}</span>
            </div>
            <button class="btn-card-delete" title="删除此任务及方案和文件" onclick="window.app.handleDeleteTask(event, '${t.id}', '${escapeHtml(t.title)}')">
              🗑️ 删除
            </button>
          </div>
          <div class="task-card-title">${escapeHtml(t.title)}</div>
          <div class="task-card-meta">
            <div>工作流：<code>${escapeHtml(wfText)}</code> <span style="color: var(--primary); margin-left: 4px; font-size: 11px;">[${escapeHtml(nodeText)}]</span></div>
            <div>路径：<code>${escapeHtml(cwdDisplay)}</code></div>
            <div>模型：<code style="color: #2563eb;">${escapeHtml(workerText)}</code></div>
          </div>
          <div class="task-card-footer">
            <span>${roundText}</span>
            <span>更新: ${updatedTime}</span>
          </div>
        </div>
      `;
      })
      .join('');
  },

  updateFilterCounts(tasks) {
    const counts = {
      all: tasks.length,
      pending_confirm: 0,
      running: 0,
      human_review: 0,
      blocked: 0,
      completed: 0,
    };

    for (const t of tasks) {
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
  },
};
