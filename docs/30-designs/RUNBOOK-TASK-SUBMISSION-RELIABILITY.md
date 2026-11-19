# Task 提交可靠性闭环

状态：Executable / 已获 MASTER 显式开工；2026-11-19。T0 已验证，T1 客户端请求键测试 4/4 PASS。

工作边界：WORKER B，checkout `/Volumes/storage/workspace/bento-b`。调查基线 `231567dcf83e2d1a000db68f03dcb655a3d57cac`，当前 main 干净。获 Executable 后任务分支固定 `codex/task-submission-reliability`；只有 MASTER 单独发出 `$bento-runbook-worker RUNBOOK-TASK-SUBMISSION-RELIABILITY.md` 才开工。

## 执行者契约

依 T0→T1→T2→T3→T4→T5 执行，不提前实施后续步骤。每步 PASS 后删除该步、改写后续前置为可核对事实，并单独提交；最后一步同步长期证据并删除 RUNBOOK。每步最多 10 文件，包含 RUNBOOK 和专门核对文件。通用规则见 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)、[Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。

MASTER 已传达全流程分支、提交、push、PR、Ready、显式评论处理、当前 HEAD 门禁通过后普通 merge、同步和清理授权；当前阶段仅调查和未提交草稿送审。不得把送审视为开工。

STOP 保留现场，不回滚用户改动；报告最后 PASS/提交、文件及符号、复现命令、脱敏实际结果和需要的决定。范围内测试错误可原步修复，产品/共享入口/基线变化交作者修订并复审。不得放宽断言、跳过用例或伪造受理。

## 目标、正式依据与当前断点

三项共用正常页面→请求键→个人 API→Orchestrator SQLite→原回执→UI 重投链，合并交付但分别验收。

| 场景      | 正式依据                                                                                                                                                                         | 当前断点                                                                                              | 本次验收                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WEB-05-04 | [需求](../10-requirements/WEB-REQUIREMENTS.md#web-05-04-bad-case-提交响应丢失)、[Task 生命周期](../20-interfaces/WEB-INTERFACE.md)、[设计](WEB-DESIGN.md) Task 冻结及重复 create | [Readiness](../40-readiness/CURRENT-READINESS.md) 缺实际丢回执对照                                    | blank 和 snapshot 均从页面创建；上游 202 后丢回包；原键重投返回同 Task，输入及环境版本不变、provisionTask 仅一次；随后发送 Run，worker execute 一次                    |
| WEB-06-03 | [需求](../10-requirements/WEB-REQUIREMENTS.md#web-06-03-bad-case-提交响应丢失)、接口 POST /tasks/{taskId}/runs、设计 Task Run                                                    | 缺同提交超时重投；TaskDetailsContent 的 onError refresh 会读出活跃 Run 并禁 canSend，没有独立重投入口 | 页面发送→上游 202 后 abort→原正文同键重投→200 同 Run；Run/user_message/execute 都恰一；同库重开重放仍同 ID                                                             |
| WEB-06-04 | [需求](../10-requirements/WEB-REQUIREMENTS.md#web-06-04-bad-case-同任务已有活跃-run)、接口 task_busy、设计 Task 写门禁                                                           | 五状态与 pending retry 各态缺逐项证据                                                                 | queued/running/recovering/needs_review/cancelling 及 preparing/workspace_restored/history_restored/blocked retry 预留均拒新键要求，原记录不变且不新增 Run/user_message |

代码事实：

- `apps/workspace/web/src/api.ts::taskMutation` 已按账号、kind、scope、正文 JSON SHA-256 存 sessionStorage 键。成功及明确 4xx 删除，网络/5xx 保留；createTask 排序 fileIds，createTaskRun trim prompt。不修改此通用策略。
- `apps/workspace/api/server.ts::taskEntryServer` blank 转 FrozenTaskInput；snapshot 经 `space-execution.ts::createTask/enrollTask/freezeTask/reconcileTask` 持久 pin/frozen intent。生产 freeze 与 receipt 逻辑不能被 fixture 替代。
- `apps/workspace/api/protocol.ts::createTaskInput`、Task 路由解析与 DTO；`execution-service-http.ts::taskForward` 原键与 prompt 转发。
- `apps/orchestrator/execution-service/http.ts::executionHttp` 的 Task 路由调用 `Store.createTask/enqueueTaskRun`，首写 202/replay 200，wake 不代表第二次执行。
- `store.ts::createTask` 的 receipt、项目、Task、refs 同一 Store.write；`enqueueTaskRun` 先查同键后写门禁，同键异 prompt 报 conflict；新增 Run 和 user_message 同事务。
- 准确门禁符号是 `taskWriteGuard/projectHasPendingRun/pendingTaskRetry`，不是初始线索中的 requireTaskWritable/enqueueTask/acceptTask。
- 已运行基线定向测试：`node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='Task input, Run, and source deletion share a durable transaction boundary' apps/orchestrator/execution-service/service.test.ts`：1/1 PASS。证明 Store 基础行为，不证明浏览器或真实 Worker。旧测试仍保留，不修改 A 独占 suite。
- `web/e2e/task.spec.ts` 的 lostReceipt 是 mock，不作为生产受理证据。#63 terminal-results fixture 仅作为组织方法参考，既有 terminal-results 文件不修改。

## Scope、Non-goals 和资源

只补三项提交可靠性、最小页面重投入口及其测试/证据。生产服务端保持只读；新测试若揭示服务端缺陷，STOP 送作者固定修正方案，不临场加文件。

禁止修改 `service.ts::retryReason`、恢复控制流、`service.test.ts`、OpenShell、Session checkpoint、安全重试 mutation/确认按钮、取消实现和结果展示。不得改 `api.ts::taskMutation`；需改时报 MASTER。A 页面只读；MASTER 已同意 B 修改 TaskDetailsContent sending/onError/canSend 周边。

不实现恢复、结案、队列公平、租户满额新能力、外部身份、S3、模型、Temporal、Docker 或 OpenShell 验收。不承诺跨设备/关浏览器离线草稿恢复。sessionStorage 测试只证明同 tab reload 后原正文仍找同键；页面临时未知提交正文只在本次组件生命周期保留，刷新可按账号找回已受理记录。

ENVIRONMENTS.md 调查时不存在；本任务不连接外部受控服务，无需配置秘密。API 端口 4343、Vite 4344，execution 使用系统分配回环端口；任一固定端口已占用 STOP，不复用/杀旧进程。临时目录由 mkdtemp 创建，finally 只清理本 fixture 自有资源。

## 数据、接口、顺序和不变量

- 公开创建 required `{name:string,source:{kind:'blank'}|{kind:'space_snapshot',spaceId:string,fileIds:string[]}}`；K 为 Idempotency-Key。name trim，snapshot fileIds 排序。私人 FrozenTaskInput required `{id:string|null,name:string,sourceSpaceId:string|null,inputFiles:{path:string,text:string}[],inputManifest:{fileId:string,path:string,bytes:number,sha256:string}[],inputDigest:string}`。blank id/source 为 null 且两个数组空；snapshot id 是 space intent UUID。inputDigest 为规范文本快照 JSON SHA-256。所有值均来自生产 mapper/freeze；fixture 只提供已保存源字节。
- Store Task 创建 hash 为 `{name,sourceSpaceId,inputManifest:按fileId排序,inputDigest}` 的 JSON SHA-256；`task_creation_receipts(owner,key,taskId,hash)` 主键 owner/key。taskId 首写由可信端分配，environmentVersion 来自 host，不由浏览器指定；重投不换版本。receipt 与 Task 同生命周期；同部署重开继续读。不同正文同键 409 idempotency_conflict，不新建记录。
- Run 请求 required `{prompt:string}`，公开 parser/客户端 trim，原键透传。Store 按 taskId/key 查既有 Run，prompt 或 retryOf 不符即 409 idempotency_conflict；同键同正文先返回原 Run，不受 busy 新写门禁影响。新的 Run ID/时间/sequence 由 Store 创建，user event ID 为 `${runId}:user`、kind=user_message、text=prompt、check=null；只 append 一次。
- 活跃 Run 集为 queued/running/recovering/cancelling/needs_review；pending retry 为 preparing/workspace_restored/history_restored/blocked。新键在这些状态回 409 task_busy，不生成 Run、event 或派发。queued/closed retry receipt 自身不持预留，前者由其新 Run 状态持门禁；此任务不改变恢复状态转换。
- DTO 沿用接口的 TaskDTO、RunDTO、TaskEventDTO；不增加公开字段、事件或数据库结构。POST 首受理 202，重投 200；公开错误 `{error:{code,message}}`。无新 outbox/Archive/版本契约。
- UI 新增 `pendingSubmission: string|null`（初始 null，组件内拥有）保存未知回执的已 trim 正文。sending 改为 `mutationFn:(submittedPrompt:string)=>createTaskRun(account,id,submittedPrompt)`。正常 onSubmit 传 prompt.trim()。onError(error,submittedPrompt) 对 ApiError 400–499 清 null；其他错误保存 submittedPrompt，然后执行现有 refresh。onSuccess 清 null、清 prompt、refresh、导航原返回 Run。
- pendingSubmission 非 null 时普通 canSend 为 false，不允许编辑或正常发送；另显文案「提交结果未确认，请重试原提交。」与 type=button「重试提交」。该按钮只在 online、任务读取未报错、无其他 mutation pending 时可点，固定调用 sending.mutate(pendingSubmission)，不采用当前输入框内容、不看 last.canContinue 放行新要求。网络/5xx 后继续保留；成功或确定 4xx 清除。不修改 retry/cancel mutation。活跃原 Run 正常入口展示「任务已有执行，请等待完成或取消。」并禁发送；取消按钮仍沿用现有条件。

## 有效 LOC 与文件映射

以下为基线已存在且交付必须核对的范围；按非空且非纯注释行计算，同一行只计一次。不计文档、新测试估值或生成物。

| 路径                                         | 行段 / 核对符号                                      | 有效 LOC | 需求映射              |
| -------------------------------------------- | ---------------------------------------------------- | -------: | --------------------- |
| apps/workspace/web/src/api.ts                | 337–406 taskMutation/createTask/createTaskRun        |       69 | 05-04/06-03 请求键    |
| apps/workspace/web/src/pages.tsx             | 1127–1250、1365–1400 TaskDetailsContent              |      160 | 06-03 重投、06-04 UI  |
| apps/workspace/api/server.ts                 | 325–410 taskEntryServer Task 接线                    |       86 | 全链                  |
| apps/workspace/api/protocol.ts               | 509–530、550–660 createTaskInput/Task route parser   |      133 | 正文与键              |
| apps/workspace/api/execution-service-http.ts | 70–105、145–240 taskForward/公开错误                 |      130 | 回执/冲突             |
| apps/workspace/api/space-execution.ts        | 409–652 enrollTask/freezeTask/advanceTask/createTask |      238 | 05-04 冻结            |
| apps/orchestrator/execution-service/http.ts  | 130–196、320–347 Task routes                         |       94 | 202/200               |
| apps/orchestrator/execution-service/store.ts | 736–940 createTask/taskWriteGuard/enqueueTaskRun     |      199 | 持久化与 busy         |
| 合计                                         | 8 个代码文件                                         |     1109 | 达到 500 LOC / 5 文件 |

允许新增且不计入上述门槛：`apps/workspace/web/src/task-submission.test.ts`、`apps/orchestrator/execution-service/task-submission.test.ts`、`apps/workspace/web/acceptance/task-submission-fixture.ts`、`apps/workspace/web/acceptance/web-task-submission.spec.ts`、`apps/workspace/web/playwright.task-submission.config.ts`。

## 机械步骤

### T5：完整门禁、正式证据和收口

前置状态：pages.tsx 最小原正文重投入口已提交；Vitest 4/4、专用 Chromium 6/6、web typecheck 全 PASS。真实受理计数 prepare/execute/Run/user_message/receipt 各一；5xx 保留、4xx 清除与等待/取消文案已验证。
允许修改：Readiness、WEB-DESIGN、public-files.json、本 RUNBOOK（最后删除）。专门核对 WEB-REQUIREMENTS、WEB-INTERFACE、package.json、README、deploy/README、ARCHITECTURE，共 10 文件。
禁止修改：需求/接口语义、非本任务 Readiness 行、运行配置及架构边界。

执行：

1. 在完整检查前先向 public-files.json.files 精确登记上述五个新增代码路径，每条只出现一次；该白名单负责允许 Git 跟踪，不等于 npm 发布范围。不得增加根 package.json.files。然后运行下列固定完整集合；首次任何失败 STOP，按原范围修复再复验，不缩减检查。原 task.spec mock 只作 shared 页面回归，尤其 A 的 retry UI。
2. WEB-DESIGN 只补未知回执临时入口的实现职责和清除规则；无新接口/依赖/发布入口，不需改 README/部署/架构。public-files.json 只登记上述五路径，npm pack 检查确认根 package.json.files 未扩展，web 测试/fixture 不进入 npm 包。
3. Readiness 逐行更新 WEB-05-04、06-03、06-04，记录日期、实际代码提交基线、命令、逐项计数和明确 synthetic identity/Worker/storage、真实 HTTP/SQLite/Chromium 范围。外部模型/OpenShell/真实身份/S3 未验，不冒称生产验收。三项全部适用断言通过才已实现。父项仅在所有必需子项完成时更新，否则保持部分实现。
4. 删除 RUNBOOK，rg 检查不存在仅指向该文件的残留引用；本步单独提交。随后按 worker skill 完成单一 PR、当前 HEAD CI/Codex 门禁、普通 merge 和同步清理；远端实时策略必须回读。共享文档合前纳入新 main，仅复验受影响边界。

验证：

```bash
pnpm check
pnpm --filter @bento/web exec playwright test e2e/task.spec.ts
pnpm --filter @bento/web exec playwright test -c playwright.task-submission.config.ts
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/execution-service/task-submission.test.ts
npm pack --dry-run --json
git diff --check
rg -n 'RUNBOOK-TASK-SUBMISSION-RELIABILITY' docs README.md .agents
```

PASS：前六条退出 0；最后 rg 在删除并清残留后无匹配（退出 1）；无 skipped 丢包/活跃态子用例，逐场景证据可回读。文档 Markdown 相对链接以本文件送审时的 Python 链接检查同法核对；删除后只核对本步改动的文档链接。STOP：基线合流影响共享入口、门禁不通过或证据不足，不标完成/不合并。失败不回滚既有业务状态，fixture finally 清理自己的临时资源。

## 完成定义与验证矩阵

| 边界           | 必需断言/证据                                                                    |
| -------------- | -------------------------------------------------------------------------------- |
| 正常入口       | blank/snapshot 页面创建、页面发送各真实 202；可回读原 Task/Run                   |
| 响应丢失       | route.fetch 真受理后 abort；第二次同 key/body 为 200 同记录                      |
| 冻结           | snapshot digest/manifest/环境不变，prepare=1；源读不重复                         |
| 执行次数       | 每 Task 指定 Run execute=1；Run/user_message/creation receipt 唯一               |
| 冲突           | 同键异正文 409，前后计数与原记录不变                                             |
| 活跃门禁       | 五 Run 态、四 retry 预留态逐项拒新键，无半提交；原键重放允许                     |
| 持久化         | Store 及无活跃执行的服务同库重开找回原 receipt；sessionStorage reload 保留未知键 |
| 授权           | 不同账号不复用客户端键，不读原 Task/Run                                          |
| UI             | 原正文重试；新要求禁用；网络/5xx 保留、成功/4xx 清临时入口；等待/取消可见        |
| 相邻边界       | task.spec 全部通过，retry/cancel/结果行为不改                                    |
| Not Applicable | 外部执行、恢复/结案实施、迁移、双写、新 outbox/Archive：本任务均无新行为         |

草稿验收不等于产品已完成。实际验证事实只迁移至 Readiness/稳定设计；临时 RUNBOOK 必须最终删除。
