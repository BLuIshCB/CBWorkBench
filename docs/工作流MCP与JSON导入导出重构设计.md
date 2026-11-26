# 工作流 MCP 创建与页面 JSON 导入导出重构设计

依据 CBWorkBench 当前开发中的工作流设计。本文件为待实施方案。

## 一、功能入口

主 MCP 仅新增 `workbench_create_workflow`。导入和导出是工作流管理页上的两个按钮。

| 入口 | 输入 | 成功结果 |
|---|---|---|
| MCP 工具 `workbench_create_workflow` | `name`、`steps` 必填，工作流 `description` 可选 | 返回后端生成的 `workflow_id` |
| 页面按钮「导入 JSON」 | 用户选择一个工作流 JSON 文件 | 创建独立模板，刷新列表并选中新模板 |
| 页面按钮「导出 JSON」 | 页面当前选中的已保存模板 | 浏览器下载该模板的 JSON 文件 |

创建工具沿用现有 MCP 的 JSON 文本回执，成功时包含 `ok`、`success`、`request_id` 和 `workflow_id`。调用方凭 `workflow_id` 查询模板或填写任务包的 `manifest.workflow_id`。该工具注册在完整管理模式下，节点运行使用的 `--mcp-advance` 只暴露结果登记工具。

## 二、页面配置人工门禁

在工作流编辑器的任务节点属性中增加「人工门禁」开关。新节点默认关闭，打开映射到现有字段 `execution_mode: "manual"`，关闭映射到 `execution_mode: "agent"`。读取已保存的节点时按该字段回显。开关仅用于任务节点，已被任务引用的模板依照现有锁定规则只读。[工作流编辑器](../src/ui/js/components/workflowView.js)

系统内置默认模板包含末尾人工复核。自定义工作流可按模板全自动结项，每个已配置的人工节点仍须由用户通过或退回。任务页面显示当前待审节点和审核去向，提交审核时须携带本次待审执行的 `attempt_id`。待审执行已变更时返回 `409 STALE_MANUAL_REVIEW`。

| 门禁状态 | 运行行为 |
|---|---|
| 关闭（`agent`） | 工作台自动执行该节点，按执行结果走成功或失败连线。 |
| 打开（`manual`） | 工作台到达该节点时等待用户在任务页面操作。通过走 `on_success`，退回走 `on_failure`。没有退回目标时任务暂停。 |

人工门禁使用现有的人工节点和审核操作。如果一步需要先自动执行，再由人确认，在自动节点之后连接一个开启人工门禁的任务节点。现有测试和验收结果规则仅适用于自动节点，页面对这类节点禁用门禁开关并提示可添加独立的人工节点。MCP 创建和 JSON 导入遇到人工门禁与自动结果规则配置在同一节点时，返回字段错误。[节点校验](../src/services/workflowDefinition.ts) · [工作流执行引擎](../src/services/workflowEngine.ts)

## 三、MCP 创建参数

普通顺序流程只需填写工作流名称、步骤名称和步骤描述。描述用于生成任务材料，具体提示词放在任务包的 `nodes/<节点目录>/prompt.md`，执行器和模型在任务中配置。

示例流程为“开发 → 独立测试 → 人工复核 → 结束”。测试失败或人工退回时均回到开发。

```json
{
  "name": "开发、测试与人工复核",
  "steps": [
    {
      "name": "开发实现",
      "description": "根据需求完成修改，并按反馈返工。"
    },
    {
      "name": "独立测试",
      "description": "运行相关测试并提交报告。",
      "result_rule": "verification",
      "on_failure": "开发实现"
    },
    {
      "name": "人工复核",
      "description": "核对需求与验证结果，通过后结束，退回时填写原因。",
      "execution_mode": "manual",
      "on_failure": "开发实现"
    }
  ]
}
```

| 单步字段 | 取值与缺省行为 |
|---|---|
| `name`、`description` | 必填非空字符串，去除首尾空白。步骤数组至少有一项。 |
| `execution_mode` | 可选，与页面「人工门禁」开关一致。省略或填 `agent` 为关闭，填 `manual` 为打开。 |
| `result_rule` | 普通步骤省略。自动步骤可填 `verification` 或 `acceptance`，启用现有测试或验收证据检查。 |
| `max_executions` | 默认不限。配置正整数时，限制该节点在同一次任务修订中的执行次数。 |
| `on_success` | 默认进入下一步，末步进入结束。指定步骤名称可跳转，填写 `null` 可直接进入结束。 |
| `on_failure` | 指定失败或人工退回时跳转的步骤名称。省略则暂停任务。 |

后端生成工作流 ID 和图内节点 ID，补齐开始、结束节点及默认连线。连线引用的步骤名称必须唯一匹配，找不到目标或同时匹配多个步骤时返回字段错误。

## 四、页面导入导出的 JSON

