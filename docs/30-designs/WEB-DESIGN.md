# Bento Web 系统设计

## 目的与范围

按 [Web 产品需求](../10-requirements/WEB-REQUIREMENTS.md) 将受邀登录、私有空间、执行输入与任务交付串成浏览器流程。HTTP 请求和响应见 [Web 接口契约](../20-interfaces/WEB-INTERFACE.md)。本文区分现有实现和后续实现路径。

个人端已接入空白 Task 和文件快照 Task，复用 Run 准入、公平派发和接管机制。WEB-A10 的验证范围为单执行宿主双槽，其他场景及部署边界见 [Readiness](../40-readiness/CURRENT-READINESS.md)。

## Web 组件树

路由由 `apps/workspace/workspace-web/src/main.tsx` 注册。Task 与执行项目 Run 各有详情入口。

```text
个人端 Web
├── 认证入口 /auth
│   ├── Keycloak 登录与邀请注册
│   └── 账号操作：退出、重新认证与注销
├── 密码开发入口 /login、/register
└── 工作台 Workbench
    ├── 导航与账号栏
    │   ├── 对话、任务、Workspace
    │   └── 当前账号、账号设置与退出
    ├── 对话首页 Dashboard /
    │   ├── TaskComposer：创建空白任务
    │   └── 执行项目入口：就绪项目选择、提交确认及最近 Run
    ├── 任务列表 TaskList /runs
    │   ├── 按 Task 名称或 ID 搜索，进入 Task 详情
    │   └── 按执行项目、状态和关键词筛选 Run，进入原 Run 详情
    ├── 项目入口 Workspace /workspaces、/workspaces/:workspaceId
    │   ├── 云端空间 SpaceList：存储用量、空间项目列表、创建项目
    │   ├── 执行项目：就绪状态、选中项目的任务历史
    │   └── 文本项目导入
    ├── 空间项目 CloudProject /space/:spaceId
    │   ├── 上传表单：文件拖放、文件及文件夹选择、清单确认、上传或续传
    │   ├── 文件与执行范围：路径、文本预览、下载、单文件删除、上传状态、取消上传
    │   ├── 从所选文件新建 Task，或准备执行项目并在对话中使用
    │   └── 文件树与项目删除确认
    ├── 任务详情 TaskDetails /tasks/:taskId
    │   ├── 冻结输入、环境版本、准备状态与按序恢复的任务事件
    │   ├── 后续要求、取消、安全重试、待核对和结案状态
    │   └── TaskRunResult：按 Run 查看检查、增量变更和累计补丁
    ├── 执行项目 RunDetails /runs/:runId?project=<projectId>
    │   ├── 任务记录：原始要求、状态、结果摘要
    │   ├── 文件变更 RunResult / DiffPreview：单轮文件列表、逐文件和完整补丁预览、下载 diff
    │   └── 排队取消、受支持 Worker 的运行取消与状态回读
    └── 账号设置 AccountSettings /account [密码开发模式]
        └── 环境列表、配置、验证与版本
```

## 组件功能说明

