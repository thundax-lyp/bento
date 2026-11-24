# WEB-06 任务提交与结果验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## WEB-A08 实栈证据

2026-11-18，B 独占 Compose 候选 `ff15b38` 使用真实 DeepSeek 和 OpenShell。[Chromium 验收配置](../../../apps/workspace/web/playwright.web-a08.config.ts)随 `d062a90` 提交，在隔离 Chromium 容器运行 `node node_modules/@playwright/test/cli.js test --config playwright.web-a08.config.ts --reporter=line --output=/tmp/web-a08`，1/1 通过。

三位受邀用户顺序从 Web 上传各自的文本项目并提交。三次原 Run 均在关页时仍处于排队状态，随后在后台成功。重新登录后，三人各自从任务列表找回同一 Run，补丁预览与下载字节一致，应用到各自原文件后与预期内容一致。六个有向跨账号组合读取任务、Run、结果和补丁均返回 404。1 MiB + 1 字节的文本可保存并按原字节下载，选作任务输入时返回 413，页面显示 1 MiB 限制。

## WEB-A09 队列与上传隔离证据

2026-11-19，以生产基线 `abfc850`、fixture提交 `681a527`、完整场景提交 `da0e51c`、CI接线提交 `c28f431` 验证。`pnpm --filter @bento/web test:queue-isolation` Chromium 1/1通过（T4场景9.8秒，命令10.9秒），无skip。三个独立浏览器context真实邀请注册、密码登录和cookie会话，经过生产 taskEntryServer → httpBackend → Orchestrator HTTP → Store/SQLite；mySpace使用独立SQLite，受控签名对象HTTP实际接收PUT并将分块与合并对象落盘。执行使用生产localHost和可释放gate，直接统计实际worker进入/退出并与SQLite槽位查询对照，不以HTTP受理替代执行证据。未修改生产实现。

- **租户容量与拒绝原子性**：配置单执行槽、每租户排队上限2。A0实际running，A1/A2 queued，A3页面提交429 `tenant_queue_full`；A的Run=3、user_message=3、创建receipt=4、retryAttempt=0及worker进入历史均不变，原Task与输入仍可见。B/C从各自页面提交各202、各queued1，跨账号读取Task/Run均404。运行Run占执行槽，queued Run及既有接口规定的未完成retry预留计排队容量；本场景没有制造retry预留。
- **容量复用与幂等**：满额时原A1键重放200、原Run不变；释放A0后A1实际进入，A队列降为1，原A3被拒绝键首次受理202，随后同键重放200、异正文409 `idempotency_conflict`。A3恰1个Run/1条user_message。最后A=4、B=1、C=1共6个Run全部succeeded、每Run实际进入worker恰一次、peakWorkers=1、最终activeWorkers/occupied/queued全0。
- **100MB上传与执行槽独立**：浏览器正常选择实际100,000,000字节文件，六块真实PUT；part1的16,777,216字节已接收，落盘/回包前由gate保持在途，其余首批三块已落盘。此时reserved=100,000,000且worker/occupied均0，Task/Run/event/receipt/attempt均不增。A/B/C提交期间上传保持在途，执行仍只有A0一槽。A1运行期间释放上传gate并完成、下载、取消第二上传预占、再上传1字节，执行snapshot（worker进入、活跃数、槽位、各租户队列与业务表计数）逐字段不变。100MB下载SHA-256为 `83d30385a4a11980275dc23de3fb49ff37b906cc841efa048a96c62d90ff3b5f`，与输入一致。
- **错误区分与额度恢复**：同部署另预占100,000,000字节，reserved恰200,000,000后新增1字节获409 `space_quota`，上传记录/预占/存储调用不增；页面预检显示“账号可用额度不足。”且不发送上传POST。任务页面固定显示“当前账号的任务队列已满。等一个排队任务开始后再提交。”。第二上传确认取消后reserved归0，原先被拒绝的1字节ID正常上传完成，saved=100,000,001、reserved=0。自有选择文件、对象、数据库及监听均在finally关闭/删除并核对。
- **聚合与邻接回归**：`pnpm check` PASS（空间API55/55、Web单测17/17与构建、Orchestrator102通过/2个既有skip、Worker typecheck、Go test/vet、lint/format）。独立运行 `(cd apps/orchestrator && go test -run '^TestTemporalFairDispatchThroughExecutionEntry$' -count=1 -v .)` 实际PASS（4.423秒），构造Go测试可执行文件并启用既有TS双槽公平/背压入口，不受普通TS suite的two-slot skip影响；已有 `6e3515f` 证据继续适用。`npm pack --dry-run --json` 110文件，根files不变、Web验收fixture不入包；四个新文件精确登记public白名单，专用场景纳入Web Chromium E2E job。
- **Not Covered**：账号种子、签名能力与执行时序为fixture；未使用真实IdP、S3、模型或OpenShell。新增场景为单槽本地Web契约验收，不证明生产双槽池化或外部服务故障；Go双槽邻接回归另列。未覆盖A6-04其他资源上限与WEB-06其他外部故障场景，WEB-06父项仍部分实现。

