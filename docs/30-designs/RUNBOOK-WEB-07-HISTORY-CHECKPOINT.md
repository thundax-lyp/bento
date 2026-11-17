# WEB-07 重试前校验 DSH 检查点 RUNBOOK

2026-11-17。独立合入候选，独立审核已通过。基线 `e2a45a4661fdbe1cf8a17060164392eab3e4a592`，工作目录 `/Volumes/storage/workspace/bento-a`。获审后任务分支为 `codex/web-07-history-checkpoint`。

## 执行者契约

T0 由作者与审核者完成。剩余实施、验证和收口按 T2–T3，依现有 WORKER 规则 PASS 后逐步提交。STOP 时保留现场，报告最后 PASS、触发断言、路径和脱敏输出。T2 只用临时本地 DB 和本地宿主 fixture，不依赖 A 独占 OpenShell 租约。B 先合共享 Readiness，T3 等 B 合入并同步复验后再改该文件。上游独立改动若改变本 RUNBOOK 固定的入口或契约，停止交还作者。

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

### T2：接通 retry 受理和首次卷恢复门禁

前置状态：`SessionHistory.validateRestoreCheckpoint` 和 `HistoryCheckpointUnavailable` 已提交。历史 focused 验证 3 项和 Orchestrator typecheck 已通过。允许修改：`apps/orchestrator/openshell/single-host.ts`、`apps/orchestrator/execution-service/service.ts`、`apps/orchestrator/execution-service/service.test.ts`、本 RUNBOOK。禁止修改：Store schema、host 实现、HTTP/SDK 协议、浏览器、Readiness。

执行：

1. 在 `SingleHostExecution` 增加同名同参 `validateRestoreCheckpoint(...): void`。先调用既有 `requireReadyHistory(sessionId, oldGeneration + 1)` 再调用 SessionHistory 只读方法。入口为 Orchestrator 内部同步调用。
2. `service.ts::retryReason` 保留现有检查顺序。保存 `db.taskCheckpoint(run.id)` 结果，按现有位置处理缺行。让既有 `readProof` 块返回或赋值可信 binding 和已校验旧代。其后使用 `binding.session, run.id, oldGeneration, checkpoint.historySha256` 调用只读入口。仅捕获 `HistoryCheckpointUnavailable` 并返回 `checkpoint_unavailable`，其余错误上抛。POST 仍先调用 `db.taskRetryReceipt(taskId, key)`。仅在无 prior 的分支调用 `retryReason` 和原 stop proof 检查。已有 prior 继续直接进入原 `Store.acceptTaskRetry` 的重放/键冲突分支，绕过此次新增的历史校验。该同步路径到 `Store.acceptTaskRetry` 无新 await。
3. `advanceTaskRetry` 的 preparing 分支内，先运行既有只读 `queryRestore` 与 receipt 绑定校验，然后用 `proof.sessionId, proof.sourceRunId, proof.oldGeneration, proof.checkpointSha256` 校验历史。紧接着按原有 receipt 条件调用 `restoreTask` 或继续既有读回。最终校验放在 query 的 await 之后，覆盖等待期间的证据失效。外层已有 blocked 条件加入 `HistoryCheckpointUnavailable`。当 workspace 已恢复，原 `SessionHistory.restore` 自身事务校验仍生效，失败时不排队并保留已发生的现场。
4. 扩展现有 `private Task HTTP preserves earlier results across a fenced retry`。在停止证据恢复原值之后、首次合法 retry 之前，保存 `history.sqlite` 中 secondRun 的完整 checkpoint 行。依次做缺行和篡改 body 两项负控，保留正确业务 checkpoint 和 stop proof，每项之后恢复该历史行。断言 GET Run 的 reason，POST 409 的 code/reason，`retry_attempts` 无对应 sourceRunId，Run 数仍为 2，原卷文件摘要不变，宿主 restore 未调用。使用测试 wrapper 从 Worker 捕获该 Task binding，用 host.snapshot 对前后快照求摘要。从首次 `start` 起，在初始 host 的 `restoreTask` wrapper 入口递增 `initialRestoreCalls`，每个 409 后断言为 0。保留原 wrapper 的暂缓恢复行为。随后执行原合法 retry、丢回包重放及先前结果保留断言，重启后的独立 `restoreCalls` 恰为 1。重试成功后再删除源历史检查点，用原 retryKey 重放，断言 200、原 attempt ID、原预分配 Run ID、state 为 queued，恢复调用仍为 1。将历史行恢复原值再继续原测试。
5. 在同文件新增 `Task retry blocks when its history checkpoint disappears before workspace restore`。沿用上个测试的 `start`、`localHost`、Task HTTP 请求/鉴权和读取习惯，创建带 README 的独立 Task。它的首轮在 local Worker 确认写入并正常关闭后由 wrapper 返回 review，等到明确 failed 且 retryReason 为 null，确认其首轮 DSH checkpoint 为显式 absent。记录当前卷摘要。分别用两份独立临时 DB 执行缺历史行和当前历史内容损坏子场景。在第一次 `queryRestore` wrapper 中，缺行场景删 sourceRun 对应的历史行，内容损坏场景把当前 Session 行的 header 改为非法 JSON，保留源 checkpoint 行和其摘要。两次均在注入后调用本地原 query，并从初次启动起计数 restoreTask 调用。原 POST 必须 202。轮询同键 POST 至 200 blocked，核对两个 ID 一致、GET 预分配 Run 为 404、`lastConfirmedPhase="preparing"`、Task reconciliation 为 `restore_conflict`、恢复调用数为 0 且卷摘要不变。两种故障均按上述断言验收。直接关闭临时控制器并清理临时目录，不尝试解除 blocked。

验证：

```bash
pnpm --filter @bento/orchestrator exec node --import ../../register-paths.mjs --experimental-strip-types --test --test-name-pattern='private Task HTTP preserves earlier results|Task retry blocks when its history checkpoint disappears' execution-service/service.test.ts
pnpm --filter @bento/orchestrator check
```

PASS：两条 focused 测试执行并覆盖全部断言，已接受的正常重试保持原重放，完整 Orchestrator 检查通过。仅允许既有两个显式可选 Temporal 测试按环境跳过。STOP：恢复先于检查、错误映射不同或回执/写锁发生非预期变化。不得把已发卷恢复的运行归为负控通过。

### T3：同步 B 后记录覆盖并收口

前置状态：T2 PASS，MASTER 确认 B 的 Readiness 已先合入，当前分支已同步其合入点。允许修改：`docs/40-readiness/CURRENT-READINESS.md` 和删除本 RUNBOOK。禁止修改：原实栈草稿、WEB-05 行、WEB-07 状态和外部配置。

执行：

1. 在 WEB-07 行只追加实际验证 SHA 和本地覆盖：缺失/损坏的 DSH checkpoint 在 retry 受理前拒绝，受理后到卷恢复前失效会阻断且不写卷。保留「部分实现」及真实 OpenShell 安全重试缺口。
2. 完成验证后删除本 RUNBOOK，检查差异和残留引用，按原 WORKER 流程交付。

验证：

```bash
pnpm check
pnpm --filter @bento/web test:e2e e2e/task.spec.ts --grep 'Task routes retain idempotency|任务详情回读取消状态'
git diff --check
```

PASS：pnpm 检查通过，两个 Chromium focused 回归实际运行，Readiness 如实记录本地覆盖。真实 OpenShell 验收留在独立后续项。STOP：B 未合入时保留 T2 的独立成果，T3 等待。任何回归失败时不写完成证据。
