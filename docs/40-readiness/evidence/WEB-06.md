# WEB-06 任务提交与结果验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## WEB-A08 实栈证据

2026-11-18，B 独占 Compose 候选 `ff15b38` 使用真实 DeepSeek 和 OpenShell。[Chromium 验收配置](../../../apps/workspace/workspace-web/tests/playwright/playwright.web-a08.config.ts)随 `d062a90` 提交，在隔离 Chromium 容器运行 `node node_modules/@playwright/test/cli.js test --config playwright.web-a08.config.ts --reporter=line --output=/tmp/web-a08`，1/1 通过。

三位受邀用户顺序从 Web 上传各自的文本项目并提交。三次原 Run 均在关页时仍处于排队状态，随后在后台成功。重新登录后，三人各自从任务列表找回同一 Run，补丁预览与下载字节一致，应用到各自原文件后与预期内容一致。六个有向跨账号组合读取任务、Run、结果和补丁均返回 404。1 MiB + 1 字节的文本可保存并按原字节下载，选作任务输入时返回 413，页面显示 1 MiB 限制。

## WEB-A09 队列与上传隔离证据

2026-11-19，以生产基线 `abfc850`、fixture提交 `681a527`、完整场景提交 `da0e51c`、CI接线提交 `c28f431` 验证。`pnpm --filter @bento/workspace-web test:queue-isolation` Chromium 1/1通过（T4场景9.8秒，命令10.9秒），无skip。三个独立浏览器context真实邀请注册、密码登录和cookie会话，经过生产 taskEntryServer → httpBackend → Orchestrator HTTP → Store/SQLite；mySpace使用独立SQLite，受控签名对象HTTP实际接收PUT并将分块与合并对象落盘。执行使用生产localHost和可释放gate，直接统计实际worker进入/退出并与SQLite槽位查询对照，不以HTTP受理替代执行证据。未修改生产实现。

- **租户容量与拒绝原子性**：配置单执行槽、每租户排队上限2。A0实际running，A1/A2 queued，A3页面提交429 `tenant_queue_full`；A的Run=3、user_message=3、创建receipt=4、retryAttempt=0及worker进入历史均不变，原Task与输入仍可见。B/C从各自页面提交各202、各queued1，跨账号读取Task/Run均404。运行Run占执行槽，queued Run及既有接口规定的未完成retry预留计排队容量；本场景没有制造retry预留。
- **容量复用与幂等**：满额时原A1键重放200、原Run不变；释放A0后A1实际进入，A队列降为1，原A3被拒绝键首次受理202，随后同键重放200、异正文409 `idempotency_conflict`。A3恰1个Run/1条user_message。最后A=4、B=1、C=1共6个Run全部succeeded、每Run实际进入worker恰一次、peakWorkers=1、最终activeWorkers/occupied/queued全0。
- **100MB上传与执行槽独立**：浏览器正常选择实际100,000,000字节文件，六块真实PUT；part1的16,777,216字节已接收，落盘/回包前由gate保持在途，其余首批三块已落盘。此时reserved=100,000,000且worker/occupied均0，Task/Run/event/receipt/attempt均不增。A/B/C提交期间上传保持在途，执行仍只有A0一槽。A1运行期间释放上传gate并完成、下载、取消第二上传预占、再上传1字节，执行snapshot（worker进入、活跃数、槽位、各租户队列与业务表计数）逐字段不变。100MB下载SHA-256为 `83d30385a4a11980275dc23de3fb49ff37b906cc841efa048a96c62d90ff3b5f`，与输入一致。
- **错误区分与额度恢复**：同部署另预占100,000,000字节，reserved恰200,000,000后新增1字节获409 `space_quota`，上传记录/预占/存储调用不增；页面预检显示“账号可用额度不足。”且不发送上传POST。任务页面固定显示“当前账号的任务队列已满。等一个排队任务开始后再提交。”。第二上传确认取消后reserved归0，原先被拒绝的1字节ID正常上传完成，saved=100,000,001、reserved=0。自有选择文件、对象、数据库及监听均在finally关闭/删除并核对。
- **聚合与邻接回归**：`pnpm check` PASS（空间API55/55、Web单测17/17与构建、Orchestrator102通过/2个既有skip、Worker typecheck、Go test/vet、lint/format）。独立运行 `(cd apps/orchestrator && go test -run '^TestTemporalFairDispatchThroughExecutionEntry$' -count=1 -v .)` 实际PASS（4.423秒），构造Go测试可执行文件并启用既有TS双槽公平/背压入口，不受普通TS suite的two-slot skip影响；已有 `6e3515f` 证据继续适用。`npm pack --dry-run --json` 110文件，根files不变、Web验收fixture不入包；四个新文件精确登记public白名单，专用场景纳入Web Chromium E2E job。
- **Not Covered**：账号种子、签名能力与执行时序为fixture；未使用真实IdP、S3、模型或OpenShell。新增场景为单槽本地Web契约验收，不证明生产双槽池化或外部服务故障；Go双槽邻接回归另列。未覆盖A6-04其他资源上限与WEB-06其他外部故障场景，WEB-06父项仍部分实现。

