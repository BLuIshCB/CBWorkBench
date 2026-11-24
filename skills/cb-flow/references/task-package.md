# 极简任务包与无上下文提示词规范

用户明确选择工作流后，生成任务包时读取本文件。先列出工作流并询问用户采用哪个，取得选择后读取完整节点定义；不得直接套用默认模板。所有字段与目录布局对应工作台 MCP 服务端契约（通过 `workbench_get_package_protocol` 与 `workbench_get_workflow` 实时查询）。

## 1. 标准极简目录组织

主 Agent 在业务工作区临时目录 `.cb-flow/<task-key>/rNN/` 下按以下极简结构生成任务包：

```text
r01/
  manifest.json              # 任务元数据清单
  requirements.md            # 必须且非空：需求文档（全局需求说明、验收基线与边界约束）
  development.md             # 必须且非空：开发文档（开发指南、架构决策与工程规范）
  nodes/
    <node_id>/               # 严格且仅覆盖工作流中的所有 task 节点（文件夹名与 node.id 完全一致）
      <node_id>.md           # 必须且非空：当前节点的具体工作内容与执行清单（按节点命名）
      prompt.md              # 可选：给该节点的独立提示词（缺失或为空时自动沿用工作流预设提示词）
```

约束与安全要求：
- **强制全局双文档（需求清单 + 开发清单）**：
  - 任务包必须强制包含 `requirements.md` 与 `development.md` 两份全局基准文件，供 Web 工作台顶部「需求文档」与「开发文档」固定页签加载。
  - **严禁使用别名**：不可命名为 `development-items.md`、`dev-plan.md`、`task-items.md` 等。文件路径必须精确为 `requirements.md`（或 `shared/resources/requirements.md`）和 `development.md`（或 `shared/resources/development.md`）。
- **极简顶层结构**：根目录下必须且仅包含 `manifest.json`、`requirements.md`、`development.md`（或规范的 `shared/resources/` 映射）以及 `nodes/` 目录。
- **1:1 节点覆盖**：`nodes/` 目录下的子目录必须且仅覆盖所选工作流中的所有 `task` 节点（不含 `start` 和 `end` 控制节点），大小写严格一致。
- **节点文档命名**：各节点下的核心工作文档必须以节点 ID 命名（即 `<node_id>.md`，例如 `nodes/development/development.md`、`nodes/check_cmd/check_cmd.md`）。
- **文本编码**：所有 Markdown 与 JSON 文件必须为 UTF-8 编码且**严禁带有 BOM 头**，内容不可为空白字符。
- **路径安全**：禁止使用符号链接（symlink）、Windows Junction 挂接点或 `..` 相对越权路径；服务端将严格执行路径越权与边界检查。

---

## 2. 标准上传文档模板 (Templates)

### 2.1 `manifest.json` 清单模板

```json
{
  "title": "示例任务标题",
  "workflow_id": "default",
  "target_cwd": "D:/CODE/PROJECT",
  "task_key": "example-task",
  "budget_max_rounds": 10,
  "execution_timeout_ms": 300000
}
```

字段说明：
- `title`（必需）：任务显示标题。
- `workflow_id`（必需）：所选工作流定义 ID。
- `target_cwd`（必需）：代码工作区绝对路径。
- `task_key`（可选）：业务唯一任务标识（缺省自动使用系统生成的 taskId）。
- `budget_max_rounds`（可选）：最大执行轮次上限（默认 10）。
- `execution_timeout_ms`（可选）：单节点执行超时毫秒数。

### 2.2 `requirements.md` 需求文档模板（必须且非空）

```markdown
# 需求文档：[任务标题]

## 1. 业务目标与背景
- 简述本次任务需解决的核心业务问题与预期效果。

## 2. 核心功能范围 (In Scope)
- [REQ-01] 详细功能点描述与边界。
- [REQ-02] 关键逻辑与字段处理规则。

## 3. 排除范围 (Out of Scope)
- 明确非本次交付的内容，杜绝范围蔓延。

## 4. 验收标准与测试基线 (Acceptance Criteria)
- [ ] 验收点 1：...
- [ ] 验收点 2：...
```

### 2.3 `development.md` 开发文档模板（必须且非空）

