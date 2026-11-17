# WEB-07 重试前校验 DSH 检查点 RUNBOOK

2026-11-17。独立合入候选，独立审核已通过。基线 `e2a45a4661fdbe1cf8a17060164392eab3e4a592`，工作目录 `/Volumes/storage/workspace/bento-a`。获审后任务分支为 `codex/web-07-history-checkpoint`。

## 执行者契约

T0 由作者与审核者完成。剩余验证和收口按 T3，依现有 WORKER 规则 PASS 后逐步提交。STOP 时保留现场，报告最后 PASS、触发断言、路径和脱敏输出。已完成的本地验收只用临时本地 DB 和本地宿主 fixture，不依赖 A 独占 OpenShell 租约。MASTER 已确认 A 的 WEB-07 检查点 PR 先合。B 继续实栈，待安全点后同步主线并复验。上游独立改动若改变本 RUNBOOK 固定的入口或契约，停止交还作者。

## 目标、依据与范围

[WEB-07、WEB-A12](../10-requirements/WEB-REQUIREMENTS.md) 要求缺检查点拒绝重试。[WEB Task retry 接口](../20-interfaces/WEB-INTERFACE.md) 已有 `run_not_retryable`、`checkpoint_unavailable` 及 blocked receipt。[停止与双检查点设计](./WEB-DESIGN.md) 要求先验证两类检查点再执行恢复。当前 `retryReason` 只核对 Store checkpoint，`advanceTaskRetry` 先进入 host 卷恢复，`SessionHistory.restore` 才会拒绝缺失或损坏的 DSH 检查点。该断点会让浏览器开放操作、受理 retry，甚至改写卷后才发现历史无法恢复。

修复覆盖原 Run 详情、正常重试 POST 及重试后台准备阶段。真实 SDK 停止证明、真实卷恢复、私有宿主能力及端到端验收继续留在原实栈草稿，走单独 T0。本次范围无 schema、公开 DTO、错误码、SDK/host 适配器、UI、Temporal 或部署变更。Readiness 的 WEB-07 仍为「部分实现」。

## 数据与调用链

- 唯一 DSH 检查点所有者为 `SessionHistory`。已有 `history_checkpoints(runId,sessionId,authorityGeneration,body,sha256)` 各列必填，runId 为主键。body 是由原作者写出的 JSON。显式空快照为 `{"kind":"absent"}`。已存在快照为 `{kind:"present",header:string,inherited:number,next:number,events:string[]}`。原事件及 checkpoint 保留。重试历史发布仍使用既有 `history_restores` 与事务。
- `Store.taskCheckpoint(runId)` 提供 workspace JSON 及 workspace/history SHA-256。Run/Session/执行代来自已校验 stop proof 和受信 binding。接受 retry 的调用方只提交原 Run 路径及既有幂等键。Store 继续分配 attempt 和目标 Run ID。旧源 Run、TaskEvent 和首轮结果版本不变。
- GET Run 经 `taskRunView → retryReason` 投影。新键 POST retry 共用 `retryReason`，遇到缺失或损坏返回 409 `{error:{code:"run_not_retryable",message,reason:"checkpoint_unavailable"}}`，无 attempt、无新 Run、无卷写入。已持久化的同键 receipt 继续按原顺序先查再重放。即使源历史检查点随后失效，同键重放也继续返回原 attempt ID、预分配 Run ID 和当前 receipt 状态（HTTP 200）。同键绑定不同请求仍走 Store 原冲突检查。前置权限、终态、stop proof、环境及任务忙碌门禁沿原顺序。
- 后台的 preparing 阶段若发现 DSH 检查点失效，走现有 `Store.advanceTaskRetry` 转 blocked，`lastConfirmedPhase="preparing"`，`error="restore_conflict"`。无新 Run 或额外卷写入。同键仍读原 attempt ID 和原预分配 Run ID。Task 写门禁与后续可信结案沿用现有契约。

## 计数

以下仅计接线、现有校验/事务与相关 fixture。排除空行及纯注释，同文件行范围无重叠。计划直接改动 5 个代码文件，共 762 既有 LOC。加上必须核对的 Store 读、接受与阻断事务，共 6 个代码文件、862 LOC。

