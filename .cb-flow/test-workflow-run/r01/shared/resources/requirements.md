# 共同需求说明：工作流链路连通性自测 (test)

## 需求背景
验证 CBWorkBench 默认开发交付工作流全链路连通性：
- 节点流转：开始 -> 开发实现 -> 独立测试 -> 整体验收 -> 人工确认 -> 结束

## 交付与验证范围
### In Scope
1. Worker 在 outputs/smoke-test/test-result.json 创建标准 UTF-8 JSON 产物；
2. 产物包含 status: "OK" 与 message: "工作流冒烟测试通过 😀"；
3. 自动化测试验证退出码为 0；
4. Codex 在只读沙箱下完成审查并输出 passed；
5. 人工在工作台界面核实后点击通过完成。

### Out of Scope
- 不修改仓库中现有的任何核心业务代码（src/、tests/、docs/）；
- 不引入外部网络请求或第三方依赖。
