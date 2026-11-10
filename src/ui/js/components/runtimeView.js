/**
 * CBWorkBench 运行时与 CLI 探测视图组件
 */

import { escapeHtml } from '../utils.js';

export const RuntimeView = {
  renderClis(clis) {
    const grid = document.getElementById('runtime-cli-grid');
    if (!grid) return;

    if (!clis || !clis.length) {
      grid.innerHTML = '<div class="empty-state">暂未检测到 CLI 配置</div>';
      return;
    }

    const icons = {
      'workbuddy': '🤖',
      'codebuddycli': '🤖',
      'codex': '💻',
      'antigravity': '🌌',
    };

    grid.innerHTML = clis.map((cli) => {
      const icon = icons[cli.id] || '🧩';
      const statusBadge = cli.available
        ? '<span class="badge badge-completed">可用</span>'
        : '<span class="badge badge-secondary">未就绪</span>';

      const supportedModels = Array.isArray(cli.supportedModels) ? cli.supportedModels : [];
      const modelsHtml = supportedModels.length > 0
        ? `<div class="cli-model-row">
             <span class="cli-model-label">可选模型：</span>
             <div class="cli-model-tags">
               ${supportedModels.map((m) => `<span class="model-tag">${escapeHtml(m)}</span>`).join('')}
             </div>
           </div>`
        : '';

      return `
        <div class="card cli-card ${cli.available ? 'cli-card-ready' : ''}" id="cli-card-${cli.id}">
          <div class="cli-card-header">
            <div class="cli-title-box">
              <span class="cli-icon">${icon}</span>
              <h4 class="cli-name">${escapeHtml(cli.name)}</h4>
            </div>
            <div class="cli-status-box">
              ${statusBadge}
            </div>
          </div>

          <div class="cli-card-body">
            <div class="cli-model-row">
              <span class="cli-model-label">默认模型：</span>
              <div class="cli-model-tags">
                <span class="model-tag default-tag">${escapeHtml(cli.defaultModel || 'default')}</span>
              </div>
            </div>
            ${modelsHtml}
          </div>

          <div class="cli-card-footer">
            <button class="btn btn-sm btn-primary" onclick="window.app.selectCliForProbe('${cli.id}')">
              🎯 探测此 CLI
            </button>
          </div>
        </div>
      `;
    }).join('');
  },

  populateProbeForm(clis) {
    const cliSelect = document.getElementById('probe-target-cli');
    if (!cliSelect) return;

    const previousValue = cliSelect.value;
    cliSelect.innerHTML = clis.map((c) => {
      const displayId = c.id === 'workbuddy' ? 'codebuddycli' : c.id;
      return `<option value="${c.id}">${escapeHtml(c.name)} (${displayId})</option>`;
    }).join('');

    if (previousValue && clis.some((c) => c.id === previousValue)) {
      cliSelect.value = previousValue;
    } else if (clis.some((c) => c.id === 'codex')) {
      cliSelect.value = 'codex';
    }

    const cwdInput = document.getElementById('probe-cwd-input');
    if (cwdInput && !cwdInput.value) {
      cwdInput.value = 'D:\\CODE\\AI\\CBWorkBench';
    }
  },
};
