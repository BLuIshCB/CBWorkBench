# 工单开发清单 (Tracer-Bullet Tickets)

## TICKET-01: 创建隔离交付产物并输出 UTF-8 中文
- **需求 ID:** REQ-CLI-01
- **阻塞关系:** blocked_by: [], blocks: [TICKET-02]
- **负责 Worker:** worker-dev
- **修改范围:** `data/cli-verification/result.txt`
- **任务目标:**
  - 使用文件工具在 `data/cli-verification/result.txt` 写入一行文本：
    `CLI_DIRECT_DISPATCH_OK: 中文任务执行成功 😀`
  - 确保文件编码为标准 UTF-8，包含尾部换行符。
- **完成条件:** 文件存在且内容精确匹配。

## TICKET-02: 运行端到端独立断言与全套回归验证
- **需求 ID:** REQ-CLI-02
- **阻塞关系:** blocked_by: [TICKET-01], blocks: []
- **负责 Worker:** worker-dev
- **修改范围:** 无代码修改，仅执行自动化测试验证
- **任务目标:**
  - 运行自动化测试验证 `data/cli-verification/result.txt` 的字节哈希与内容；
  - 运行工作台全量离线回归套件 `node bin/test-runner.js tests/cliRunner.test.ts`；
  - 对照 `/code-review` 检查 `git diff`，确保不污染业务工程外文件。
- **完成条件:** 独立测试执行退出码均为 0。
