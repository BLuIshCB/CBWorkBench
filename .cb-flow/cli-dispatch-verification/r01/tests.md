# 自动化测试用例清单

## TEST-01: 交付产物存在性与精确内容逐字节断言
- **关联需求:** REQ-CLI-01
- **执行方式:** 自动化命令
- **执行命令:** `node -e "const fs=require('fs'), assert=require('assert'); const c=fs.readFileSync('data/cli-verification/result.txt','utf8'); assert.equal(c.trim(), 'CLI_DIRECT_DISPATCH_OK: 中文任务执行成功 😀'); console.log('PASS TEST-01');"`
- **预期结果:** 退出码 0，输出 PASS TEST-01。

## TEST-02: CLI Runner 独立子进程通信与编码回归套件
- **关联需求:** REQ-CLI-02
- **执行方式:** 自动化命令
- **执行命令:** `node bin/test-runner.js tests/cliRunner.test.ts`
- **预期结果:** 退出码 0，全套 8 组子进程用例均通过。
