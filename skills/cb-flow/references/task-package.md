# 任务包与节点模板

生成前通过 `workbench_get_package_protocol` 查询当前契约，通过 `workbench_get_workflow` 核对用户已选工作流。

## 任务包存放与提交

- 在目标实例协议返回的 `instance.data_dir` 下创建 `task-drafts/<任务名>-<唯一后缀>/r0001/`。任务目录使用简短的英文字母、数字和连字符。修订时优先沿用原任务的草稿目录，创建下一个可用的版本目录，保留此前已审阅的内容。
- 无法取得数据目录或无法写入时，说明具体原因和已知路径，并暂停编写。所有任务包草稿通过工作台数据目录保存。
- `target_cwd` 填实际开发项目的绝对路径。任务专用文档和附件放入包内，按包内相对路径引用。
- 向用户展示材料并获得上传授权后，调用 `workbench_submit_task`，传入该版本目录的绝对 `package_root`。修订已提交任务时同时传入 `task_id`。工作台归档后，用户在工作台手动确认启动。

## 材料目录

```text
r0001/
  manifest.json                  # 必需
  requirements.md                # 必需且非空
  development.md                 # 选填
  nodes/
    <node_id>/
      prompt.md                  # 每个任务节点必需且非空
      <node_id>.md               # 选填
      resources/                 # 选填
```

- `manifest.json` 必须包含 `title`、`workflow_id` 和绝对路径 `target_cwd`。可提供 `task_key`、`budget_max_rounds` 和 `execution_timeout_ms`。
- `requirements.md` 必须非空，涵盖需求范围、约束和验收标准。
- `nodes/` 的子目录与工作流中的任务节点一一对应。各节点的 `prompt.md` 必须非空，明确节点职责、执行步骤、产物和完成条件。人工节点使用同名文件作为核验指引。
- `development.md`、节点同名说明和 `resources/` 内的节点附件按需提供。JSON 和 Markdown 使用无 BOM 的 UTF-8。路径必须位于包内，使用普通文件。
- 工作台「冻结材料」下的「需求文档」展示需求和全局补充材料。「节点文档」按工作流列出各任务节点，默认打开该节点的 `prompt.md`，并显示选填附件及返工记录。

## 任务包模板

### `manifest.json`

替换标题、工作流 ID 和绝对目标路径。按实际需要填入可选字段。

```json
{
  "title": "替换为任务标题",
  "workflow_id": "替换为用户选定的工作流 ID",
  "target_cwd": "D:/PROJECT/repository"
}
```

### `requirements.md`

```markdown
# [任务标题]

## 目标与交付范围
[说明要解决的问题、期望行为和本次交付边界]

## 业务规则与约束
[列出影响实现和测试的规则、例外及兼容要求]

## 验收标准
- [ ] [给定场景、操作和可观测结果]
```

### 自动节点的 `prompt.md`

按工作流中的实际职责填写。开发节点写明变更范围和验证要求，测试节点写明需要覆盖的场景，验收节点写明证据与判定口径。运行时提供完成命令和本次输出目录，静态模板只引用这些上下文。

```markdown
# [节点名称]

## 职责与输入
[写明本节点目标、操作权限和需要读取的需求或上游证据]

## 执行步骤
1. [按本节点职责写明实际操作]
2. [核对对应验收标准并生成要求的证据]

## 完成条件
[写明成功、业务失败和执行受阻的判定标准]
按工作台提供的完成协议提交结果，收到 MCP 回执后结束 CLI。
```

在配置了退回路径的节点模板中补充需要移交的故障位置、修改要求和复验条件。验证和验收节点使用下文的证据契约。

### 人工节点的 `prompt.md`

```markdown
# [人工节点名称]

## 核验材料
[列出需要查看的代码变更、测试证据或验收记录]

## 核验标准
- [ ] [可逐项确认的标准]

## 决策
标准均满足时在工作台确认通过。需要退回时填写问题位置、修改要求和复验条件。
```

开发方案、详细工作清单或参考资料较多时，分别用选填的 `development.md`、节点同名 Markdown 或 `resources/` 承载。只提供本次任务需要的材料。

## 节点完成

每个自动节点的运行提示词附带本次 `complete-node` 命令。完成工作并写好证据后，节点执行该命令调用 MCP 的 `workbench_advance_workflow`。用 `--outcome passed|failed` 和 `--summary` 提交结果。业务失败走工作流的失败连线，无法继续执行时提交 `failed` 并加 `--failure-kind execution`，由工作台暂停。MCP 受理后结束 CLI，工作台在进程正常退出后切换节点。最终回复可自由书写。

### 验证节点证据 `outputs/test_report.json`

验证节点根据项目实际测试入口选择并执行命令，记录真实退出码和输出，至少提交一条记录。任一命令非零退出时按业务失败提交。

```json
{
  "tests": [
    {
      "command": "实际执行的测试命令",
      "cwd": "实际工作目录",
      "exit_code": 0,
      "stdout": "实际标准输出",
      "stderr": "实际错误输出"
    }
  ]
}
```

### 验收节点证据 `outputs/acceptance-report.json`

验收节点执行只读核验，依据运行提示词填入实际修订号和证据。通过时有验收项且全部通过，`issues` 为空。需要修改时使用 `needs_changes` 并提交业务失败。执行受阻时使用 `blocked` 对应的技术失败报告。

```json
{
  "decision": "passed",
  "revision": 1,
  "summary": "实际验收结论",
  "criteriaResults": [
    { "id": "AC-01", "passed": true, "evidence": "实际检查记录或文件位置" }
  ],
  "issues": [],
  "manualChecksPending": []
}
```

## 退回交接

退回已执行节点时，发起方在本次执行的 `outputs/rework/` 直接写入一份或多份非空 Markdown。每份文档可使用以下模板：

```markdown
# [待修复问题]

- 位置及证据：[文件与行号、测试失败记录或复现步骤]
- 修改要求：[具体缺陷、预期行为和变更边界]
- 复验条件：[修复后要执行的检查以及通过标准]
```

调用工作台已提供的完成命令时，提交 `--outcome failed`，为每份文件按交接顺序附加一个参数。例如：

```text
--outcome failed --summary "发现两项需修改" --rework-path "outputs/rework/validation.md" --rework-path "outputs/rework/regression.md"
```

参数会作为 MCP 的 `rework_paths` 传入，路径相对于本次执行目录。完整声明目录内的所有文件。文件遗漏、重复、缺失或内容为空时，按 MCP 返回的信息补齐并重提。

新修订的返工记录初始为空。CLI 正常退出后，工作台按任务修订和接收节点追加归档 `rework-prompt-01.md`、`rework-prompt-02.md` 等，并在节点文档中展示。接收节点按本次批次的提交顺序读取全部文档，正常进入时从 `prompt.md` 开始。重复回执和同一批次的执行重试沿用已分配的编号。人工退回由人工意见生成一份归档文档。
