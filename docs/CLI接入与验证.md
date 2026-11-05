# 原生 CLI 对话接入

工作台通过独立子进程调用 WorkBuddy、Codex 和 Antigravity，不经过 MCP/Desktop Bridge，不需要启动对应桌面客户端。三家共用 `IAgentAdapter.execute({ prompt, cwd, model, timeoutMs, taskId })`，不区分开发者或验收者能力。

## 本机使用

```powershell
# 列出 CLI 启动入口；这一步不证明登录和模型对话成功
node bin/agent.js list

# 真实对话校验，每次生成新的中文随机标记，必须精确返回才算通过
node bin/agent.js verify workbuddy
node bin/agent.js verify codex
node bin/agent.js verify antigravity

# 首次登录或登录失效时，使用相同入口与配置登录
node bin/agent.js login workbuddy
node bin/agent.js login codex
node bin/agent.js login antigravity
```

任意提示词使用 `node bin/agent.js chat <id> [cwd] [model]`，完整提示词通过 UTF-8 stdin 输入。Node 程序示例：

```javascript
import { spawn } from 'node:child_process';
const child = spawn('node', ['bin/agent.js', 'chat', 'codex', process.cwd()], {
  shell: false, stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end('请分析当前代码，先给结论。\n中文、多行和特殊字符均原样传入。', 'utf8');
```

也可在工作台“CLI 适配器中心”发送提示词，三个入口都调用同一个接口。`default` 表示不指定模型，沿用 CLI 自身默认值；其他模型名原样交给厂商 CLI 校验，不做静默回退。

Codex 的可选模型通过同一独立 CLI 的 `debug models` 命令刷新，过滤隐藏模型，目录缓存五分钟。任务开发、验收与即时对话三个模型控件均使用原生下拉框，完整列出模型，选择“手动输入模型”后显示独立输入框，保存的自定义模型不会被列表覆盖。目录获取失败会明确提示，不能把默认模型误报成完整模型列表。目录列出不等同于每个模型均已通过当前账户的真实调用验证。

## 安装与配置

Windows 运行：

```powershell
.\bin\install-clis.ps1 -WorkBuddyProductPath 'D:\CODE\TOOL\WorkBuddy\resources\app.asar.unpacked\cli\product.json'
```

安装脚本将官方独立 CLI 放到 `data/runtimes/`，不会修改全局 PATH。Codex 使用已验证的 `0.166.0`，CodeBuddy CLI 使用 `2.179.0`；Antigravity 从官方发行清单下载并校验 SHA512。已有 `data/agent-cli.json` 会保留，不覆盖用户配置。

WorkBuddy 使用完整 CodeBuddy 引擎加载 WorkBuddy 官方产品配置。复制后的配置使用独立认证标识 `cbworkbench-workbuddy-cli`，其用途是隔离凭据文件名，避免覆盖桌面版的加密凭据。首次使用必须完成一次 CLI 自身的浏览器登录。后续后台任务只启动 CLI，登录浏览器和桌面客户端均不需要常驻。

配置优先读取 `CB_AGENT_CLI_CONFIG` 指定的文件，否则读取 `data/agent-cli.json`，最后尝试已有安装位置。示例：

```json
{
  "workbuddy": {
    "executable": "C:/runtime/node.exe",
    "script": "D:/CBWorkBench/data/runtimes/native/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy",
    "env": {
      "ACC_PRODUCT_CONFIG_PATH": "D:/CBWorkBench/data/runtimes/workbuddy-product.json",
      "CODEBUDDY_CONFIG_DIR": "D:/CBWorkBench/data/workbuddy-cli"
    }
  },
  "codex": {
    "executable": "C:/runtime/node.exe",
    "script": "D:/CBWorkBench/data/runtimes/native/node_modules/@openai/codex/bin/codex.js"
  },
  "antigravity": {
    "executable": "D:/CBWorkBench/data/runtimes/antigravity/agy.exe"
  }
}
```

