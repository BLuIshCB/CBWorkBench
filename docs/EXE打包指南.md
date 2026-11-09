# CBWorkBench 独立可执行程序打包指南 (EXE)

CBWorkBench 支持通过 Node.js 原生 SEA (Single Executable Applications) 架构打包为 **Windows 独立单文件可执行程序 (`cb-workbench.exe`)**。

---

## 🌟 核心特性

1. **单文件零依赖分发**：
   - 生成的 `cb-workbench.exe` 内置了完整的 Node 24 引擎、原生 SQLite (`node:sqlite`)、MCP 服务协议与所有运行依赖。
   - 目标机器**无需安装 Node.js、无需运行 `npm install`**，拷贝文件即可运行。
2. **静态前端资源双模式**：
   - **开发模式**：如果本地存在 `src/ui/` 或 `ui/` 目录，优先直接读取本地磁盘文件，支持热修改。
   - **单文件独立模式**：如果移至没有源码的干净环境，自动无缝降级读取 EXE 二进制内编译的内嵌静态资源（HTML/CSS/JS）。
3. **友好启动与交互**：
   - 双击直接启动并在控制台打印访问地址与状态。
   - 自动在系统默认浏览器中弹出工作台页面。

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
