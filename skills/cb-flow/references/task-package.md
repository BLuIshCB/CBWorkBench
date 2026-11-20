# 任务包与无上下文提示词规范（`cb.task-package/2.0`）

用户明确选择工作流后，生成任务包时读取本文件。先列出工作流并询问用户采用哪个，取得选择后读取完整定义与提示词，再按节点设计方案和 Markdown；不得直接套用默认模板。所有字段与目录布局对应工作台 MCP 服务端契约（通过 `workbench_get_package_protocol` 与 `workbench_get_workflow` 实时查询）。

## 1. 标准目录组织

主 Agent 在业务工作区临时冻结目录 `.cb-flow/<task-key>/rNN/` 下按以下统一结构生成任务包（所有任务节点使用相同目录形态，不按节点名称特殊分化）：

```text
r01/
  manifest.json
  shared/
    resources/
      requirements.md            # 可选：共同需求与边界基线
      acceptance-baseline.md     # 可选：冻结的共同判定标准
  nodes/
    <safe_node_dir>/             # 来自 workbench_get_workflow 返回的 dir_name
      node.md                    # 节点职责、输入、工作步骤、完成条件、输出与阻塞处理
      prompt.md                  # 节点独立提示词或人工核验指引
      resources/                 # 可选：本节点专属清单、用例、JSON Schema 等普通资源
        <resource_files>
```

约束：
- **禁止旧全局正文文件**：不再使用根目录 `task.md`、`development.md`、`tests.md`、`acceptance.md` 或 `prompts/verifier.md` / `prompts/worker-*.md`。
- **文本编码**：所有文本（Markdown / JSON）必须为 UTF-8 无 BOM；`size_bytes` 和 `sha256` 必须严格按原始字节计算。
- **路径安全**：统一使用 `/`，禁止绝对路径、盘符、`..`、UNC、符号链接或大小写重名。
- **所有权隔离**：`shared/resources/*` 归属 `{"scope": "shared"}`，各 `nodes/<dir>/*` 归属 `{"scope": "node", "node_id": "<id>"}`；任何节点不得引用他节点私有文件。

## 2. `manifest.json` 规范

先调用 `workbench_get_workflow` 获取 `definition_sha256`、任务节点 ID、安全目录名 `dir_name` 及 `material_contract`：

```json
{
  "protocol_version": "cb.task-package/2.0",
  "task_key": "example-task",
  "revision": 1,
  "title": "示例任务",
  "target_cwd": "D:/CODE/PROJECT",
  "workflow": {
    "id": "default",
    "definition_sha256": "<from workbench_get_workflow>"
  },
  "readiness": "ready",
  "blockers": [],
  "nodes": [
    {
      "node_id": "development",
      "node_ref": "nodes/development/node.md",
      "prompt_ref": "nodes/development/prompt.md",
      "resources": [
        {
          "id": "dev-items",
          "path": "nodes/development/resources/development-items.md",
          "description": "按 Tracer-bullet 拆解的独立工单清单"
        }
      ],
      "shared_refs": ["shared/resources/requirements.md"],
      "input_bindings": [],
      "output_contract": {
        "required_outputs": ["result"],
        "optional_outputs": []
      }
    }
  ],
  "files": [
    {
      "path": "shared/resources/requirements.md",
      "owner": { "scope": "shared" },
      "media_type": "text/markdown",
      "size_bytes": 123,
      "sha256": "<64-hex>"
    }
  ]
}
```

关键规则：
- `nodes` 必须 1:1 覆盖工作流的所有 `task` 节点（不含 `start` 与 `end`）。
- `files` 必须完整登记 `nodes` 引用的全部文件，**不得登记 `manifest.json` 本身**。
- `manifest.json` 写完后另行计算其原始字节 SHA-256（`manifest_sha256`），用于 `workbench_stage_package` 与 `workbench_finalize_package`。
- `readiness` 仅为 `"ready"` 或 `"blocked"`；`"ready"` 仅代表材料完整，工作台手动启动与人工审核始终由人类用户操作决定。

## 3. 节点内容规范

### `nodes/<dir>/node.md`
以所选工作流中该节点的提示词、职责与实际流转为基础编写，不按节点名称猜测职责。所有任务节点包含：

1. 节点目标与负责需求 ID
2. 输入材料及用途
3. 工作范围与必须保持的行为
4. 具体工作项与执行步骤
5. 完成条件与证据要求
6. 交付物与输出格式
7. 阻塞条件及处理方式

### `nodes/<dir>/prompt.md`
保留编排提示词的要求，补充本次节点的输入、步骤、完成条件与输出。执行器会同时接收编排提示词和任务包提示词，任务包不能降低或覆盖编排要求；出现冲突先澄清。

- **Agent 节点**：开发节点注入 `implement`（全新窗口隔离 + TDD 红绿重构）与 `/code-review` 自审要求；只读验收节点使用只读审查约束，其他节点按职责设计。使用运行视图相对路径（`context.json`、`material/node.md`、`material/resources/*`、`shared/resources/*`、`inputs/*`、`outputs/`），严禁依赖主 Agent 聊天上下文。
- **测试验证 Agent 节点**（`result_rule = "verification"`）：根据项目的真实测试入口和任务验收要求自行选择、执行命令，不修改业务代码。命令可以作为任务材料中的建议，不是用户必须填写的工作流配置。声明 `test_report` 输出，并为下游验收绑定当前代码代次的测试证据。
- **Manual 节点**：写明人应查看什么、通过/退回条件与退回原因指引。

测试节点将实际执行证据写入 `outputs/test_report.json`，`tests` 至少一项：

```json
{
  "tests": [
    { "command": "实际运行的命令", "cwd": "实际工作目录", "exit_code": 0, "stdout": "实际标准输出", "stderr": "实际错误输出" }
  ]
}
```

工作台根据节点提交的退出码判定测试结果并保存证据；非零退出码走失败路径，缺失或格式无效的证据阻塞任务。不得把 Agent 正常退出等同于测试通过。

## 4. MCP 上传与修订流程（仅 `local_path`）

1. **选择工作流与查询契约**：调用 `workbench_list_workflows` 展示候选并询问用户，等待选择后调用 `workbench_get_workflow` 与 `workbench_get_package_protocol`；本次已明确选择则直接核对。
2. **本地冻结与自检**：写入 `.cb-flow/<task-key>/rNN/` 并计算所有文件与 Manifest 的真实字节大小及 SHA-256。
3. **门禁 1（对话授权）**：向用户展示路径、摘要、节点分工与阻塞项，获得明确同意后再上传。
4. **暂存与校验**：调用 `workbench_stage_package`（`source.mode: "local_path"`），再按需用 `workbench_finalize_package(validate_only=true)` 校验。
5. **正式提交**：调用 `workbench_finalize_package(validate_only=false)` 冻结至工作台 `revisions/rNNNN/`，进入 `pending_confirm` 状态并给出 Web 详情链接，等待用户在 Web 端手动点击启动。
6. **修订提交**：如任务运行中须先停止并确认进程退出；修订时 `operation: "revise"`，传入 `task_id`、`expected_revision` 与新 `revision = expected_revision + 1`。
