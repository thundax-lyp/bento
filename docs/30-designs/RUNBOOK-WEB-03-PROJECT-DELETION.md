# WEB-03 项目整体删除 RUNBOOK

- 状态：2026-11-13 草稿，待 MASTER 指派独立审核。当前 checkout 的 `main` 只允许写此草稿。
- 基线：`e2df225840dc9c7c065891788cc0587e9279b26e`，目标 `thundax-lyp/bento:main`。后续获派任务分支 `codex/web-03-project-deletion`。
- 窗口：本任务先修改和合入共享空间 API、执行账本及 Docker 验证边界。后合入方同步并复验上传、初始化、Run、文件删除和项目删除竞态。测试使用临时目录、回环端口与 fixture；浏览器套件独占 4319/4320。
- 执行契约：MASTER 核对草稿 SHA-256、独立结论、T0 和任务分支上的单文件 RUNBOOK 提交后显式调用 WORKER。草稿位于仓库忽略范围，获派单文件提交时仅对这一路径强制暂存。发布前按 T6 删除，公开清单只覆盖最终树。按编号执行，每步 PASS 后只提交该步产物和删去该步的 RUNBOOK，保留其余编号，把引用已删步骤的前置条件改为可查事实。提交失败时留在本步重验受影响检查。发布走一个 PR、当前 HEAD 明确 Codex 结论和必需 CI，处理意见显式调用 `bento-codex-comment-fix`，普通 merge 后核对同步及分支清理。

## 目标与正式依据

用户打开自己项目的影响预检查，查看文件、未清理上传、历史 Run 和已发布补丁，保留确认前下载。用户确认后服务端重查并冻结，按稳定标识清理当前绑定的执行项目、Session、Workspace、历史 Run、补丁、空间对象与记录。完成后原账号重复请求返回 204，其他账号看到 404。无执行绑定的空项目走同一空间删除状态机。

