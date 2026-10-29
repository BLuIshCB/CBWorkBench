# Worker 执行提示词：Direct CLI 任务交付

你是在全新独立窗口中执行任务的开发人员（Worker ID: worker-dev）。
本次任务不带历史上下文，不依赖上一轮会话记忆。

## 目标与工单
请根据任务说明与工单要求，完成以下自包含任务：
1. 在工作台隔离目录创建 `data/cli-verification/result.txt`（若目录不存在请先创建目录）。
2. 在该文件中精确写入内容：
   `CLI_DIRECT_DISPATCH_OK: 中文任务执行成功 😀`
   并以标准 UTF-8 编码保存。
3. 执行独立测试：
   `node -e "const fs=require('fs'), assert=require('assert'); const c=fs.readFileSync('data/cli-verification/result.txt','utf8'); assert.equal(c.trim(), 'CLI_DIRECT_DISPATCH_OK: 中文任务执行成功 😀'); console.log('PASS TEST-01');"`
4. 对照 `/code-review` 纪律检查 `git diff`：
   - 严禁修改工程代码库其他任何文件；
   - 确认无多余的临时日志或调试代码。

完成后简明输出执行结果及确认信息。
