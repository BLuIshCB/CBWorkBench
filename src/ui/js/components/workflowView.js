/**
 * CBWorkBench SVG 工作流编排视图组件
 * 严格支持三种节点类型：start、end、task
 * 任务节点执行方式：agent、command、manual
 * 成功连线（蓝色实线）与失败连线（灰色虚线）
 */

import { api } from '../api.js';
import { escapeHtml } from '../utils.js';

export class WorkflowView {
  constructor(app) {
    this.app = app;
    this.workflows = [];
    this.currentWorkflow = null;
    this.currentNodes = [];
    this.selectedNodeId = null;
    this.connectPending = null; // { sourceId, edgeType: 'on_success' | 'on_failure' }
    this.executors = [];
  }

  async init() {
    try {
      const execRes = await api.getExecutors();
      if (execRes && execRes.agents) {
        this.executors = execRes.agents;
      }
    } catch {}
    await this.loadWorkflows();
  }

  async loadWorkflows() {
    try {
      const res = await api.getWorkflows();
      if (res && res.success) {
        this.workflows = res.workflows || [];
        if (!this.currentWorkflow && this.workflows.length > 0) {
          const defaultWf = this.workflows.find((w) => w.id === 'default') || this.workflows[0];
          await this.selectWorkflow(defaultWf.id, defaultWf.version);
        } else if (this.currentWorkflow) {
          await this.selectWorkflow(this.currentWorkflow.id, this.currentWorkflow.version);
        }
      }
    } catch (e) {
      console.error('Failed to load workflows:', e);
    }
  }

  async selectWorkflow(id, version) {
    try {
      const res = await api.getWorkflow(id, version);
      if (res && res.success) {
        this.currentWorkflow = res.workflow;
        this.currentNodes = JSON.parse(JSON.stringify(res.workflow.nodes || []));
        this.selectedNodeId = this.currentNodes[0]?.id || null;
        this.connectPending = null;
        this.render();
      }
    } catch (e) {
      alert(`加载工作流失败: ${e.message}`);
    }
  }

  render() {
    const container = document.getElementById('view-workflows');
    if (!container) return;

    if (!this.currentWorkflow) {
      container.innerHTML = '<div class="loading-state">正在加载工作流...</div>';
      return;
    }

    const wf = this.currentWorkflow;
    const selectedNode = this.currentNodes.find((n) => n.id === this.selectedNodeId);

    container.innerHTML = `
      <div class="wf-container">
        <!-- Top Toolbar -->
        <div class="wf-header">
          <div class="wf-title-group">
            <h2>工作流编排</h2>
            <div class="wf-selector-wrap">
              <select id="wf-select-picker" class="input-select" onchange="app.workflowView.onWorkflowSelectChange(this.value)">
                ${this.workflows
                  .map(
                    (w) =>
                      `<option value="${w.id}:${w.version}" ${w.id === wf.id ? 'selected' : ''}>${escapeHtml(w.name)} (v${w.version})${w.isDefault ? ' [默认]' : ''}</option>`
                  )
                  .join('')}
              </select>
              <span class="badge badge-blue">版本 v${wf.version}</span>
            </div>
          </div>
          <div class="action-group">
            <button class="btn btn-secondary" onclick="app.workflowView.showNewWorkflowModal()">➕ 新建工作流</button>
            <button class="btn btn-secondary" onclick="app.workflowView.resetDefaultWorkflow()">🔄 恢复默认流程</button>
            <button class="btn btn-primary" onclick="app.workflowView.saveWorkflow()">💾 保存新版本</button>
          </div>
        </div>

        ${
          this.connectPending
            ? `<div class="wf-connect-banner">
                <span>正在为节点 <strong>[${this.connectPending.sourceId}]</strong> 连线 <strong>${this.connectPending.edgeType === 'on_success' ? '【成功去向】' : '【失败去向】'}</strong>：请点击目标节点卡片完成连线，或</span>
                <button class="btn btn-sm btn-secondary" onclick="app.workflowView.cancelConnect()">取消连线</button>
              </div>`
            : ''
        }

        <!-- Workspace Main: Diagram + Config Panel -->
        <div class="wf-workspace">
          <!-- Left/Center Diagram Area -->
          <div class="wf-canvas-card">
            <div class="wf-canvas-header">
              <span class="canvas-hint">💡 点击节点查看/编辑右侧配置；成功连线为蓝色实线，失败连线为灰色虚线。</span>
              <button class="btn btn-sm btn-secondary" onclick="app.workflowView.addNodePrompt()">➕ 添加任务节点</button>
            </div>
            <div class="wf-svg-viewport" id="wf-svg-viewport">
              ${this.buildSvgDiagram()}
            </div>
          </div>

          <!-- Right Config Panel -->
          <div class="wf-config-card" id="wf-node-config-panel">
            ${this.buildNodeConfigHtml(selectedNode)}
          </div>
        </div>
      </div>
    `;
  }

