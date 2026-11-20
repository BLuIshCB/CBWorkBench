# 独立测试节点操作说明

本节点执行工作流预设的自动化测试命令：
node -e "const fs=require('fs'), assert=require('assert'); const d=JSON.parse(fs.readFileSync('outputs/smoke-test/test-result.json','utf8')); assert.equal(d.status,'OK'); assert.equal(d.message,'工作流冒烟测试通过 😀'); console.log('PASS TEST-01');"

核验测试进程的退出码是否为 0。若非 0 则驳回至 development 节点修复。