## 场景补充证据

- **WEB-06 需求汇总**。WEB-06-01～05 已有验收证据。2026-11-24 任务分支补齐待核对、确认和可信结案的部分实现。最小实栈通过登录、上传及探针沙盒策略核对，Orchestrator 未启动，完整三账号中断和可信结案待验。见 [本轮实栈记录](https://github.com/thundax-lyp/bento/blob/6ae58ef5038b30898935a958d07cc73ab55323bb/docs/30-designs/RUNBOOK-WEB-06-RECONCILIATION.md#2026-11-24-最小实栈阶段记录)。
- **WEB-06-02 查询终态和无变更结果**。2026-11-19 `38e32ae`：独立 Chromium 1/1，经实际 API→执行 HTTP→SQLite 验成功非空/零字节、持久 failed 固定摘要、运行中不可用；双 view 预览/附件字节与 SHA 相同，空可下载，失败/不可用无下载且 409。HTTP focused 2/2 验四检查、404、重开一致；默认 Chromium 22/22、pnpm check 通过（既有2跳过）、pack 105文件无越界。Worker/身份/卷为 fixture，failed 关闭服务后注入；不证明故障处理，未跑模型/OpenShell/OIDC/S3；既有 A13 保留原版本范围。
- **WEB-06-03 提交响应丢失**。2026-11-19，代码 `7d4eb12`，同专用 Chromium 6/6：正常页面发送，经实际上游 202 后丢回包，活跃及已完成 Run 均由“重试提交”以原正文/原键回 200 同 Run，execute/Run/user_message 均 1；同库重开仍同 ID。Vitest `tests/task-submission.test.ts` 4/4 验证未知键跨模块重载保留、成功/4xx 清除、账号/正文/Task 隔离；Chromium 验证同 tab reload 保留键、5xx 保留入口/4xx 清除。真实 HTTP/SQLite，合成身份/Worker；不承诺跨设备或关闭浏览器草稿恢复。
- **WEB-06-04 同任务已有活跃 Run**。2026-11-19，`7d4eb12`，`pnpm check` Store `execution-service/task-submission.test.ts` 13/13；SQLite 重开后 queued/running/recovering/needs_review/cancelling 及 retry preparing/workspace_restored/history_restored/blocked 逐态拒新键 task_busy，原记录/计数不变；queued 终态释放、closed 为 task_not_ready。专用 Chromium 6/6：实际 running 拒新键、同键异正文冲突，页面提示等待/取消。状态及 stop/retry 为 fixture，不证明真实恢复/结案。
- **WEB-06-05 租户队列满**。2026-11-19，`c28f431` 本地Chromium三独立账号、生产HTTP/SQLite、100MB物理分块上传与实际受控host验收通过；A满额429无半写、B/C各202、上传不占槽、额度与队列提示可区分。见[WEB-A09队列与上传隔离证据](#web-a09-队列与上传隔离证据)。
- **WEB-06-06 执行落盘后回执前中断**。本地 Chromium 已验证待核对时隐藏补丁（`058a272`）。任务分支 `1c2b67d` 接入配置式 SDK Task 可信退出观察，`e07d054` 提供持久待核对列表。三账号真实强杀、旧代拒写、UNKNOWN 不重放及 B/C 交付待验。
