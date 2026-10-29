/**
 * CBWorkBench 响应式状态管理中心
 */

class Store {
  constructor() {
    this.state = {
      currentFilter: 'all',
      currentTaskId: null,
      tasks: [],
      currentTaskDetail: null,
      activeDetailTab: 'overview',
      currentMaterialSubtab: 'task',
      latestMaterials: null,
      availableWorkers: [],
      availableReviewers: [],
      runtimeClis: [],
      currentProbeResult: null,
    };
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  setState(partialState) {
    this.state = { ...this.state, ...partialState };
    this.notify();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.error('[Store] Error in listener:', e);
      }
    }
  }
}

export const store = new Store();
