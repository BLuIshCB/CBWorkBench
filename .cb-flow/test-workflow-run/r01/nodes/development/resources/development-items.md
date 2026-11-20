# 工单清单 (Tracer-Bullet Tickets)

## TICKET-01: 创建冒烟自测产物
- 需求 ID: REQ-TEST-01
- 阻塞关系: blocked_by: [], blocks: [TICKET-02]
- 目标路径: outputs/smoke-test/test-result.json
- 完成标准: 文件创建并包含指定 JSON。

## TICKET-02: 运行冒烟测试断言与自审
- 需求 ID: REQ-TEST-02
- 阻塞关系: blocked_by: [TICKET-01], blocks: []
- 完成标准: 自动化断言通过，退出码为 0。