| 文件                                                  | 基线范围                       | LOC |
| ----------------------------------------------------- | ------------------------------ | --: |
| `apps/orchestrator/openshell/session-history.ts`      | 46–54, 170–245, 263–354        | 173 |
| `apps/orchestrator/openshell/single-host.ts`          | 103–122                        |  18 |
| `apps/orchestrator/openshell/remote-session.test.ts`  | 99–238                         | 138 |
| `apps/orchestrator/execution-service/service.ts`      | 511–640, 670–697, 1650–1693    | 198 |
| `apps/orchestrator/execution-service/service.test.ts` | 4121–4207, 4217–4364           | 235 |
| `apps/orchestrator/execution-service/store.ts`，只读  | 949–1009, 1021–1046, 1742–1754 | 100 |

## 执行步骤

### T0：锁定可执行草稿

前置状态：当前工作树只有本轮草稿与先前实栈草稿。允许修改：本文件。禁止修改：生产、测试、Readiness、私有和外部运行配置。

执行：

1. 核对 HEAD 与基线，独立审核 T1/T2 可在本地完成。原实栈草稿继续作为未跟踪文件保留。T0 只运行 `git add -- docs/30-designs/RUNBOOK-WEB-07-HISTORY-CHECKPOINT.md`，提交前以 `git diff --cached --name-only` 断言暂存区只有本文件。
2. 在分支起点提交已审核的本 RUNBOOK。记录 A 本地工具链与既有基线验证，Orchestrator 47 通过、2 个可选 Temporal 跳过，Chromium focused 2 通过。

验证：

```bash
git rev-parse HEAD
git status --short
git diff --check
pnpm exec prettier --check docs/30-designs/RUNBOOK-WEB-07-HISTORY-CHECKPOINT.md
```

PASS：版本与审核结论可追溯，运行契约一致。STOP：工作树有归属不明的改动、独立审核未通过或入口与草稿不同。继续前记录具体差异。

### T3：同步主线并收口 WEB-07 本地覆盖

前置状态：T2 提交 `025c87995d32fac8f2a58a1563c8971f941daccf` 已通过 focused HTTP 和完整 Orchestrator 检查，修订稿已独立复核，A 当前交付顺序已由 MASTER 确认。允许修改：`docs/40-readiness/CURRENT-READINESS.md` 的 WEB-07 行和删除本 RUNBOOK。禁止修改：原实栈草稿、其他 Readiness 行、WEB-07 状态和外部配置。

执行：

1. 运行 `git fetch origin main` 和 `git merge --no-edit origin/main` 同步最新主线，要求 `git merge-base --is-ancestor origin/main HEAD` 成功。当前核对的主线 `e2a45a4661fdbe1cf8a17060164392eab3e4a592` 已是祖先。若发生冲突或上游改变本任务契约，STOP 并记录实际差异。
2. 在 WEB-07 行追加 T2 提交短 SHA `025c879` 和本地证据。记录缺失或损坏的 DSH 检查点在新 retry 受理前返回 409 且无 attempt/卷恢复，已受理后到首次恢复前失效会阻断且不改卷，同键重放保留原回执。保留「部分实现」、原本地证据及真实 OpenShell 安全重试缺口。
3. 删除本 RUNBOOK，检查无残留引用。按下列命令验证最终工作树。PASS 后只提交 WEB-07 行和本文件删除。推送本任务分支并创建或恢复同一个 PR，按 WORKER 流程进入 Ready、核对当前 HEAD 的必需 CI 和 Codex 审查结论、处理反馈并按授权合并。合入后同步 A 并清理已合并的任务分支，保留未跟踪的 OpenShell 后续稿。

验证：

```bash
git merge-base --is-ancestor origin/main HEAD
pnpm check
pnpm --filter @bento/web test:e2e e2e/task.spec.ts --grep 'Task routes retain idempotency|任务详情回读取消状态'
git diff --check
git diff --name-status
```

PASS：`pnpm check` 通过，两个 Chromium focused 用例实际运行。相对 T2 的未提交差异仅为 WEB-07 证据行和本 RUNBOOK 删除。T3 的工作树验证通过后才提交，PR 合并仍须满足实时门禁。STOP：主线冲突、契约漂移、回归失败或超出允许差异时保留现场并报告。真实 OpenShell 验收留在独立后续项。
