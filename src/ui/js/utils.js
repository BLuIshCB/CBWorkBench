/**
 * CBWorkBench UI 基础工具库
 */

export function formatTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatStatus(status) {
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

export function formatStage(stage) {
  const map = {
    worker_dev: 'Worker 开发与修复',
    worker_review: 'Worker 审查准备',
    running_tests: '独立必需测试',
    codex_acceptance: 'Reviewer 自动验收',
    human_review: '人工审核门禁',
  };
  return map[stage] || stage;
}

export function copyToClipboard(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.innerText || el.textContent || '';
  navigator.clipboard.writeText(text).then(
    () => alert('已成功复制到剪贴板！'),
    () => alert('复制失败，请手动选择复制。')
  );
}

export function toggleDrawer(drawerId) {
  const el = document.getElementById(drawerId);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

/**
 * 极简且强大的 Markdown 渲染器，将 Markdown 文本转换成美观的 HTML 结构
 */
export function renderMarkdown(md) {
  if (!md) return '<p style="color: var(--text-muted);">(无内容)</p>';

  // 1. 抽取并临时保护代码块 ``` ... ```
  const codeBlocks = [];
  let text = md.replace(/```([a-zA-Z0-9_\-]*)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang || '', code: escapeHtml(code.trim()) });
    return placeholder;
  });

  // 2. 抽取并保护单行代码 `...`
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(escapeHtml(code));
    return placeholder;
  });

  // 3. 转义普通 HTML 字符防止 XSS
  text = escapeHtml(text);

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
  text = text.replace(/<\/ul>\s*<ul>/g, '');

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
