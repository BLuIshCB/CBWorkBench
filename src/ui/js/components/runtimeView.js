/**
 * CBWorkBench 运行时与 CLI 探测视图组件
 */

import { escapeHtml } from '../utils.js';

const SOURCE_LABELS = {
  config: '配置文件',
  env: '环境变量',
  path: 'PATH',
  'shell-path': '登录 shell PATH',
  'install-dir': '已知安装目录',
  fallback: '裸名（待探活验证）',
};

function statusBadge(cli) {
  if (!cli.available) return '<span class="badge badge-blocked">未找到</span>';
  if (cli.discovery?.source === 'fallback') return '<span class="badge badge-running">待验证</span>';
  return '<span class="badge badge-completed">已找到</span>';
}

function renderDiscovery(cli) {
  const discovery = cli.discovery;
  if (!discovery) return '';

  const rows = [];
  if (discovery.entry) {
    rows.push(`<div class="cli-model-row">
      <span class="cli-model-label">启动入口${discovery.version ? `（${escapeHtml(discovery.version)}）` : ''}</span>
      <code class="cli-entry">${escapeHtml(discovery.entry)}</code>
    </div>`);
  }
  rows.push(`<div class="cli-model-row">
    <span class="cli-model-label">探测来源</span>
    <div class="cli-model-tags"><span class="model-tag">${escapeHtml(SOURCE_LABELS[discovery.source] || discovery.source)}</span></div>
  </div>`);

  if (!cli.available && discovery.reason) {
    rows.push(`<div class="cli-reason">${escapeHtml(discovery.reason)}</div>`);
  }

  const candidates = Array.isArray(discovery.candidates) ? discovery.candidates : [];
  if (!cli.available && candidates.length) {
    rows.push(`<details class="cli-candidates">
      <summary>试过 ${discovery.scanned || candidates.length} 个路径，全部失败（展开明细）</summary>
      <ul>${candidates.map((candidate) => `<li>${escapeHtml(candidate.path)}｜${escapeHtml(SOURCE_LABELS[candidate.source] || candidate.source)}｜${escapeHtml(candidate.reason || '可运行')}</li>`).join('')}</ul>
    </details>`);
  }

  // 两个字段一起回填：只改可执行文件时，脚本不会被静默丢掉。
  const executableValue = escapeHtml(discovery.executable || '');
  const scriptValue = escapeHtml(discovery.script || '');
  rows.push(`<details class="cli-manual">
    <summary>手动指定入口</summary>
    <div class="cli-manual-row">
      <input id="cli-exe-input-${cli.id}" class="form-control" placeholder="可执行文件绝对路径（node.exe / .exe / .cmd）" value="${executableValue}" />
      <button class="btn btn-sm btn-secondary" onclick="app.pickCliFile('${cli.id}','exe')">浏览…</button>
    </div>
    <div class="cli-manual-row">
      <input id="cli-script-input-${cli.id}" class="form-control" placeholder="脚本路径，可留空（如 codex.js / codebuddy）" value="${scriptValue}" />
      <button class="btn btn-sm btn-secondary" onclick="app.pickCliFile('${cli.id}','script')">浏览…</button>
    </div>
    <div class="cli-manual-row">
      <button class="btn btn-sm btn-primary" onclick="app.saveCliPath('${cli.id}')">保存</button>
    </div>
  </details>`);

  return rows.join('');
}

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
      const supportedModels = Array.isArray(cli.supportedModels) ? cli.supportedModels : [];
      const modelsHtml = supportedModels.length > 0
        ? `<div class="cli-model-row">
             <span class="cli-model-label">可选模型：</span>
             <div class="cli-model-tags">
               ${supportedModels.map((m) => `<span class="model-tag">${escapeHtml(m)}</span>`).join('')}
             </div>
           </div>`
        : '';

      const catalogError = cli.extraInfo?.modelCatalogError
        ? `<div class="cli-model-row"><span class="cli-model-label">模型目录</span><span class="cli-entry">${escapeHtml(cli.extraInfo.modelCatalogError)}</span></div>`
        : '';

      return `
        <div class="card cli-card ${cli.available ? 'cli-card-ready' : ''}" id="cli-card-${cli.id}">
          <div class="cli-card-header">
            <div class="cli-title-box">
              <span class="cli-icon">${icon}</span>
              <h4 class="cli-name">${escapeHtml(cli.name)}</h4>
            </div>
            <div class="cli-status-box">
              ${statusBadge(cli)}
            </div>
          </div>

          <div class="cli-card-body">
            ${renderDiscovery(cli)}
            <div class="cli-model-row">
              <span class="cli-model-label">默认模型：</span>
              <div class="cli-model-tags">
                <span class="model-tag default-tag">${escapeHtml(cli.defaultModel || 'default')}</span>
              </div>
            </div>
            ${modelsHtml}
            ${catalogError}
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