```markdown
# 开发文档：[任务技术方案与规范指南]

## 1. 架构方案与模块设计
- 涉及的核心模块、数据流转、接口/契约定义。

## 2. 工程纪律与编码标准
- 遵循单分支开发策略（main），所有修改就地生效。
- 开发阶段不考虑向后兼容，废弃代码、字段与兼容层直接删除。
- 遵循 TDD（红-绿-重构）流程，以可自动化运行的测试作为完成依据。

## 3. 预期变更文件范围
- 拟新增或修改的文件清单（缩小改动半径）。

## 4. 自动化验证命令
- 执行测试验证的确定性命令（如 npm test）。
```

### 2.4 `nodes/<node_id>/<node_id>.md` 节点文档模板（必须且非空，按节点命名）

每个任务节点根目录下必须提供与节点 ID 同名的 markdown 文件（例如 `nodes/development/development.md`、`nodes/acceptance/acceptance.md`）：

```markdown
# 节点工作文档：[节点名称] ([node_id])

## 1. 节点目标与职责
- 说明本节点在工作流中的分工（如代码编写、自动化测试、人工验收等）。

## 2. 具体工作项与执行清单
- [ ] 工作项 1：...
- [ ] 工作项 2：...

## 3. 交付物与完成条件
- 本节点必须生成的代码、文档或测试证据。
- 自审检查清单（自测退出码为 0，无未清理调试代码）。
```

### 2.5 `nodes/<node_id>/prompt.md` 节点独立提示词模板（可选）

为该节点 CLI/Agent 提供的自定义执行提示词。若未提供或为空，平台执行引擎自动沿用工作流模板中该节点的预设提示词。

```markdown
你是专门负责 [节点名称] 的执行 Agent。
请严格对照 nodes/[node_id]/[node_id].md 清单开展工作，参考 shared/ 下的需求与开发文档。
执行前请先编写失败测试，再实现功能，最后进行代码自审。
```

---

## 3. 测试验证节点契约 (`result_rule = "verification"`)

- 执行该节点的 Agent 根据项目真实测试入口和任务要求自行选择并执行测试命令，不修改业务代码。
- 必须将实际执行证据输出至 `outputs/test_report.json`，格式如下（`tests` 至少包含一条记录）：
```json
{
  "tests": [
    { "command": "实际运行的测试命令", "cwd": "工作目录", "exit_code": 0, "stdout": "实际标准输出", "stderr": "实际错误输出" }
  ]
}
```
- 工作台根据退出码判定测试结果；非 0 退出码自动路由至返工路径，缺失或无效证据将阻塞任务。

---

## 4. MCP 单阶段提交流程

彻底废除 `stage` 草稿暂存与 `finalize` 二次提交两阶段逻辑，收敛为单阶段原子提交：

1. **查询工作流与契约**：调用 `workbench_list_workflows` 展示候选并询问用户选择，选定后调用 `workbench_get_workflow` 获取完整节点定义。
2. **本地组装任务包**：写入 `.cb-flow/<task-key>/rNN/`，准备 `manifest.json`、`requirements.md`、`development.md` 及各节点的 `nodes/<node_id>/<node_id>.md`。
3. **门禁 1（对话授权）**：向用户展示本地任务包路径、节点材料与工单摘要，获得明确同意后再调用上传工具。
4. **单阶段原子提交**：
   - 调用工作台 MCP 工具 `workbench_submit_task`：
     ```json
     {
       "package_root": "D:/CODE/PROJECT/.cb-flow/example-task/r01",
       "task_id": "可选。若传入则作为现有任务的新修订版本提交"
     }
     ```
   - 服务端直接在本地验证目录结构完整性与 UTF-8 编码，原子复制归档到工作台内部 `tasks/<taskId>/revisions/rNNNN/` 并冻结为只读。
   - 任务状态直接置为 `pending_confirm`，返回任务 ID 与 Web 详情链接。
5. **门禁 2（Web 手动确认启动）**：提示用户在 Web 端手动点击启动按钮，严禁由 Agent 自动调用启动接口。
6. **修订提交**：若任务处于非运行状态（如 `blocked`、`completed` 或 `cancelled`），再次调用 `workbench_submit_task` 并传入相同 `task_id`，系统自动递增修订版本号 `revision`。
