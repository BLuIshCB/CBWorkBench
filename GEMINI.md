# CBWorkBench 项目规范

## 运行与修改规范

1. **修改后无需重启**：
   - 每次修改代码后不需要重新启动项目。
2. **服务独立启动**：
   - 若项目尚未启动，不要在当前对话内启动服务，需提示另开独立对话或终端执行 `npm start` 启动。

## 分支与文档规范

1. **单分支开发与追踪**：
   - 严格遵循单分支策略，所有改动直接基于 `master` 分支推进，追踪 `origin/master`，无需也不允许切分多个分支。
2. **文档集中存放**：
   - 项目所有 Markdown 架构、规范和开发指南统一存放于 `docs/` 目录，详见 [`docs/README.md`](file:///d:/CODE/AI/CBWorkBench/docs/README.md)。
3. **开发边界守则**：
   - 严格遵循 [`docs/BOUNDARIES.md`](file:///d:/CODE/AI/CBWorkBench/docs/BOUNDARIES.md) 中声明的系统边界、三道硬门禁、Worker 工作区限制以及 Codex 只读沙箱原则。
