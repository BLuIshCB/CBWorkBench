---
name: to-tickets
description: 基于规格说明书（Spec）将复杂任务拆解为贯穿端到端调用链的 Tracer-Bullet 工单；显式声明阻塞关系（DAG），确保每张票完全自包含，可被独立执行且无需跨票上下文。
---

# to-tickets

依据已冻结的 Spec 规格文档，将系统功能拆分为若干张精细、自包含的 **Tracer-Bullet（曳光弹）** 工单。每张工单贯穿端到端的完整调用链，显式标注前置阻塞边（`blocked_by`）与后置影响（`blocks`），使得每个开发执行者只需持有单张工单即可独立交付，无需依赖历史会话。

## 核心原则

1. **Tracer-Bullet 垂直切片**：严禁按技术架构分层“切蛋糕”（如：先建所有表，再写所有 Service，最后连 UI）。必须按端到端小功能切片——从调用入口、业务处理到最终存储与反馈，每条切片都形成最小可运行闭环。
2. **显式声明阻塞边**：所有工单构成严格的 DAG（有向无环图）。每张票必须显式声明其依赖的 `blocked_by: [TICKET-ID]`，无未声明的隐式时序。
3. **完全自包含上下文 (Self-Contained)**：任何一张票交由一个全新上下文的 Agent 或工程师时，都能直接开工。所有必要的入参契约、涉及文件、测试命令与验收标准均直接写在票内，严禁出现“见上一张票”的描述。

---

## 交付物

| 交付物 | 目标路径 | 说明 |
| :--- | :--- | :--- |
| **工单总索引与拓扑图** | `docs/tickets/<feature-name>/README.md` | 包含工单全景列表、DAG 依赖拓扑、阻塞边关系矩阵 |
| **独立工单文件** | `docs/tickets/<feature-name>/TICKET-xxx-<name>.md` | 各自独立的工单详情文件，包含无上下文执行材料 |

---

## 工单标准模板 (Ticket Template)

每张工单必须严格遵守以下自包含结构：

```markdown
# TICKET-001: [动宾短语描述的目标]

## 1. 元数据与依赖 (Metadata & Edges)
- **ID**: `TICKET-001`
- **关联 Spec 章节**: `docs/specs/<feature-name>.spec.md#3.1`
- **阻塞依赖 (`blocked_by`)**: `[]` (或 `["TICKET-000"]`)
- **后续阻塞 (`blocks`)**: `["TICKET-002"]`
- **预估变更文件范围**:
  - `src/core/parser.ts`
  - `tests/core/parser.test.ts`

## 2. 任务目标 (Objective)
明确一句话：本工单打通的端到端最小闭环是什么？

## 3. 自包含契约与上下文 (Context & Contracts)
- **输入参数与类型**:
  ```typescript
  interface ParserInput { ... }
  ```
- **预期输出与行为**:
  ```typescript
  interface ParserResult { ... }
  ```
- **边缘与异常约束**: 当输入为空或非法时必须抛出 `ValidationError`。

## 4. 实施步骤建议 (Action Plan)
1. 编写失败单元测试 `tests/core/parser.test.ts` 覆盖基本输入与异常场景。
2. 在 `src/core/parser.ts` 实现核心解析逻辑。
3. 导出接口并在调用入口注入。

## 5. 验收命令与断言 (Acceptance Criteria & Test Commands)
- **执行命令**: `npm test -- tests/core/parser.test.ts`
- **退出码要求**: `0`
- **断言标准**:
  - [ ] 正常输入能够完整贯穿返回目标结构。
  - [ ] 异常输入能够被正确捕获并返回标准错误。
```

---

## 拆票准则与反模式警示

### ✅ 正确做法：Tracer-Bullet 垂直贯穿
- **TICKET-001**: 实现基础登录认证主链路（打通最小的前端表单输入 -> 鉴权中间件 -> Mock 用户数据库 -> 颁发 Token 闭环）。
- **TICKET-002**: 在 001 基础上扩展密码哈希与真实持久化数据库读写。
- **TICKET-003**: 在 001/002 基础上扩展 OAuth 第三方登录。

### ❌ 错误做法：水平架构分层横切
- **错误票 A**: 设计并创建全部数据库表结构。（无法独立端到端验证）
- **错误票 B**: 写完全部后端 Service 逻辑。（调用链未接通）
- **错误票 C**: 画完所有前端界面。（无法联调验证，纯空壳）

---

## 验收与自检清单

- [ ] 每张票的 `blocked_by` 依赖关系明确，无循环依赖（Cycle-free DAG）。
- [ ] 抹去前序会话后，单独拿任意一张票给全新会话的模型，模型拥有足够的输入可立即开始编码。
- [ ] 每张票都包含明确的可运行测试命令（如 `npm test -- ...`），不依赖口头推断。
- [ ] 所有的需求项均能在 Spec 中找到源头映射。
