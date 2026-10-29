# 任务规格说明：CLI 任务分发与无客户端对话验证

## 1. 需求背景与目标

CBWorkBench 工作台已将 Worker 与 Reviewer 全面重构成 Direct CLI 非交互模式：
- 本地非交互子进程直接派发，移除了 WorkBuddy Desktop Bridge、桌面 Sidecar 及外部 MCP Client 依赖；
- 必须通过 UTF-8 stdin 传递完整长提示词与中文多行内容，避免命令行参数截断；
- 每次任务执行均添加 `--no-session-persistence`（或 Codex 的 `--ephemeral`），禁止将本次 Agent 对话持久化到桌面客户端；
- 任务执行完成后，客户端无新增会话，工作台保留完整审计与测试证据。

## 2. 交付与验证范围 (Scope)

### In Scope
1. 验证 Worker Direct CLI 在隔离工作目录下安全创建 `data/cli-verification/result.txt`；
2. 内容精确包含 UTF-8 中文与状态标识：`CLI_DIRECT_DISPATCH_OK: 中文任务执行成功 😀`；
3. 运行工作台独立自动化测试断言，验证文件逐字节完整性；
4. 由 Reviewer 在只读沙箱下读取产物并给出结构化通过判定；
5. 人工确认 WorkBuddy / Codex 客户端会话列表未新增本次对话记录。

### Out of Scope
- 不修改供应商安装目录和全局 bundle；
- 不修改全局 MCP 配置；
- 不允许任何伪装测试或 mock 绕过。