| 组件                 | 显示内容和交互                                                                                                                                               | 数据与状态边界                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 认证入口与工作台外壳 | 展示登录、受邀注册和账号操作。工作台保留导航，受保护页面按有效会话加载。                                                                                     | Keycloak 负责受邀身份。密码开发模式使用独立路由。会话失效时先重新认证，再按当前账号检查原资源归属。                                          |
| 任务输入与最近任务   | 从首页创建空白 Task。从就绪执行项目提交时选择项目和任务要求，最近 Run 可进入原详情。                                                                         | 发送中阻止重复提交。响应不明时保留原项目、要求和提交键，由「确认上次提交」查询或重试同一请求。                                               |
| 任务列表             | 按名称或 ID 搜索 Task。执行项目 Run 可按状态筛选，按 ID 或摘要搜索，并按更新时间降序显示。                                                                   | 按当前账号及选中的项目查询，读取失败可在原页重读。                                                                                           |
| 云端空间与空间项目   | 汇总已保存字节、预占和上限。项目内选择文件或文件夹，展示上传进度、文件路径、取消和下载。目标界面将上传记录和已保存文件分开，提供文件树、预览和删除影响说明。 | 空间 ID 与执行项目 ID 分开。可执行输入只来自已保存文件。清理中的上传保留额度，待存储确认后释放。                                             |
| 执行范围             | 选择已保存文件，展示校验和导入状态。当前就绪后提供「在对话中使用」。失败时列出文件级问题。                                                                   | 空间项目记录输入来源，执行项目持有 Workspace。初始化重试沿用原键。完整产品的独立任务 Workspace 见[文件读取与执行输入](#文件读取与执行输入)。 |
| 任务记录与执行控制   | Task 详情展示要求、执行事件、状态、续做、取消和安全重试。待核对和结案时显示脱敏结论。                                                                        | 活跃任务轮询服务端，断线保留最后确认的记录。取消动作依赖当前 Run 查询成功、空闲且在线。Task 事件按序号续读。                                 |
| 文件变更与交付       | Task 按 Run 查看检查、增量变更和累计补丁。执行项目 Run 可按文件审阅单轮变更。                                                                                | 详情确认成功后读取同一 Run 的补丁。补丁可用后提供预览和下载，空 diff 显示无变更。                                                            |

页面状态以服务端回读为准。组件分别处理初次加载、无数据、请求失败和可重试状态。下载和删除等动作按资源状态显示。跨页面返回时使用原项目或 Run 链接。

## 用户操作说明

### 从执行项目提交 Run

1. 打开工作台并登录。受邀部署经 Keycloak 组织邀请完成注册和验证。已登录用户从导航进入 **Workspace**。
2. 在 **云端空间** 创建或选择项目。打开项目，在 **上传文件** 选择文件或文件夹，点击 **上传或续传**。中断后回到原项目，重新选择同一文件并继续。对无需继续的未完成记录点击 **取消上传**，等清理完成后额度回收。
3. 在 **文件与执行范围** 勾选已保存的输入，点击 **准备执行文件**。校验失败时按文件提示修正选择。显示就绪后点击 **在对话中使用**，打开带预选执行项目的对话首页。
4. 填写 **任务要求**，点击 **发送任务**。成功后进入原任务详情。提交响应不明时点击 **确认上次提交**。页面关闭后可从最近任务、执行项目历史或原链接找回任务。
5. 在 **任务详情** 查看状态与摘要。任务成功且补丁可用时，在 **文件变更** 选择文件查看对应补丁块，或点 **完整补丁** 回到原文。点 **下载 diff** 获取当前 Run 的完整补丁。待核对时保留原页面入口，可信侧确认结果后再读取补丁。

### 发起 Task、继续对话并交付

1. 在对话首页创建空白任务，或在空间项目勾选文件并点击**从所选文件新建任务**。任务准备就绪后，在详情提交要求。
2. 任务详情显示冻结的输入、平台环境版本、准备状态和执行进度。准备失败时显示原因和下一步。
3. 任务结束后，在任务详情追加要求可继续原会话，并生成新的 Run。要停止活跃任务时点击 **取消**，等待最终状态。确认失败或取消且符合重试条件时，可从原记录显式重试。
4. 选择 Run，查看结论、变更和检查结果，有文件变更时下载该版本的累计补丁。

### 管理文件和账号

- **当前**。在空间项目中打开已保存文件的文本预览或下载原件。单文件删除先确认路径与影响，清理完成后更新列表和额度。在账号入口退出，或按当前登录方式重新认证并注销。注销后由后台推进资源清理。
- 删除项目时先查看影响，再确认提交。存在未完成上传、正在初始化或受保护的活跃任务时，页面显示阻塞原因。

## 个人端认证与账号

### Purpose And Scope

对应 [WEB-01](../10-requirements/WEB-REQUIREMENTS.md#web-01-账号和访问控制)。Keycloak 是受邀认证部署的身份服务。Bento 保留业务账号、项目与 Run 归属，以及注销清理状态。

### Responsibilities And Dependencies

当前接线如下。

- NGINX 将 `/auth`、`/auth/*` 和 `/api/*` 代理到 Go Workspace API，其余页面走工作区 SPA。认证页由 Go API 提供。
- Keycloak 托管邀请、注册、邮箱验证、密码、身份会话与认证审计。Bento 仅处理 OIDC 回调，使用授权码、S256 PKCE、state、nonce 和签名校验。回调检查已验证邮箱及配置的组织 alias。
- Go Workspace API 直接访问 MySQL 8.4。现有密码开发模式保留原有入口。Keycloak 部署使用 OIDC 入口。

### State And Failure Handling

- `web_accounts` 以 `owner_id` 为主键，OIDC 账号由 `(oidc_issuer, oidc_subject)` 唯一约束。Go 分配不透明 `owner_id`，并发重复插入后读回同一绑定。OIDC 账号无需本地密码或邀请码摘要。邮箱作为会话展示值。
- OIDC 事务在 Go API 内存中保存五分钟，成功回调前单次领取。Bento 会话和 Keycloak 会话各自独立。Bento Cookie 固定有效期 24 小时，使用 HttpOnly、SameSite=Lax，HTTPS 下加 Secure。Go API 重启后重新登录，MySQL 的绑定与关闭状态保留。
- 每次受保护请求重查本地账号状态。无法完成验证或读取账号时拒绝访问。业务注销要求原会话及同一身份重新认证，MySQL 原子写入关闭和待清理状态，既有清理流程按 `ownerId` 重试。Keycloak 身份保留。

### Security And Observability

生产使用 HTTPS，开发环境的环回 HTTP 通过 SSH 隧道访问远端 IdP。认证事件由 Keycloak 保存与查询。Bento NGINX 访问日志使用 URI 路径，省略回调查询参数。凭据和远端地址保存在部署环境中。

### Acceptance

本机 Docker 和远程 Keycloak 的浏览器验证见 [需求完成状况](../40-readiness/CURRENT-READINESS.md)。部署配置见 [部署配置](../../deploy/README.md#准备配置)。

## 工作区初始化

Task 初始化使用独占 Session、sandbox 和 volume。空白输入使用空快照。文件入口先在空间 SQLite 持久化来源意图并 pin 已选文件，校验 UTF-8、路径、额度和字节后冻结副本。Orchestrator 按原创建 receipt 准备工作区，核对回读摘要后释放 pin。准备失败可在原地址使用原文件和环境版本重准备。

从已保存文件初始化工作区的接口、重试和来源清单见[文件存储设计](#项目文件与存储)。

## 提交与交付

Task 使用稳定详情地址，按事件 sequence 恢复历史和持续读取。同一 Task 中每次后续要求原子写入用户事件和独立 Run；结果版本分别绑定该轮执行前及 Task 初始两份基线。Task 的完整接口见 [Task 生命周期](../20-interfaces/WEB-INTERFACE.md#task-生命周期)。

- 执行项目入口先展示项目、已选输入和任务要求。该入口使用执行项目 Run 接口。浏览器仅按账号和执行项目保存待确认提交键及描述摘要。服务端以同一键返回同一个 Run。
- 执行项目 Run 被接受后跳转稳定详情地址。工作台「任务」可按账号下的项目找到原 Run。详情轮询活跃任务，重连或在原页主动重读时从服务端更新同一 Run。临时失败保留已确认的记录。读取进行中、失败或离线时暂停取消及补丁交付。资源不存在或越权时隐藏历史，登录失效后重新验证会话。待核对显示「上一次操作结果未确认」，可信侧确认成功后再读取成果。
- 执行项目 Run 的 diff 相对该 Run 的执行前基线。首次执行前基线来自初始化文件。后续 Run 的基线来自执行前 Workspace。预览与下载使用同一 Run 的 diff 接口和字节。补丁尚未发布或临时读取失败时可在原页重读，成功后开放预览和下载。默认展示完整补丁，可按文件切换。无法完整识别的补丁显示原文和说明。零字节显示无变更。
- Task 的待核对、成功确认、失败确认和无法确认结案由执行服务持久化。浏览器读取原 Run 状态和结果。待核对和结案 Run 的补丁请求返回 409。结案关闭原 Task 的续做，保留历史交付和审计。可信侧核对、重放与 Worker 操作留在私有边界。验收见 [WEB-A10](../40-readiness/evidence/WEB-06.md#web-a10-2026-11-26-正式验收)。

## 执行环境与任务交互

### Task 生命周期

- Orchestrator 在 `Store` 持有 Task、Run、事件、结果、Workspace 检查点、停止证据与重试 receipt。Task 的内部执行项目 ID 固定等于 Task ID。每 Task 一条 backing `projects` 记录，独占其 session/sandbox/volume，复用已有调度查询与 binding。旧项目入口对 backing project 过滤并返回 404，防止绕过 Task 写门禁。个人端只持有空间来源意图、文件 pin、空间删除及账号清理协调记录。SessionHistory 管理 DSH 的检查点、写围栏和 restore receipt。
- ID 为服务端 UUID v4，时间为 UTC ISO-8601。空白 Task ID 由 Orchestrator 分配，快照 Task ID 由个人端来源意图分配，Run ID 和 retry attempt ID 由 Orchestrator 生成，空间来源 ID 沿用现有 `resourceId`。客户端只提供幂等键。Run 状态沿用 `RunStatus`。活动集合为 pending_approval、queued、running、recovering、cancelling、needs_review，以及待恢复 retry receipt。分配按 Task 从 1 递增的 Run 序号。Run 的 authority generation 来自现有 `inspect/admit`。排队重试可记录预期新代，使用前再比对 authority。
- Task 行持有 `id,owner,name,sourceSpaceId,inputDigest,environmentVersion,createdAt,updatedAt,prepareError,closedReason`。closedReason 为 null 或 unconfirmed。`sourceSpaceId` 和 `prepareError` 可空。状态由 backing project 的 importing/ready/failed 映射 preparing/ready/failed，逻辑删除门禁映射 deleting。最终清除后读 404。初始内容存 backing project 的冻结文本。输入摘要沿用 `textSnapshot → snapshotSha256`。新增 manifest 为 `{fileId:string,path:string,bytes:number,sha256:string}[]`，按 fileId 排序，逐项与文本 UTF-8 字节校验。空白使用空数组。恢复和 diff 始终读取冻结文本。
- 创建 receipt 按 `(owner,key)` 唯一。Run 的 continue/retry 共用 `(taskId,key)`，两类 hash 用操作名区分。canonical JSON 一律用 UTF-8 `JSON.stringify` 和下面列出的字段顺序，无末尾换行。创建外部 hash 为 `{name,source}`，其中 snapshot source 的字段顺序为 kind/spaceId/fileIds，fileIds 排序。内部创建 hash 为 `{name,sourceSpaceId,inputManifest,inputDigest}`，由 Orchestrator 重算。Run hash 分别用 `{op:"continue",prompt}` 与 `{op:"retry",sourceRunId}`。相同键同 hash 回原资源，异 hash 409。每次新用户要求在 Run 入队的同一事务写事件，eventId 为 `${runId}:user`。retry 复制原 prompt，追加类型为 step 的重试事件，eventId 为 `${runId}:retry`。公开 payload 不带 key/hash/receipt。
- Web 的 `api.ts::taskMutation` 在 sessionStorage 按账号、动作、Task/来源 scope 和规范正文摘要保留请求键。网络或 5xx 结果未知时复用原键，成功及明确 4xx 清除。`pages/tasks/details/index.tsx::TaskDetailsContent` 另以组件状态保留未知提交的原 prompt，暂停编辑和新要求，提供“重试提交”；无论原 Run 活跃或已完成，按钮都只重投该正文并找回原 Run。响应成功或明确 4xx 后清除临时入口，5xx 保留。其他新键继续受活跃 Run/attempt 门禁约束，页面提示等待或取消。组件临时正文不承诺跨刷新或跨设备保留；同 tab sessionStorage 未知键保留，已受理记录可按原账号重新打开。
- Event sequence 是 Task 级从 1 开始的严格递增整数，`UNIQUE(taskId,eventId)`。相同 eventId 的 replay 须在分配 sequence 前处理。投影结束的 `(runId,generation)` 标记也由 Store 在同一事务落账。同 ID 内容不同报内部证据冲突。结果 `version=1`，唯一键为 runId，结果、事件和基线只有项目删除或账号 purge 时物理清理。成功状态和冻结结果在同一 Store 事务写入。增量和累计复用 `unifiedDiff`，两者使用同一个结果快照。发布记录包含版本、两个 baseline digest、after digest、两份 diff UTF-8 字节、各自 SHA-256、摘要、checks 及时间。重放比较所有内容，沿用首次记录的时间。

#### 停止与双检查点

- Run 取得调度预留后、`db.start` 与 Worker admit 前，持久化 Workspace 完整文本和摘要，以及 `SessionHistory.checkpoint` 的 receipt。以 runId 为不可变键，重放复用该快照，现场摘要不一致时进待核对。尚无 DSH 历史时 checkpoint 是明确的 absent。其余存当前 header JSON、inherited、next、顺序 events、epoch 与 SHA-256，要求无 handle、batch intent，owner 和 epoch 由 T3 的条件验证。History 与 Store 各自事务，均落账后才能执行。
- 使用 `SingleHostExecution.takeover` 的旧代撤权及 stop observation。该调用随后重新启动沙盒。新代 READY 只说明当前授权状态，不能证明当前卷无写入者。可信 launcher callback 持久 `worker_exit(runId,generation,at)`。worker 返回、abort、超时本身不构成 exit。现有 SDK 分支无法仅凭 operations 表证明工具副作用已知。Task 的可信 adapter 只有显式提供 `ExecutionHost.taskRecovery` 时才可提供 `retryObservation(binding,runId,generation):Promise<{unknownOperations:number,workspaceOnly:boolean}>`，证明旧代没有 UNKNOWN 且所有影响限于可恢复 Workspace。仅凭空 operations 表、文件差异、Worker 自报或进程终止时保持 needs_review。非 SDK 同样需要此观察。本轮仅启用确定性 local fixture 的恢复能力。基线 `command-host.ts::commandHost` 的非预热分支使用 `worker.ts::processWorker`，该函数只接收 request 和 signal。其 Promise settle 或子进程 close 不提供旧代全部进程退出的证明。预热 Worker 的现有可取消能力也不能证明新代卷的独占性。命令宿主、本轮无已验证恢复能力的生产模块均不开放 Task retry。对于执行过的 Run，缺此能力返回 409 run_not_retryable，reason 为 stop_unconfirmed。排队取消从未 admission 时保持原路径，不创建 stop proof。
- 新增可选 ExecutionHost.observeWorkerExit(binding,runId,generation):Promise<WorkerExitObservation|null>。WorkerExitObservation 固定为 {sessionId,runId,generation,bindingDigest,exitedAt}，只来自可信 launcher 的持久进程监督记录。服务 worker 执行派发前持久 runId/generation/bindingDigest 对应的 admission 记录。已有 supportsRunningCancellation 的 host 继续使用回调；local fixture 同时设置该能力。回调关闭后由服务写 worker_exit，按 runId/generation 唯一，先核对 admission 和 binding。admission 使用既有 runs 新增 nullable admittedGeneration/admittedBindingDigest，恢复 worker 不覆盖 execute admission，重复值不覆盖。重启只先从 Store 读取该 receipt；没有回调记录时由 stopAndProve/closeTaskRun 查询 observeWorkerExit，核对全部字段和旧代身份后持久采用。仅已知执行代才可查询，timeout、abort、worker Promise settle、takeover 后的 READY 皆无证据效力。普通 commandHost 不提供 observeWorkerExit 或 taskRecovery，继续按既有保守待核对路径，重试回 409 run_not_retryable，reason 为 stop_unconfirmed；缺该证据的可信结案返回私有 review_unavailable，生产适配器需提供观察后才能结案。
- localHost 是 fixture 退出观察记录的生产者。其 worker 在完成或中止的 finally 中先等待该 attempt 发出的所有本地文件写入和持久化请求结束，再关掉活动计数、在该 binding 的私有项目目录写入 exits/<runId>.<generation>.json。以同目录临时文件写入固定字段 WorkerExitObservation、fsync 文件、rename、fsync exits 目录，然后才调用 onWorkerExit。使用绑定校验过的 Run UUID 和正整数 generation 生成文件名；若同键已有记录，逐字段核对后使用原 exitedAt。localHost.observeWorkerExit 只读该文件并验证 binding、session、run、generation，缺文件回 null，损坏或冲突拒绝。崩溃发生在文件持久后且 Store 回执前时，重启走此 API 并补写原时间；在宿主持久前崩溃时不补造证明。只有回调而无可回读记录的宿主，一旦丢失回调且 Store 无 receipt，就保留原执行代和 needs_review，返回 run_not_retryable/stop_unconfirmed，可信结案返回 review_unavailable；后续只在可信观察可用且验证通过后重读同一 Run。
- Store `stop_proofs` 以 source run ID 为键持久 canonical JSON、SHA-256。proof 是 source Run 的一次性停止证据。retry_attempts 以 sourceRunId 唯一，第二个键不得重复消费同一 proof；已入队重试再次失败时有独立 Run ID，按该 ID 取得独立 proof。固定键序 `{taskId,runId,sessionId,bindingDigest,oldGeneration,newGeneration,workerExitedAt,authorityState,authorityRun,hasCapability,unknownOperations,pendingBatches,workspaceOnly,observedAt}`。bindingDigest 为按 tenant/project/session/sandbox/volume 顺序的 JSON SHA-256。必须是同绑定、`newGeneration=oldGeneration+1`、READY、null run、无 capability、两个计数为 0、workspaceOnly=true。取消经可信观察可保留被部分修改的卷，旧 SDK 无证据则按现有逻辑进入待核对。可信确认失败沿现有 review 边界，拥有以上完整证据才开放 retry。
- `service.ts::stopAndProve` 调用链为持久 exit → `SingleHostExecution.takeover` → `inspect` → `hasUnknownOperations` → `host.retryObservation` → `SingleHostExecution.historyQuiescence` → `Store.recordStopProof`。已 READY 时回用同一旧代持久 takeover 状态。任一证据不足返回原保守分支。 `Store.readStopProof` 只读原 canonical JSON/SHA。 `task-retry-recovery.ts::verifiedStopProof` 重新反序列化、逐字段校验和 canonicalize/hash，比较 source/new run、attempt、Task、session、固定 binding 和当前新代。签发内部 branded `VerifiedStopProof` 后才调用 `SingleHostExecution.restoreHistory → SessionHistory.restore`。SessionHistory 从自己的库验证 checkpoint、epoch、无 handle/intents 以及 receipt，禁止读取 Store。brand 定义置于 `session-history.ts`，服务专用构造通过 TS 类型断言，SQLite 读取结果及 HTTP 输入不得直接断言。
- SDK Task 的停止证明另外要求 `sdk.decodeExecEvent`、独立 `observeWorkerExit` 和 `taskRecovery.observeSdkRetrySafety(binding,runId,generation):Promise<SdkRetrySafetyObservation|null>`。受信 deployment adapter 生成 `{sessionId,runId,generation,bindingDigest,exitedAt,observedAt,unknownOperations,workspaceOnly}`，所有字段必需；Worker、模型和公开 HTTP 输入不得提交该观察。adapter 依据有效独占 profile/lease、同环境 launch/witness、实际 sandbox/volume 挂载与隔离观察、独立 Worker 退出生成证据，缺失或矛盾返回 null。Orchestrator 逐字段比对 source Run、代次与固定绑定摘要（含 tenant/project/session/sandbox/volume），要求 exitedAt 等于持久 taskExit 回执、时间可解析且 exitedAt ≤ observedAt ≤ 当前服务时间、workspaceOnly 严格 true、unknownOperations 严格 0。任一能力缺失、异常或错绑定保持保守拒绝；函数或 decoder 的存在本身不授权重试。其后仍验证沙盒停止与撤权后的新代 READY、无 capability、operation UNKNOWN 为零及 History 静止，再写既有 canonical StopProof，不新增持久字段或公开 DTO。非 SDK 使用原 retryObservation 路径；普通 SDK 无独立证据继续进入待核对。
- `retry_attempts` 持久 `id,taskId,sourceRunId,newRunId,key,hash,phase,lastConfirmedPhase,oldGeneration,newGeneration,workspaceSha256,historySha256,error,createdAt,updatedAt`。与 Task 的活动判定和队列容量同事务竞争。完整 phase 及门禁见下文 blocked 重试的可信结案。preparing 先重验证证据，再调用 `host.taskRecovery.restoreTask(binding,attemptId,files,expectedSha256)`。写入卷之前，adapter 对当前 binding 持有排他的写入禁入权，并在同一 attempt 下额外停掉、观察新代沙盒及所有卷写入者均已退出。该确认独立于旧代停止证明和 READY，且在发布和哈希回读期间持续有效。adapter 在独占期内原子发布 staging、回读摘要并持久化同 attemptId 的恢复回执，然后恢复原 binding 并独立观察 mount 和 running，之后才归还独占权。STOP 或回执未知时保持 Task 写门禁并只对账原 attempt，未知停止或未证实独占时不得执行任何卷修改。回包丢失可先读现有 receipt 并独立 snapshot 对账，摘要匹配时推进同 attempt。事务间崩溃保留当前 phase。证据冲突进入 blocked，锁住写入并走人工核对。
- taskRecovery 还提供 queryRestore(binding,attemptId):Promise<null|{attemptId:string,phase:"prepared"|"published"|"ready",sha256:string}>，由相同绑定根读取 receipt，仅做观察。restoreTask 在 staging 验证通过后先持久 prepared（含 staging ID、旧 pointer、expectedSha256），再 rename 指针。queryRestore 若看到 prepared 及指向该 attempt staging 的 pointer，应验证摘要后报告 published。published 表示已发布但尚未证明新代运行及挂载；ready 表示已完成独占回读与启动观察。重启后先 query，同键 null 才首次写入；prepared 只在重新取得独占并观察停止后继续原 staging；published 禁止第二次替换，先验证原树并续作启动；ready 仅独立回读。识别到异 pointer 或 digest 不符保持门禁并 STOP。
- localHost 使用同一私有 project root 中的可信 volume pointer。新增 resolveTaskVolume(binding)，仅允许单段相对名字匹配 volume-<UUID>，拒绝绝对路径、斜杠、目标 symlink 及非目录。校验 realpath 仍为该 project root 的直接子目录，再把实际目录传给现有 readTextVolume。所有 fixture snapshot 和写入均通过该解析；在 binding 互斥区修改指针。旧项目仍直接读其 volume 目录；readTextVolume 保持拒绝 symlink 根。publish 由同目录 rename 原子完成，指针切换前的 journal 及恢复回执在返回前同步到持久目录。
- SessionHistory 的 restore 在一个事务内写恢复回执再返回。保留 batch receipts 和原 checkpoint，校验并恢复 header/inherited/event prefix，更新 next/revision，并在恢复回执中记录新 Run ID 与代数。非空 prefix 保持旧代的 revoked 状态，实际 admit 再通过持久化围栏取得新代写权。排队的重试被取消后，下一轮可继续取得该代写权。absent checkpoint 删除当前 session/events，等待 admit 后由 DSH create 初始化。相同 attemptId 重放返回原 receipt，异内容拒绝。只有独立回读 Workspace 和 DSH digest 都匹配，Store 才把同一预分配 Run 排队并清除 attempt 写门禁。TaskEvent、原 Run、旧结果保持原样。

#### 清理、可信结案与事件投影

- 私有 GET /v1/task-sources/{spaceId}/deletion 返回 200 {runCount,diffCount,blockers}。GET 与 DELETE 可带 legacyProjectId，取自 spaceExecution.deletionProject 的已确认映射。DELETE /v1/task-sources/{spaceId} 只接受 phase=hold、commit、release，要求 K。旧 DELETE /v1/projects/{projectId} 原样保留。
- Store 的 task_source_deletions 主键为 (owner,spaceId,operationId)，字段为 legacyProjectId nullable、state、denialCode nullable。hold 以一个 Store.write 事务检查该 source 的所有 Task 与可选旧执行项目。检查准备中、活动 Run/attempt、文件删除门禁、旧项目删除操作及 owner drain。阻断时按 project_importing、project_busy、owner_closed 优先级持久 denied receipt，无资源冻结。成功写 held 及每个目标的 item receipt。held/committing 同时阻止所有目标的新写和旧项目直删。held 不触发清理。
- 以下错误只用于私有 source 路径，个人端按当前 phase 消费。相同操作键但关联字段不同回 409 idempotency_conflict。hold 遇 held 回 202 {state:"held"}，committing 回 202 {state:"deleting"}，deleted 回 204，denied 回原 409，released 回 409 deletion_released。commit 只将 held 转 committing，committing 重放回 202 deleting，deleted 回 204，denied 回原 409，缺 receipt 或 released 回 409 deletion_not_held。release 将 held 转 released 并解冻，缺 receipt 建 released tombstone，released/denied 同键均回 204，committing/deleted 回 409 deletion_committed。其他键只与 held/committing/deleted 冲突。owner drain 后继续处理已有 receipt 的同键操作。
- committing 每项等待 Temporal 关闭并执行可信 sandbox/volume purge，再用同一 Store 事务清理关联业务记录并标项 cleaned。旧 binding 也使用该 item 作清理授权。所有项完成才将 receipt 标 deleted，空集合也留 receipt。晚到的 Task create 若来源已删返回 404。
- space_project_deletions 的 phase 固定为 holding/committing/releasing/cleaning/deleted，原 executionProjectId 为可空字段。holding 由 deleteProject 在 SQLite 写入，原子拦住新来源意图及文件写入。先对账已有来源请求再发 hold。hold 回 held 先持久 committing，回 deleting 同样进入 committing，回 204 进入 cleaning。hold 明确拒绝时先持久 releasing 及原错误，再发 release。release 回 204 删除本地门禁并返回原拒绝，回 deletion_committed 则改为 committing 并续作。未知响应仅重放当前动作，commit 未知禁止 release。只有明确取得 commit 204 才物理回收文件。接受迟到 hold 的 204 视为同一 commit 已完成。
- 账号关闭用原 account sweep 和 POST /v1/account/purge。新增私有 POST /v1/account/drain，无正文，回 204，认证规则同 purge，仅持久 Store.drainOwner。sweepAccounts 先标空间 owner drain，再等 API inFlight 收敛，调用 drain 得 204。随后等待 space.drain(owner) 的已有本地 phase 与来源 receipt 全部收敛，再调用原 purge。该分离避免来源 receipt 等待远端关写而 purge 又等待 space.drain 的死锁。尚未送达的冻结意图可标 abandoned，结果未知的先以私有 GET /v1/tasks?creationKey=<K> 查询同 owner receipt，回 200 {items:TaskDTO[]}，至多一项。查不到时只在 owner drain 后原键重放确认拒绝；明确拒绝后释放 pin。task-sources 私有门禁和 account/drain 都由 execution-service-http.ts 的现有 Bearer 与 owner header 映射转发，后者的 Operation kind 固定为 drainOwner。Orchestrator drain 持久关闭新业务写，等待 held/committing 操作收敛和全部 Run 终态、调度关闭。needs_review 阻止 purge，项目删除和账号注销均不代结案。
- 可信结案沿用私有 review module，给 start.ts 的 InstallReview 依次传入原 reviewRun、新 closeTaskRun 和 readTaskClosure。closeTaskRun(input:{runId:string,decision:"failed"|"unconfirmed",expectedGeneration:number}):Promise<void> 只接受 Task needs_review。服务以独立可信退出证明、旧代沙盒停止、新代 READY/无能力、binding 和 session 静止为前置。输入决议本身无证据效力。failed 在缺完整 retry proof 时也可进入终态，retryReason 固定 stop_unconfirmed 或 checkpoint_unavailable，不能续写原工作区。unconfirmed 进入 failed 终态，Task 持久 closedReason=unconfirmed，禁再次执行，旧成功结果继续可读。两类终态均允许删除及注销。原 reviewRun 成功路径对 Task 同时保存 review receipt 和两类结果。
- Store 以独立的 task_closure_audit(runId PRIMARY KEY,decision,authorityGeneration,stopDigest,closedAt) 保存最小审计。它没有到业务表的外键，stopDigest 为固定顺序 {exitReceiptDigest,bindingDigest,oldGeneration,newGeneration} 的 JSON SHA-256。决议、审计和终态同一事务，原决议重放成功，异决议拒绝。仅受信 readTaskClosure(runId:string):TaskClosureAudit|null 可读。项目和账号 purge 删除业务关联数据，保留此表。表中没有 owner、prompt、文件、输出和凭据，随部署的持久审计保留规则处理。
- Worker 仍使用受信 Binding、Grant 和 persistence 协议。Task identity 使用 `binding.project`，服务只对有 Task 行的绑定附 `WorkerRequest.publicEventsUrl?: string`。Worker 不调用 checkpoint、restore 或停止接口。现有 `runDshWorker` 已区分首轮 create 与后续 resume，沿用其会话入口。新增 Runtime 的 `publicEvents?(events:readonly Event[]):readonly PublicWorkerEvent[]` 作为固定 DSH bootstrap 的脱敏投影边界。SDK host 若未配此回调，Task execute 在发送 prompt 前返回 review，保留待核对，旧项目仍按原流程。fixture 使用同一 ingress。
- `PublicWorkerEvent` 判别联合为 `{offset:number,kind:"agent_reply"|"step"|"command",text:string}` 或 `{offset:number,kind:"check",name:string,status:CheckStatus,output:string|null}`。offset 为本轮 DSH 事件数组的零基索引，每 offset 最多一个公开事件，递增。固定上限每批 100 项、单批 256 KiB、每 text/output 4096 UTF-8 字节、name 120 字节。在 flush 后、返回完成前，以 Worker Bearer POST `/task-events`，正文 `{items}`。捕获已观察的投影前缀，失败/取消时仅保留成功送达的 prefix。Orchestrator 校验活跃 execute grant、run 与 binding，再以 `${runId}:${generation}:${offset}` 写入 Store，重复载荷 200，冲突或旧代拒绝。无可验证投影回执禁止发布成功。部署 bootstrap 负责从公开用户可见字段投影，命令只公开脱敏名称，check output 仅可信可公开摘要；原始参数、工具 JSON、环境/密钥字段不进入载荷。测试以金丝雀凭据验证最终 HTTP 和 diff 无该值，生产密钥隔离仍需真实环境证据。

#### 源文件引用与活跃门禁

- 空间 pin 仅保护冻结和准备。READY 校验通过后释放 pin；Orchestrator 继续保留 `task_input_refs(taskId,fileId)`，主键为两字段，随 Task 创建事务从 manifest 写入，随 Task 清理删除。Space 的 space_task_inputs 同样长期保留 taskId/fileId，readPinned 为 0/1，READY 时从 1 改为 0，项目/账号清理时才删引用行。文件 ID 仍留在冻结 manifest，源文件的终态删除不改冻结副本。
- 新私有 `POST /v1/task-sources/{spaceId}/files/{fileId}/deletion-holds/{operationId}` 取 hold，`DELETE` 释放，同源路由只由 Space 调用，认证使用 Bearer + 可信 owner header。两者都无正文，不再额外需要 K。可选 `legacyProjectId=<id>` 仅来自 Space 的既有已验证文件关联。二者均回 `200 {state:"held"|"denied"|"released"}`，scope 或关联不符为 404，原键更改 legacyProjectId 为 409 idempotency_conflict。
- Store `task_input_delete_holds(owner,spaceId,fileId,operationId,legacyProjectId,state)` 的主键为前四字段，legacyProjectId 可空，state 为 held/denied/released。acquireTaskInputDeleteHold 的 Store.write 先回读同 owner/source/file/key receipt，关联字段变化报 409 idempotency_conflict。新取时总按 (owner,spaceId) 检查 source deletion，无需 legacyProjectId。source 为 held/committing 时记 denied 并回 200 denied，已 deleted 时回 404 not_found；owner 已 drain 时回 409 owner_closed。再校验请求给出的旧项目 owner 及原项目门禁，并检查引用该文件的 Task 是否 preparing、有活跃 Run 或持门禁的 retry attempt。任一引用繁忙则持久 denied，否则持久 held。项目取门禁也在同一 Store.write 检查该 source 的 held 文件门禁，故两个动作按同账本事务提交顺序线性化。
- Space 在保存 checking 前于空间 SQLite 验证 owner/space/file、saved 状态和 pin。受信调用经此验证，Orchestrator 以 header owner 限定查询；零 Task 引用且无 legacyProjectId 是有效空集合，走同一 source/owner 检查并在无阻断时持久 held。held 期间引用该文件的 Task 新 Run、retry 和重准备，以及关联旧项目写入均拒绝 project_busy。不相关文件无影响。同键重放已有 held/denied/released 在 owner drain 后照常回原状态。release 先回读同键，held 转 released，denied/released 回 released；缺记录写 released tombstone（source 已删回 404），迟到的 acquire 不能复活。release 允许已 drain 的 owner 收敛原操作。
- `apps/workspace/workspace-api/src/space_file_deletion.go` 中的 SQLite 事务先检查 pin，再保存原 `space_file_deletions` receipt 为 checking，即使无旧执行项目也发新 hold。快照创建只接受没有删除 receipt 的已保存文件。若已有 pin，则拒绝删除，不派发 hold。若已有 checking，则拒绝新来源 pin。先入队时，hold 被拒绝并保留原文件；先取 hold 时，入队拒绝。活跃引用门禁由持久 Run/attempt 状态派生，终态原子解除，无内存计数。Space 在 held 后进入 deleting，确认对象已删除才进入 releasing，原键 release 确认后持久 deleted。任一回包未知按同一 receipt 和 phase 续作；未确认取 hold 前不得删对象。denied 后回收 checking intent 并返回 project_busy。新取明确收到 owner_closed 或 not_found 时也回收 checking intent 并转发对应错误，保留对象且不发送 release；未知结果继续原键查询。终态后删源文件，不影响未来从已冻副本续聊。

#### blocked 重试的可信结案

- 重试 receipt 的 phase 只能为 preparing、workspace_restored、history_restored、blocked、queued、closed。持久 `lastConfirmedPhase`，只允许 preparing、workspace_restored、history_restored，初始 preparing。每次确认恢复阶段时原子更新 phase 和 lastConfirmedPhase；进入 blocked、queued 或 closed 时保留最后已确认阶段。在 blocked 的可信对账补齐证据并入队时，这一事务同时将 lastConfirmedPhase 推进至 history_restored。
- preparing、workspace_restored、history_restored、blocked 持有一份队列预留、Task 写门禁以及文件/项目删除和 owner purge 门禁。finalize 将 attempt 变为 queued、插入原预分配 Run、转移队列预留和门禁至新 Run，在同一 Store.write 内完成。queued receipt 自身不占额度、不持门禁，后续以新 Run 状态判断，Run 终态后不再阻塞删除或 purge。可信结案将 blocked 变为 closed、释放所有 attempt 预留和清理门禁、关闭 Task 后续写入，在一个事务完成。queued/closed 的同键同 hash 读回原 receipt，异 hash 返回 409。receipt 与业务记录同生命周期，独立审计由原保留规则处理。后台重启只扫描 preparing、workspace_restored、history_restored 并验证原阶段证据，blocked 仅供可信侧对账或结案；queued/closed 不进入恢复扫描。
- `blocked` 是预分配重试的待核对态。尝试保留 lastConfirmedPhase 和原阶段证据、Task 写锁和队列预留；原 Run 的终态、旧结果和断点保持。公开同键 retry receipt 读回 blocked，新增 `TaskDTO.reconciliation` 为 null 或 `{attemptId,state:"blocked",reason:"restore_conflict"}`，可见原因固定，不暴露证据原文。不同提交键的写入回 task_busy。后台不重发恢复、不排队、不释放资源。项目删除和账号 purge 继续等待。
- 可信模块新增第四个安装参数位置 `closeTaskRetry({attemptId,expectedGeneration}):Promise<void>`，仅对 blocked 执行“结果无法确认”结案。服务在保持 attempt 写门禁时核对原持久退出回执和绑定、authority READY 且无 Run/capability，SessionHistory 无打开 handle 或未结批次，并调用可信 host 的 `observeRetryCleanup(binding,attemptId,generation)`。该可选方法返回 null 或 `{attemptId,generation,bindingDigest,restoreIdle:true,volumeWriters:0,sandboxStopped:true,observedAt}`。该证据必须来自当前绑定的独占停止观察，确认旧/新执行写入和 restore 均不再进行。local fixture 使用同一恢复互斥，在排除 in-flight 恢复后 stop + stopped 回读并维持 Task 门禁；普通 command host 不实现。缺证据返回 review_unavailable，保持 blocked。UNKNOWN 不再执行、不标确认成功，可在前述清理安全事实齐备时人工结案。
- 同一可信模块的第六个参数 `reconcileTaskRetry({attemptId,expectedGeneration}):Promise<"pending"|"queued">` 只观察 blocked 的既有证据。一律先读取原 StopProof、queryRestore、通过 restoredHistoryDigest(proof) 校验 History 的原 restore receipt 和当前摘要，核对原 attemptId、Workspace ready receipt、Workspace 与历史各自摘要、当前 authority generation 和同一 binding，并独立回读 volume SHA。History 接口缺原同 attempt receipt 或摘要不符时返回 pending。只在两次恢复均已完整落盘、绑定已就绪且无 UNKNOWN 时，使用原 attempt/预分配 Run ID 原子完成 finalize；重复请求返回原 queued。任一项缺失或未知返回 pending，继续保留 blocked，不发新的 restore、stop 或用户操作。与 closeTaskRetry 对同一 attempt 互斥，Store 终态条件写防止二者同时成功。
- Store `task_retry_closure_audit(attemptId PRIMARY KEY,authorityGeneration,evidenceDigest,closedAt)` 无业务外键。evidenceDigest 为按字段序 {exitReceiptDigest,bindingDigest,authorityGeneration,cleanupObservation} 序列化后的 SHA-256。确认后 `Store.closeBlockedTaskRetry` 在一事务内比对 attempt/authority generation、插入审计、phase=closed、Task.closedReason=unconfirmed、释放队列预留和删除门禁。closed 终态无新 Run，重放返回原 closed receipt。Task 继续可读旧结果，禁止新执行；项目删除和 purge 可按原 receipt 继续。受信读回使用第五参数 `readTaskRetryClosure(attemptId):TaskRetryClosureAudit|null`；项目与账号 purge 均保留最小审计。相同 generation 的结案可重复确认，异代拒绝。拒绝结案只保留 blocked 和原未知证据，不写闭合审计或释放门禁。

### 现有项目入口

以下对应 WEB-05～08。排队取消及支持停止观察的运行取消已有实现。沙盒准备、续聊、安全重试、完整运维结案及累计交付仍是目标。

- 执行行为沿用个人版 DSH CLI。会话工作目录作为命令和文件工具的工作目录，命令从执行环境的 PATH 查找，项目依赖通过工作区内的依赖清单和命令准备。个人版的本地子进程、文件和沙盒服务由 Bento Worker 绑定到受信控制面分配的 OpenShell 沙盒。工具使用沙盒内的工作目录和进程环境，平台凭据留在可信侧。
- 平台运行环境由部署配置提供，以不可变的镜像和策略版本标识。个人端 API 校验输入权限并固定输入快照，Orchestrator 在受理时固定平台环境版本，并按冻结清单准备任务的独立 Workspace 和沙盒绑定。空白任务使用空输入清单。已受理任务在原地址保留脱敏后的准备失败原因。同一冻结清单可重新准备，清单变化时经用户确认创建新任务。
- 任务详情读取持久消息和执行事件，以事件序号续读。已结束且可继续的任务使用相同 Session 和 Workspace 提交后续 Run。客户端重试原提交键，服务端返回已接受的 Run。每个 Run 保存独立结果及其执行前基线。
- 客户端将 `pending_approval` 显示为「待审批」，并允许所有者取消。待审批 Run 的额度、派发与审批见 [Task Run 审批设计](APPLICATION-BOUNDARIES-DESIGN.md#task-run-审批)。
- 取消请求交给 Orchestrator。排队取消与 `Store.start` 竞争同一条 queued 状态，已有 Temporal 预留时仍可取消。取消成功保留原 Run 和预留历史，迟到 Activity 读回终态后返回。运行取消先写持久意图，保留原槽位。只有确认旧代撤权、沙盒停止和该 Worker 退出后才写终态并释放槽位。内置预热宿主用对应 Worker 子进程的 close 提供退出证据，普通 Promise 完成不算。已发 grant 且缺退出观察能力时拒绝请求。重启后缺持久退出证明时继续显示取消中并保留槽位。
- 用户从原详情回读权威状态。停妥后若有 UNKNOWN、基线差异、SDK 调用无法排除或可信证据不可读，进入待核对，保留原记录并阻止同项目新写入，不提供 diff。其余确认已停且无未确认副作用的运行显示已取消。
- Orchestrator 在执行前保存可恢复的 Workspace 和会话检查点。安全重试先确认旧代撤权和停止，再恢复该轮检查点并登记新 Run。检查点不可用或副作用未经确认时拒绝重试。
- Orchestrator 记录待核对事项与处理结论，可信运维入口负责发现、接手和提交证据。证据不足的结案先检查停止、撤权和资源清理条件，再持久化终态与脱敏结论。用户侧只读取处理状态。清理可消费已结案的终态，结案审计按部署规则保留。
- 每个可交付 Run 保存结果版本、本轮执行前基线和任务初始基线。交付审阅和下载读取相对初始基线生成的同一份累计变更。后续 Run 生成独立结果版本。

## 安全与可观测性

- 服务端从 Cookie 解析 owner，并校验空间项目、文件、执行项目和 Run 的关系。错误、操作日志及远端验收记录不记录邀请码、签名 URL、私有路径和原始用户文件。空间和执行的持久状态保留稳定 ID 供对账。
- 针对运维记录上传和初始化阶段、重试次数、预占字节、删除待清理时长和稳定错误分类。任务仍使用执行侧的 Run ID 与状态对账。
- 真实部署保留现有 Origin 校验、HTTPS 和私有桶。对象存储凭证及执行服务凭证仅供任务入口使用。配置见 [任务入口说明](../../apps/workspace/workspace-api/README.md)。

## 验收

场景和通过条件见[产品验收标准](../10-requirements/WEB-REQUIREMENTS.md#验收标准)，当前证据和缺口见[需求完成状况](../40-readiness/CURRENT-READINESS.md)。

## 项目文件与存储

### 目的与范围

实现 [Web 产品需求](../10-requirements/WEB-REQUIREMENTS.md)的 WEB-02～04。浏览器中的「我的空间」用于管理私有项目、原始文件、上传记录和额度。用户可选择已保存的文件作为 Agent 任务输入。本文定义空间元数据、对象存储和执行服务的交接，以及上传、预览、删除和恢复的行为。HTTP 字段与错误码见 [Web 接口契约](../20-interfaces/WEB-INTERFACE.md)。

### 职责与持久化边界

| 组件         | 持有数据与职责                                                                               |
| ------------ | -------------------------------------------------------------------------------------------- |
| 浏览器       | 文件选择、目录相对路径、分块摘要计算、传输进度及重选续传。账号用量以服务端返回为准。         |
| 个人端 API   | 从业务会话取得 `ownerId`，校验项目与文件归属，管理路径占用、额度、上传状态、传输授权和清理。 |
| 私有对象存储 | 保存原始文件和未合并分块。按服务端生成的对象键寻址，使用短期预签名 URL 授权单项操作。        |
| Orchestrator | 持有执行项目、Session、Workspace、Run 和补丁，负责确认旧执行停止和回收执行资源。             |

当前部署由 Go Web 入口代理 TypeScript API，空间元数据保存在单 API 进程使用的 SQLite 中。Go 接管 API 时保留以下产品行为与恢复语义。进程内的互斥只适用于当前单进程部署。多写入进程需要持久的条件更新和操作认领机制。

| 记录              | 持久字段与关系                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space_projects`  | 项目 ID、所属账号和名称。                                                                                                                                                             |
| `space_uploads`   | 上传 ID、项目和账号、相对路径、声明大小、有序 SHA-256 清单、状态、S3 multipart ID、到期时间、最晚签名失效时间和清理结果。进入 `saved` 后同一条记录成为文件记录，文件 ID 沿用上传 ID。 |
| `space_execution` | 空间项目和账号、初始化提交键、输入清单、临时文本快照、执行项目 ID、初始化状态和文件级校验问题。当前每个空间项目最多有一条有效绑定。                                                   |
| 对象              | 对象键为 `space/<uploadId>`。用户路径仅用于组织文件、初始化输入和生成下载文件名。                                                                                                     |

同一项目内的有效记录占用其路径。拒绝同名文件及文件与目录的前缀冲突，例如同时写入 `src` 和 `src/app.ts`。路径以 `/` 分段，拒绝空段、点段、反斜杠、控制字符和超过 1024 个 UTF-16 码元的路径。文件树由已保存记录投影，目录节点由文件路径生成。上传记录独立展示进度与失败原因。

### 上传与续传

1. 浏览器接收文件拖放或通过 picker 选择文件及文件夹，保留文件夹的相对路径。上传前展示目标项目、文件清单、总字节数、可用额度和逐项拒收原因。确认后仅发送可提交项，按 16 MiB 切块并逐块计算 SHA-256。空文件的摘要清单为空。服务端在每个文件开始时重新校验。
2. 客户端为文件生成 UUID 并随项目、路径、大小和摘要清单提交。API 在同一 SQLite 写事务中校验项目归属、路径冲突及账号额度，写入 `preparing`。同 ID 同内容重试复用记录。同 ID 的路径、项目、大小或摘要变化返回冲突。
3. 预占提交后，API 为非空文件创建 multipart 上传并保存存储侧 ID。若创建成功后响应丢失，重试按精确对象键清理此前未登记的 multipart 上传，再创建新的上传。空文件在完成阶段直接写入零字节对象。
4. 浏览器对缺失分块逐个请求授权，最多并行上传四块。每个签名绑定对象键、multipart ID、从 1 开始的分块编号、准确长度和 SHA-256。API 在返回地址前持久化其最晚失效时间。分块地址有效期 10 分钟，上传会话自预占起有效 24 小时。
5. 网络中断后，浏览器重新获取上传记录和存储侧已验证分块。重选文件时重算清单，通过同一上传 ID 校验项目、路径、大小和摘要。只有长度、摘要及 ETag 均符合要求的分块参与合并。签名过期时按同一分块重新授权。
6. 完成请求先持久化 `completing`，再核对全量分块并按编号合并。API 检查最终对象大小后转为 `saved`。完成响应丢失时，重试先 HEAD 原对象。对象已可见且大小正确时复用原结果。HEAD 与分块查询都未确认结果时回到上传状态，允许补传。存储查询失败时保留持久状态等待再次核对。

#### 状态与额度

| 状态                             | 可执行操作与恢复                                                       | 额度   |
| -------------------------------- | ---------------------------------------------------------------------- | ------ |
| `preparing`                      | 创建或重建 multipart 上传。可取消或等待过期清理。                      | 预占   |
| `uploading`                      | 查询已验分块、签发分块、完成或取消。到期停止签发。                     | 预占   |
| `completing`                     | 重试完成或通过扫描核对对象。分块不足时回到上传。大小不符转入失败清理。 | 预占   |
| `saved`                          | 出现在文件树中，可下载或选择为执行输入。重复完成返回同一文件。         | 已保存 |
| `cleaning`                       | 等待已签发分块地址失效，终止对应 multipart 上传并删除可能残留的对象。  | 预占   |
| `cancelled`、`expired`、`failed` | 清理结束，保留状态供用户查看。重新上传使用新 ID。                      | 已释放 |

单文件与账号额度采用[空间接口](../20-interfaces/WEB-INTERFACE.md#我的空间--web-02--web-03)的 100 MB 和 200 MB 目标值。沿用 16 MiB 分块，100 MB 文件需上传 6 块。原子预占按同一账号的已保存与预占之和计算。完成只切换用量归类，清理完成才释放额度。上传、查询、预览与下载均独立于 Run 队列。

当前同一上传的准备、签名、完成和取消由进程内互斥串行化。已经开始完成时，取消返回冲突，页面查询原状态。后台约每 30 秒推进完成对账、过期和到期清理。进程重启后从 SQLite 重读状态。桶生命周期规则负责兜底清理孤儿分块，业务额度仍以 API 的清理记录为准。

浏览器在清单确认后按可提交项的顺序建立逐文件上传记录。同一批次保留等待、校验、传输、确认、已保存和未确认等逐项结果，直至下一次确认或离开该项目页面。传输计数以续传查询返回的已验证分块和本次收到成功 PUT 响应的分块为准，去重显示。收到 `saved` 前仍处于上传或确认流程。遇到会话失效时停止后续项，并分别显示当前项和未开始项。用户可重选原文件，沿用已有上传记录继续。

### 文件读取与执行输入

下载校验账号归属及 `saved` 状态，签发短期附件地址，文件名取路径最后一段。文本预览采用独立的 300 秒只读地址，最多 256 KiB。浏览器限制实际读取字节，使用严格 UTF-8 解码并按纯文本渲染。超限或无法解码时保留下载入口。签发以后，既有地址可在有效期内使用，清理完成以存储侧确认对象不可读为准。

当前初始化接收 1～100 个不重复的已保存文件 ID，合计最多 1 MiB。空间初始化、直接文本导入和执行服务共用 [TypeScript 快照契约](../../shared/text-snapshot.ts)中的限额。API 按文件 ID 排序保存输入及摘要，同一 `Idempotency-Key` 绑定同一文件集合。当前用数据库唯一约束限制同一空间项目的有效初始化记录。单文件删除与输入选择的同步写入互斥，初始化中的引用会阻止删除。后台按清单读取对象、校验字节和摘要并严格解码。任一文件无效时返回文件级问题。验证通过后先持久化文本快照，再用稳定内部提交键导入执行项目。导入回执丢失时重发原键，已知执行项目 ID 时查询原项目。校验在派发前明确失败时，用户可修正文件选择并用新键重试。导入已创建执行项目后，保留绑定并展示其状态及失败原因。仅在工作区就绪后开放 Run 提交。补丁相对对应 Run 的执行前基线，Agent 改动保存在执行侧。

完整 Web 产品的目标是每个独立任务持有自己的 Workspace。同一任务的后续 Run 使用原 Workspace。空间侧应保存按任务引用的不可变输入清单，文件删除时按活跃引用判断阻塞，项目删除需清理所有关联执行工作区。现有一项目一绑定接口是当前实现，新的任务级关联与 HTTP 字段随任务设计一起更新。

### 删除与注销

#### 单文件删除 · 已实现

- 空间 API 校验归属、文件状态和初始化引用。对已有执行项目引用，先持久化原操作 ID，再向 Orchestrator 取得门禁。Orchestrator 在 SQLite 事务中检查未结束 Run，并与新 Run 入队互斥。明确拒绝时文件保持可读，门禁回执未知时重试同一操作。
- 接受后文件进入 `deleting`，继续计入已保存用量，并停止签发下载和预览地址。后台复用空间 sweep。对象删除结果未知时先 HEAD 原对象，确认不可读后才释放 Run 门禁。已确认的步骤随服务重启保留。
- 收到门禁释放回执后一次回收额度并移除列表入口。保留原 owner 的文件 ID 墓碑，重复删除返回 `204`，来源清单显示文件已不可用。执行 Workspace 和历史 Run、补丁继续可查。

#### 项目删除 · 已实现

1. 页面读取影响摘要，展示文件、未完成上传、任务、补丁和阻塞原因。已发布补丁在确认前可下载。提交删除时再次检查未完成上传、初始化及活跃任务。
2. API 持久化删除意图并阻止该项目的新上传和初始化。Orchestrator 原子检查相关活跃 Run 并冻结对应执行入口。存在排队、执行、恢复、取消中或待核对 Run 时拒绝删除。明确拒绝时解除尚未生效的空间侧冻结。执行侧结果未知时保持冻结并查询原操作。
3. 执行侧确认撤权及停止，清理项目独占的 Session、Workspace、任务和补丁。共享引用或所有权不明时暂停清理。执行侧清理确认后按持久进度清理空间侧对象和上传，保留尚未清理部分的额度。
4. 对象和执行资源都确认清理后删除可见记录，保留用于校验归属和重复请求的完成标记。操作进度至少记录资源 ID、所属账号、阶段及失败原因。任一步骤重启后沿用原操作标识与已确认进度。
5. 空间与执行侧各持久化账号 drain。项目删除先受理时，账号清理等待原操作完成。账号 drain 先写入时，拒绝新的项目删除。项目和账号清理确认对象不可读后，全局保留已清理上传的 ID，防止同键写入让已签发地址读到其他文件。该记录不计入额度。

#### 账号注销 · 当前路径

账号关闭与清理请求一同持久化。个人端 API 拒绝新授权，等待账号正在处理的请求和空间初始化退出。执行侧先清理该账号的任务和执行资源，待确认完成后空间侧逐个终止分块、删除对象并删除文件记录，最后清理空间项目与执行绑定。未过期的上传授权和仍在进行的对象操作延迟清理。任一步失败都保留原清理请求，由后台重试。当前 Keycloak 注销、S3 和真实执行资源的联合清理仍待验收。

### 安全与可观测性

- 使用私有桶和最小权限存储凭据。账号和父子资源关系由服务端校验。越权访问使用与资源不存在一致的响应。下载、预览和传输签名只为已授权的单个对象或分块发放。
- 对象存储 CORS 限制到 Web origin、分块 PUT 所需方法和请求头。文本预览使用同一 Web origin 的受控 GET。反向代理保留 Origin，部署使用 HTTPS。配置见 [个人端 API](../../apps/workspace/workspace-api/README.md)。
- 诊断按上传 ID、项目 ID、状态、失败类别、预占量和滞留时长定位。目标监控覆盖过期清理积压、合并对账失败和额度不一致。日志省略签名 URL、凭据和用户文件内容。

### 验收

| 场景             | 通过条件                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 路径、归属与额度 | 目录上传保留层级，拒绝路径穿越和前缀冲突。跨账号读取、分块签名、完成、删除和初始化均拒绝。按下文验证 100 MB、200 MB 边界及并发预占。 |
| 上传与恢复       | 模拟创建或完成回执丢失、断网、进程重启和完成与取消竞争。原 ID 对应唯一对象和唯一用量记录。重选不同文件拒绝续传，已验证分块不重传。   |
| 过期与清理       | 在分块签名仍有效时取消或过期。等待失效后验证无残留对象或分块，确认额度可重用。                                                       |
| 读取与初始化     | 下载与源文件逐字节一致。预览测试超限、无效 UTF-8 和脚本字符。模拟导入回执丢失，确认原执行项目可找回。                                |
| 删除与注销       | 验证新 Run、初始化与删除的并发顺序。注入对象删除和执行清理的回执丢失，重启后继续原操作。核对历史结果保留范围及额度。                 |

上述场景是设计验收条件。已执行验证和未覆盖项见 [实现覆盖记录](../40-readiness/CURRENT-READINESS.md)。

#### 上传验证顺序

1. 在同一真实部署的浏览器、个人端 API 和私有对象存储上，使用隔离测试账号，从页面选择略大于 16 MiB、可拆为两块的文件。记录分块 PUT 和状态回读，确认文件进入文件树，下载并核对源文件摘要。删除后确认对象不可读、无残留分块且用量回到基线。此步骤通过后开始真实边界验收。
2. 执行 WEB-A02。上传 100,000,000 字节文件，先确认至少一块已被存储验证，再中断网络并刷新。用同大小、不同内容的文件验证续传被拒绝，然后重选原文件。让缺块的已签发地址失效，同时保持上传记录有效。观察旧地址的 PUT 被拒和新地址获签，核对续传只 PUT 缺块。核对六块的实际长度及最终下载 SHA-256。另用 100,000,001 字节文件验证页面拒收、直接 API 请求拒绝且无预占或分块 PUT。
3. 执行 WEB-A03。在同账号实际保存两个 100,000,000 字节文件，确认已保存为 200,000,000 字节、预占为零，再尝试新增 1 字节并核对服务端拒绝且用量不变。可复用 WEB-A02 保存的对象。另构造并发开始请求，使其分别可容纳但合计超出剩余额度，核对仅有符合额度的预占成功。分别验证取消、上传记录过期及删除，核对清理确认前的记账、对象或分块移除后的用量以及同账号重新使用释放的额度。

常规回归使用小数据、隔离环境的短有效期或受控时钟覆盖并发、两类过期、清理失败和重启恢复。分块签名过期验证同一上传 ID 的重新授权，上传记录过期验证停止续传、清理并释放预占。涉及真实签名校验时由测试存储确认旧地址失效。真实容量验收单独执行，证据记录实际传输字节、环境、构建版本与结果。小数据及受控时间的结果按其覆盖范围记录。

每次真实验收开始前，按环境带宽和清理配置记录阶段总截止、无进展截止与清理截止。观察页面逐文件状态、已验证分块数及字节数、最近成功时间、API 状态和存储回读。验证期间保留脱敏的上传 ID、用量和状态时间线。到达无进展或阶段总截止时停止新增 PUT 和重试，查询原 ID。未完成上传发起取消，完成结果待确认时先对账，已保存的测试文件通过正常删除入口清理。等待已签发地址失效并确认存储清理和额度恢复。到达清理截止仍未确认时保留原 ID 和待清理状态，按原记录恢复清理，确认后再重跑。

## 源码职责与监听生命周期

个人端 Go API 在 `apps/workspace/workspace-api/src/main.go` 建立监听和管理关闭流程。项目空间读写、文件和项目删除及快照推进各由 Go 路由和状态机处理。空间页面和上传规划位于 `apps/workspace/workspace-web/src/space/`。

Orchestrator 的 `service.ts` 组合执行服务。`task-retry-recovery.ts` 管理 Task 停止证据复验与恢复推进；`task-run-view.ts` 生成 Task Run 视图及重试原因。`store/index.ts` 提供执行账本入口，`store/task-evidence.ts` 负责证据、检查点和关闭审计，复用 Store 的 SQLite 连接及事务函数，不引入独立数据库或事务边界。

前端页面组件统一置于 `src/pages/`，`pages/index.ts` 提供路由导出入口。`pages/auth/` 管理登录、注册与账号设置，`pages/workbench/` 管理工作台布局，`pages/projects/` 管理项目页面，`pages/tasks/` 管理 Task 列表、提交和详情。每个页面组件使用独立目录的 `index.tsx`，专属子组件位于同目录；Task 结果组件位于 `pages/tasks/details/run-result.tsx`，业务标签由 `pages/tasks/labels.ts` 维护。在线状态订阅由 `pages/shared/online.ts` 共享。 Web 单元与组件测试位于源码目录外的 `tests/`，Vitest 从该目录发现 `*.test.ts` 和 `*.test.tsx`；TypeScript 和 ESLint 同时覆盖源码与测试。
