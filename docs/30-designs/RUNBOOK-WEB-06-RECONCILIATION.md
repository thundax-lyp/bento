# WEB-06 待核对、结果确认与可信结案

**状态：Blocked（2026-11-26）。** 适用于 PR #102 的 WEB-A10 验收分支。只读核对当前证据，保留本文件。执行者须等作者复核同候选、独占装配和完整验收入口并给出继续指令。

## 范围与断点

范围为 [WEB-06-06～09](../10-requirements/WEB-REQUIREMENTS.md#web-06-任务提交与结果)、受影响的 WEB-07 回归及本轮独占资源回收。调用链沿 [Web 接口](../20-interfaces/WEB-INTERFACE.md)、[Web 设计](WEB-DESIGN.md) 和 [平台架构](../00-governance/ARCHITECTURE.md)。可信侧复核不能从用户入口调用。仅中断指定 Run 及执行代，分别证明原执行退出、旧代撤权、回执缺失、同卷副作用未重放，以及其他账号继续交付。

[正式与补充实测](../40-readiness/evidence/WEB-06.md#web-a10-2026-11-26-正式验收)覆盖产品场景并记录了实测入口。现有记录尚未证明原定 T2c、T3 整组门槛，包括同候选仓库 Chromium 用例、同候选 WEB-07 邻接回归，以及完整的租约级资源清理回读。

### T2c：同候选验收与清理

前置状态：作者确认当前 runner、独占装配和批准记录绑定同一源码、镜像和租约，正常冒烟通过。当前状态为 STOP。允许修改本文件以记录脱敏证据。禁止修改生产契约、放宽验收断言或操作共享资源。

执行：保留原步骤和验收矩阵供作者校对。从仓库根目录读取历史原文：

```bash
git show d22f21a14615bceff4cdf0c08a56a46c4afa9f07:docs/30-designs/RUNBOOK-WEB-06-RECONCILIATION.md
```

PASS：作者确认现行命令并提供同租约、同源码的仓库 Chromium 1/1、零跳过结果，逐项断言与独立审计齐备。按租约回读容器、网络、卷、对象及 Gateway sandbox 的清理结果，并证明既有环境仍健康。STOP：候选或入口不一致、任何断言未通过或资源归属不明。保留现场和既有证据，禁止清理归属未确认的资源。历史命令需经作者校对后才能执行。

### T3：邻接回归与收口

前置状态：T2c PASS。允许修改本文件及 WEB-06 的 Readiness 与证据。禁止降低门槛或扩大验收范围。

执行：作者复核历史 T3 命令是否仍匹配当前测试入口后，执行原定 focused、浏览器回归、根目录聚合检查及打包检查。

PASS：同候选完整验证通过，核对 WEB-07 受影响断言、项目删除、账号注销和发布文件范围。将候选身份、验收与清理结果写入 [WEB-06 证据](../40-readiness/evidence/WEB-06.md) 和 [Readiness](../40-readiness/CURRENT-READINESS.md) 后，按 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md#completion-and-deletion) 删除本文件并检查残留引用。STOP：验证、证据或候选一致性有缺口时保留本文件。
