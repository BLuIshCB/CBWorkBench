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
      'codex': '💻',
      'antigravity': '🌌',
    };

    grid.innerHTML = clis.map((cli) => {
      const icon = icons[cli.id] || '🧩';
      const statusBadge = cli.available
        ? '<span class="badge badge-completed">入口可启动</span>'
        : cli.configured
        ? '<span class="badge badge-pending_confirm">已声明 (待检测)</span>'
        : '<span class="badge badge-secondary">未就绪</span>';

      const roleBadge = '<span class="badge badge-running">CLI 对话</span>';

      const connHtml = cli.connectionType
        ? `<div class="cli-meta-item">
             <span class="label">连接通道：</span>
             <span class="value font-mono text-blue" style="font-size: 11px;">${escapeHtml(cli.connectionType)}</span>
           </div>`
        : '';

      const modelsHtml = `<div class="cli-meta-item">
             <span class="label">默认模型：</span>
             <span class="value"><code>${escapeHtml(cli.defaultModel || 'default')}</code></span>
           </div>` + (cli.supportedModels && cli.supportedModels.length > 0
        ? `<div class="cli-meta-item">
             <span class="label">${cli.extraInfo?.modelCatalogSource === 'cli' ? 'CLI 模型目录' : '模型建议'}：</span>
             <span class="value"><code class="code-pill">${escapeHtml(cli.supportedModels.join(', '))}</code></span>
           </div>`
        : '');

      return `
        <div class="card cli-card ${cli.available ? 'cli-card-ready' : ''}" id="cli-card-${cli.id}">
          <div class="cli-card-header">
            <div class="cli-title-box">
              <span class="cli-icon">${icon}</span>
              <div>
                <h4 class="cli-name">${escapeHtml(cli.name)}</h4>
                <div class="cli-role">${escapeHtml(cli.role)}</div>
              </div>
            </div>
            <div class="cli-status-box">
              ${roleBadge}
              ${statusBadge}
            </div>
          </div>

          <div class="cli-card-body">
            <p style="color: #8b949e; font-size: 12px; margin-bottom: 8px;">${escapeHtml(cli.description || '')}</p>
            ${connHtml}
            ${modelsHtml}
            <p>真实对话验证：${escapeHtml(cli.verification?.state || "unknown")} ${escapeHtml(cli.verification?.model || "")} ${escapeHtml(cli.verification?.message || "请点击验证真实对话")}</p>
            <p>入口：${escapeHtml(cli.discovery?.entry || "未发现")}</p>
            <div class="cli-meta-item">
              <span class="label">适配器标识：</span>
              <span class="value"><code class="path-code">${escapeHtml(cli.id)}</code></span>
            </div>
            <div class="cli-meta-item">
              <span class="label">健康诊断：</span>
              <span class="value ${cli.available ? 'text-green' : 'text-muted'}">${escapeHtml(cli.statusMessage || '--')}</span>
            </div>
          </div>

          <div class="cli-card-footer">
            <button class="btn btn-sm btn-primary" onclick="window.app.selectCliForProbe('${cli.id}')">
              🎯 填入探测台
            </button>
            <button class="btn btn-sm btn-secondary" onclick="window.app.quickProbeCli('${cli.id}')">
              ⚡ 验证真实对话
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
      return `<option value="${c.id}">${escapeHtml(c.name)} (${c.id})</option>`;
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