## 场景补充证据

- **WEB-06 需求汇总**。WEB-06-01～05 已有验收证据。2026-11-24 的最小实栈通过登录、上传和探针沙盒策略核对，当时尚未启动 Orchestrator。2026-11-25 的后续实栈推进到正常任务派发，仍未通过完整验收。见 [WEB-A10 脚手架与实栈边界](#web-a10-脚手架与实栈边界)。
- **WEB-06-02 查询终态和无变更结果**。2026-11-19 `38e32ae`：独立 Chromium 1/1，经实际 API→执行 HTTP→SQLite 验成功非空/零字节、持久 failed 固定摘要、运行中不可用；双 view 预览/附件字节与 SHA 相同，空可下载，失败/不可用无下载且 409。HTTP focused 2/2 验四检查、404、重开一致；默认 Chromium 22/22、pnpm check 通过（既有2跳过）、pack 105文件无越界。Worker/身份/卷为 fixture，failed 关闭服务后注入；不证明故障处理，未跑模型/OpenShell/OIDC/S3；既有 A13 保留原版本范围。
- **WEB-06-03 提交响应丢失**。2026-11-19，代码 `7d4eb12`，同专用 Chromium 6/6：正常页面发送，经实际上游 202 后丢回包，活跃及已完成 Run 均由“重试提交”以原正文/原键回 200 同 Run，execute/Run/user_message 均 1；同库重开仍同 ID。Vitest `tests/task-submission.test.ts` 4/4 验证未知键跨模块重载保留、成功/4xx 清除、账号/正文/Task 隔离；Chromium 验证同 tab reload 保留键、5xx 保留入口/4xx 清除。真实 HTTP/SQLite，合成身份/Worker；不承诺跨设备或关闭浏览器草稿恢复。
- **WEB-06-04 同任务已有活跃 Run**。2026-11-19，`7d4eb12`，`pnpm check` Store `execution-service/task-submission.test.ts` 13/13；SQLite 重开后 queued/running/recovering/needs_review/cancelling 及 retry preparing/workspace_restored/history_restored/blocked 逐态拒新键 task_busy，原记录/计数不变；queued 终态释放、closed 为 task_not_ready。专用 Chromium 6/6：实际 running 拒新键、同键异正文冲突，页面提示等待/取消。状态及 stop/retry 为 fixture，不证明真实恢复/结案。
- **WEB-06-05 租户队列满**。2026-11-19，`c28f431` 本地Chromium三独立账号、生产HTTP/SQLite、100MB物理分块上传与实际受控host验收通过；A满额429无半写、B/C各202、上传不占槽、额度与队列提示可区分。见[WEB-A09队列与上传隔离证据](#web-a09-队列与上传隔离证据)。
- **WEB-06-06 执行落盘后回执前中断**。本地 Chromium 已验证待核对时隐藏补丁（`058a272`）。任务分支 `1c2b67d` 接入配置式 SDK Task 可信退出观察，`e07d054` 提供持久待核对列表。后续正式三账号结果见下方 2026-11-26 验收。

## WEB-A10 脚手架与实栈边界

- **定向验证**。候选 runner 路径白名单测试 3/3，覆盖空差异、单一允许路径和越界路径。Playwright 配置发现 1 个 Chromium 用例，验收源码类型检查通过。SDK reconciliation 定向测试 7/7，retry SDK 定向测试 32/32。用例发现与定向测试只证明脚手架和所测契约。
- **正常实栈冒烟未通过**。A 独占候选验证了四个隔离账户的真实 OIDC 会话、签名对象写入和独立读回，以及有效 SDK 授权正控的 gRPC 成功和独立上游计数从 0 增至 1。后续诊断冒烟使用新 Task/Run。执行 Worker 发出 `ready` 并进入 `base-bootstrap` 后，在初始化和工具注册之前结束输出、退出码为 1，未返回执行回执。恢复 Worker 返回 `recovered`，新 Run 保持 `needs_review`，Chromium 等待成功终态超时，未取得补丁下载。现有日志仅确定失败边界，无法归因到内部异常。有效授权正控不证明工具副作用或下载成功。
- **故障注入边界**。验收仅中断 A 的当次 Worker 执行，按 Run 和执行代定位，在写入落盘后、回执持久化前触发。禁止通过宿主 kill 或停止、重启共享容器注入故障。独立确认 A 的 Worker 退出和回执缺失，核对 B 在原 Worker 上完成、C 按队列推进。
- **中断后的等待预算**。脚手架在中断操作返回后用 10 秒独立核对 A 当次 Worker 的退出，再用 30 秒等待原 Run 进入待核对。单次退出取证和 Run 状态查询各限 2 秒。B/C 正常执行仍各用 120 秒状态等待。短预算尚未经过独占实栈校准。
- **2026-11-25 本地启动受阻**。候选 runner 路径检查 3/3 通过。执行 `--prepare` 时，专用 WEB-A10 环境目录不存在，runner 在读取租约前返回 ENOENT。本地 Docker context 未列出运行中的 Compose 项目，实栈冒烟和故障场景均未启动。

## WEB-A10 2026-11-26 正式验收

- **候选与入口**。批准的源码 tree 为 `a590b5fe1a09b9ab57fb900d724bf34b1b8928fc`，归档 SHA-256 为 `e49eb53a7a8eb5ed10ad4fa8ebb5c7a98507b7c09cf79f3b0f6ce75d4ba5de30`。Runner 核验冻结源码及 60 项输入，`--prepare` 和 `--verify` 均退出 0。Web 和 Go 控制器从冻结源码构建。模型响应由验收脚本提供，OIDC、MinIO、Go/Temporal、OpenShell SDK、沙盒及 Chromium 为实栈。正式 runner 调用候选的私有 Chromium 矩阵，覆盖以实际断言为准。
- **WEB-06-06**。A 与 B 先占两个不同 Worker。C 在真实账本中排队且无执行授权，随后交付。按 A 的 Run、执行代和沙盒定位写操作，落盘回读后暂扣 SDK 回执，目标 Worker 自行退出。独立 launcher 与账本确认原代退出、执行回执为零、SDK 操作结果未知。恢复后同卷标记只出现一次，旧代 SDK 写入返回 gRPC 16 且相应文件未出现。B 在原 Worker 完成，B/C 分别从浏览器下载对应补丁。
- **WEB-06-07**。可信侧收到待核对通知。待核对时 A 的原 Run 补丁返回 409；凭原代 SDK 操作和独立快照摘要确认后，原页面下载对应补丁。后续 Run 包含两轮累计改动，原 Run 补丁保持原字节，提交同键重投复用同一 Run。
- **WEB-06-08**。可信失败后，未知副作用场景的重试按钮缺席，直接请求返回 409。无副作用取消场景经可信确认后，Chromium 安全重试返回 202，工作区及 Session 恢复证据匹配，替代 Run 成功。
- **WEB-06-09**。确认旧执行停止后作无法确认结案，原补丁仍返回 409。同账号可独立发起任务，项目删除完成。另一个结案任务经 OIDC 重认证注销后，会话返回 401，执行卷已回收，结案审计仍可读。
- **收尾**。Runner 恢复了原 Web 上游，独占服务预检再次通过。注销前已核对双检查点恢复；注销后重试记录随任务清理，验收输出与结案审计保留。

## WEB-A10 2026-11-26 补充验收

- **WEB-06-08**。复用已批准源码、Web 镜像和 Go 控制器，以独立 Chromium 探针重跑三账号矩阵。可信侧确认失败后，原 Run 页面可见完整文案“可信核对确认执行失败。”。未知副作用场景仍拒绝重试，安全场景恢复工作区与 Session 后，替代 Run 成功。
- **WEB-06-09**。原页面显示“该任务已结案，执行结果无法确认。历史交付仍可查看。”，后续要求输入框和“发送要求”按钮均禁用。同一登录会话带新幂等键向原任务提交续做，返回 HTTP 409 和 `task_not_ready`。请求前后 API 均只列出原 Run，SQLite 独立计数为 1。原 Run 补丁仍返回 409，同账号独立新建、项目删除、OIDC 重认证注销、执行卷回收和结案审计保留均通过。
- **收尾**。补充探针退出 0，原 Web 上游已恢复，独占环境预检再次通过。具体运行日志和结果文件见本地 `ENVIRONMENTS.md`。
