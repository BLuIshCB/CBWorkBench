# 验收标准清单 (Acceptance Criteria)

## 自动化验收标准 (Automated Review)

### CRIT-01: 交付产物存在且内容与编码正确
- **关联需求:** REQ-CLI-01
- **责任方:** Reviewer (Codex / WorkBuddy 只读沙箱)
- **判定条件:** `data/cli-verification/result.txt` 存在且内容包含 `CLI_DIRECT_DISPATCH_OK: 中文任务执行成功 😀`。
- **所需证据:** 实际读取该文件的路径与文本内容。

### CRIT-02: 自动化独立测试全部通过
- **关联需求:** REQ-CLI-02
- **责任方:** Reviewer
- **判定条件:** TEST-01 与 TEST-02 自动化测试报告显示 exitCode === 0。
- **所需证据:** 测试输出日志。

## 人工审核项 (Human Review)

### MANUAL-01: 桌面客户端零新增会话核验
- **说明:** 执行前后打开 WorkBuddy / Codex 桌面客户端，确认会话列表中未新增本次任务对话，且历史会话未被修改。
- **责任方:** 人类工程师