  onWorkflowSelectChange(val) {
    const [id, ver] = val.split(':');
    this.selectWorkflow(id, parseInt(ver, 10));
  }

  // --- SVG Diagram Rendering ---

  buildSvgDiagram() {
    const nodes = this.currentNodes;
    if (!nodes || nodes.length === 0) {
      return '<div class="empty-state">工作流无节点</div>';
    }

    // Assign fixed positions in a logical horizontal sequence
    const nodePositions = new Map();
    const orderedIds = [];

    // Order: start -> follow on_success chain -> end
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

    // Add any remaining unvisited nodes
    for (const n of nodes) {
      if (!visited.has(n.id)) {
        orderedIds.push(n.id);
        visited.add(n.id);
      }
    }

    const nodeWidth = 150;
    const taskHeight = 84;
    const terminalHeight = 44;
    const startX = 30;
    const gapX = 60;
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

    // Build edges (lines)
    const linesSvg = [];

    nodes.forEach((node) => {
      const fromPos = nodePositions.get(node.id);
      if (!fromPos) return;

      // 1. on_success edge (Blue Solid Line)
      if (node.on_success) {
        const toPos = nodePositions.get(node.on_success);
        if (toPos) {
          const isForward = toPos.x > fromPos.x;
          if (isForward) {
            // Forward straight horizontal connector
            const x1 = fromPos.x + fromPos.w;
            const y1 = fromPos.y + fromPos.h / 2;
            const x2 = toPos.x;
            const y2 = toPos.y + toPos.h / 2;
            const midX = (x1 + x2) / 2;

            linesSvg.push(`
              <path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#2563eb" stroke-width="2.5" fill="none" marker-end="url(#arrow-blue)" />
              <rect x="${midX - 18}" y="${(y1 + y2) / 2 - 10}" width="36" height="18" rx="4" fill="#eff6ff" stroke="#93c5fd" />
              <text x="${midX}" y="${(y1 + y2) / 2 + 3}" font-size="11" fill="#1d4ed8" text-anchor="middle" font-weight="600">成功</text>
            `);
          } else {
            // Backward return connector (loops on top or bottom)
            const x1 = fromPos.x + fromPos.w / 2;
            const y1 = fromPos.y;
            const x2 = toPos.x + toPos.w / 2;
            const y2 = toPos.y;
            const topY = 40;

            linesSvg.push(`
              <path d="M ${x1} ${y1} C ${x1} ${topY}, ${x2} ${topY}, ${x2} ${y2}" stroke="#2563eb" stroke-width="2" stroke-dasharray="4,4" fill="none" marker-end="url(#arrow-blue)" />
              <rect x="${(x1 + x2) / 2 - 18}" y="${topY - 9}" width="36" height="18" rx="4" fill="#eff6ff" stroke="#93c5fd" />
              <text x="${(x1 + x2) / 2}" y="${topY + 4}" font-size="11" fill="#1d4ed8" text-anchor="middle" font-weight="600">成功</text>
            `);
          }
        }
      }

      // 2. on_failure edge (Gray Dashed Line)
      if (node.on_failure) {
        const toPos = nodePositions.get(node.on_failure);
        if (toPos) {
          const isReturn = toPos.x <= fromPos.x;
          if (isReturn) {
            // Loop underneath
            const x1 = fromPos.x + fromPos.w / 2;
            const y1 = fromPos.y + fromPos.h;
            const x2 = toPos.x + toPos.w / 2;
            const y2 = toPos.y + toPos.h;
            const bottomY = baseY + taskHeight + 50 + (nodes.indexOf(node) % 3) * 20;

            linesSvg.push(`
              <path d="M ${x1} ${y1} C ${x1} ${bottomY}, ${x2} ${bottomY}, ${x2} ${y2}" stroke="#64748b" stroke-width="2" stroke-dasharray="5,5" fill="none" marker-end="url(#arrow-gray)" />
              <rect x="${(x1 + x2) / 2 - 18}" y="${bottomY - 9}" width="36" height="18" rx="4" fill="#f8fafc" stroke="#cbd5e1" />
              <text x="${(x1 + x2) / 2}" y="${bottomY + 4}" font-size="11" fill="#475569" text-anchor="middle" font-weight="600">失败</text>
            `);
          } else {
            // Forward failure connector
            const x1 = fromPos.x + fromPos.w;
            const y1 = fromPos.y + fromPos.h - 15;
            const x2 = toPos.x;
            const y2 = toPos.y + toPos.h - 15;
            const midX = (x1 + x2) / 2;

            linesSvg.push(`
              <path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#64748b" stroke-width="2" stroke-dasharray="5,5" fill="none" marker-end="url(#arrow-gray)" />
              <rect x="${midX - 18}" y="${(y1 + y2) / 2 - 9}" width="36" height="18" rx="4" fill="#f8fafc" stroke="#cbd5e1" />
              <text x="${midX}" y="${(y1 + y2) / 2 + 4}" font-size="11" fill="#475569" text-anchor="middle" font-weight="600">失败</text>
            `);
          }
        }
      }
    });

    // Build node boxes
    const nodesSvg = nodes.map((node) => {
      const pos = nodePositions.get(node.id);
      if (!pos) return '';

      const isSelected = node.id === this.selectedNodeId;
      const isStart = node.type === 'start';
      const isEnd = node.type === 'end';

      if (isStart) {
        return `
          <g class="svg-node svg-node-start ${isSelected ? 'selected' : ''}" onclick="app.workflowView.selectNode('${node.id}')" cursor="pointer">
            <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="${pos.h / 2}" fill="${isSelected ? '#dbeafe' : '#eff6ff'}" stroke="${isSelected ? '#2563eb' : '#3b82f6'}" stroke-width="${isSelected ? '3' : '2'}" />
            <text x="${pos.x + pos.w / 2}" y="${pos.y + pos.h / 2 + 5}" font-size="14" font-weight="bold" fill="#1e40af" text-anchor="middle">⚡ 开始</text>
          </g>
        `;
      }

      if (isEnd) {
        return `
          <g class="svg-node svg-node-end ${isSelected ? 'selected' : ''}" onclick="app.workflowView.selectNode('${node.id}')" cursor="pointer">
            <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="${pos.h / 2}" fill="${isSelected ? '#e2e8f0' : '#f1f5f9'}" stroke="${isSelected ? '#475569' : '#64748b'}" stroke-width="${isSelected ? '3' : '2'}" />
            <text x="${pos.x + pos.w / 2}" y="${pos.y + pos.h / 2 + 5}" font-size="14" font-weight="bold" fill="#334155" text-anchor="middle">🏁 结束</text>
          </g>
        `;
      }

      // Task node card
      const modeLabel = node.execution_mode === 'agent' ? 'Agent' : node.execution_mode === 'command' ? '命令' : '人工';
      const modeBadgeColor = node.execution_mode === 'agent' ? '#2563eb' : node.execution_mode === 'command' ? '#0d9488' : '#7c3aed';
      const modeBadgeBg = node.execution_mode === 'agent' ? '#eff6ff' : node.execution_mode === 'command' ? '#f0fdfa' : '#f5f3ff';

      return `
        <g class="svg-node svg-node-task ${isSelected ? 'selected' : ''}" onclick="app.workflowView.selectNode('${node.id}')" cursor="pointer">
          <!-- Card background -->
          <rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" rx="8" fill="#ffffff" stroke="${isSelected ? '#2563eb' : '#cbd5e1'}" stroke-width="${isSelected ? '2.5' : '1.5'}" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.06))" />
          
          <!-- Mode badge -->
          <rect x="${pos.x + 8}" y="${pos.y + 8}" width="38" height="18" rx="4" fill="${modeBadgeBg}" stroke="${modeBadgeColor}" stroke-width="1" />
          <text x="${pos.x + 27}" y="${pos.y + 21}" font-size="10" font-weight="bold" fill="${modeBadgeColor}" text-anchor="middle">${modeLabel}</text>
          
          <!-- Max limit -->
          <text x="${pos.x + pos.w - 10}" y="${pos.y + 21}" font-size="10" fill="#64748b" text-anchor="end">${node.max_executions ? `上限 ${node.max_executions}次` : '不限次数'}</text>

          <!-- Node Name -->
          <text x="${pos.x + 10}" y="${pos.y + 46}" font-size="13" font-weight="bold" fill="#1e293b">${escapeHtml(node.name || node.id)}</text>
          
          <!-- Detail subtext -->
          <text x="${pos.x + 10}" y="${pos.y + 66}" font-size="11" fill="#64748b">${escapeHtml(node.execution_mode === 'agent' ? (node.executor || 'workbuddy') : node.execution_mode === 'command' ? (node.command || '独立测试') : '人工审核')}</text>
        </g>
      `;
    });

    return `
      <svg width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#2563eb" />
          </marker>
          <marker id="arrow-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
          </marker>
        </defs>
        ${linesSvg.join('\n')}
        ${nodesSvg.join('\n')}
      </svg>
    `;
  }

