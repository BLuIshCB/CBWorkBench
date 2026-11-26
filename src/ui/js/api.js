/**
 * CBWorkBench 前端 API 客户端层
 */

const API_BASE = window.location.origin;

/**
 * 统一 HTTP 请求封装，安全解析 JSON 并为非 JSON 错误响应提供可读提示。
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };
  const res = await fetch(url, {
    ...options,
    headers,
  });

  const rawText = await res.text();
  if (!rawText) {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }
    return { success: true };
  }

  try {
    return JSON.parse(rawText);
  } catch {
    if (res.status === 404) {
      throw new Error(`接口不存在 (HTTP 404): ${endpoint}，当前后台服务版本可能过旧，请重启最新服务或重新打包后再试`);
    }
    throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 200)}`);
  }
}

export const api = {
  // System APIs
  getExecutors: () => request('/api/system/executors'),

  // Tasks APIs
  getTasks: (status) => request(`/api/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getTaskDetail: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`),
  getRevisionResource: (taskId, revision, resourcePath, offset = 0, limit = 262144) =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/revisions/${encodeURIComponent(revision)}/resource?path=${encodeURIComponent(resourcePath)}&offset=${offset}&limit=${limit}`),
  getReworkResource: (taskId, revision, nodeId, sequence) =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/revisions/${revision}/rework/${sequence}?node=${encodeURIComponent(nodeId)}`),
  confirmStartTask: (taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/confirm-start`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  stopTask: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: 'POST',
  }),
  deleteTask: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  }),
  clearAllTasks: () => request('/api/tasks/clear-all', {
    method: 'POST',
  }),
  submitHumanReview: (taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/human-review`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  // Runtime & Probe APIs
  getRuntimeClis: (options = {}) => {
    const opts = typeof options === 'boolean' ? { withVersion: options } : options;
    const params = new URLSearchParams();
    if (opts.refresh) params.set('refresh', '1');
    else if (opts.withVersion) params.set('version', '1');
    const query = params.toString();
    return request(`/api/runtime/clis${query ? `?${query}` : ''}`);
  },
  refreshRuntimePath: () => request('/api/runtime/refresh-path', { method: 'POST', body: '{}' }),
  pickRuntimeFile: () => request('/api/runtime/pick-file', { method: 'POST', body: '{}' }),
  setRuntimeCliPath: (body) => request('/api/runtime/cli-path', { method: 'POST', body: JSON.stringify(body) }),
  probeCli: (body) => request('/api/runtime/probe', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  // Workflow APIs
  getWorkflows: () => request('/api/workflows'),
  getWorkflow: (id) => request(`/api/workflows/${encodeURIComponent(id)}`),
  importWorkflow: (workflow) => request('/api/workflows/import', {
    method: 'POST',
    body: JSON.stringify(workflow),
  }),
  exportWorkflow: (id) => request(`/api/workflows/${encodeURIComponent(id)}/export`),
  saveWorkflow: (body) => request('/api/workflows', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  resetDefaultWorkflow: () => request('/api/workflows/reset-default', {
    method: 'POST',
  }),
  deleteWorkflow: (id) => request(`/api/workflows/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  getTaskWorkflow: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/workflow`),
  updateTaskWorkflowNode: (taskId, nodeId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/workflow/nodes/${encodeURIComponent(nodeId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  submitManualDecision: (taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/workflow/manual-decision`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
};
