/**
 * CBWorkBench 前端 API 客户端层
 */

const API_BASE = window.location.origin;

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  return res.json();
}

export const api = {
  // System APIs
  getSystemStatus: () => request('/api/system/status'),
  getExecutors: () => request('/api/system/executors'),

  // Tasks APIs
  getTasks: (status) => request(`/api/tasks${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getTaskDetail: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`),
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
  getRuntimeClis: () => request('/api/runtime/clis'),
  probeCli: (body) => request('/api/runtime/probe', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  // Workflow APIs
  getWorkflows: () => request('/api/workflows'),
  getWorkflow: (id, version) => request(`/api/workflows/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`),
  saveWorkflow: (body) => request('/api/workflows', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  resetDefaultWorkflow: () => request('/api/workflows/reset-default', {
    method: 'POST',
  }),
  getTaskWorkflow: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/workflow`),
  submitManualDecision: (taskId, body) => request(`/api/tasks/${encodeURIComponent(taskId)}/workflow/manual-decision`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
};
