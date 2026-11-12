# Module Design Template

起草时将标题替换为模块名称。各节按任务合并，集中说明不适用的内容及原因。

## Purpose

说明模块解决的问题和预期行为。

## Scope And Non-goals

列出本模块负责的能力和明确排除的范围。

## Related Requirements And Interfaces

链接对应需求、验收条件和跨边界契约，标明相关章节或接口名称。

## Responsibilities And Dependencies

- **归属和入口**：列出涉及的应用或子工程及其生产入口。个人端与管理端各自说明 `auth`、`web`、`api` 中涉及的职责。
- **调用链**：说明调用方、被调用方、依赖方向、同步或异步边界。涉及执行时，说明 Orchestrator 的编排职责和独立 Worker 的执行边界。
- **实现状态**：分别说明当前接线和目标设计，链接相关代码和平台架构。

## State And Failure Handling

- **数据归属**：列出权威数据、读写方、只读投影和持久化位置。涉及 Run 时，说明 Orchestrator 的权威状态与 Temporal 编排历史的关系。
- **状态与恢复**：说明适用的状态转换、原子性、幂等、重试、失败语义和同一部署重启后的恢复。

## Security And Observability

- **权限**：说明身份来源、授权检查的位置及跨应用调用使用的身份。
- **观测**：说明日志、审计、指标或关联标识如何定位失败及验证关键行为。

## Acceptance

将验收条件对应到验证入口和预期结果。记录验证所需环境，链接对应 Readiness 条目。
