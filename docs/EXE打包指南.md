# CBWorkBench 独立可执行程序打包指南 (EXE)

CBWorkBench 支持通过 Node.js 原生 SEA (Single Executable Applications) 架构打包为 **Windows 独立单文件可执行程序 (`cb-workbench.exe`)**。

---

## 🌟 核心特性

1. **单文件零依赖分发**：
   - 生成的 `cb-workbench.exe` 内置了完整的 Node 24 引擎、原生 SQLite (`node:sqlite`)、MCP 服务协议与所有运行依赖。
   - 目标机器**无需安装 Node.js、无需运行 `npm install`**，将 EXE 放到可写目录后双击即可启动。使用 WorkBuddy、Codex 或 Antigravity 执行任务时，仍需配置并登录所选 CLI。
2. **静态前端资源双模式**：
   - **源码运行模式**：优先读取本地 `src/ui/` 或 `ui/` 文件，支持热修改。
   - **EXE 运行模式**：只读取同次打包内嵌的静态资源（HTML/CSS/JS），即使旁边存在源码也不覆盖，避免前后端版本混用。修改源码后需要重新打包并重启 EXE 才会生效。
3. **友好启动与防重复弹窗**：
   - 双击直接启动并在控制台打印访问地址与状态。
   - 首次启动自动在系统默认浏览器中打开工作台页面。
   - **防重复弹窗冷却锁**：通过 8 秒冷启动宽限期与 3 秒前端心跳追踪；若页面已处于打开状态，重复双击 exe 自动复用后台并跳过重复弹窗，同时自动尝试激活（AppActivate）已有浏览器窗口。
4. **控制台交互化指令**：
   - 常驻运行时支持通过命令行输入指令：
     - `web`: 确定性打开一个新工作台网页（无视冷却锁与已打开状态）。
     - `tasks`: 查看当前数据库中的任务列表与执行状态。
     - `clear`: 清空控制台屏幕。
     - `help`: 显示可用指令帮助。
     - `exit`: 优雅停止 HTTP 服务并安全退出进程。

---

## 🔨 一键打包命令

在项目根目录下执行：

```bash
npm run build:exe
```

构建流水线会自动执行以下阶段：
1. 探测并定位本地 Node 24 运行时；
2. 扫描 `src/ui/` 并生成内嵌静态资源字典；
3. 使用 `esbuild` 将后端 TypeScript 与所有三方依赖打平为 CJS 单文件；
4. 调用 `--experimental-sea-config` 生成二进制 Blob；
5. 使用 `postject` 注入 Blob 生成 `cb-workbench.exe`。

产物输出于：
* 项目根目录：[`cb-workbench.exe`](file:///d:/CODE/AI/CBWorkBench/cb-workbench.exe)
* 输出目录：[`dist/cb-workbench.exe`](file:///d:/CODE/AI/CBWorkBench/dist/cb-workbench.exe)

---

## Windows 内测交付

`D:\CODE\AI\Use version` 是给用户内测体验的便携版交付目录。将当次构建的 `dist/cb-workbench.exe` 复制进去，发送时把整个 `Use version` 文件夹交给用户。纯净交付包只需包含 `cb-workbench.exe`。

如果交付副本运行过，发送前先退出工作台和使用同一数据目录的 MCP 进程，再把 `Use version` 下的 `data` 整体移到发送目录之外备份。这样任务、工作流配置、日志和归档资料都留在本地。验证新版时可以另建临时目录运行一份 EXE，让待发送的文件夹保持干净。

用户将文件夹放到有写权限的位置，再双击 `cb-workbench.exe`。默认情况下，首次启动会在 EXE 同级创建 `data`、生成本机实例标识、初始化 `data/workbench.db` 的 SQLite 表，并写入系统自带的「默认开发交付流程」。任务列表初始为空，后续任务和配置由用户在自己的副本中创建。设置了 `CB_DATA_DIR` 或传入 `--data-dir` 时，程序会使用指定目录。

已经参加内测的用户如需保留任务和配置，退出工作台及同目录的 MCP 进程后，只替换原文件夹里的 EXE，保留自己的完整 `data`。

---

## 数据与迁移

EXE 默认使用与自身同级的 `data`，首次启动会自动创建。默认端口为 3721，已经被其他程序占用时，工作台自动选择空闲端口并打开实际地址。

| 位置 | 内容 |
| --- | --- |
| `data/workbench.db` | 本机 SQLite 数据库，保存任务、流程状态、执行记录及任务材料索引 |
| `data/tasks/` | 导入的任务包、节点材料和运行产物 |
| `data/documents/` | 可自行创建，用于存放普通文件、Markdown 和历史资料 |

- 新用户只需一份 `cb-workbench.exe`。迁移已有数据时，退出工作台和连接同一目录的 MCP 进程，然后复制 EXE 和完整的 `data`。资料如果仅保存在本机，仍需随 `data` 一起备份。
- 旧版 EXE 在 Windows 上默认使用 `%LOCALAPPDATA%/CBWorkBench/data`。可在旧版启动日志中核对实际路径。停机后将旧目录整体复制到新版 EXE 旁。目标已有数据时应先备份两边，避免合并或覆盖两套数据库。SQLite 使用 WAL 模式，迁移时保留目录中的数据库相关文件。旧的 `server.json` 记录运行状态，可以跳过。
- 已有任务记录的目标项目和第三方 CLI 可能使用本机绝对路径。更换电脑后，启动任务前需核对项目位置和 CLI 配置。已归档的任务材料仍从迁移后的 `data/tasks` 中读取。

---

## 🚀 运行参数

```bash
# 默认启动 (端口 3721，自动打开浏览器)
.\cb-workbench.exe

# 自定义端口与主机
.\cb-workbench.exe --port 3800 --host 0.0.0.0

# 纯后台服务 (不自动唤起浏览器)
.\cb-workbench.exe --no-open

# 查看完整命令行帮助
.\cb-workbench.exe --help
```

显式的 `--data-dir` 优先于 `CB_DATA_DIR`。保留的 `--portable` 可显式选择 EXE 同级 `data`，不可与数据目录覆盖项同用。配置外部 MCP 客户端时，将命令设为 EXE 的绝对路径，参数设为 `["--mcp"]`。如果启动工作台时指定了数据目录，MCP 也应使用同一目录。
