# 测试用例清单

## TEST-01: 产物存在性与 JSON 格式校验
- 命令: node -e "const fs=require('fs'), assert=require('assert'); const d=JSON.parse(fs.readFileSync('outputs/smoke-test/test-result.json','utf8')); assert.equal(d.status,'OK'); assert.equal(d.message,'工作流冒烟测试通过 😀'); console.log('PASS TEST-01');"
- 期望: 退出码 0，输出 PASS TEST-01