- [WEB-03 与 WEB-A05/A10](../10-requirements/WEB-REQUIREMENTS.md#验收标准)规定影响确认、未清理上传和未终结 Run 阻断、归属与额度。WEB-A10 中，本轮验证待核对期间持续拒绝，以及基线已有的确认成功路径结束后允许清理。
- [项目详情及目标扩展](../20-interfaces/WEB-INTERFACE.md#项目详情及目标扩展)规定 HTTP 响应和 blockers。[Web 设计](WEB-DESIGN.md#项目删除--目标)规定冻结、回执、执行资源与对象的清理顺序。[平台架构](../00-governance/ARCHITECTURE.md#当前实现接线)规定 API 和 Orchestrator 权责。
- [Readiness](../40-readiness/CURRENT-READINESS.md)的 WEB-03 目前只有单文件证据。正式依据可按职责同时满足。接口的三个 blocker 适用于整个项目，设计明确将取消中纳入未结束；设计中的每任务独立 Workspace 属后续产品范围，当前一空间项目最多一个执行绑定。单文件条款所列 `file_delete_unconfirmed` 只用于单文件。
- Scope 为当前 TypeScript 空间、当前 Orchestrator 与 Web 入口。可信运维接手、确认失败、证据不足结案及独立审计，整套账号注销验收，任务级 Workspace、Go Orchestrator 切换，真实 S3/CORS、Keycloak、Temporal、OpenShell 联合验收留在 Readiness。真实环境引用 [部署配置入口](../../deploy/README.md#准备配置)的 `debug-workspace/web.env`、`debug-workspace/execution.env`；本轮验证不读取或输出配置值。

## 当前入口与安全不变量

| 边界       | 基线入口和缺口                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空间       | `apps/workspace/api/space.ts` 的 `mySpace.route/reserve/deleteFile/advanceFileDeletion/sweep/purge` 持有 SQLite 上传、单文件意图和额度。现有 `apps/workspace/api/space-execution.ts` 的 `spaceExecution.start/current/reconcile` 持久化初始化输入及绑定，`validating/importing` 包括导入回执丢失。两处都需要项目门禁。                                                                                                                                                                |
| 执行       | `apps/orchestrator/execution-service/store.ts` 的 `Store.addRun/enqueueRun/acquireFileDeleteHold/purgeProject` 持有入队条件、单文件锁及项目账本清理。现有 `apps/orchestrator/execution-service/service.ts` 的 `serveExecution.purgeOwner` 是账号级操作，已调用 `scheduler.purgeClosed` 与 `SingleHostExecution.purge`，需要新增项目级入口。                                                                                                                                           |
| 外部资源   | `apps/orchestrator/openshell/authority.ts` 的 `Authority.checkPurge` 拒绝仍获授权、绑定不符和共享 Session 资源。`apps/orchestrator/openshell/single-host.ts` 的 `SingleHostExecution.purge` 撤销通道后调用可信宿主，再删 Session 历史及权威记录。`apps/orchestrator/execution-service/docker-openshell-purge.ts` 的 `dockerOpenShellPurge` 校验独占卷标签、确认沙盒和挂载消失，再确认卷不存在。`apps/workspace/api/space-storage.ts` 的 `spaceStorage.size/remove` 用 HEAD 核实对象。 |
| 传输及页面 | `apps/workspace/api/server.ts` 的 `taskEntryServer` 业务请求派发和账号清理 sweep，`apps/workspace/api/execution-service-http.ts` 的 `httpBackend`，以及 `apps/workspace/web/src/space.tsx` 的 `CloudProject/SpaceList`。既有 202/204 序列化可复用，需补项目 DELETE 的 Origin 检查。                                                                                                                                                                                                   |

1. owner 由现有认证取得。内部仍使用 service bearer 和 `X-Bento-Owner-Id`。任何查看、删除和重放先验证 owner 与项目、子资源关系。无权及不存在统一 404。
2. 空间在同一个 SQLite 同步事务里重查上传、初始化并写删除意图。执行侧在 `Store.write` 内重查 Run 与单文件门禁并冻结。任何网络调用在事务之后。两侧均在第一处可产生写入或签名的同步入口检查，签名返回前再查门禁。
3. 上传阻断为 `preparing/uploading/completing/cleaning`，含签名尚未过期的清理。Run 阻断为 `queued/running/recovering/cancelling/needs_review`，使用既有 `pending`。发布补丁统计 `status='succeeded' AND diff IS NOT NULL`，包括空串；Run 总数包括全部当前历史和活跃记录。预检查只读，拒绝决定在实际写入门禁时重算。
4. 禁止从 404、超时或无效回执推断远端成功。只用同一 owner、项目及操作 ID 恢复。工作区清理等待宿主独占、撤权和消失的可信观察。项目成功以执行账本清理及所有对象确认不可读为条件。空间额度由记录归类求和，禁止引入计数减法。
5. 现有项目和文件 ID 以服务端校验的 UUID v4 保存。删除操作 ID 由空间 API 生成 UUID v4，写入意图后沿用。用户无需提供幂等键或请求体。现有创建与 Run 的 idempotency 规则继续生效；已删空间项目 ID 禁止复用。无新事件、版本、request hash、outbox、公开审计接口或迁移。

## 固定数据和传输

- 公共 `GET /api/space/projects/{spaceId}/deletion` 返回 200 和 `{fileCount:number,uploadCount:number,runCount:number,diffCount:number,blockers:DeletionBlocker[]}`，计数为非负安全整数，`DeletionBlocker = 'upload_pending' | 'project_importing' | 'project_busy'`。固定按此顺序输出、去重。无绑定的执行计数为 0。现有空间列表项目项和项目详情均加可选 `state?: 'deleting'`，仅有未完成意图时发出。冻结后列表保留项目及其清理中的上传额度，详情返回现有形状，其中 `files:[]` 且 `execution:{state:'uninitialized'}`，客户端优先显示清理进度。
- 公共 DELETE 成功仅 202 `{state:'deleting'}` 或 204 无正文。确定拒绝为 409 加首个 blocker，或在独立单文件意图未结束时返回 503 `project_delete_unconfirmed`；回执未知同为该 503，保留意图。删除完成后的预检查及详情为 404。已有删除意图时预检查以空间已存活记录计数，执行侧进行中可读内部影响；执行已确认完成后执行计数归零。已冻结的公共上传、单文件删除及初始化写请求返回 409 `project_busy`；已有资源读取在清理期间按下述步骤关闭。
- 内部 GET `/v1/projects/{projectId}/deletion` 返回 200 `{runCount:number,diffCount:number,blockers:('project_importing'|'project_busy')[]}`。使用原始 owner 校验，允许读冻结项目；项目不存在为 404。DELETE/预检查并发时，若读取内部影响失败且本地已存在删除意图，重读同一空间项目意图，只有阶段已推进到 `cleaning` 才按已确认执行完成返回零，否则返回 503。
- 按 [私有执行接口](../20-interfaces/WEB-INTERFACE.md#私有执行接口与目标扩展)使用内部 DELETE `/v1/projects/{projectId}`，无正文，仅由 `httpBackend` 将已持久化 UUID v4 写入唯一的 `Idempotency-Key` header。禁止从 URL、正文或公共请求 header 取操作 ID。执行 HTTP 用 headersDistinct 校验恰好一个合法 UUID v4，否则 400 `invalid_input`，认证先于校验。成功仅 202 JSON `{state:"deleting"}` 或 204 无正文。持久 denied 回执重放为 409 `project_importing` 或 `project_busy`；新的空间请求可生成新操作。已受理的同项目不同 ID 为 409 `idempotency_conflict`，owner drain 先到为 409 `owner_closed`，异 owner 或未知项目为 404 `not_found`。错误沿用原 JSON envelope。空间仅对合法的 409 `project_importing/project_busy/owner_closed` 解除冻结；owner_closed 映射公共 409 `project_busy`。其他执行错误、异常、无效回执一律映射公共 503 `project_delete_unconfirmed`，沿用原意图。
- 执行 SQLite 新表 `project_deletions(projectId TEXT NOT NULL, operationId TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, code TEXT, PRIMARY KEY(projectId,operationId)) STRICT`，state 限定 `denied/deleting/deleted`，code 仅 denied 非空且限上述值。按 `projectId` 对 `deleting/deleted` 建部分唯一索引。独立于项目 FK，正常清理的终态必须与账本删除同事务落盘。账号清理完成后删除该 owner 的删除回执。沿用既有持久 `draining_owners`，以 drain 写入和删除 begin 的 SQLite 事务排序。
- 空间 SQLite 新表 `space_project_deletions(spaceId TEXT PRIMARY KEY, owner TEXT NOT NULL, operationId TEXT NOT NULL UNIQUE, executionProjectId TEXT, phase TEXT NOT NULL, lastError TEXT) STRICT`，phase 限定 `checking/cleaning/deleted`。无绑定时 executionProjectId 为 NULL。lastError 默认 NULL，仅记录 `execution_unconfirmed` 或 `storage_unconfirmed`，成功推进时清空。检查阶段只冻结空间，等执行侧明确完成后进入 cleaning；项目可见记录与墓碑完成在同一事务。账号清理完成后删除该 owner 的空间墓碑。另建 `space_draining_owners(owner TEXT PRIMARY KEY) STRICT`，由 `mySpace.drain` 首条同步写入，跨重启保留，账号 purge 完成后仍保留。全局 `space_retired_upload_ids(id TEXT PRIMARY KEY) STRICT` 只存 ID，无 owner、正文、路径、额度或过期时间，项目及账号清理均永久保留。因为 `spaceObjectKey` 只取文件 ID，任一 owner 的 reserve 均不得复用已退休 ID，避免旧预签名 URL 读取后来同键写入的对象。

## T0：基线与资源

前置状态：在仓库根目录，初始工作区干净，MASTER 已指定共享窗口。允许修改：本草稿。禁止修改：分支、索引及实现。初次取证在草稿写入前执行；开工时以已审核提交为 HEAD，验证其父提交为基线且工作区干净。

```bash
git status --short --branch
git rev-parse main origin/main
git remote get-url origin
git ls-remote origin refs/heads/main
node -v
pnpm -v
pnpm check
pnpm --filter @bento/workspace-api exec node --experimental-strip-types --test space-files.test.ts file-delete-hold.test.ts
pnpm --filter @bento/web test:e2e
```

PASS：两本地 ref 与远端 main 均为指定基线，远端为 `thundax-lyp/bento`，Node 22 和仓库指定 pnpm 可用，聚合检查退出 0，单文件聚焦 4 项及 Chromium 7 项通过且无 skip。2026-11-13 本机实际为 Node 22.23.2、pnpm 12.15.0，以上结果均取得。Docker CLI 在本机不可用，容器构建固定由远端 Deployment image builds 门禁覆盖。本机测试及 CI 镜像构建均不证明真实联合部署。STOP：基线、资源窗口或上述本地门禁变化，保留输出并交 MASTER 重新核对。

## 机械步骤

每步文件数均计入 RUNBOOK。下列命令均从仓库根目录执行。所有断言必须执行且退出 0，skip 或弱化断言一律 STOP。通用 STOP 报告最后 PASS 和 SHA、失败断言、文件和符号、复现命令、脱敏输出及待决条件。测试故障保留可重现 fixture 配置，清理仅测试自行创建的目录和端口。数据库或外部调用失败保持已持久化阶段，使用原标识续跑。

### T4：空间端持久清理与用户 HTTP

前置状态：严格内部 HTTP 回执已提交。允许修改（5）：`apps/workspace/api/{space,space-execution,server,space-files.test}.ts` 四个文件、RUNBOOK。禁止修改：对象存储协议、额度上限、账号认证、其他上传接口的既有正常行为。

执行：

1. `mySpace` 建项目意图表。新增 `projectDeletionImpact(owner: string, spaceId: string)`、`deleteProject(owner: string, spaceId: string)`、`advanceProjectDeletion(owner: string, spaceId: string)`。预检查先读 owner 及上传计数，再查执行影响并合并 blocker。上传阻断查固定四态，fileCount 计当前 `saved/deleting`，runCount/diffCount 取内部结果。未受理时 404 仅用于空间资源不存在或异 owner；内部 404 归未知 503。
2. DELETE 先检查 owner 完成墓碑，命中则 204。否则在 `commitDeletionChange` 事务内先读已有同 owner 意图，再对新意图重查 owner、持久 space drain、上传、初始化及独立单文件意图；仅无 blocker 且无独立文件意图时写入同一项目唯一意图。已有意图复用，未知门禁不得删除意图。无绑定直接 cleaning。有绑定先 checking，收到约定的明确 409 时原子删除意图并按固定映射返回 409。内部 202 保留 checking 并返回 202。内部 204 原子转 cleaning，并把本项目所有 saved 改为 deleting，仍计用量。无绑定直接进入 cleaning 时在同一意图事务把 saved 改为 deleting。回执未知保留 checking，记录错误并返回 503。
3. 在 `reserve` 的原事务内先确认 owner 对项目有权且未冻结，再按全局 `space_retired_upload_ids` 查上传 ID，命中统一 404，无预占或存储副作用。新冻结写入守卫接到`spaceExecution.start` 的同步入口、`deleteFile` 写意图前，以及上传 POST 锁内查空间项目冻结。把冻结检查作为 `spaceExecution` 的新增第四个参数 `requireWritableProject: (owner: string, spaceId: string) => void`。该调用直到初始化插入之间无 await。添加 `spaceExecution.projectDeletionInput(owner: string, spaceId: string): {importing:boolean,projectId:string|null}`，复用 project/current，`validating/importing` 为 importing，其余读持久绑定。preview/download 在发签名前与返回 Location 前校验无未完成项目意图。上传读取在删除中返回 404；项目详情和列表投影按固定传输。创建项目检查墓碑，原 ID 不复用且返回 404。
4. 请求和后台复用以 spaceId 为键的在途 Promise，避免清理并发。每次 30 秒 sweep 在现有上传与文件清理之后按 rowid 推进所有 checking/cleaning 意图，不要求用户登录。checking 使用原远端操作，只有确定拒绝才解除冻结；cleaning 仅处理同 owner/spaceId 的上传。按 rowid 遍历 deleting 行，HEAD 非空则调用 storage.remove，再 HEAD，只有 null 才将该行置 deleted。异常保持额度及阶段并记录 storage_unconfirmed。原已清理上传无需再 Abort。所有对象确认后在同一事务将该项目所有上传 ID（含历史 cancelled/expired/failed/deleted）写入全局退休表，再清除上传、初始化及项目行，写 deleted 项目墓碑。后续重复 DELETE 返回 204。close 等 sweep 和在途操作结束。
5. `mySpace.drain` 先同步持久化 owner drain，再调用原 execution.drain，并在该 owner 有 checking/cleaning 时返回 false。服务重启时 `taskEntryServer.sweepAccounts` 继续读取既有持久账号清理请求；已写的 space drain 在首轮 sweep 之前仍生效。账号 `mySpace.purge` 入口也必须先执行 drain 并等已有项目删除完成。账号清理每个上传时沿用原签名时限守卫和对象清理，确认 HEAD 缺失后，在同一事务写退休 ID 并删除上传记录。保留全局退休表及 drain；账号最终事务清除该 owner 的项目墓碑。`server.ts` 的现有 DELETE Origin 条件同时匹配 `files` 和 `projects`，复用 deleteStatus 序列化。
6. 在 `space-files.test.ts` 添加 `project deletion space`，复用临时 SQLite 和对象 fixture。空间状态断言调用 mySpace.route，Origin 断言通过 taskEntryServer 回环端口 0，注入同文件内 Auth fixture，给带 Cookie 的 DELETE 发匹配与不匹配的 Origin。用明确的 barrier 锁定上传/初始化先到与删除先到两种顺序。覆盖预检查不冻结、未清理上传（含 cleaning）、初始化未知、执行拒绝时解除冻结、单文件清理交错、Origin、两账号、两个对象分阶段清理。模拟执行受理回执与对象删除回执丢失，重开同 DB 并驱动原 sweep；断言原 operationId、仍可读对象对应额度保留、清理后一次释放、重复 204、旧 ID 不可复用。覆盖项目删除及账号 purge 两条路径：用另一 owner 在其项目 reserve 同一已清理 ID，断言 404、无存储调用、额度不变，重开后仍拒绝；旧签名指向的键始终不存在。分别测试 drain 先到的 409 和项目意图先到的 202，重启后新删除仍拒绝、旧项目原操作继续及 204 查询，项目完成前账号 purge 不发对象清理，完成后账号 purge 继续。测试用存储 fixture 验证 HEAD unknown 保留额度；单文件历史保留场景继续通过。再在同文件添加 `project deletion crosses both HTTP boundaries`，以 taskEntryServer + httpBackend 连接真实 serveExecution 和 localHost，各用独立临时目录及动态端口，存储由对象 fixture 提供。用真实初始化绑定和两个 owner 的 Run 验证预检查、删除、旧公共补丁 URL 404、另一账号仍可下载及空间用量回收。所有状态等待用 5 秒总期限，空间 sweep 以现有 mock timer 驱动。

验证：

```bash
pnpm --filter @bento/workspace-api check
pnpm --filter @bento/workspace-api exec node --experimental-strip-types --test space-files.test.ts file-delete-hold.test.ts cancel-run.test.ts
```

PASS：全部断言通过，两向 drain 顺序重启后保持，跨账号复用项目或账号已清理的文件 ID 均拒绝，无未确认对象提前释放额度。STOP：通用条件或任何故障可绕过 owner、冻结、回执及对象确认。

### T5：项目删除确认与进度

前置状态：公共预检查、状态投影和 DELETE 已实现。允许修改（5）：`apps/workspace/web/src/{space-api.ts,space.tsx,space-api.test.ts}` 三个文件、`apps/workspace/web/e2e/space-preview.spec.ts`、RUNBOOK。禁止修改：公共路由层级、账户入口、任务页面、单文件正常操作。

执行：

1. 在 space-api.ts 增加项目 state 可选字段、`ProjectDeletionImpact`、`getProjectDeletionImpact(id: string, signal?: AbortSignal)` 与 `deleteSpaceProject(id: string): Promise<'deleting'|'deleted'>`。DELETE 沿用单文件 15 秒 timeout 和 202/204 处理，空间列表及项目详情 deleting 时每 2 秒 refetch。
2. `CloudProject` 展示「删除项目」按钮，打开确认区域才请求影响。展示四个计数、三种阻塞对应的中文原因与不可恢复范围。请求中、失败或存在 blocker 时禁用「确认删除」，「取消」只关闭确认。预检查期间保留文件及历史入口。发出首次确认 DELETE 前以 JSON.stringify(['bento:project-delete',account,id]) 为 sessionStorage 键记录用户已确认；只写入标志，不存错误或资源数据。明确 409 清标志并重新请求影响，显示稳定错误。收到 503、超时或断网保留标志和原项目 ID，回读详情和影响，允许「查询删除进度」。查询按钮每次提交原项目 DELETE 并在结果未知时保留标志，回读路径只读。收到 202 或回读 state=deleting 后关闭预览、上传、初始化及历史入口，显示进度和查询按钮；从服务器回读 deleting 时也记录标志。若详情或影响 404 且标志存在，先于通用 404 分支查询原 DELETE；对同一轮 404 只发一次，随后 503 或断网由查询按钮继续，DELETE 本身 404 显示原错误且不宣告完成。只有 204 时清标志、刷新空间列表与额度并回到 /space。无标志的未知项目 404 不发 DELETE。SpaceList 显示正在删除的项目，支持返回其进度页面。
3. 在 space-api.test.ts 验证项目 ID 路径编码、GET/DELETE 方法和 202/204 解码。扩充 Chromium fixture `项目删除显示影响、阻塞并等待完成`，用拦截器断言点击确认前无 DELETE、阻塞禁用且文件可下载、确认后 202、刷新仍清理中、对象与额度在服务端完成后才从 UI 消失，直接访问旧链接失效。新增 Chromium fixture `项目删除响应丢失后用原编号确认完成`，分别运行初次 DELETE 503、网络中断两组：拦截端记录已提交，后台完成并令详情和影响都返回 404，确认至少观察到一个 404 后才发原路径 DELETE；该请求返回 204 后才导航 /space，显示回读后的额度且项目消失。对没有本页确认标志的另一未知 ID，断言不发 DELETE。

验证：

```bash
pnpm --filter @bento/web check
pnpm --filter @bento/web test:e2e -- e2e/space-preview.spec.ts
```

PASS：Web 构建、单测及四项 space-preview Chromium 测试通过，响应丢失测试内 503 和断网两个子场景均执行。STOP：通用条件或确认前提交 DELETE、仅凭本地乐观状态宣告额度回收。

### T6：完整验证与证据收口

前置状态：项目确认与进度已提交，T1–T5 均有可追溯证据。允许修改（4）：`docs/20-interfaces/WEB-INTERFACE.md`、`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`、RUNBOOK（删除）。另专门核对（5）：`README.md`、`deploy/README.md`、`deploy/compose.yaml`、`public-files.json`、`package.json`。合计 9。禁止修改：发布入口、CI 配置或正式产品范围。

执行：

1. 接口登记实际公开和内部字段、冻结与回执语义。设计更新项目删除实现状态及账号清理互斥。Readiness 的 WEB-03 登记日期、验证基线、实现 SHA、Node/Chromium fixture、实际结果及未覆盖项。WEB-01/06 继续保留可信运维和真实联合验收缺口。没有新增生产文件或入口，既有镜像 COPY、启动命令及打包范围继续覆盖。核对清单时比较相对 main 的最终差异，临时 RUNBOOK 必须从最终树消失。
2. 删除 RUNBOOK，检查无残留引用。运行完整集合。Docker 本机缺失由同一 PR 当前 HEAD 的 `Deployment image builds` 覆盖；同时必须取得 `Repository checks`、`Web Chromium E2E` 和实时 required checks。真实联合部署保留未覆盖。Readiness 的证据明确标记 Temporal 子进程回执、Docker/Gateway、S3 为 fixture，reviewRun 仅确认成功，账号测试仅验证与项目删除的持久 drain 和上传 ID 隔离。

验证：

```bash
pnpm check
pnpm --filter @bento/workspace-api exec node --experimental-strip-types --test space-files.test.ts file-delete-hold.test.ts cancel-run.test.ts
pnpm --filter @bento/web test:e2e
git diff --check
npm pack --dry-run --json
test ! -e docs/30-designs/RUNBOOK-WEB-03-PROJECT-DELETION.md
test "$(rg -l 'RUNBOOK-WEB-03-PROJECT-DELETION' . | wc -l | tr -d ' ')" = 0
```

PASS：本地完整集合退出 0，测试覆盖实际执行；打包清单没有草稿、临时状态、凭据和受控配置。两个变更的正式文档中新增的相对链接和 heading anchor 均可解析。当前 HEAD 的 CI 与审查在提交后按 WORKER 流程完成，已合入目标分支并回读后才报告交付完成。STOP：通用条件或任何证据与待发布 HEAD 不对应，保留 PR 待审，按授权修复后复验。真实运行证据缺口记录在 Readiness。
