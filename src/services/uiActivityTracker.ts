export class UiActivityTracker {
  private lastHeartbeatAt: number = 0;
  private lastBrowserOpenedAt: number = 0;
  private activeSessions = new Map<string, number>();
  private readonly heartbeatTimeoutMs: number = 15000; // 15秒无心跳视为断开 (容错 Chromium 后台节流)
  private readonly openCooldownMs: number = 8000;       // 8秒防高频重复弹窗冷却锁

  constructor(heartbeatTimeoutMs: number = 15000, openCooldownMs: number = 8000) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.openCooldownMs = openCooldownMs;
  }

  recordHeartbeat(clientId: string, timestamp?: number): void {
    const now = timestamp !== undefined ? timestamp : Date.now();
    this.lastHeartbeatAt = now;
    const trimmedId = clientId?.trim();
    if (trimmedId) {
      this.activeSessions.set(trimmedId, now);
    }
    this.cleanupExpired(now);
  }

  removeSession(clientId: string, timestamp?: number): void {
    const now = timestamp !== undefined ? timestamp : Date.now();
    const trimmedId = clientId?.trim();
    if (trimmedId) {
      this.activeSessions.delete(trimmedId);
    }
    this.cleanupExpired(now);
    if (this.activeSessions.size === 0) {
      this.lastHeartbeatAt = 0;
    } else {
      let maxTimestamp = 0;
      for (const t of this.activeSessions.values()) {
        if (t > maxTimestamp) maxTimestamp = t;
      }
      this.lastHeartbeatAt = maxTimestamp;
    }
  }

  recordBrowserOpen(timestamp?: number): void {
    this.lastBrowserOpenedAt = timestamp !== undefined ? timestamp : Date.now();
  }

  getLastBrowserOpenedAt(): number {
    return this.lastBrowserOpenedAt;
  }

  /**
   * 判定页面是否已打开或处于冷启动加载宽限期
   */
  hasActiveUi(nowTimestamp?: number): boolean {
    const now = nowTimestamp !== undefined ? nowTimestamp : Date.now();

    // 1. 冷却锁判定：8秒内刚触发过打开，认定为正在打开中
    if (this.lastBrowserOpenedAt > 0 && (now - this.lastBrowserOpenedAt) < this.openCooldownMs) {
      return true;
    }

    // 2. 活跃 Session 判定
    this.cleanupExpired(now);
    if (this.activeSessions.size > 0) {
      return true;
    }

    // 3. 兜底心跳判定 (如未传 clientId 的心跳)
    if (this.lastHeartbeatAt > 0 && (now - this.lastHeartbeatAt) < this.heartbeatTimeoutMs) {
      return true;
    }

    return false;
  }

  private cleanupExpired(now: number): void {
    for (const [id, lastSeen] of this.activeSessions.entries()) {
      if (now - lastSeen > this.heartbeatTimeoutMs) {
        this.activeSessions.delete(id);
      }
    }
  }

  reset(): void {
    this.lastHeartbeatAt = 0;
    this.lastBrowserOpenedAt = 0;
    this.activeSessions.clear();
  }
}

export const uiActivityTracker = new UiActivityTracker();
