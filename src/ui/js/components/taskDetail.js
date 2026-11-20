/**
 * CBWorkBench 任务详情视图组件 (cb.task-package/2.0 统一节点材料视图)
 */

import { escapeHtml, formatStatus, formatStage, renderMarkdown, formatExecutor } from '../utils.js';
import { populateModelPicker, updateModelPicker, getModelValue } from './modelPicker.js';

export const TaskDetail = {
  selectedNodeId: null,

  render(data, availableAdapters, activeDetailTab, currentMaterialSubtab, currentResourcePath) {
    const { task, latestRevision, manifest, packageFiles, rounds, testRuns, acceptanceRuns, taskWorkflow } = data;

    // 1. Header summary line
    const titleEl = document.getElementById('detail-task-title');
    if (titleEl) titleEl.textContent = task.title;
    const keyEl = document.getElementById('detail-task-key');
    if (keyEl) keyEl.textContent = task.task_key;
    const revEl = document.getElementById('detail-task-rev');
    if (revEl) revEl.textContent = `r${String(task.revision).padStart(4, '0')}`;
    const roundEl = document.getElementById('detail-current-round');
    if (roundEl) roundEl.textContent = task.current_round;
    const maxRoundEl = document.getElementById('detail-max-rounds');
    if (maxRoundEl) maxRoundEl.textContent = task.budget_max_rounds;
    const createdEl = document.getElementById('detail-created-at');
    if (createdEl) createdEl.textContent = new Date(task.created_at).toLocaleString();

    const wfInfoEl = document.getElementById('detail-workflow-info');
    if (wfInfoEl) {
      wfInfoEl.textContent = taskWorkflow?.workflow_id || 'default';
    }
    const currNodeEl = document.getElementById('detail-current-node');
    if (currNodeEl) {
      currNodeEl.textContent = taskWorkflow?.current_node_id || '--';
    }

    const badge = document.getElementById('detail-status-badge');
    if (badge) {
      badge.className = `badge badge-${task.status}`;
      badge.textContent = formatStatus(task.status);
    }

    // 2. Action buttons in summary
    const actionsContainer = document.getElementById('detail-actions-container');
    if (actionsContainer) {
      actionsContainer.innerHTML = '';

      if (task.status === 'running') {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn btn-danger';
        stopBtn.textContent = '停止后续执行';
        stopBtn.onclick = () => window.app.handleStopTask();
        actionsContainer.appendChild(stopBtn);
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-outline-danger';
      deleteBtn.innerHTML = task.status === 'cleanup_failed' ? '🔁 重试彻底删除' : '🗑️ 删除任务';
      deleteBtn.title = '删除此任务并一并清理全部节点材料、历史修订与运行产物';
      deleteBtn.onclick = () => window.app.handleDeleteCurrentTask();
      actionsContainer.appendChild(deleteBtn);
    }

    // 3. Gate 2 Launch Card (Clean launch controls, no hardcoded worker/reviewer)
    const gate2LaunchCard = document.getElementById('gate2-launch-card');
    if (gate2LaunchCard) {
      if (task.status === 'pending_confirm' || task.status === 'blocked') {
        gate2LaunchCard.style.display = 'block';
        const timeoutInput = document.getElementById('execution-timeout-minutes');
        if (timeoutInput && timeoutInput.dataset.taskId !== task.id) {
          timeoutInput.value = (task.execution_timeout_ms || 3600000) / 60000;
          timeoutInput.dataset.taskId = task.id;
        }
        const inputCwd = document.getElementById('input-confirmed-cwd');
        if (inputCwd && inputCwd.dataset.taskId !== task.id) {
          inputCwd.dataset.taskId = task.id;
          inputCwd.value = task.confirmed_cwd || task.target_cwd;
        }

        const gitInfoEl = document.getElementById('gate2-git-info');
        if (gitInfoEl) {
          gitInfoEl.innerHTML = `
            <span style="color: var(--text-muted);">提交默认目录：</span> <code>${escapeHtml(task.target_cwd)}</code>
            ${task.git_commit ? ` | <span style="color: var(--text-muted);">基准 HEAD：</span> <code>${task.git_commit}</code>` : ''}
            ${latestRevision?.package_digest ? ` | <span style="color: var(--text-muted);">包摘要：</span> <code>${escapeHtml(latestRevision.package_digest.slice(0, 12))}...</code>` : ''}
          `;
        }
      } else {
        gate2LaunchCard.style.display = 'none';
      }
    }

    // 4. Gate 3 Human Review Banner
    const gate3Card = document.getElementById('gate3-card');
    if (gate3Card) {
      gate3Card.style.display = task.status === 'human_review' ? 'flex' : 'none';
    }

    // 5. Blocked / Cleanup Failed Alert
    const blockedAlert = document.getElementById('blocked-alert');
    if (blockedAlert) {
      if (task.status === 'blocked' || task.status === 'cleanup_failed') {
        blockedAlert.style.display = 'flex';
        const titleEl = document.getElementById('blocked-alert-title');
        const reasonEl = document.getElementById('blocked-reason-text');
        const actionBtn = document.getElementById('blocked-action-btn');
        if (reasonEl) reasonEl.textContent = task.blocked_reason || '执行受阻或清理失败';
        if (task.status === 'cleanup_failed') {
          if (titleEl) titleEl.textContent = '🗑️ 清理失败待重试：';
          if (actionBtn) {
            actionBtn.textContent = '重试彻底删除';
            actionBtn.onclick = () => window.app.handleDeleteCurrentTask();
          }
        } else {
          if (titleEl) titleEl.textContent = '⚠️ 异常待处理：';
          if (actionBtn) {
            actionBtn.textContent = '重试并继续';
            actionBtn.onclick = () => window.app.handleResumeBlocked();
          }
        }
      } else {
        blockedAlert.style.display = 'none';
      }
    }

    // 6. Interactive Task Workflow Workspace (Canvas + Inspector)
    this.renderTaskWorkflow(data, availableAdapters);

    // 7. Git Metadata
    const gitRoot = document.getElementById('git-root');
    if (gitRoot) gitRoot.textContent = task.git_root || '(未识别 Git 根目录)';
    const gitBranch = document.getElementById('git-branch');
    if (gitBranch) gitBranch.textContent = task.git_branch || 'HEAD';
    const gitCommit = document.getElementById('git-commit');
    if (gitCommit) gitCommit.textContent = task.git_commit || '(无)';
    const gitStatus = document.getElementById('git-status');
    if (gitStatus) gitStatus.textContent = task.git_status || 'Clean';

    // 8. Rounds & Evidence Timeline
    this.renderRoundsTimeline(rounds, testRuns, acceptanceRuns, data.workflowNodeRuns || []);

    // 9. Uniform Node Materials Reader
    this.renderMaterialsTabs(
      { task, latestRevision, manifest, packageFiles: packageFiles || [] },
      currentMaterialSubtab || 'manifest',
      currentResourcePath
    );
  },

  renderTaskWorkflow(data, availableAdapters) {
    const { task, taskWorkflow, nodeExecutionCounts, workflowNodeRuns } = data;
    const svgContainer = document.getElementById('task-wf-svg-viewport');
    const panelContainer = document.getElementById('task-wf-node-panel');
    const badgeEl = document.getElementById('task-wf-badge');
    if (!svgContainer || !panelContainer) return;

    if (!taskWorkflow) {
      svgContainer.innerHTML = '<div class="empty-state">任务工作流未初始化</div>';
      panelContainer.innerHTML = '<div class="config-empty-hint">暂无工作流数据</div>';
      return;
    }

    if (badgeEl) {
      badgeEl.textContent = `工作流: ${taskWorkflow.workflow_id}`;
    }

    let nodes = [];
    try {
      nodes = JSON.parse(taskWorkflow.nodes_json);
    } catch {
      nodes = [];
    }

    if (!nodes || nodes.length === 0) {
      svgContainer.innerHTML = '<div class="empty-state">工作流无节点</div>';
      panelContainer.innerHTML = '<div class="config-empty-hint">暂无节点</div>';
      return;
    }

    // Default selectedNodeId to current_node_id or first task node
    if (!this.selectedNodeId || !nodes.some((n) => n.id === this.selectedNodeId)) {
      const current = nodes.find((n) => n.id === taskWorkflow.current_node_id);
      this.selectedNodeId = current ? current.id : (nodes.find((n) => n.type === 'task')?.id || nodes[0]?.id);
    }

    const selectedNode = nodes.find((n) => n.id === this.selectedNodeId) || nodes[0];
    const currentNodeId = taskWorkflow.current_node_id;

    // 1. Render SVG Diagram
    svgContainer.innerHTML = this.buildTaskSvgDiagram(nodes, currentNodeId, task.status, this.selectedNodeId, nodeExecutionCounts);

    // 2. Render Node Inspector Panel
    panelContainer.innerHTML = this.buildTaskNodePanelHtml(selectedNode, task, taskWorkflow, workflowNodeRuns || [], availableAdapters || []);

    // 3. Initialize model picker for selected node
    this.initNodeModelPicker(selectedNode, availableAdapters);
  },

  buildTaskSvgDiagram(nodes, currentNodeId, taskStatus, selectedNodeId, nodeExecutionCounts) {
    const nodePositions = new Map();
    const orderedIds = [];

    const visited = new Set();
    const startNode = nodes.find((n) => n.type === 'start') || nodes[0];
    let curr = startNode;

    while (curr && !visited.has(curr.id)) {
      visited.add(curr.id);
      orderedIds.push(curr.id);
      if (curr.on_success && nodes.some((n) => n.id === curr.on_success)) {
        curr = nodes.find((n) => n.id === curr.on_success);
      } else {
        break;
      }
    }

    for (const n of nodes) {
      if (!visited.has(n.id)) {
        orderedIds.push(n.id);
        visited.add(n.id);
      }
    }

    const nodeWidth = 160;
    const taskHeight = 90;
    const terminalHeight = 46;
    const startX = 30;
    const gapX = 70;
    const baseY = 140;

    let curX = startX;
    orderedIds.forEach((id) => {
      const node = nodes.find((n) => n.id === id);
      const isTerminal = node?.type === 'start' || node?.type === 'end';
      const w = isTerminal ? 100 : nodeWidth;
      const h = isTerminal ? terminalHeight : taskHeight;
      const y = isTerminal ? baseY + (taskHeight - terminalHeight) / 2 : baseY;

      nodePositions.set(id, { x: curX, y, w, h });
      curX += w + gapX;
    });

    const totalWidth = Math.max(curX + 60, 960);
    const totalHeight = 360;

    const linesSvg = [];
    nodes.forEach((node) => {
      const fromPos = nodePositions.get(node.id);
      if (!fromPos) return;

      if (node.on_success) {
        const toPos = nodePositions.get(node.on_success);
        if (toPos) {
          const isForward = toPos.x > fromPos.x;
          if (isForward) {
            const x1 = fromPos.x + fromPos.w;
            const y1 = fromPos.y + fromPos.h / 2;
            const x2 = toPos.x;
            const y2 = toPos.y + toPos.h / 2;
            const midX = (x1 + x2) / 2;

            linesSvg.push(`
              <path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#2563eb" stroke-width="2.5" fill="none" marker-end="url(#task-arrow-blue)" />
              <rect x="${midX - 18}" y="${(y1 + y2) / 2 - 10}" width="36" height="18" rx="4" fill="#eff6ff" stroke="#93c5fd" />
              <text x="${midX}" y="${(y1 + y2) / 2 + 3}" font-size="11" fill="#1d4ed8" text-anchor="middle" font-weight="600">成功</text>
            `);
          } else {
            const x1 = fromPos.x + fromPos.w / 2;
            const y1 = fromPos.y;
            const x2 = toPos.x + toPos.w / 2;
            const y2 = toPos.y;
            const topY = 40;

            linesSvg.push(`
              <path d="M ${x1} ${y1} C ${x1} ${topY}, ${x2} ${topY}, ${x2} ${y2}" stroke="#2563eb" stroke-width="2" stroke-dasharray="4,4" fill="none" marker-end="url(#task-arrow-blue)" />
              <rect x="${(x1 + x2) / 2 - 18}" y="${topY - 9}" width="36" height="18" rx="4" fill="#eff6ff" stroke="#93c5fd" />
              <text x="${(x1 + x2) / 2}" y="${topY + 4}" font-size="11" fill="#1d4ed8" text-anchor="middle" font-weight="600">成功</text>
            `);
          }
        }
      }

      if (node.on_failure) {
        const toPos = nodePositions.get(node.on_failure);
        if (toPos) {
          const isReturn = toPos.x <= fromPos.x;
          if (isReturn) {
            const x1 = fromPos.x + fromPos.w / 2;
            const y1 = fromPos.y + fromPos.h;
            const x2 = toPos.x + toPos.w / 2;
            const y2 = toPos.y + toPos.h;
            const bottomY = baseY + taskHeight + 50 + (nodes.indexOf(node) % 3) * 20;

            linesSvg.push(`
              <path d="M ${x1} ${y1} C ${x1} ${bottomY}, ${x2} ${bottomY}, ${x2} ${y2}" stroke="#64748b" stroke-width="2" stroke-dasharray="5,5" fill="none" marker-end="url(#task-arrow-gray)" />
              <rect x="${(x1 + x2) / 2 - 18}" y="${bottomY - 9}" width="36" height="18" rx="4" fill="#f8fafc" stroke="#cbd5e1" />
              <text x="${(x1 + x2) / 2}" y="${bottomY + 4}" font-size="11" fill="#475569" text-anchor="middle" font-weight="600">失败</text>
            `);
          } else {
            const x1 = fromPos.x + fromPos.w;
            const y1 = fromPos.y + fromPos.h - 15;
            const x2 = toPos.x;
            const y2 = toPos.y + toPos.h - 15;
            const midX = (x1 + x2) / 2;

            linesSvg.push(`
              <path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#64748b" stroke-width="2" stroke-dasharray="5,5" fill="none" marker-end="url(#task-arrow-gray)" />
              <rect x="${midX - 18}" y="${(y1 + y2) / 2 - 9}" width="36" height="18" rx="4" fill="#f8fafc" stroke="#cbd5e1" />
              <text x="${midX}" y="${(y1 + y2) / 2 + 4}" font-size="11" fill="#475569" text-anchor="middle" font-weight="600">失败</text>
            `);
          }
        }
      }
    });

    const nodesSvg = nodes.map((node) => {
      const pos = nodePositions.get(node.id);
      if (!pos) return '';

      const isSelected = node.id === selectedNodeId;
      const isCurrent = node.id === currentNodeId && taskStatus !== 'completed' && taskStatus !== 'cancelled';
      const isStart = node.type === 'start';
      const isEnd = node.type === 'end';
      const execCount = (nodeExecutionCounts && nodeExecutionCounts[node.id]) || 0;

      if (isStart) {
        return `
          <g class="svg-node svg-node-start ${isSelected ? 'selected' : ''} ${isCurrent ? 'is-current' : ''}" onclick="app.selectTaskWorkflowNode('${node.id}')" cursor="pointer">
            <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="${pos.h / 2}" fill="${isCurrent ? '#bfdbfe' : isSelected ? '#dbeafe' : '#eff6ff'}" stroke="${isCurrent ? '#1d4ed8' : isSelected ? '#2563eb' : '#3b82f6'}" stroke-width="${isCurrent ? '3' : isSelected ? '2.5' : '2'}" />
            <text x="${pos.x + pos.w / 2}" y="${pos.y + pos.h / 2 + 5}" font-size="14" font-weight="bold" fill="#1e40af" text-anchor="middle">⚡ 开始</text>
          </g>
        `;
      }

      if (isEnd) {
        const isCompleted = taskStatus === 'completed';
        return `
          <g class="svg-node svg-node-end ${isSelected ? 'selected' : ''} ${isCompleted ? 'is-current' : ''}" onclick="app.selectTaskWorkflowNode('${node.id}')" cursor="pointer">
            <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="${pos.h / 2}" fill="${isCompleted ? '#dcfce7' : isSelected ? '#e2e8f0' : '#f1f5f9'}" stroke="${isCompleted ? '#16a34a' : isSelected ? '#475569' : '#64748b'}" stroke-width="${isCompleted || isSelected ? '3' : '2'}" />
            <text x="${pos.x + pos.w / 2}" y="${pos.y + pos.h / 2 + 5}" font-size="14" font-weight="bold" fill="${isCompleted ? '#166534' : '#334155'}" text-anchor="middle">${isCompleted ? '✓ 已完成' : '🏁 结束'}</text>
          </g>
        `;
      }

      // Task node
      const modeLabel = node.execution_mode === 'manual' ? '人工' : 'Agent';
      const modeBadgeColor = node.execution_mode === 'manual' ? '#7c3aed' : '#2563eb';
      const modeBadgeBg = node.execution_mode === 'manual' ? '#f5f3ff' : '#eff6ff';

      let statusBadgeText = '';
      let statusBadgeBg = '';
      let statusBadgeColor = '';
      if (isCurrent) {
        statusBadgeText = '● 当前节点';
        statusBadgeBg = '#2563eb';
        statusBadgeColor = '#ffffff';
      } else if (execCount > 0) {
        statusBadgeText = `✓ 已跑 ${execCount}次`;
        statusBadgeBg = '#dcfce7';
        statusBadgeColor = '#166534';
      }

      const cardBg = isCurrent ? '#f0f7ff' : '#ffffff';
      const cardStroke = isCurrent ? '#2563eb' : isSelected ? '#3b82f6' : '#cbd5e1';
      const cardStrokeWidth = isCurrent ? '3' : isSelected ? '2.5' : '1.5';

      return `
        <g class="svg-node svg-node-task ${isSelected ? 'selected' : ''} ${isCurrent ? 'is-current' : ''}" onclick="app.selectTaskWorkflowNode('${node.id}')" cursor="pointer">
          <!-- Card background -->
          <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="8" fill="${cardBg}" stroke="${cardStroke}" stroke-width="${cardStrokeWidth}" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.06))" />
          
          <!-- Mode badge -->
          <rect x="${pos.x + 8}" y="${pos.y + 8}" width="38" height="18" rx="4" fill="${modeBadgeBg}" stroke="${modeBadgeColor}" stroke-width="1" />
          <text x="${pos.x + 27}" y="${pos.y + 21}" font-size="10" font-weight="bold" fill="${modeBadgeColor}" text-anchor="middle">${modeLabel}</text>
          
          <!-- Status / Execution badge on top right -->
          ${statusBadgeText ? `
            <rect x="${pos.x + pos.w - 74}" y="${pos.y + 8}" width="66" height="18" rx="4" fill="${statusBadgeBg}" />
            <text x="${pos.x + pos.w - 41}" y="${pos.y + 21}" font-size="10" font-weight="bold" fill="${statusBadgeColor}" text-anchor="middle">${statusBadgeText}</text>
          ` : `
            <text x="${pos.x + pos.w - 10}" y="${pos.y + 21}" font-size="10" fill="#64748b" text-anchor="end">${node.max_executions ? `上限 ${node.max_executions}次` : '不限'}</text>
          `}

          <!-- Node Name -->
          <text x="${pos.x + 10}" y="${pos.y + 48}" font-size="13" font-weight="bold" fill="#1e293b">${escapeHtml(node.name || node.id)}</text>
          
          <!-- Subtext: Executor / Model -->
          <text x="${pos.x + 10}" y="${pos.y + 70}" font-size="11" fill="#64748b">
            ${escapeHtml(node.execution_mode === 'manual' ? '人工审核' : `${formatExecutor(node.executor)}: ${node.model || 'default'}`)}
          </text>
        </g>
      `;
    });

    return `
      <svg width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="task-arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>
          <marker id="task-arrow-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
          </marker>
        </defs>
        ${linesSvg.join('\n')}
        ${nodesSvg.join('\n')}
      </svg>
    `;
  },

  buildTaskNodePanelHtml(node, task, taskWorkflow, workflowNodeRuns, availableAdapters) {
    if (!node) {
      return '<div class="config-empty-hint">请在左侧点击选择一个节点以查看提示词与执行配置。</div>';
    }

    const isFrozen = task.status !== 'pending_confirm';
    const isStart = node.type === 'start';
    const isEnd = node.type === 'end';
    const isTask = node.type === 'task';
    const isCurrent = node.id === taskWorkflow?.current_node_id && task.status !== 'completed';

    const nodeRuns = (workflowNodeRuns || []).filter((nr) => nr.node_id === node.id);

    return `
      <div class="node-config-header">
        <div>
          <h3 style="font-size: 15px; margin: 0; color: #0f172a;">${escapeHtml(node.name || node.id)}</h3>
          <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${node.id}</span>
        </div>
        <div style="display: flex; gap: 6px;">
          ${isCurrent ? '<span class="badge badge-running">● 当前节点</span>' : ''}
          <span class="badge ${isStart ? 'badge-blue' : isEnd ? 'badge-gray' : 'badge-green'}">
            ${isStart ? '开始节点' : isEnd ? '结束节点' : (node.execution_mode === 'manual' ? '人工任务' : 'Agent任务')}
          </span>
        </div>
      </div>

      ${isFrozen ? `
        <div class="node-frozen-alert">
          <span style="font-size: 15px;">🔒</span>
          <div>
            <strong>已冻结</strong>：任务已开始执行（状态：${formatStatus(task.status)}），节点模型与配置已不可更改。
          </div>
        </div>
      ` : `
        <div class="node-editable-alert">
          <span style="font-size: 15px;">✏️</span>
          <div>
            <strong>待启动确认</strong>：任务尚未开始，您可以选中节点查看提示词并切换执行模型。
          </div>
        </div>
      `}

      <div class="node-config-form">
        ${isTask ? `
          <!-- Node Prompt View -->
          <div class="form-group">
            <label class="form-label" style="font-weight: 600; color: #1e293b;">
              📋 节点提示词 (Prompt)
            </label>
            <div class="node-prompt-box">${escapeHtml(node.prompt || node.description || '(该节点未配置独立提示词)')}</div>
            <small class="form-hint" style="color: var(--text-muted); font-size: 11px;">
              该提示词在执行时连同隔离任务材料共同注入 CLI 上下文。
            </small>
          </div>

          <!-- Model & Executor Selection -->
          ${node.execution_mode !== 'manual' ? `
            <div class="form-group" style="background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid var(--surface-border);">
              <label class="form-label" style="font-weight: 600; color: #1e293b;">🤖 执行器与模型配置</label>
              
              <div style="margin-bottom: 10px;">
                <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 4px;">执行器 (Executor)：</label>
                <select id="task-node-executor-select" class="form-control" ${isFrozen ? 'disabled' : ''} onchange="app.handleTaskNodeExecutorChange('${node.id}', this.value)">
                  ${(availableAdapters || []).map((a) => `
                    <option value="${a.id}" ${node.executor === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>
                  `).join('')}
                </select>
              </div>

              <div>
                <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 4px;">执行模型 (Model)：</label>
                <select id="task-node-model-select" class="form-control" ${isFrozen ? 'disabled' : ''} onchange="app.handleTaskNodeModelSelectionChange('${node.id}')"></select>
                <input id="task-node-model-select-custom" class="form-control" style="display: none; margin-top: 6px;" aria-label="手动输入模型" placeholder="输入模型名称" ${isFrozen ? 'disabled' : ''}>
              </div>

              ${!isFrozen ? `
                <div style="margin-top: 12px; display: flex; align-items: center; gap: 8px;">
                  <button class="btn btn-sm btn-primary" onclick="app.saveTaskNodeModel('${node.id}')">💾 保存模型修改</button>
                  <span id="task-node-save-feedback" style="font-size: 12px; color: #16a34a; font-weight: 600;"></span>
                </div>
              ` : ''}
            </div>
          ` : `
            <div class="form-group" style="background: #faf5ff; padding: 12px; border-radius: 8px; border: 1px solid #e9d5ff;">
              <span style="font-weight: 600; color: #7c3aed;">⚖️ 人工审核任务</span>
              <p style="font-size: 12px; color: #6b21a8; margin: 4px 0 0 0;">本节点等待用户手动审核并通过或退回，不使用 CLI 模型。</p>
            </div>
          `}

          <!-- Routing Information -->
          <div class="routing-group">
            <div style="font-size: 12px; margin-bottom: 6px;">
              <strong>成功后去向：</strong> <code>${escapeHtml(node.on_success || '(流程结束)')}</code>
            </div>
            ${node.on_failure ? `
              <div style="font-size: 12px;">
                <strong>失败后去向：</strong> <code>${escapeHtml(node.on_failure)}</code>
              </div>
            ` : ''}
          </div>

          <!-- Execution History for This Node -->
          <div class="form-group" style="margin-top: 6px;">
            <label class="form-label" style="font-weight: 600; color: #1e293b;">
              ⏱️ 本节点执行记录 (${nodeRuns.length} 次)
            </label>
            ${nodeRuns.length > 0 ? `
              <div style="display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow-y: auto;">
                ${nodeRuns.slice().reverse().map((nr) => `
                  <div style="padding: 6px 10px; border: 1px solid var(--surface-border); border-radius: 6px; background: #ffffff; font-size: 11px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <span><strong>#${nr.execution_index}</strong> (R${nr.round_number})</span>
                      <span class="badge ${nr.status === 'passed' ? 'badge-completed' : nr.status === 'failed' ? 'badge-blocked' : 'badge-running'}">${nr.status}</span>
                    </div>
                    ${nr.result_summary ? `<div style="color: var(--text-muted); margin-top: 2px;">${escapeHtml(nr.result_summary)}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : `
              <div style="font-size: 12px; color: var(--text-muted);">本节点尚未执行</div>
            `}
          </div>
        ` : `
          <!-- Start or End Node -->
          <div style="color: var(--text-muted); font-size: 13px; padding: 12px 0;">
            ${isStart ? '工作流起点。点击“确认并开始”后将自动进入首个任务节点。' : '工作流终点。当流程流转到此节点时任务将自动标记为已完成。'}
          </div>
          ${node.on_success ? `
            <div class="routing-group">
              <div style="font-size: 12px;"><strong>入口去向：</strong> <code>${escapeHtml(node.on_success)}</code></div>
            </div>
          ` : ''}
        `}
      </div>
    `;
  },

  initNodeModelPicker(node, availableAdapters) {
    if (!node || node.execution_mode === 'manual' || node.type !== 'task') return;
    const adapter = (availableAdapters || []).find((a) => a.id === (node.executor || 'workbuddy')) || availableAdapters?.[0];
    populateModelPicker('task-node-model-select', adapter, node.model);
  },

  renderRoundsTimeline(rounds, testRuns, acceptanceRuns, nodeRuns) {
    const container = document.getElementById('rounds-timeline');
    if (!container) return;

    if ((!rounds || rounds.length === 0) && (!nodeRuns || nodeRuns.length === 0)) {
      container.innerHTML = '<div style="color: var(--text-muted); padding: 30px; text-align: center;">任务尚未产生执行轮次记录。</div>';
      return;
    }

    const grouped = {};
    for (const r of rounds || []) {
      if (!grouped[r.round_number]) grouped[r.round_number] = [];
      grouped[r.round_number].push(r);
    }

    const roundNumbers = Object.keys(grouped).sort((a, b) => Number(b) - Number(a));

    const nodeRunsSummaryHtml = (nodeRuns && nodeRuns.length > 0) ? `
      <div class="card" style="margin-bottom: 18px;">
        <h4 style="font-size: 14px; margin-bottom: 10px; color: #0f172a;">节点执行尝试记录 (${nodeRuns.length} 次)</h4>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${nodeRuns.slice().reverse().map((nr) => `
            <div style="padding: 8px 12px; border: 1px solid var(--surface-border); border-radius: 6px; background: #f8fafc; font-size: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <div>
                  <strong>${escapeHtml(nr.node_id)}</strong>
                  <span style="color: var(--text-muted); margin-left: 6px;">#${nr.execution_index} (attempt: <code>${escapeHtml(nr.run_id.slice(0, 14))}</code>)</span>
                </div>
                <span class="badge ${nr.status === 'passed' ? 'badge-completed' : nr.status === 'failed' || nr.status === 'blocked' ? 'badge-blocked' : 'badge-running'}">${nr.status}</span>
              </div>
              ${nr.result_summary ? `<div style="color: var(--text-main);">${escapeHtml(nr.result_summary)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    container.innerHTML = nodeRunsSummaryHtml + roundNumbers
      .map((rn) => {
        const roundRounds = grouped[rn];
        const roundTests = (testRuns || []).filter((t) => t.round_number === Number(rn));
        const roundAcceptance = (acceptanceRuns || []).find((a) => a.round_number === Number(rn));

        return `
        <div class="card round-card" style="margin-bottom: 20px;">
          <div class="round-card-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--surface-border); padding-bottom: 10px; margin-bottom: 14px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <h4 style="font-size: 15px; color: #0f172a;">第 ${rn} 轮执行与模型调试</h4>
              <span class="dbg-pill" style="color: #2563eb; border-color: #bfdbfe; background: #eff6ff;">
                Stage: ${formatStage(roundRounds[roundRounds.length - 1]?.stage)}
              </span>
            </div>
            <span style="font-size: 12px; color: var(--text-muted);">${new Date(roundRounds[0].started_at).toLocaleTimeString()}</span>
          </div>

          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${roundRounds
              .map(
                (r, idx) => {
                  const roundDomId = `round-${rn}-step-${idx}`;
                  const durationSec = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : (r.finished_at && r.started_at ? ((r.finished_at - r.started_at) / 1000).toFixed(1) + 's' : '--');
                  const rawAdapter = r.adapter_id || r.worker_id;
                  const displayAdapter = formatExecutor(rawAdapter);
                  const adapterLabel = r.adapter_id ? `${displayAdapter} (${r.model_name || 'default'})` : displayAdapter;

                  return `
              <div style="background: var(--surface-hover); padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: 600; color: var(--primary); font-size: 13px;">${formatStage(r.stage)}</span>
                    <span class="dbg-pill" style="color: var(--purple); background: rgba(124, 58, 237, 0.1);">
                      ${escapeHtml(adapterLabel)}
                    </span>
                    <span style="font-size: 11px; color: var(--text-muted);">耗时: ${durationSec}</span>
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <span class="badge ${r.status === 'passed' ? 'badge-completed' : r.status === 'failed' ? 'badge-blocked' : 'badge-running'}">${r.status}</span>
                  </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                  ${r.input_prompt ? `
                    <button class="dbg-btn" onclick="window.app.toggleDrawer('${roundDomId}-prompt')">🔍 查看 Prompt 输入</button>
                    <button class="dbg-btn" onclick="window.app.copyToClipboard('${roundDomId}-prompt-content')">📋 复制 Prompt</button>
                  ` : ''}
                  ${r.output_text ? `
                    <button class="dbg-btn" onclick="window.app.toggleDrawer('${roundDomId}-output')">📜 查看模型响应 Output</button>
                    <button class="dbg-btn" onclick="window.app.copyToClipboard('${roundDomId}-output-content')">📋 复制 Response</button>
                  ` : ''}
                </div>

                ${r.input_prompt ? `
                  <div id="${roundDomId}-prompt" class="dbg-drawer" style="display: none;">
                    <div style="font-size: 11px; color: #79c0ff; margin-bottom: 4px; font-weight: 600;">模型完整输入提示词 (Prompt)：</div>
                    <pre id="${roundDomId}-prompt-content" class="code-block" style="font-size: 11px; max-height: 260px; overflow-y: auto; white-space: pre-wrap;">${escapeHtml(r.input_prompt)}</pre>
                  </div>
                ` : ''}

                ${r.output_text ? `
                  <div id="${roundDomId}-output" class="dbg-drawer" style="display: block;">
                    <div style="font-size: 11px; color: #56d364; margin-bottom: 4px; font-weight: 600;">模型输出与执行日志：</div>
                    <pre id="${roundDomId}-output-content" class="code-block" style="font-size: 11px; max-height: 220px; overflow-y: auto; white-space: pre-wrap;">${escapeHtml(r.output_text)}</pre>
                  </div>
                ` : ''}

                ${r.error_message ? `<div style="color: #dc2626; font-size: 12px; margin-top: 6px; padding: 6px 10px; background: #fee2e2; border: 1px solid #fecaca; border-radius: 4px;">❌ 错误信息：${escapeHtml(r.error_message)}</div>` : ''}
              </div>
            `;
                }
              )
              .join('')}

            ${
              roundTests.length > 0
                ? `
              <div style="background: var(--surface-hover); padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="font-weight: 600; color: var(--primary); margin-bottom: 8px; font-size: 13px;">独立命令执行结果：</div>
                ${roundTests
                  .map(
                    (t) => `
                  <div style="font-size: 12px; margin-bottom: 6px; padding: 6px 10px; background: #ffffff; border: 1px solid var(--surface-border); border-radius: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <div>
                        <span style="color: ${t.passed ? 'var(--success)' : 'var(--danger)'}; font-weight: bold;">[${t.passed ? 'PASS' : 'FAIL'}]</span>
                        <code style="margin-left: 6px;">${escapeHtml(t.command)}</code>
                      </div>
                      <span style="color: var(--text-muted); font-size: 11px;">Exit: ${t.exit_code}</span>
                    </div>
                    ${t.stderr && !t.passed ? `<pre style="color: var(--danger); font-size: 11px; background: #fee2e2; padding: 6px; margin-top: 4px; border-radius: 4px; overflow-x: auto;">${escapeHtml(t.stderr)}</pre>` : ''}
                    ${t.stdout && !t.passed ? `<pre style="color: var(--text-muted); font-size: 11px; padding: 4px; margin-top: 2px; overflow-x: auto;">${escapeHtml(t.stdout)}</pre>` : ''}
                  </div>
                `
                  )
                  .join('')}
              </div>
            `
                : ''
            }

            ${
              roundAcceptance
                ? `
              <div style="background: var(--surface-hover); padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border); border-left: 4px solid var(--primary);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <span style="font-weight: 600; color: var(--primary); font-size: 13px;">Reviewer 自动验收评估报告：</span>
                  <span class="badge ${roundAcceptance.decision === 'passed' ? 'badge-completed' : roundAcceptance.decision === 'needs_changes' ? 'badge-pending_confirm' : 'badge-blocked'}">${roundAcceptance.decision}</span>
                </div>
                <div style="font-size: 13px; color: var(--text-main); margin-bottom: 8px; line-height: 1.5;">${escapeHtml(roundAcceptance.summary)}</div>
                ${roundAcceptance.issues_json && roundAcceptance.issues_json !== '[]' ? `
                  <div style="margin-top: 8px; padding: 8px 10px; background: #fee2e2; border: 1px solid #fecaca; border-radius: 4px;">
                    <div style="color: #991b1b; font-weight: 600; font-size: 12px; margin-bottom: 4px;">待修复 Issues 清单：</div>
                    <pre style="color: #dc2626; font-size: 11px; white-space: pre-wrap;">${escapeHtml(roundAcceptance.issues_json)}</pre>
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
  },

  renderMaterialsTabs(materialsData, activeSubtab, activeResourcePath) {
    const subtabsEl = document.getElementById('material-subtabs');
    const navEl = document.getElementById('material-resource-nav');
    const contentEl = document.getElementById('mat-rendered-content');
    if (!subtabsEl || !navEl || !contentEl) return;

    const { task, latestRevision, manifest, packageFiles } = materialsData;
    const nodes = Array.isArray(manifest?.nodes) ? manifest.nodes : [];
    const sharedFiles = packageFiles.filter((f) => f.owner_scope === 'shared');

    const tabs = [
      { id: 'manifest', label: 'Manifest 概览' },
      ...(sharedFiles.length > 0 ? [{ id: 'shared', label: `共同资源 (${sharedFiles.length})` }] : []),
      ...nodes.map((n) => ({ id: `node:${n.node_id}`, label: `节点: ${n.node_id}` })),
    ];

    const effectiveSubtab = tabs.some((t) => t.id === activeSubtab) ? activeSubtab : 'manifest';

    subtabsEl.innerHTML = tabs
      .map(
        (t) =>
          `<button class="mat-subtab-btn ${t.id === effectiveSubtab ? 'active' : ''}" onclick="app.setMaterialSubtab('${escapeHtml(t.id)}')">${escapeHtml(t.label)}</button>`
      )
      .join('');

    if (effectiveSubtab === 'manifest') {
      navEl.style.display = 'none';
      if (!manifest) {
        contentEl.innerHTML = '<p style="color: var(--text-muted);">当前任务尚未提交冻结的任务包清单。</p>';
        return;
      }
      const summaryMd = [
        `# 任务包概览 (${manifest.protocol_version || 'cb.task-package/2.0'})`,
        '',
        `- **任务 ID**: \`${task.id}\``,
        `- **修订号**: \`r${String(task.revision).padStart(4, '0')}\``,
        `- **就绪状态**: \`${manifest.readiness}\``,
        `- **工作流**: \`${manifest.workflow?.id}\` (SHA: \`${manifest.workflow?.definition_sha256 || '--'}\`)`,
        `- **包摘要 (package_digest)**: \`${latestRevision?.package_digest || '--'}\``,
        `- **文件总数**: ${packageFiles.length} 个`,
        '',
        '## 完整 manifest.json',
        '```json',
        JSON.stringify(manifest, null, 2),
        '```',
      ].join('\n');
      contentEl.innerHTML = renderMarkdown(summaryMd);
      return;
    }

    let filesForTab = [];
    if (effectiveSubtab === 'shared') {
      filesForTab = sharedFiles;
    } else if (effectiveSubtab.startsWith('node:')) {
      const nodeId = effectiveSubtab.slice('node:'.length);
      filesForTab = packageFiles.filter((f) => f.owner_scope === 'node' && f.owner_node_id === nodeId);
    }

    if (filesForTab.length === 0) {
      navEl.style.display = 'none';
      contentEl.innerHTML = '<p style="color: var(--text-muted);">该分组下暂无文件。</p>';
      return;
    }

    const selectedPath =
      activeResourcePath && filesForTab.some((f) => f.path === activeResourcePath)
        ? activeResourcePath
        : filesForTab[0].path;

    navEl.style.display = 'flex';
    navEl.innerHTML = filesForTab
      .map((f) => {
        const shortLabel = f.path.split('/').slice(-2).join('/');
        const isActive = f.path === selectedPath;
        return `<button class="btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}" onclick="app.selectMaterialResource('${escapeHtml(f.path)}')">${escapeHtml(shortLabel)} (${f.size_bytes}B)</button>`;
      })
      .join('');

    window.app.loadMaterialResource(task.id, task.revision, selectedPath);
  },
};
