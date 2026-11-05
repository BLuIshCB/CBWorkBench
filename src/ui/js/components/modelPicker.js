import { escapeHtml } from '../utils.js';

const CUSTOM_MODEL = '__custom_model__';

/** 原生下拉不依赖 datalist 弹层；自定义模型使用独立输入框。 */
export function populateModelPicker(id, agent, preferredModel) {
  const select = document.getElementById(id);
  const custom = document.getElementById(`${id}-custom`);
  if (!select || !custom) return;
  const fallback = agent?.defaultModel || 'default';
  const models = [...new Set([fallback, ...(agent?.supportedModels || [])])];
  const selected = preferredModel || fallback;
  select.innerHTML = models.map(model => `<option value="${escapeHtml(model)}">${model === 'default' ? '沿用CLI配置' : escapeHtml(model)}</option>`).join('') +
    `<option value="${CUSTOM_MODEL}">手动输入模型…</option>`;
  select.value = models.includes(selected) ? selected : CUSTOM_MODEL;
  custom.value = models.includes(selected) ? '' : selected;
  updateModelPicker(id);
}

export function updateModelPicker(id) {
  const select = document.getElementById(id);
  const custom = document.getElementById(`${id}-custom`);
  if (select && custom) custom.style.display = select.value === CUSTOM_MODEL ? '' : 'none';
}

export function getModelValue(id) {
  const select = document.getElementById(id);
  return (select?.value === CUSTOM_MODEL ? document.getElementById(`${id}-custom`)?.value : select?.value)?.trim() || '';
}
