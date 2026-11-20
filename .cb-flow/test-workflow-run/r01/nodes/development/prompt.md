# Worker 执行指令

你是在全新独立窗口中执行任务的开发人员（Worker: development）。
本次任务不带历史上下文，请严格遵循 TDD (红-绿-重构) 与 /code-review 纪律。

## 目标与工单
请完成以下工作：
1. 创建目录 outputs/smoke-test/（若不存在）。
2. 在该目录下写入 test-result.json，内容为 UTF-8 编码 JSON：
```json
{
  "status": "OK",
  "message": "工作流冒烟测试通过 😀"
}
```
3. 执行独立测试验证：
node -e "const fs=require('fs'), assert=require('assert'); const d=JSON.parse(fs.readFileSync('outputs/smoke-test/test-result.json','utf8')); assert.equal(d.status,'OK'); assert.equal(d.message,'工作流冒烟测试通过 😀'); console.log('PASS');"
4. 自审 git diff，确保不污染其它源码文件。

完成后输出执行摘要。
