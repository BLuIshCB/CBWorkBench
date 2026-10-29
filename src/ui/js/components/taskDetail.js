/**
 * CBWorkBench 任务详情视图组件
 */

import { escapeHtml, formatStatus, formatStage, renderMarkdown } from '../utils.js';

export const TaskDetail = {
  render(data, availableWorkers, availableReviewers, activeDetailTab, currentMaterialSubtab) {
    const { task, latestRevision, workerPrompts, rounds, testRuns, acceptanceRuns } = data;

    // 1. Header summary line
    const titleEl = document.getElementById('detail-task-title');
    if (titleEl) titleEl.textContent = task.title;
    const keyEl = document.getElementById('detail-task-key');
    if (keyEl) keyEl.textContent = task.task_key;
    const revEl = document.getElementById('detail-task-rev');
    if (revEl) revEl.textContent = `r${task.revision}`;
    const roundEl = document.getElementById('detail-current-round');
    if (roundEl) roundEl.textContent = task.current_round;
    const maxRoundEl = document.getElementById('detail-max-rounds');
    if (maxRoundEl) maxRoundEl.textContent = task.budget_max_rounds;
    const createdEl = document.getElementById('detail-created-at');
    if (createdEl) createdEl.textContent = new Date(task.created_at).toLocaleString();

    const workerEl = document.getElementById('detail-worker-info');
    if (workerEl) {
      workerEl.textContent = `${task.worker_executor || 'workbuddy'}:${task.worker_model || 'deepseek-v4-flash'}`;
    }
    const reviewerEl = document.getElementById('detail-reviewer-info');
    if (reviewerEl) {
      reviewerEl.textContent = `${task.reviewer_executor || 'workbuddy'}:${task.reviewer_model || 'deepseek-v4-flash'}`;
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
      deleteBtn.innerHTML = '🗑️ 删除任务';
      deleteBtn.title = '删除此任务并一并清理相关方案和文件';
      deleteBtn.onclick = () => window.app.handleDeleteCurrentTask();
      actionsContainer.appendChild(deleteBtn);
    }

    // 3. Gate 2 Confirmation Card
    const gate2Card = document.getElementById('gate2-card');
    if (gate2Card) {
      if (task.status === 'pending_confirm') {
        gate2Card.style.display = 'block';
        const inputCwd = document.getElementById('input-confirmed-cwd');
        if (inputCwd && !inputCwd.value) {
          inputCwd.value = task.target_cwd;
        }

        window.app.populateExecutorSelects(
          task.worker_executor || 'workbuddy',
          task.worker_model || 'deepseek-v4-flash',
          task.reviewer_executor || 'workbuddy',
          task.reviewer_model || 'deepseek-v4-flash'
        );

        const gitInfoEl = document.getElementById('gate2-git-info');
        if (gitInfoEl) {
          gitInfoEl.innerHTML = `
            <span style="color: var(--text-muted);">提交默认目录：</span> <code>${escapeHtml(task.target_cwd)}</code>
            ${task.git_commit ? ` | <span style="color: var(--text-muted);">基准 HEAD：</span> <code>${task.git_commit}</code>` : ''}
          `;
        }
      } else {
        gate2Card.style.display = 'none';
      }
    }

    // 4. Gate 3 Human Review Banner
    const gate3Card = document.getElementById('gate3-card');
    if (gate3Card) {
      gate3Card.style.display = task.status === 'human_review' ? 'flex' : 'none';
    }

    // 5. Blocked Alert
    const blockedAlert = document.getElementById('blocked-alert');
    if (blockedAlert) {
      if (task.status === 'blocked') {
        blockedAlert.style.display = 'flex';
        const reasonEl = document.getElementById('blocked-reason-text');
        if (reasonEl) reasonEl.textContent = task.blocked_reason || '执行受阻或超出预算';
      } else {
        blockedAlert.style.display = 'none';
      }
    }

    // 6. Stepper States
    this.updateStepper(task.current_stage, task.status);

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
    this.renderRoundsTimeline(rounds, testRuns, acceptanceRuns);

    // 9. Materials Content (Markdown Reader)
    this.renderCurrentMaterial({
      task_md: latestRevision?.task_md || '# 无任务说明',
      development_md: latestRevision?.development_md || '# 无开发清单',
      tests_md: latestRevision?.tests_md || '# 无测试用例',
      acceptance_md: latestRevision?.acceptance_md || '# 无验收标准',
      workerPrompts: workerPrompts || [],
    }, currentMaterialSubtab);
  },

  updateStepper(stage, status) {
    const steps = ['worker', 'tests', 'codex', 'review'];
    steps.forEach((s) => {
      const el = document.getElementById(`step-${s}`);
      if (el) el.classList.remove('active', 'passed');
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
  },

  renderRoundsTimeline(rounds, testRuns, acceptanceRuns) {
    const container = document.getElementById('rounds-timeline');
    if (!container) return;

    if (!rounds || rounds.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); padding: 30px; text-align: center;">任务尚未产生执行轮次记录。</div>';
      return;
    }

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
                  const durationSec = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + 's' : (r.finished_at && r.started_at ? ((r.finished_at - r.started_at)/1000).toFixed(1)+'s' : '--');
                  const adapterLabel = r.adapter_id ? `${r.adapter_id} (${r.model_name || 'default'})` : (r.worker_id || 'workbuddy');

                  return `
              <div style="background: #0d1117; padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: 600; color: #58a6ff; font-size: 13px;">${formatStage(r.stage)}</span>
                    <span class="dbg-pill" style="color: #a371f7; background: rgba(163, 113, 247, 0.1);">
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

                ${r.error_message ? `<div style="color: #ff7b72; font-size: 12px; margin-top: 6px; padding: 6px 10px; background: rgba(255, 123, 114, 0.1); border-radius: 4px;">❌ 错误信息：${escapeHtml(r.error_message)}</div>` : ''}
              </div>
            `;
                }
              )
              .join('')}

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
                        <code style="margin-left: 6px;">${escapeHtml(t.command)}</code>
                      </div>
                      <span style="color: var(--text-muted); font-size: 11px;">Exit: ${t.exit_code}</span>
                    </div>
                    ${t.stderr && !t.passed ? `<pre style="color: #ff7b72; font-size: 11px; background: rgba(255,0,0,0.1); padding: 6px; margin-top: 4px; border-radius: 4px; overflow-x: auto;">${escapeHtml(t.stderr)}</pre>` : ''}
                    ${t.stdout && !t.passed ? `<pre style="color: #8b949e; font-size: 11px; padding: 4px; margin-top: 2px; overflow-x: auto;">${escapeHtml(t.stdout)}</pre>` : ''}
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
              <div style="background: #0d1117; padding: 12px 16px; border-radius: 6px; border: 1px solid var(--surface-border); border-left: 4px solid #bc8cff;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <span style="font-weight: 600; color: #bc8cff; font-size: 13px;">Reviewer 自动验收评估报告：</span>
                  <span class="badge ${roundAcceptance.decision === 'passed' ? 'badge-completed' : roundAcceptance.decision === 'needs_changes' ? 'badge-pending_confirm' : 'badge-blocked'}">${roundAcceptance.decision}</span>
                </div>
                <div style="font-size: 13px; color: #f0f6fc; margin-bottom: 8px; line-height: 1.5;">${escapeHtml(roundAcceptance.summary)}</div>
                ${roundAcceptance.issues_json && roundAcceptance.issues_json !== '[]' ? `
                  <div style="margin-top: 8px; padding: 8px 10px; background: rgba(255, 123, 114, 0.08); border-radius: 4px;">
                    <div style="color: #ff7b72; font-weight: 600; font-size: 12px; margin-bottom: 4px;">待修复 Issues 清单：</div>
                    <pre style="color: #ff7b72; font-size: 11px; white-space: pre-wrap;">${escapeHtml(roundAcceptance.issues_json)}</pre>
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

  renderCurrentMaterial(materials, subtab) {
    const container = document.getElementById('mat-rendered-content');
    if (!container || !materials) return;

    let mdText = '';
    switch (subtab) {
      case 'task':
        mdText = materials.task_md;
        break;
      case 'dev':
        mdText = materials.development_md;
        break;
      case 'tests':
        mdText = materials.tests_md;
        break;
      case 'acceptance':
        mdText = materials.acceptance_md;
        break;
      case 'worker':
        if (materials.workerPrompts && materials.workerPrompts.length > 0) {
          mdText = materials.workerPrompts
            .map((w) => `### Worker: ${w.worker_id} (${w.role})\n\n${w.prompt_text}`)
            .join('\n\n---\n\n');
        } else {
          mdText = '*未定义独立 Worker 提示词*';
        }
        break;
    }

    container.innerHTML = renderMarkdown(mdText);
  },
};
