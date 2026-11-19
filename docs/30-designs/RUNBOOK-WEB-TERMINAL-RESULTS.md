# WEB 终态结果与非通过检查验收

## 状态与执行者契约

2026-11-19；WORKER B；仅调查起草，未获 Executable，禁止实施、提交和部署。
绑定 checkout 为派工指定的 bento-b；调查基线 `fbbee2f536112ba6e050b469bd1c6134306694d8`，目标分支 main，计划分支 `codex/web-terminal-results`。
本稿为待审草稿，不自行授予 Executable。按 MASTER 2026-11-19 补充口径，失败和非通过检查使用真实投影、HTTP、Store 和 Chromium 的分层 fixture；本轮不部署或调用模型。
收到 MASTER 的同一内容 Executable 后才单独提交本文件；收到显式 worker 开工后才实施。
逐步 PASS 才删除该步并同次提交，最后一步同步长期证据并删除本文件。失败停在原步，不删步骤，不放宽断言。

## Purpose、Scope 与 Non-goals

以 [WEB-06-02](../10-requirements/WEB-REQUIREMENTS.md#web-06-02-happy-path-查询终态和无变更结果) 和 [WEB-08-04](../10-requirements/WEB-REQUIREMENTS.md#web-08-04-bad-case-检查失败或无法执行) 为独立验收边界，合并交付原因是二者共用 Worker 公开投影、冻结结果、查询和下载链。
从正常任务页观察成功非空 diff、成功空 diff、明确失败、结果尚不可用；对 passed/failed/not_run/unavailable 逐项核对公开事件、结果和页面。
已有成功证据适用时复用，新增验证补齐实际缺口。目标是两行均有正式必需断言的适用通过记录。
不改 retry/cancel/checkpoint/Session 恢复、Task 状态语义、鉴权机制、旧部署迁移、模型能力、部署拓扑；不碰 A 的任务控制区和 web-a13 验收文件。
MASTER 已允许 pages.tsx 的 resultVersion=null 提示及 TaskRunResult/checkLabels 的最小修复；未授权顺手整理其他 UI。
A 先使用实栈并先合入，B 在步骤提交的安全点 merge 最新 main，复验共享查询展示和 A 的重试回归。实栈窗口未经 MASTER 放行不得使用。

## 正式依据与当前断点

- [接口](../20-interfaces/WEB-INTERFACE.md) Task 生命周期：TaskEventDTO、ResultDTO、结果及版本化 diff 路由。
- [设计](./WEB-DESIGN.md) Task 生命周期与公开事件：Worker 只传白名单；Store 同事务冻结成功与结果；两个 diff 来自同一快照。
- [架构](../00-governance/ARCHITECTURE.md)：Run/结果权威在 Orchestrator；Worker 仅投影；Web 只查询。
- [Readiness](../40-readiness/CURRENT-READINESS.md)：WEB-06-02 部分实现，WEB-08-04 待核验；WEB-08-01/02/03 已实现。
- pages.tsx::checkLabels 已有四个准确中文标签；TaskRunResult 已先读 metadata 再读固定版本 diff，成功零字节仍提供下载。selected.resultVersion=null 时当前无结果不可用文案，是本次最小生产修复。
- task-projection.ts::projectTaskChecks 把可信 pass/fail/skip/unavailable 映射为四种公开值，固定输出而不复制原工具文本。已有单测四状态不是实栈页面证据。
- service.test.ts 的 Task event projection suite 目前只覆盖 passed，并对私有字段、旧授权、重复事件和补丁字节有 fixture 证据，不能充当真实模型通过。

## 已有证据与缺口

Readiness 记载 2026-11-17 `36ab687` 加私有 Worker 的 WEB-A13 1/1：两轮修改、第三轮只读、补丁应用和字节对账、独立私有标记负例。原始记录位于 B 受控租约 `web-a13/full-stack/a13-output.*` 与 `web-a13/orchestrator-state/{business,authority}.sqlite`。本轮尚未远程回读；记录不等于当前部署通过。本任务本地分层验收不依赖重新部署；无法取得原件时不扩大复用声明。
本地旧 AUDIT.md 多处仍写“未运行”，与最终 Readiness 阶段不同，不能据该候选草稿覆盖最终记录；必须核对实际输出、源码和 launcher 摘要。
复用前核对 `git diff 36ab687..HEAD` 对结果链逐文件的影响，原始输出的用例标题、退出码、Run/version、SHA 和无跳过断言。只复用有真实原件且未被行为变化影响的断言。
缺口：空 diff 独立零字节下载、明确失败及不可用页面、failed/not_run/unavailable 每种状态的实际公开输出、当前版本页面提示。无检查记录 `[]` 不代表 not_run。

## 数据、调用链与不变量

1. 私有 bootstrap `trustedTaskChecks(events)` 产出 `{version:1,offset:number,outcome:'pass'|'fail'|'skip'|'unavailable'}`；三个字段必需，不接受多余字段；offset 为本轮真实事件索引，不重复、不越界。不得从用户正文或模型自述伪造可信结果。
2. `projectTaskChecks(eventCount,visible,checks)` 产出只读 PublicWorkerEvent 数组；check 为 `{offset,kind:'check',name,status,output}`，status 固定四值，output 为 string|null。固定名称“工作区内容检查”；pass 输出“内容与预期一致”，fail 输出“内容与预期不同”，skip 为 null，unavailable 输出“无法读取检查目标”。其他公开事件仅 `{offset,kind,text}`。
3. Worker POST task-events 受 execute grant/binding/generation 守卫；事件按 offset 排序，Store event sequence 为 Task 级递增。公开 payload 不携带 token、路径、卷、命令参数、未知原文或工具 JSON。结构校验不能替代可信 producer 的语义脱敏。
4. Store::publishTaskResult(runId,input,reviewProof?) 的 input 必需五个 string 字段：baselineSha256、initialSha256、afterSha256、incremental、cumulative。最后公开 agent_reply 为 summary，无时固定 Run completed.；checks 从已存 check 事件取。version 固定 1；runId 唯一；补丁以 UTF-8 字节计算 SHA-256；首次 createdAt 与结果持久化。成功状态和结果同事务写入，重放全部内容相同才复用；本任务不改此事务或生命周期。
5. GET tasks/{taskId}/runs/{runId}/results 返回 `{result:{runId,version:1,summary,checks,incrementalSha256,cumulativeSha256,createdAt}}`；checks 每项 name/status/output 全必需，output 可 null。公开 API protocol::taskResponse 再白名单投影并核对 Run/version。Web TaskResult 对应同字段；Run.resultVersion 为 number|null、summary 为 string|null。
6. GET results/1/diff 必需 view=incremental|cumulative；download 可省略或唯一值 1。成功返回 text/plain 的同一字符串，下载附件名 changes.patch；没有已成功结果返回 409 diff_unavailable。越权/错误绑定为 404。下载零字节是成功空结果，不是 409。
7. taskRunView 读取权威状态；失败原因来自服务固定摘要，不输出异常原文。页面只显示服务公开摘要；本任务不新增从原始错误猜测失败原因的 mapper。
8. 同部署重启后沿用 Store 持久化结果与 version；本轮不修改持久化、回执、outbox、恢复、ID/时间来源。不可用不得凭 UI 创建空结果。后轮不能改写旧 Run。只读结果不要求伪造检查。

## 有效 LOC 核算

以下均为验收必须核对的既有代码；不代表预期修改量。按基线行段去重，排除空行和纯注释，不含新测、文档和生成物。合计 **712 LOC / 9 个代码文件**。

| 文件                                             | 行段      | 有效 LOC | 符号与验收关联                                           |
| ------------------------------------------------ | --------- | -------: | -------------------------------------------------------- |
| `apps/worker/task-projection.ts`                 | 1–74      |       67 | projectTaskChecks / outcomes；四状态及脱敏               |
| `apps/worker/task-bootstrap.ts`                  | 1–91      |       85 | bootstrap；可信 producer 与公开投影接线                  |
| `apps/worker/protocol.ts`                        | 62–133    |       68 | PublicWorkerEvent / publicTaskEventBatch；公开字段和限制 |
| `apps/orchestrator/execution-service/store.ts`   | 1233–1311 |       79 | publishTaskResult；冻结结果和检查来源                    |
| `apps/orchestrator/execution-service/http.ts`    | 276–398   |      123 | Task 路由结果/下载分支；不可用门禁与同字节               |
| `apps/orchestrator/execution-service/service.ts` | 1159–1193 |       33 | finish；同快照生成两种补丁                               |
| `apps/workspace/api/protocol.ts`                 | 724–849   |      126 | taskRunDTO / taskCheck / taskResponse；公开白名单        |
| `apps/workspace/web/src/api.ts`                  | 201–240   |       40 | TaskRun / TaskCheck / TaskResult；页面消费者             |
| `apps/workspace/web/src/pages.tsx`               | 1537–1627 |       91 | TaskRunResult；固定版本预览和下载                        |

## Plan

各步文件数包含本 RUNBOOK 与专门只读核对文件。执行期间通用工具加载不额外扩大该步业务核对清单。所有命令从仓库根执行。

### T5：完整复验与独立证据收口

前置：上一 STEP 已提交独立 HTTP/Store/DTO/Chromium 验收，1/1 通过、Web typecheck 和定向 ESLint 通过；已采用证据的版本边界准确、已纳入 A 的最新 main 并经 MASTER 核对共享行为。若 A 尚未合入，在已提交独立验收 STEP 的安全点等待并保留只剩 T5 的 RUNBOOK；不得把等待当作前置已满足，不执行 T5、不删除 RUNBOOK、不宣告收口。merge 不改写历史，冲突涉及 A 控制区先 STOP。
允许修改：CURRENT-READINESS.md、本 RUNBOOK。
专门只读：WEB-DESIGN.md、README.md、deploy/README.md（均为现有正式路径），合计 5。
执行：记录日期、准确源码/Worker 版本、环境摘要、各用例结果、已有证据复用边界及未覆盖项。Readiness 仅改 WEB-06-02 和 WEB-08-04 行；父汇总变化交 MASTER 协调，不覆盖 A 内容。未改架构/启动/发布方式，核对三份入口文档后记录无需改写。将适中长度的分项证据直接写入这两行说明列，不新增独立证据文档；不含本机路径、真实身份或连接参数。
验证：

```bash
pnpm check
pnpm --filter @bento/web test:e2e -- --project=chromium
npm pack --dry-run --json
git diff --check
```

PASS：完整检查退出 0；Readiness 分项证据逐项关闭两个需求；共享查询、结果下载和 A 的既有安全重试 Chromium 回归通过。未通过的必需项不得标已实现。删除本 RUNBOOK，rg 核对无仅指向它的链接，再提交。
STOP：完整验证失败、证据版本受改动影响或尚有未验必需项，保留步骤并报告 MASTER。本轮没有实栈撤场，旧服务、卷和资源不动。
提交边界：`Docs(task-entry): 记录终态结果逐项验收证据`，同次删除整个 RUNBOOK。

## 验证矩阵与关闭定义

| 正式场景              | 必需可见断言                                                             | 计划证据                        |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| WEB-06-02 成功非空    | 正常入口、同 Run/version、两 view 预览和下载同字节及 SHA                 | A13 适用原件 + T2/T3/T4         |
| WEB-06-02 成功空      | 结论可读、无变更、两 view 可下载零字节、不出现尚不可用                   | 只读 A13 原件 + T3/T4 补缺      |
| WEB-06-02 明确失败    | failed、公开原因、无结果下载、不包含私有内容                             | T3 mock + T4 持久失败 fixture   |
| WEB-06-02 尚不可用    | null version、明确尚不可用、无下载、409                                  | T2/T3/T4                        |
| WEB-08-04 passed 对照 | 真实 passed，名称和公开输出准确                                          | T1/T2/T3/T4，实栈仅复用适用原件 |
| WEB-08-04 failed      | 实际失败不显示通过，固定公开输出                                         | T1/T2/T3/T4                     |
| WEB-08-04 not_run     | fixture TrustedTaskCheck skip 投影事实、not_run/null、“未运行”           | T1/T2/T3/T4                     |
| WEB-08-04 unavailable | fixture TrustedTaskCheck unavailable 投影事实、unavailable、固定公开输出 | T1/T2/T3/T4                     |

权限、旧代、重放、持久重开覆盖采用既有测试加 T2，不改变生产事务；完整负例扩展、并发恢复和迁移 Not Applicable，本任务无该行为变更。旧 Run 不覆盖复用适用 A13。
全部矩阵满足、长期证据和 Readiness 完成才关闭。WEB-06-02/WEB-08-04 的本地分层验证足以关闭本任务展示与查询契约；不代表真实模型具备全部非通过状态的生产触发工具。PR/Ready/Codex 当前 HEAD 审查、普通 merge、同步清理依 worker 技能和 PR 规则执行，先 A 后 B；本轮授权覆盖这些后续动作，但当前阶段仍只起草。
