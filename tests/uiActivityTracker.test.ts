import assert from 'node:assert/strict';
import { UiActivityTracker, uiActivityTracker } from '../src/services/uiActivityTracker.ts';

console.log('[Test] Running uiActivityTracker.test.ts...');

// 1. 初始状态
{
  const tracker = new UiActivityTracker(10000, 8000);
  assert.equal(tracker.hasActiveUi(1000), false, 'Initial state should have no active UI');
  assert.equal(tracker.getLastBrowserOpenedAt(), 0, 'Initial browser open time should be 0');
  console.log('  ✓ Initial state is inactive');
}

// 2. 8 秒防重复弹窗冷却锁
{
  const tracker = new UiActivityTracker(10000, 8000);
  const openTime = 100000;
  tracker.recordBrowserOpen(openTime);
  assert.equal(tracker.getLastBrowserOpenedAt(), openTime);

  // 冷却期内 (0s ~ 7.999s)
  assert.equal(tracker.hasActiveUi(openTime + 100), true, 'Active immediately after open');
  assert.equal(tracker.hasActiveUi(openTime + 4000), true, 'Active at 4s');
  assert.equal(tracker.hasActiveUi(openTime + 7999), true, 'Active just before cooldown ends');

  // 冷却期后 (>= 8s)
  assert.equal(tracker.hasActiveUi(openTime + 8000), false, 'Inactive exactly at cooldown boundary');
  assert.equal(tracker.hasActiveUi(openTime + 8001), false, 'Inactive after cooldown ends');
  console.log('  ✓ 8-second browser open cooldown lock functions accurately');
}

// 3. 心跳检测与多客户端会话维护
{
  const tracker = new UiActivityTracker(10000, 8000);
  const baseTime = 200000;

  tracker.recordHeartbeat('client-1', baseTime);
  assert.equal(tracker.hasActiveUi(baseTime + 5000), true, 'Active with client-1 heartbeat at 5s');

  // 注册 client-2
  tracker.recordHeartbeat('client-2', baseTime + 6000);
  // 在 baseTime + 11000 时，client-1 (已过 11s) 超时失效，但 client-2 (仅过 5s) 依然活跃
  assert.equal(tracker.hasActiveUi(baseTime + 11000), true, 'Active because client-2 is still within 10s');

  // 移除 client-2，此时全部 session 退出
  tracker.removeSession('client-2');
  assert.equal(tracker.hasActiveUi(baseTime + 11000), false, 'Inactive after all sessions removed');
  console.log('  ✓ Multi-client session lifecycle & timeout tracking works');
}

// 4. 兜底心跳 (无 clientId)
{
  const tracker = new UiActivityTracker(10000, 8000);
  const baseTime = 300000;

  tracker.recordHeartbeat('', baseTime);
  assert.equal(tracker.hasActiveUi(baseTime + 2000), true, 'Active with anonymous heartbeat');
  assert.equal(tracker.hasActiveUi(baseTime + 10001), false, 'Inactive when anonymous heartbeat expires');
  console.log('  ✓ Anonymous heartbeat fallback works');
}

// 5. reset 与单例验证
{
  uiActivityTracker.reset();
  assert.equal(uiActivityTracker.hasActiveUi(), false);
  uiActivityTracker.recordBrowserOpen();
  assert.equal(uiActivityTracker.hasActiveUi(), true);
  uiActivityTracker.reset();
  assert.equal(uiActivityTracker.hasActiveUi(), false);
  console.log('  ✓ Global singleton instance reset works');
}

// 6. removeSession 处理包含过期会话的清理 (防幽灵活跃)
{
  const tracker = new UiActivityTracker(10000, 8000);
  // client-crashed 在 10000 上报
  tracker.recordHeartbeat('client-crashed', 10000);
  // client-normal 在 18000 上报 (此时 client-crashed 距今 8s 尚未过期)
  tracker.recordHeartbeat('client-normal', 18000);
  assert.equal(tracker.hasActiveUi(19000), true);

  // 在 22000 时，client-crashed 已超期 12s。client-normal 正常退出
  tracker.removeSession('client-normal', 22000);

  // 此时唯一活着的会话已关闭，虽然 client-normal 4s 前刚上报过，但系统应立即判定为 inactive
  assert.equal(tracker.hasActiveUi(22001), false, 'Should be inactive immediately after last valid session removed');
  console.log('  ✓ Stale dead session does not prevent session removal from resetting active state');
}

// 7. 多活跃会话时移除其中一个，保持剩余会话的最大心跳时间
{
  const tracker = new UiActivityTracker(10000, 8000);
  tracker.recordHeartbeat('client-A', 10000);
  tracker.recordHeartbeat('client-B', 15000);

  // 移除 client-B，client-A 依然有效 (15100 - 10000 = 5100 < 10000)
  tracker.removeSession('client-B', 15100);
  assert.equal(tracker.hasActiveUi(15100), true, 'Still active with remaining client-A');
  // client-A 在 20001 超期 (20001 - 10000 = 10001 > 10000)
  assert.equal(tracker.hasActiveUi(20001), false, 'Inactive when client-A expires');
  console.log('  ✓ Removing one of multiple sessions accurately preserves remaining session heartbeat');
}

console.log('✅ uiActivityTracker.test.ts passed successfully!');
