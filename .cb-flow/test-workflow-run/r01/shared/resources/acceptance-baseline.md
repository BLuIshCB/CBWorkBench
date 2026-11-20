# 共同验收基线

1. 产物存在性：outputs/smoke-test/test-result.json 必须存在且内容合法。
2. 编码与格式：标准 UTF-8 JSON，包含键 status 值为 "OK"，message 值为 "工作流冒烟测试通过 😀"。
3. 自动化测试：独立测试退出码必须为 0。
4. 人工确认：在 Web 界面确认所有节点记录完整。
