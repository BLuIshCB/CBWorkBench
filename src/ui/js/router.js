/**
 * CBWorkBench 前端路由控制器
 */

export class Router {
  constructor(handlers) {
    this.handlers = handlers;
    window.addEventListener('popstate', () => this.handleRoute());
  }

  handleRoute() {
    const path = window.location.pathname;
    if (path === '/runtime') {
      this.handlers.onRuntime(false);
    } else {
      const taskMatch = path.match(/^\/tasks\/([a-zA-Z0-9_\-]+)/);
      if (taskMatch) {
        this.handlers.onTaskDetail(taskMatch[1], false);
      } else {
        this.handlers.onTaskList(false);
      }
    }
  }

  navigate(path) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    this.handleRoute();
  }

  updateNavTabs(activeTab) {
    const tabTasks = document.getElementById('nav-tab-tasks');
    const tabRuntime = document.getElementById('nav-tab-runtime');
    if (tabTasks) tabTasks.classList.toggle('active', activeTab === 'tasks');
    if (tabRuntime) tabRuntime.classList.toggle('active', activeTab === 'runtime');
  }
}