  // --- Node Configuration Panel ---

  buildNodeConfigHtml(node) {
    if (!node) {
      return '<div class="config-empty-hint">请在左侧画布中点击选择一个节点进行配置。</div>';
    }

    const isStart = node.type === 'start';
    const isEnd = node.type === 'end';
    const otherNodes = this.currentNodes.filter((n) => n.id !== node.id && n.type !== 'start');

    return `
      <div class="node-config-header">
        <h3>节点属性配置</h3>
        <span class="badge ${isStart ? 'badge-blue' : isEnd ? 'badge-gray' : 'badge-green'}">${node.type === 'start' ? '开始节点' : node.type === 'end' ? '结束节点' : '任务节点'}</span>
      </div>

      <div class="node-config-form">
        <div class="form-group">
          <label class="form-label">节点 ID (不可修改)</label>
          <input type="text" class="input-text" value="${escapeHtml(node.id)}" disabled />
        </div>

        <div class="form-group">
          <label class="form-label">节点名称</label>
          <input type="text" class="input-text" value="${escapeHtml(node.name || '')}" onchange="app.workflowView.updateCurrentNodeField('name', this.value)" ${isStart || isEnd ? 'disabled' : ''} />
        </div>

        ${
          !isStart && !isEnd
            ? `
          <div class="form-group">
            <label class="form-label">执行方式 (Execution Mode)</label>
            <select class="input-select" onchange="app.workflowView.updateCurrentNodeField('execution_mode', this.value)">
              <option value="agent" ${node.execution_mode === 'agent' ? 'selected' : ''}>Agent (调用 CLI 适配器)</option>
              <option value="command" ${node.execution_mode === 'command' ? 'selected' : ''}>命令 (后台独立执行命令)</option>
              <option value="manual" ${node.execution_mode === 'manual' ? 'selected' : ''}>人工 (等待用户核验确认)</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">最大执行次数 (0 或留空为不限制)</label>
            <input type="number" min="0" max="100" class="input-text" value="${node.max_executions || 0}" onchange="app.workflowView.updateCurrentNodeField('max_executions', parseInt(this.value, 10))" />
            <small class="form-hint">设置为 0 或留空表示节点不做次数限制。</small>
          </div>

          ${
            node.execution_mode === 'agent'
              ? `
            <div class="form-group">
              <label class="form-label">执行器 (Executor)</label>
              <select class="input-select" onchange="app.workflowView.updateCurrentNodeField('executor', this.value)">
                <option value="workbuddy" ${node.executor === 'workbuddy' ? 'selected' : ''}>WorkBuddy</option>
                <option value="codex" ${node.executor === 'codex' ? 'selected' : ''}>Codex</option>
                <option value="antigravity" ${node.executor === 'antigravity' ? 'selected' : ''}>Antigravity</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">结果判定规则 (Result Rule)</label>
              <select class="input-select" onchange="app.workflowView.updateCurrentNodeField('result_rule', this.value)">
                <option value="default" ${node.result_rule !== 'acceptance' ? 'selected' : ''}>普通完成规则</option>
                <option value="acceptance" ${node.result_rule === 'acceptance' ? 'selected' : ''}>结构化验收规则 (Acceptance)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">节点提示词模板 (Prompt)</label>
              <textarea class="input-textarea" rows="4" onchange="app.workflowView.updateCurrentNodeField('prompt', this.value)">${escapeHtml(node.prompt || '')}</textarea>
            </div>
          `
              : node.execution_mode === 'command'
              ? `
            <div class="form-group">
              <label class="form-label">测试/执行命令 (留空则执行测试清单)</label>
              <input type="text" class="input-text" placeholder="npm test 或留空" value="${escapeHtml(node.command || '')}" onchange="app.workflowView.updateCurrentNodeField('command', this.value)" />
            </div>
          `
              : `
            <div class="form-group">
              <label class="form-label">人工核验说明</label>
              <textarea class="input-textarea" rows="3" onchange="app.workflowView.updateCurrentNodeField('prompt', this.value)">${escapeHtml(node.prompt || '')}</textarea>
            </div>
          `
          }
        `
            : ''
        }

        <!-- Routing configuration -->
        ${
          !isEnd
            ? `
          <div class="form-group routing-group">
            <label class="form-label"><strong>成功后去向 (on_success)</strong></label>
            <div class="routing-row">
              <select class="input-select" onchange="app.workflowView.updateCurrentNodeField('on_success', this.value)">
                ${otherNodes
                  .map((n) => `<option value="${n.id}" ${node.on_success === n.id ? 'selected' : ''}>${escapeHtml(n.name)} (${n.id})</option>`)
                  .join('')}
              </select>
              <button class="btn btn-sm btn-secondary" onclick="app.workflowView.startConnect('${node.id}', 'on_success')">🎯 连线点击</button>
            </div>
          </div>
        `
            : ''
        }

        ${
          !isStart && !isEnd
            ? `
          <div class="form-group routing-group">
            <label class="form-label"><strong>失败后去向 (on_failure)</strong></label>
            <div class="routing-row">
              <select class="input-select" onchange="app.workflowView.updateCurrentNodeField('on_failure', this.value || null)">
                <option value="" ${!node.on_failure ? 'selected' : ''}>-- 无（失败后暂停任务）--</option>
                ${otherNodes
                  .filter((n) => n.type !== 'end')
                  .map((n) => `<option value="${n.id}" ${node.on_failure === n.id ? 'selected' : ''}>${escapeHtml(n.name)} (${n.id})</option>`)
                  .join('')}
              </select>
              <button class="btn btn-sm btn-secondary" onclick="app.workflowView.startConnect('${node.id}', 'on_failure')">🎯 连线点击</button>
            </div>
          </div>
        `
            : ''
        }

        ${
          !isStart && !isEnd
            ? `
          <div class="node-actions-footer">
            <button class="btn btn-sm btn-danger" onclick="app.workflowView.deleteCurrentNode('${node.id}')">🗑️ 删除该节点</button>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  // --- Node Actions ---

  selectNode(id) {
    if (this.connectPending) {
      // Connect pending edge to this clicked node
      const { sourceId, edgeType } = this.connectPending;
      if (sourceId === id) {
        alert('不能连线到自身');
        return;
      }
      const targetNode = this.currentNodes.find((n) => n.id === id);
      if (targetNode?.type === 'start') {
        alert('不能连线回开始节点');
        return;
      }
      if (edgeType === 'on_failure' && targetNode?.type === 'end') {
        alert('失败去向不能直接连向结束节点');
        return;
      }

      const sourceNode = this.currentNodes.find((n) => n.id === sourceId);
      if (sourceNode) {
        sourceNode[edgeType] = id;
      }
      this.connectPending = null;
      this.selectedNodeId = sourceId;
      this.render();
      return;
    }

    this.selectedNodeId = id;
    this.render();
  }

  startConnect(sourceId, edgeType) {
    this.connectPending = { sourceId, edgeType };
    this.render();
  }

  cancelConnect() {
    this.connectPending = null;
    this.render();
  }

  updateCurrentNodeField(field, value) {
    const node = this.currentNodes.find((n) => n.id === this.selectedNodeId);
    if (!node) return;
    node[field] = value;
    this.render();
  }

  addNodePrompt() {
    const name = prompt('请输入新任务节点名称 (如: 压力测试 / 代码重构):');
    if (!name || !name.trim()) return;

    const baseId = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'task';
    let id = baseId;
    let count = 1;
    while (this.currentNodes.some((n) => n.id === id)) {
      id = `${baseId}_${count++}`;
    }

    // Default target is end node
    const endNode = this.currentNodes.find((n) => n.type === 'end');
    const devNode = this.currentNodes.find((n) => n.id === 'development') || this.currentNodes[1];

    const newNode = {
      id,
      name: name.trim(),
      type: 'task',
      execution_mode: 'agent',
      executor: 'workbuddy',
      model: 'default',
      prompt: `执行节点任务: ${name.trim()}`,
      max_executions: 0,
      on_success: endNode ? endNode.id : null,
      on_failure: devNode ? devNode.id : null,
    };

    // Insert before end node
    const endIndex = this.currentNodes.findIndex((n) => n.type === 'end');
    if (endIndex >= 0) {
      this.currentNodes.splice(endIndex, 0, newNode);
    } else {
      this.currentNodes.push(newNode);
    }

    this.selectedNodeId = id;
    this.render();
  }

  deleteCurrentNode(id) {
    const node = this.currentNodes.find((n) => n.id === id);
    if (!node || node.type === 'start' || node.type === 'end') {
      alert('开始节点和结束节点不可删除');
      return;
    }

    if (!confirm(`确定删除任务节点 [${node.name || id}] 吗？`)) return;

    // Remove node
    this.currentNodes = this.currentNodes.filter((n) => n.id !== id);

    // Clean up references in other nodes
    this.currentNodes.forEach((n) => {
      if (n.on_success === id) n.on_success = null;
      if (n.on_failure === id) n.on_failure = null;
    });

    this.selectedNodeId = this.currentNodes[0]?.id || null;
    this.render();
  }

  // --- Save & Reset Actions ---

  async saveWorkflow() {
    if (!this.currentWorkflow) return;

    try {
      const res = await api.saveWorkflow({
        id: this.currentWorkflow.id,
        name: this.currentWorkflow.name,
        description: this.currentWorkflow.description,
        is_default: this.currentWorkflow.isDefault ? 1 : 0,
        nodes: this.currentNodes,
      });

      if (!res.success) {
        alert(`保存工作流失败:\n${res.message || res.errors?.join('\n')}`);
        return;
      }

      alert(`工作流保存成功！产生新版本: v${res.workflow.version}`);
      await this.loadWorkflows();
      await this.selectWorkflow(res.workflow.id, res.workflow.version);
    } catch (e) {
      alert(`保存工作流失败: ${e.message}`);
    }
  }

  async resetDefaultWorkflow() {
    if (!confirm('确定将默认工作流恢复至系统内置标准模板（开始→开发→测试→验收→人工确认→结束）吗？')) return;
    try {
      const res = await api.resetDefaultWorkflow();
      if (res.success) {
        alert('默认工作流已成功重置！');
        await this.loadWorkflows();
        await this.selectWorkflow('default');
      } else {
        alert(`重置失败: ${res.message}`);
      }
    } catch (e) {
      alert(`重置失败: ${e.message}`);
    }
  }

  showNewWorkflowModal() {
    const id = prompt('请输入新工作流唯一英文 ID (如: fast_track / full_regression):');
    if (!id || !id.trim()) return;
    const name = prompt('请输入新工作流中文名称 (如: 快速修复交付流程):');
    if (!name || !name.trim()) return;

    // Seed basic 3-node graph: start -> dev -> end
    const nodes = [
      { id: 'start', name: '开始', type: 'start', on_success: 'development' },
      {
        id: 'development',
        name: '开发实现',
        type: 'task',
        execution_mode: 'agent',
        executor: 'workbuddy',
        model: 'default',
        prompt: '实现需求',
        max_executions: 0,
        on_success: 'end',
        on_failure: null,
      },
      { id: 'end', name: '结束', type: 'end' },
    ];

    api
      .saveWorkflow({
        id: id.trim(),
        name: name.trim(),
        description: '自定义新建工作流',
        nodes,
      })
      .then((res) => {
        if (res.success) {
          this.loadWorkflows().then(() => this.selectWorkflow(id.trim(), res.workflow.version));
        } else {
          alert(`创建失败: ${res.message || res.errors?.join('; ')}`);
        }
      });
  }
}