一个 UTF-8 JSON 文件保存一个模板。根对象包含 `name`、`nodes`，工作流描述 `description` 按需保留。下例中的两个 `"on_failure": "step_1"` 分别表示测试失败和人工退回后，返回 ID 为 `step_1` 的开发节点。

```json
{
  "name": "开发、测试与人工复核",
  "nodes": [
    {"id":"start","name":"开始","description":"进入首个任务节点。","type":"start","on_success":"step_1"},
    {"id":"step_1","name":"开发实现","description":"根据需求完成修改，并按反馈返工。","type":"task","on_success":"step_2"},
    {
      "id": "step_2",
      "name": "独立测试",
      "description": "运行相关测试并提交报告。",
      "type": "task",
      "result_rule": "verification",
      "on_success": "step_3",
      "on_failure": "step_1"
    },
    {
      "id": "step_3",
      "name": "人工复核",
      "description": "核对需求与验证结果，通过后结束，退回时填写原因。",
      "type": "task",
      "execution_mode": "manual",
      "on_success": "end",
      "on_failure": "step_1"
    },
    {"id":"end","name":"结束","description":"完成工作流。","type":"end"}
  ]
}
```

所有节点保留 `id`、`name`、`description` 和 `type`。开始节点和任务节点还需写明 `on_success`。JSON 中的连线统一使用节点 ID，保留节点顺序及开始、结束节点的名称和描述。

任务节点的四个可选字段仅在有实际配置时导出。门禁开启时写 `execution_mode: "manual"`，启用测试或验收校验时写 `result_rule`，设了次数上限时写 `max_executions`，配了失败去向时写 `on_failure`。导入识别 `manual` 并回显为门禁开启，省略或显式填写 `agent` 都按门禁关闭处理。后端在图校验前补齐内部必需的 `execution_mode: "agent"`。

默认模板和被引用的模板均可导出。导入生成新的工作流 ID，保留图内节点 ID，便于还原连线和材料目录。再次导出的 JSON 内容应与首次导出一致。

单个导入文件上限为 5 MiB。MCP 创建、页面保存和导入均按规范导出的 UTF-8 JSON 字节数校验，避免生成无法回导的文件。安全的下划线开头和较长节点 ID 可原样往返。

## 五、实现落点

1. 节点编辑器直接读取和保存 `execution_mode`，沿用已有节点保存逻辑。MCP 创建展开步骤，页面导入读取完整节点图，写入前均校验字段并复用 `validateWorkflowNodes`。导入还应校验节点 ID 能安全用于页面绑定和任务材料路径，非法 ID 直接定位到节点。
2. 创建和导入共用新增逻辑。后端生成 `wf_<UUID>`，在现有 `workflow_definitions` 表中插入新模板，以数据库主键约束保证唯一。若复用现有兼有更新能力的保存方法，须在同一写事务内查重并写入。[模板存储](../src/storage/db.ts)
3. 「导入 JSON」打开文件选择器，将文件对象提交给 `POST /api/workflows/import`。成功后刷新列表。当前模板有未保存编辑时保留当前草稿，可从列表选择新模板。其余情况直接选中新模板。「导出 JSON」通过 `GET /api/workflows/:id/export` 下载当前选中的已保存模板。

MCP 参数类型、枚举及必填项错误由 SDK 以 `-32602` 返回。应用层的连线、大小及业务规则错误返回 `INVALID_WORKFLOW`，并指出出错字段，例如 `steps[1].on_failure`。页面导入的字段和连线错误均返回 `INVALID_WORKFLOW`。导出找不到模板时返回 `WORKFLOW_NOT_FOUND`。

## 六、验收用例

| 场景 | 预期结果 |
|---|---|
| 最小创建 | 只传名称和一个步骤的名称、描述，返回新 ID，并生成开始、自动节点、结束三节点。 |
| 页面配置人工门禁 | 打开或关闭后保存并重新加载，开关回显正确。使用该模板启动新任务时，门禁开启的节点等待人工，关闭的节点自动执行。 |
| 三个入口的门禁行为 | MCP 创建或 JSON 导入使用 `manual` 时，页面回显开启，页面开启后导出的节点含 `execution_mode: "manual"`。自动执行节点的导出省略此字段。 |
| 自动结果规则与门禁 | 页面提示测试和验收节点使用独立门禁。MCP 或 JSON 将两者填在同一节点时返回校验错误。 |
| 自动失败与人工退回 | 配置失败连线时均跳到目标任务节点，省略时暂停。 |
| 页面导出、导入、再导出 | 新模板 ID 不同，节点 ID、分支和非默认配置完整保留，两次导出的 JSON 内容相等。 |
| 非法字段、重复节点 ID、目标不存在或节点不可达 | 报错定位到字段或节点，数据库无新增模板。 |
| 入口检查 | 主 MCP 仅新增创建工具。使用页面按钮可完成下载和导入，导入后的模板可用于新任务。 |