Windows 下使用原生 `.exe` 或 Node + 脚本路径，避免通过 `.cmd` 和 shell 拼接提示词。可用 `args` 配置固定的前置参数，`env` 仅对子进程生效。配置、二进制、登录状态和测试产物均不纳入 Git。

## 调用架构与权限

```text
CLI / HTTP / WorkflowEngine
           ↓
AdapterRegistry → IAgentAdapter.execute()
           ↓
WorkBuddyAdapter / CodexAdapter / AntigravityAdapter
           ↓
NativeCliAdapter → CliRunner → 原生 CLI 进程
```

Adapter 只处理厂商参数和输出协议。`CliRunner` 负责 UTF-8 管道、退出码、超时、取消、输出上限和进程回收。工作流需要验收时，由 `AcceptanceService` 构造验收提示词、解析和校验返回的业务 JSON，厂商 Adapter 不知道“验收者”角色。

按当前要求不设置沙箱，使用 CLI 的跳过交互审批参数：

| CLI | 主要参数 | 输出协议 |
| --- | --- | --- |
| WorkBuddy | `-p --dangerously-skip-permissions --no-session-persistence` | JSON 结果对象或包含终态 result 的事件数组 |
| Codex | `exec --dangerously-bypass-approvals-and-sandbox --ephemeral --json` | JSONL，必须有 `turn.completed`，提取 `agent_message` |
| Antigravity | `--dangerously-skip-permissions --input-format stream-json --output-format stream-json` | stdin 为 user 事件，输出必须有 SUCCESS result |

提示词中的只读、目录范围等要求是行为约定，不是权限隔离。CLI 拥有启动账户可用的权限，厂商自身策略仍由其 CLI 实现。工作台不会伪装为受隔离环境以进一步绕过厂商限制。

WorkBuddy 和 Codex 禁用会话持久化；Antigravity 使用其原生历史机制，没有宣称它不保存会话。三家都不自动续接既有对话、不在失败后换厂商重跑。开发和验收的现有任务状态与人工门禁继续保留，适配器本身不限制用途。

## 验证

```powershell
# 离线回归；启动器默认创建独立临时数据库
node bin/test-runner.js

# 显式真实测试：HTTP → Adapter → CLI → 模型
# 每家检查中文随机标记，以及实际创建 UTF-8 文件后的独立读取断言
node bin/test-runner.js tests/agentsLiveSmoke.ts
```

真实测试报告位于 `data/cli-live-<timestamp>/report.json`。`--help` / `--version` 成功只代表入口可启动，模型响应和文件产物需要单独验证。普通 `ok` 表示 CLI 调用成功，不等同于业务验收通过。

## 官方参考

- [Codex 非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)
- [CodeBuddy CLI 安装](https://www.codebuddy.cn/docs/cli/installation)
- [Antigravity Headless](https://antigravity.google/docs/cli/headless/)
- [Antigravity 安装](https://antigravity.google/docs/getting-started/)

## Codex 单独使用与统一时限（2026-11-05）

源码运行需要 Node 24+、Git 与 npm 依赖。已有 Codex 时保留现有安装和登录态；运行 `bin/check-codex.ps1` 检查入口，再启动工作台，在运行时页面点击“验证真实对话”。其他 CLI 缺失不会阻断 Codex；本文原有三家一起安装脚本属于可选方式。

新任务优先 Codex，default 表示沿用 CLI 配置、不传 -m；旧任务执行器和模型按原记录保留。启动确认仅有一个单次执行分钟输入，开发、验收和每条独立测试分别计时，默认60分钟。旧总预算与分阶段时限已停用；工作台源码不含发行包或内置运行时。

Windows 非交互控制台无法可靠软停止，使用 taskkill /T /F 并确认退出；POSIX 受控进程组先请求终止，5秒后强制停止；回收确认上限为10秒。失败会保留占用与日志，不能继续派发任务。重试清理只针对仍持有活动进程句柄的运行，不使用历史 PID 猜测身份。
