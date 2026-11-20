# 独立测试节点 (test)

## 节点目标
执行独立测试验证冒烟产物。实际执行命令在工作流节点配置中指定。

## 验证项
- outputs/smoke-test/test-result.json 存在且格式正确。
- 断言退出码为 0。
