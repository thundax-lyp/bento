# WEB-03 删除与额度回收 RUNBOOK

## 状态与授权

2026-11-18，WORKER B 送审草稿，第二轮 T0 环境门禁 **PASS**，执行入口与证据已固定。产品仓执行待 MASTER 复审和派发。起点为 B 仓干净的 `main`，基线 `6b8eefa259386e4872320d179f9a714b49fb16f8`，与本地 `origin/main` 一致。执行分支待授权。

当前执行本地基线、新 B 独占环境准备和 T0 证据回读。T0 至 T7 是审核对象。T0.1 本地基线可独立执行。T0.2 新环境准备已经授权。T1、T2 产品仓文件和 Git 分支须经 MASTER 审计为 Executable 并明确下发。T3 至 T5 以前置通过为条件。任何失败保留原 ID、阶段和脱敏证据，报告最后通过步骤、失败断言、文件与符号、最小复现命令、实际结果和继续所需决定。源代码缺陷先交 MASTER 审核最小复现及精确修复计划。验收基线阶段允许修改的文件为零。

## 目标与边界

本轮在 B 独占实栈交付 WEB-03-02 正常单文件与项目删除，以及同一项目的 WEB-03-06 未完成上传清理。先通过浏览器下载已保存原件，经真实 Worker 产出补丁。删除一个源文件并复验历史，再用剩余文件所属项目验证先取消 multipart、先清理后释放预占、随后整项目删除。WEB-03-01/03/04/05 仅核对既有证据边界。

保持 [Architecture](../00-governance/ARCHITECTURE.md) 所定所有权。Space 持有原件、预占、来源意图和删除收据，Orchestrator 持有 Task、Run、结果和执行资源。本轮只通过现有入口读回完成的 Task/Run 及清理结果。WEB-03-07 活跃引用门禁是独立未覆盖项，现有活跃 Run 双 HTTP、终态后放行证据保留。WEB-06 运维结案、WEB-07 取消与恢复、共享 Task/Run 权威状态及 A 的资源超出本轮边界。发现交叠或需要共享改动则交 MASTER 排序。

## 契约和调用链

正式依据为 [WEB-03 / WEB-A03～A05](../10-requirements/WEB-REQUIREMENTS.md)、[我的空间及 Task 私有清理接口](../20-interfaces/WEB-INTERFACE.md)、[删除、输入引用与活跃门禁设计](WEB-DESIGN.md)。WEB-03-06 的操作顺序由接口明确为先取消上传，等清理完成，再提交项目 DELETE。页面预检显示 `upload_pending` 并禁用确认，同时保留独立的取消上传按钮。直接 DELETE 再检查并返回 `409 upload_pending`。

- 公开请求由登录 session 绑定 owner，写入需同源。DELETE 无正文，resource ID 来自路径。预检返回 `{fileCount,uploadCount,runCount,diffCount,blockers}`，四个计数为 number，blockers 为稳定错误码数组。个人 API `server.ts` 将内部 `deleteStatus` 映射到 `202 {state:"deleting"}` 或空正文 `204`。越权或不存在为 `404 not_found`。项目和文件门禁不确定分别为 `503 project_delete_unconfirmed` 和 `503 file_delete_unconfirmed`，同资源 ID 回查。
- 单文件经 `deleteFile → checkFileDeletion → advanceFileDeletion`。事务验证 pin 与归属并创建 `space_file_deletions`。`fileId` 对应原上传 ID，`operationId:string` 由服务生成并持久，`executionProjectId:string|null` 由已有绑定取得。通过私有 POST/DELETE `/v1/task-sources/{spaceId}/files/{fileId}/deletion-holds/{operationId}` 取还门禁，空正文，旧项目才带 `legacyProjectId`，受信 owner header 与 Bearer 绑定。收据 `state` 为 held、denied 或 released。checking 期间对象保留。held 后转 deleting 并禁止发新下载地址，仍计 saved。存储 HEAD 确认消失后持久 releasing，再等 release 收据，事务写 deleted 并移除本地门禁。原账号按同文件 ID 回 204，保留不计费墓碑。冻结输入字节、Task、Run 和补丁保持原版本。
- 项目经 `projectDeletionImpact → deleteProject → advanceProjectDeletion → cleanProject`。本地收据字段 `spaceId,owner,operationId:string`、`executionProjectId,lastError:string|null`、`phase:holding|committing|releasing|cleaning|deleted`。项目归属由 session 和持久行校验，操作键由服务生成。holding 后收敛既有来源意图，私有 DELETE `/v1/task-sources/{spaceId}` 用同 Idempotency-Key 依次 hold、commit，明确拒绝走 release 并回传原错误。未知回执沿原阶段重放。只有明确远端 204 才开始空间对象清理。逐键存储 HEAD 确认后回收对应 saved，末尾事务清除空间项目、上传、来源意图和绑定，退役上传 ID 并写 deleted 收据。项目详情及影响预检终态 404，原账号重放 DELETE 为 204。
- 未完成上传的公开记录为 `{id,project,path,size,state,expires}`，前三项为 string，size 和 expires 为 number。服务端保留 owner、可空 storageId、signedUntil、可空 cleanup。取消走 `POST /api/space/uploads/{uploadId}/cancel`，GET 查状态与已验证 parts。preparing/uploading/completing/cleaning 计 reserved。后台等待 signedUntil，经 `spaceStorage.abort` 按键找全分块会话、Abort 并以 ListParts 确认消失，有未登记原件则 DeleteObject 后以 HEAD 确认，才进入 cancelled/expired/failed 释放 reserved。
- Space 后台按持久收据恢复，同次部署重启沿用原 owner、资源和 operationId。本轮复用既有重启、回执丢失和重复请求测试。Task 从原 manifest 创建冻结输入，成功后可通过公开接口读回 Task、Run 和版本 1 的两份补丁。

## 基线代码核算

范围均相对仓根，使用基线行号。每段数字为排除空行和纯注释后的有效 LOC，相同文件行段互斥。计入验收必须核对的既有实现、测试和真实浏览器入口，数字表示调查与验收范围。

| 文件                                              | 符号或行段及行数                                                                                                                                                                      |     小计 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: |
| `apps/workspace/api/space.ts`                     | 195–432 项目预检与删除（233）；676–688 clean（13）；773–910 文件删除与 sweep（133）；918–954 额度投影（37）；1034–1060 文件 DELETE 与下载（27）；1061–1118 分块观察、取消和签名（57） |      500 |
| `apps/workspace/api/space-storage.ts`             | 19–26 键与 missing（7）；78–119 signPart/parts（42）；145–201 size/remove/abort（56）；214–230 download（17）                                                                         |      122 |
| `apps/workspace/api/space-execution.ts`           | 360–367 hasTaskPin（7）；657–686 settleProjectTasks/purgeTaskIntents（28）；734–743 projectDeletionInput（10）                                                                        |       45 |
| `apps/workspace/api/space-files.test.ts`          | 140–338 单文件存储与门禁回执（189）；339–668 项目冻结、重开和 pending 门禁（326）；1857–1909 A04 门禁与未登记对象（52）；2729–2819 A03 取消与存储确认（89）                           |      656 |
| `apps/workspace/web/src/space.tsx`                | 347–414 CloudProject 删除状态与重放（68）；560–573 remove mutation（14）；763–815 项目确认（53）；942–1000 上传取消、文件确认（59）                                                   |      194 |
| `apps/workspace/web/src/space-api.ts`             | 79–108 项目预检和删除（27）；113–133 上传取消、查询及文件下载删除（19）                                                                                                               |       46 |
| `apps/workspace/web/e2e/space-preview.spec.ts`    | 130–246 文件确认与额度（113）；247–358 项目确认与阻塞（111）；359–471 丢失响应重放（112）                                                                                             |      336 |
| `apps/workspace/web/acceptance/web-a13.spec.ts`   | 34–74 同源读取及真实快照（37）；75–158 派发、终态及结果补丁（79）；184–248 浏览器结果定位与附件校验（64）                                                                             |      180 |
| `apps/workspace/web/playwright.web-a13.config.ts` | 1–39 独占 HTTPS 与配置范式（36）                                                                                                                                                      |       36 |
| **合计**                                          | **9 个文件**                                                                                                                                                                          | **2115** |

`server.ts`、Orchestrator 的 `store.ts/http.ts/service.ts`、其余历史回归和部署文档用于交叠及证据核对，以上合计未纳入这些补充范围。授权修复前另按缺陷逐项核算改动。

## 前置与执行步骤

### T0.1 — 执行本地 baseline

前置状态：确认本地候选为既定基线；使用仓内 mock Chromium 和测试自建回环服务，无需 T0 或远端凭据。允许修改：无。禁止修改：测试断言与配置。

验证：

```sh
cd /Volumes/storage/workspace/bento-b
pnpm --filter @bento/workspace-api exec node --import ../../../register-paths.mjs --test space-files.test.ts file-delete-hold.test.ts
pnpm --filter @bento/web exec playwright test e2e/space-preview.spec.ts --project=chromium --workers=1
pnpm check
```

PASS：三命令退出 0，文件/项目删除、门禁、重复请求、重启保留及 A03/A04 相关用例通过，浏览器确认和重放用例全部通过。STOP：任何失败或预期用例未运行，附测试名和精确断言。

本轮实测（2026-11-18，`6b8eefa`）：三条命令均退出 0。定向 API 22/22，覆盖单文件删除在存储与执行收据确认前保留额度、双 HTTP 项目删除与 ID 退役、个人 API 重启后的原收据回读，以及 WEB-A03 取消/过期/删除的回收与 WEB-A04 六项。Chromium 5/5，覆盖确认前预览/下载、确认后等待额度、项目门禁和丢失删除响应后用原编号回读。仓库级 `pnpm check` 通过，其中 Orchestrator 88 通过、2 跳过。浏览器为本地 mock，API 为受控存储 fixture。本轮无需实栈入口。

### T0.2 — 核准 B 专用候选和运维入口

前置状态：MASTER 派发 T0 并授权新 B 独占环境。允许修改：仅本轮私有准备文件和已核实归属的新资源。禁止修改：A 环境及旧 B 资源、产品代码和 Git 分支。

1. 在 B 仓执行 `git rev-parse HEAD main origin/main`、`git status --short --branch`。本轮产品候选固定为 `6b8eefa259386e4872320d179f9a714b49fb16f8`，验收夹具另存版本摘要。运行镜像、Worker、宿主及其配置分别记摘要。Worker 采用获核准的 B 私有真实 DSH/OpenShell 运行件，记录来源、覆盖层差异及摘要。未经核准的镜像或覆盖层不能证明本基线。
2. B 无 `ENVIRONMENTS.md`。已只读检查 MASTER 仓说明的 Docker 测试和工作树配置，以及 B 私有 `debug-workspace/web-a08/` 和 `debug-workspace/web08-stack/`。先静态核对历史脚本，再用受控 SSH 盘点并启动本轮新资源。

| 已查入口                                                                                            | 可复用内容                                                  | 唯一真实命令的阻断                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B 私有 `web-a08/find-b.sh`、`inventory.sh`、`candidate.py`、`stack.sh`                              | 历史资源归属核验、候选摘要校验及预检、启动、停止分工        | discover/stack 使用历史 B A13 路径和候选绑定。旧脚本不得直接运行。新清单可用下文通用 Compose 命令，历史 transport 供复用传输和受控调用方式。                             |
| B 私有 `web-a08/storage.sh`、`ref-web05-storage-stage.sh`、`cleanup.sh`                             | 旧桶归属核对、独占签发与撤场方式                            | 桶和租约绑定旧 A13。现有 WEB-A02 checker 公开契约只有 saved/absent，无法证明指定 uploadId 的第一块或清理中状态。需核准针对新桶的只读精确键检查器及新资源的撤销权限。     |
| B 私有 `web08-stack/a13/run-live-a13.sh`、`web-a08/run-acceptance.sh`、仓内 A13/A08 Playwright 配置 | 严格 TLS 及真实浏览器鉴权，A13 真实 Worker 和补丁读回       | 历史 runner 选择旧 case 和身份；本轮使用下文专用 Playwright 配置，身份文件与 endpoint 绑定新租约。                                                                       |
| 仓内 `deploy/compose.yaml` 和 [部署手册](../../deploy/README.md)                                    | 服务装配、Temporal 队列隔离和受信 Workspace/沙盒 purge 接口 | 通用 Compose 无 WEB-A05 租约分配。需固定新部署项目名、独占 Temporal namespace/queue、卷、桶、Realm/账号、端口、执行宿主与镜像等归属，使下文 Compose 命令只作用于新租约。 |

#### T0.2 实际环境记录

2026-11-18 北京时间 16:18:52 取得新租约，截止 18:18:52。通过 B 私有 SSH helper 验证固定 host key，宿主 Compose 为 2.35.1。分配前监听和 Docker labels 均查空。仅在新租约内执行，项目名 `bento-b-web-a05`。Web TLS 19443、S3 TLS 19444、Gateway mTLS 19445、Gateway 健康端口 19809。19808 已登记备用，起租时空闲。避开 A 的 18443、18444、18445、18808。新资源写入前验证 lease scope、UID、截止及现有归属。

已执行入口在 B 忽略目录 `debug-workspace/web-a05/`。以 `python3 debug-workspace/web-a08/ssh.py 'bash -s' < debug-workspace/web-a05/<脚本>` 执行已核准 shell 步骤。新资源归属可回读 `com.docker.compose.project=bento-b-web-a05`、`io.bento.lease=bento-b-web-a05` 或运行时资源 `bento.web08=bento-b-web-a05`。所有历史资源仅核对不可变运行件或配置来源。

| 实际步骤         | 命令及回读                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基线候选         | `git archive --format=tar.gz 6b8eefa259386e4872320d179f9a714b49fb16f8` 经受控 SSH 导入新候选目录，Compose 文件 SHA-256 为 `6b802a627c732e16bc4f105c8bc6a8706b588986696b02ea6e4dba69e8632693`。                                                                                                                                                                                                                                                             |
| 构建             | `build-candidate.sh` 的常规源构建在远端依赖下载阶段失败。离线路径用本机 Go linux/amd64 交叉构建和 OIDC Web 产物，Orchestrator 容器依赖清单逐字节匹配，Web 基础运行件对应 `36ab687`，相关依赖清单在基线间无差异。 `build-offline.sh` 通过，r2 Web 镜像为 `sha256:0d5c32f5e39ec33fa324f0d8f4796d3c36b3f6a602371a72df1bc1e35c38ac70`，Orchestrator 为 `sha256:4ea1acbe3340147b0394f5acd6156bd2b9460cb51d5cdf6d48af71f201718da5`。两者版本标签均回读到本候选。 |
| S3               | `start-storage.sh` 以 MinIO RELEASE.2025-09-07T16-13-09Z（`sha256:b9d8e234865d3b9ad2c872fde5ea6eea9eea3e196a218586809a034de1f56f26`）在专属网络启动，严格 TLS 通过。 `probe-storage.py` 创建独立无版本桶，签发分别受限的 app 和 observer STS。只读者的 PUT 被拒。实际 16 MiB ListParts、精确键 HEAD 及清理回读通过。                                                                                                                                       |
| OIDC             | `stage-identity.sh` 启动独占 PostgreSQL、Keycloak 26.8.2 和 TLS 代理，实测 HTTPS discovery issuer 精确匹配。 `provision-account.sh` 通过，只创建本 Realm 中验证邮箱的 B 测试用户和组织成员资格。                                                                                                                                                                                                                                                           |
| OpenShell        | `stage-gateway.sh`、`retry-gateway.sh` 用 0.1.6 镜像 `sha256:95e67567f4524e198efb67095169c3745b746024178ebc9416266af09025b8dc`、新证书和独立 SQLite、标签与端口启动。健康回读为 200。用已复制 CLI、单独 XDG 配置和新证书执行原 scope 的 sandbox list 成功，无证书同操作被拒。                                                                                                                                                                              |
| Worker 运行装配  | `stage-runtime.py` 把现有运行件及候选 Worker 源码放到专属目录，`recover-relay.sh` 声明并回读单独控制及代理 socket。实际 Worker 镜像为 `sha256:4124547c03b00df0889ad5fa3dc6aa21f9942ebc920654a0415c349d68374ef2`。环境摘要为 `sha256:57cd772c1a3b0bc38328409fd4fc44d7ba9ba0ffc680978e086bfe13abd1e115`。                                                                                                                                                    |
| 观察和撤场       | 私有 `observe.py` 提供 storage/runtime 子命令。以 `python3 "$HOME/bento-b-web-a05/inputs/observe.py" storage` 或 `runtime` 后接 T2 参数使用。 `teardown.sh` 先核对恢复记录、运行资源和进程指纹，再移除本轮资源。已上传并语法检查，待 T7 现场执行。                                                                                                                                                                                                         |
| 候选应用         | `start-app.sh` 使用独占 Compose project、独立 Temporal 锁和命名卷。先修复本轮 Temporal SQLite 卷权限和应用镜像读权限，再确认代理、Web、Orchestrator、MySQL、PostgreSQL、Keycloak、Temporal 七服务已启动，Web、Orchestrator 和数据库 health 通过，HTTPS 未登录 session 为 401。                                                                                                                                                                             |
| 真实浏览器       | `run-browser.sh --worker` 使用本轮 CA 的 Chromium，Web/S3 严格 TLS、真实 OIDC 回调、独占空账号和 Space API 均通过。受控探针上传并从真实源文件完成 Task Workspace 准备，独立 `observe.py runtime workspace` 回读精确 Task、沙盒、卷及独占标签。                                                                                                                                                                                                             |
| Worker 探针 STOP | `run-browser.sh --resume-worker` 继续原 Task 后真实提交 Run，接受 202。私有 transport 启动并回收 Worker，但 Run 在 180 秒后仍为 recovering。只读回读 Session、Worker 退出证明、停止证明、恢复及结果记录均为零。未通过 T0 PASS；不计入 WEB-03-02 或 WEB-03-06 实栈验收。                                                                                                                                                                                    |
| Worker 导入定位  | 用同一 Worker 镜像和只读 bootstrap、无网络容器复现 `ERR_MODULE_NOT_FOUND`。只在本轮私有 bootstrap 增加指向现有唯一锁定包的链接后，`check-bootstrap.sh` 中 base、task-bootstrap、dsh-worker 三个导入均通过。原探针使用现成脚本化模型夹具，该夹具要求 execute；缺少能按同一 Run 取得可信停止和恢复结果的可用启动配置。导入通过未证明实际修复了原 Run。                                                                                                       |
| 截止处置         | 停止前确认探针仍 recovering、归属为本 B 项目且无运行中的 Worker 容器，然后只停止本 B Orchestrator，避免 Temporal 重复尝试。保留同一原 Run、账本、Workspace、Session 观察入口及资源。撤场门禁受原探针阻断，需经已核准可信宿主恢复或结案后，走原项目删除并执行 T7。                                                                                                                                                                                          |

#### T0.2 续验结果

2026-11-18 北京时间 17:20:03 开启第二个 B 独占租约，截止 19:20:03。已重新核验原租约 Docker 容器、网络、卷和监听均为空后才重新分配同一专属名称和端口。第二轮重新生成身份、CA、mTLS、桶和凭据，复用第一轮已核准的 B 镜像及本地构建产物。17:20:41 签发一小时 STS，派发时按剩余有效期核对 20 分钟验收及撤场窗口。剩余不足时，先在本租约内按原 `rearm-storage.sh` 的 `probe-storage.py` 步骤续发，再用新会话重启本轮 Web 读取当前凭据，复核严格 TLS 和空账号。禁止将原凭据用于重建。

| 证据          | 结果与位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原 Run 及撤场 | `archive-run.sh` 用只读挂载复制原账本，确认唯一 Run 仍为 recovering，Session、可信退出、停止证明、恢复记录和结果均为零。原 business SQLite SHA-256 `37f9fa49dc1182513412603418a46126f0d1a5b6e401d5913a27e0489a7a8439`。按当前 `commandHost` 的 SDK 及停止证明入口，当前 Run 缺少可信结案所需事实。 `retire-original.sh` 先停本轮 Web，按原绑定清理沙盒和卷，按原空间账本键清理真实对象，核对无分块，再用本轮 `teardown.sh` 回读容器、网络、卷及端口全空。原账本在退役租约私有证据目录保留，未手改或重投。 |
| 新配置        | 只读核对 A 的运行机制。B 的 `prepare-worker-v2.sh` 准备 B 自有原位 bootstrap，调用原 `run-worker.ts`，进程仅按 Run 获得 persistence、operation 和 SDK socket。私有 host 接上标准 SDK Exec 事件解码，校验真实退出。三项实际 Worker 导入检查通过。未使用 A 的镜像标签、运行资源、认证资料或目录。                                                                                                                                                                                                           |
| 运行          | `run-browser.sh --worker` 仅运行一个新探针。实际严格 TLS、OIDC、空账号、浏览器上传和从文件创建 Task 通过。以本轮确定性的脚本化模型响应驱动真实 DSH/OpenShell 改写隔离卷，Run 为 succeeded，公开回复和累计补丁中 `+one` 均读回。第三方模型调用不在本证据范围。                                                                                                                                                                                                                                             |
| 删除及观察    | `confirm-probe-clean.sh` 先通过 `observe.py runtime capture` 读回 Task、Session、沙盒及卷的原绑定。再经正式 Space 项目 DELETE 达到 204，同 ID 重放 204，对应项目、Task、Run、补丁、原件下载返回 404，账号 saved/reserved 为 0/0。最后独立按精确对象 ID 和原执行绑定核对 S3 HEAD 缺失、multipart 缺失、Session/沙盒/Worker/卷均不存在。探针的浏览器身份文件已清理，复跑的 Web、S3、Gateway 和宿主进程仍归第二个租约。                                                                                      |
| 脚本绑定      | `bootstrap-a05.ts` SHA-256 `11483105e7c0b9a659e6b9e7d4df94ef6ec123dabe59de1ffe1dde6377952903`，`confirm-probe-clean.sh` SHA-256 `c42cc951cb9a2e38e0a3a9e2593df2acbdb9ef834b458c965a94d5dc05dd534d`，`observe.py` SHA-256 `383015ba24d2a617d827b79d753ece164f74476425b8fc22024f24913293b81c`，最终撤场 `teardown.sh` SHA-256 `777d1ca566e8781db5ddd03cafc94b3212dce4d512a906f32ec5209a1bf4eac6`。                                                                                                          |

T0 **PASS**。本轮证据限定于环境先决条件和独立探针。WEB-03-02 的单文件全链与 WEB-03-06 的项目内上传门禁仍以 T3–T5 正式验收为准。B 产品仓分支与实现等待 MASTER 明确下发。

#### 新 B 租约资源清单

候选发布至新根目录，固定为受控宿主租约根 `BENTO_A05_LEASE_ROOT` 下的 `candidate`，仅从本地候选提交导出源码。租约根、宿主和任务所有者由现有受控入口绑定。以下名称统一使用一份预检确认的 `BENTO_A05_PROJECT`，固定为 `bento-b-web-a05`，本轮通过宿主新目录的原子创建及租约有效期锁定。

| 资源                               | 可按租约派生                                                                                                                     | 配置入口与归属验证                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose 项目、默认网络、六个命名卷 | 可。Compose `-p` 隔离默认网络和无显式 name 的卷；启动前确认相同项目标签及派生名称从未被占用。                                    | 读取 Docker Compose labels、network 和 mount metadata。执行和 Keycloak 绑定目录均从新 candidate 的 `debug-workspace/` 派生，校验绝对路径及非 symlink。                                                                                                                                                                                                                    |
| Web/Worker 镜像标签、回环端口      | 可派生新标签；端口须在受控宿主锁定并预检空闲。Compose 原有固定端口和显式 `:local` 镜像标签不会随 `-p` 隔离。                     | 专用 override 使用 `ports: !override` 覆盖 Web 的默认发布，其余 Temporal 和 Mailpit 不发布，用 `ports: !reset []`。Web 镜像改为项目名专属标签，Worker 用其独占运行件摘要，若构建 Worker 镜像也用独占标签。镜像回读与运行件清单一致。                                                                                                                                      |
| Realm、账号、业务凭据              | 独占 PostgreSQL/Keycloak 可创建新 Realm、客户端、组织和测试用户；数据库与服务 bearer 可本地生成。                                | 候选目录 `debug-workspace/keycloak-import/`、`web.env` 和根私有 .env。需获准组织登录入口和受控测试身份交付。通过严格 TLS 的 issuer/callback、实际登录和空空间基线核验。                                                                                                                                                                                                   |
| Temporal                           | 独占开发 Temporal 服务及命名卷，自带 `default` namespace 可用；队列设为项目名。原生容器网络地址为 `temporal:7233`。              | `debug-workspace/execution.env`。预检验证进程端点属于新网络、namespace 位于本租约实例、队列配置与清单一致。若宿主要求接入共享 Temporal，则 namespace 的创建或使用权限必须由管理员分配。                                                                                                                                                                                   |
| 存储                               | 桶名可用项目名。原生 Space 键固定为 `space/{uploadId}`，仅换项目名或设置共享桶 IAM scoped prefix 无法给 Space 添加新的租约前缀。 | `web.env` 的 `BENTO_SPACE_S3_ENDPOINT`、`BENTO_SPACE_S3_BUCKET`、`AWS_REGION` 及 AWS 凭证链。作法固定为独立桶，关闭版本留存，凭据仅作用于该桶和 `space/`。管理员须授权在现有服务创建新桶及签发凭据，或授予新独占 MinIO 实例所需宿主资源与 TLS 入口；历史 storage 段可供核对所需权限。验证真实、无缓存的分块 PUT、精确键 HEAD、ListMultipartUploads/ListParts 和跨桶拒绝。 |
| OpenShell、Worker、模型            | Task ID 及独占绑定由执行系统创建。Compose 命名卷和项目名不能授予 OpenShell scope 或匹配已有 volume 驱动的访问权限。              | `execution.env` 的 `BENTO_HOST_CONFIG` 或 `BENTO_HOST_MODULE`，以及可信镜像/策略摘要生成的 `BENTO_EXECUTION_ENVIRONMENT_VERSION`。需获准 B scope、mTLS、适配器与私有 Worker/模型运行访问。实际 probe 校验绑定、宿主 scope、沙盒、卷标签及幂等 purge。历史 gateway 脚本有端口检查、证书签发、probe 和清理逻辑；其授权输入仍待本轮分配。                                    |
| Web/S3 HTTPS、宿主控制             | 可生成专属回环映射和配置，入口域名/路由、浏览器信任链及 Docker/受信宿主操作权需已有受控权限。                                    | 使用 MASTER 仓环境说明定位宿主，通过 B 历史 SSH/transport 的受控方式提交精确命令。本轮实际受控宿主和新资源回读见下文。实际环境需分别验证容器及 Chromium 所见 issuer、S3 CORS/签名 origin 和 CA。                                                                                                                                                                          |

#### 既有 Compose 的固定预检、启动和撤场顺序

在受控宿主、独占锁已取得、私有配置已装入新候选目录后执行。环境变量只加载绝对路径、项目名及配置路径，敏感值从租约文件读取。下面仅为将来实栈执行门禁，草稿轮次均未运行。

```sh
cd "${BENTO_A05_LEASE_ROOT:?}/candidate" || exit 1
compose_a05() {
    docker compose --project-name "${BENTO_A05_PROJECT:?}" \
        --env-file "${BENTO_A05_LEASE_ROOT:?}/compose.env" \
        -f deploy/compose.yaml -f "${BENTO_A05_LEASE_ROOT:?}/compose.override.yaml" \
        --profile dev "$@"
}
compose_a05 config --quiet
```

预检须在创建前以 Docker labels 验证没有同名项目的容器、网络和卷，以主机监听清单核对预分配 Web 回环端口，以静默解析后的 Compose 模型核对镜像标签、mount、端口、环境版本及服务列表。命令输出仅记录断言。然后用既有 Compose 启动与查询，无需等另写一套部署脚本：

```sh
compose_a05 up -d temporal
compose_a05 exec -T temporal temporal operator cluster health --address 127.0.0.1:7233
compose_a05 up -d --build --wait --wait-timeout 300 bento-web mysql orchestrator postgres keycloak
compose_a05 ps
```

Temporal health 以每两秒一次、最多 60 秒轮询，退出 0 才启动其余五个服务。启动后核对六个服务归属、Docker health 和 Temporal，使用严格 TLS 登录 B 测试身份并核对空空间，执行 B Worker 探针与存储只读权限探针。Mailpit 和 Compose Worker 构建目标不参与本轮。真实 Worker 从受信宿主按 Task 启动。TLS、存储和 OpenShell 由其已批准的租约入口装配。

撤场先按原资源 ID 完成取消和业务删除，在租约内确认对象、multipart、沙盒、业务 Session 和卷清理，再撤租约专属凭据与入口。Compose 收尾须先按同一清单回读归属，仅当业务资源确认清完且已获授权时执行：

```sh
compose_a05 down --volumes
docker ps -aq --filter "label=com.docker.compose.project=${BENTO_A05_PROJECT:?}"
docker volume ls -q --filter "label=com.docker.compose.project=${BENTO_A05_PROJECT:?}"
docker network ls -q --filter "label=com.docker.compose.project=${BENTO_A05_PROJECT:?}"
```

三个回读均须为空。外部资源再按各自租约权限复核。失败保留业务 DB、原资源 ID 和同一租约，不先执行 down --volumes。阶段截止固定为最多 120 秒无进展、180 秒等 Worker 结果、720 秒等 multipart 清理和单次 20 分钟；外部资源撤场截止由 MASTER 随租约确认。

PASS：独占环境、实际应用健康、真实浏览器鉴权、只读存储与执行观察和实际 Worker 探针均通过，探针资源按原入口清干净。STOP：任一前置不满足。原探针按独占环境撤场保留证据，第二轮已完成应用启动、单轮运行和探针清理。租约或 STS 时窗不足时先更新本轮资源并复验。

### T1 — 只读验收观察器

前置状态：T0 已确认新租约及观察权限。优先复用本轮私有 `observe.py`，第二轮 `capture` 和 `absent` 已通过真实探针验证。本轮选定该私有入口，仓内脚本保留为复审拒绝私有入口时的后备。MASTER 审定私有入口不足并另授权新增时，允许新增 `apps/workspace/web/scripts/observe-web-a05.mjs`。禁止修改产品、宿主状态及部署入口。复用候选 Workspace API 已声明的 AWS SDK，从该包的 package.json 创建模块解析入口。仅执行 HeadObject、ListMultipartUploads、ListParts，按 exact key 和稳定 upload ID 对账，遍历分页。入口固定为 `node apps/workspace/web/scripts/observe-web-a05.mjs storage` 后接下节参数。绑定 endpoint、bucket、region 和单独只读凭据，拒绝改写及跨租约参数。

执行入口固定为 `node apps/workspace/web/scripts/observe-web-a05.mjs runtime` 后接下节参数，仅在 B 租约宿主本地运行。输入为受控挂载 `business.sqlite`、`history.sqlite` 的绝对路径、同租约的运行资源只读观察命令和一个 0600 的捕获文件路径。以 Node SQLite `readOnly: true`，用 `tasks.id = projects.id` 回读 `projects.sessionId/sandbox/volume`，从 `history.sqlite.sessions` 按 `id` 观察 Session。捕获时验证 Task 对应沙盒及卷均出现于受信宿主观察，并记录原绑定。Worker 真实性由 T0 的运行件及 T3 的实际 Run 证据确认。终态按同输入外部观察命令及精确绑定确认沙盒、卷和 Session 消失。外部观察命令须由 MASTER 按实际 host driver 固定并校验来源，观察器不调用 purge 或修改 SQLite。

验证：

```sh
cd /Volumes/storage/workspace/bento-b
node --check apps/workspace/web/scripts/observe-web-a05.mjs
node apps/workspace/web/scripts/observe-web-a05.mjs --self-test
```

PASS：自检使用私有临时目录与受控响应，涵盖 HEAD 404 与 403 区别、精确键与前缀相似键、分页、第一块、已清理、租约错配拒绝、SQLite 只读和原绑定查无。实栈前仍需以新租约现场探针确认身份及 API 权限。STOP：需新增生产依赖、共享实现或额外写权限，或运行侧缺可信只读观察。存储及执行命令通过租约受控 wrapper 绑定给下节两个检查器输入。

T2 本地门禁已通过。验收配置 `apps/workspace/web/playwright.web-a05.config.ts` 和 `apps/workspace/web/acceptance/web-a05.spec.ts` 已定型，typecheck 与定向 ESLint 通过，`--list` 唯一发现 `WEB-A05 B isolated deletion and quota reclamation`。T3–T5 依次由该测试的三个步骤运行，使用本轮私有观察入口及 0600 恢复文件。运行命令为 `pnpm --filter @bento/web exec playwright test --config playwright.web-a05.config.ts --workers=1`，实际环境、证据与清理按 T0 和各步骤执行。失败时保持同一恢复记录，按原 ID 清理，达到截止保留现场交 MASTER。

### T3 — WEB-03-02 / WEB-A05 单文件

前置状态：T0.1、T0.2、T1、T2 通过，B 账号单独使用。允许修改：无。禁止修改：Worker、点名对账结果。

执行：

1. 浏览器创建名称为 `WEB-A05 ` 加随机 UUID 的干净项目。从文件夹 `web-a05` 上传 `src/input.txt`（UTF-8 `base\n`）和 `keep/keep.txt`（UTF-8 `keep\n`）。核对树、大小、文本预览、原件下载 SHA-256。路径穿越和重名按现有 WEB-A05 本地负例回归。记录空间 `saved`、`reserved` 和待删文件长度 N。
2. 从待删文件创建真实 Task，向真实 Worker 提交固定串 `WEB-A05 fixture append one`，等待 Run 成功产出非空补丁。T2 配置步骤在专属 bootstrap 增加该固定串与原样本 `src/input.txt` 的唯一绑定，仍只执行核对 base、追加 one 换行、回读实际卷字节的固定动作。真实 DSH/OpenShell 执行采用第二轮已验证的脚本化模型响应。保存 Task/Run 标识及结果版本，分别读取 incremental、cumulative 的预览及实际下载字节，核对与结果内两个 SHA-256 一致。
3. 打开文件删除确认，检查路径与历史保留提示，退出确认并再次通过浏览器下载同一 SHA-256。重新打开并确认，捕获 DELETE 状态及空间投影。以同源原入口核对已接受删除后无新下载或预览签名。DELETE 的同源调用在浏览器 session 内发送 Origin，GET 对 302 禁用自动跳转以便区分签名发行和存储读取。
4. 独立查真实存储精确键。通过已确认的观察入口建立 HEAD 缺失与最终额度的时序。实栈轮询如捕获 deleting，断言仍计 N。无论是否捕获瞬态，T0.1 的文件删除与 WEB-A03 deleted quota 两组存储故障断言均须通过，证明故障期间额度保持。实栈终态单独证明真实存储与额度闭环，证据记录是否实测到中间态。
5. 终态重复同文件 DELETE 两次，两次均为空正文 204。重新打开 Task、Run、结果及两份补丁，比较版本与原字节。确认下载签名路径为 404，独立 HEAD 缺失，保留文件的字节和用量一致。

PASS：最终 `saved` 仅减少 N，`reserved` 与起始相同，重放无额外变化，Task/Run 仍可读且补丁字节未变。STOP：任一断言失败或存储身份无法确认。保留原操作查询，不手工删对象。

### T4 — WEB-03-06 稳定 multipart 停点与取消

前置状态：T3 通过，项目剩一个已保存样本和已完成历史。允许修改：无。禁止修改：bucket 生命周期、时钟与对象账本。

1. 用同一浏览器登录会话 POST 原项目 uploads，新 UUID，路径 `pending.bin`，大小 16,777,217，内容全零，两块 SHA-256 以 Base64 提交。请求 part number 1 后用页面浏览器 fetch 以 Blob 发送 16,777,216 字节，头为返回的 `x-amz-checksum-sha256`，HTTP 2xx。禁止申请第二块签名及调用 complete，形成稳定停点。确认 API parts 为 [1]，检查器 `part-one` 成功。服务端清理围栏为签发时刻加 605 秒，采样从签发请求完成开始计时。
2. 页面打开项目删除预检，断言 `uploadCount = 1`、`upload_pending` 和确认禁用。同一登录会话发直接 DELETE，断言 `409 upload_pending`、剩余文件仍可按摘要下载。关闭确认，点击上传行的“取消上传”。在签名有效窗口内读回 cleaning，`reserved` 仍有 16,777,217 字节、项目直接 DELETE 仍为同一 409，检查器仍证实已存第一块。若签名窗口已不足且未观察到这组断言，本步 STOP 并记录原 ID 后清理。
3. 每两秒查询原 upload 状态与精确键。进入 terminal 前，读到 cleaning 的同一响应轮次保留预占。终态要求 cancelled、`multipart-absent` 和 `head-absent` 均成立，reserved 回到 T3 基线。重放取消一次，预占无变化，项目影响预检不再含 upload_pending。不可将一次并行采样中的先后推断为原子时序。故障下保留预占及真实清理后释放的因果顺序还须由 T0.1 的 WEB-A03 cancelled quota 和 WEB-A04 wrong object size 两组断言支持。

PASS：已在真实存储写入且清理第一块，观察到 cleaning 保留预占和项目门禁，终态预占精确释放，项目可进入 T5。STOP：对象或分块无法对账、预占提前释放、DELETE 提前被接受或拒绝码错误。

### T5 — WEB-03-02 整项目删除

前置状态：T4 通过。允许修改：无。禁止修改：共享执行状态。

1. 通过 `capture {taskId}` 确认旧 Task 的执行资源，重新预检并校验界面说明文件、执行工作区、任务历史与补丁均移除。确认前下载剩余原件与补丁，摘要与基线一致。
2. 在页面确认删除。按同项目 ID 等 204，间隔两秒回读且不换 ID。读回项目详情、影响预检、原件下载、历史 Task、Run、结果及两个补丁入口均为 404，Task 列表移除。检查器确认两个文件精确键缺失、无 multipart；执行检查器确认原绑定资源已回收。
3. 同项目 ID 再 DELETE 两次，均为空正文 204。该独占空账户的 saved/reserved 回到 0/0，T3 已回收的字节本步没有再次影响额度。

PASS：关联入口、真实存储、执行资源均回收，额度稳定且重放结案。STOP：任一入口、对象、执行资源或额度无法对账。

### T6 — 复核现有证据和一级状态

前置状态：T0.1 至 T5 的结果可追溯。允许修改：获授权时仅 `docs/40-readiness/CURRENT-READINESS.md` 的 WEB-03-02、WEB-03-06、一级汇总证据。禁止修改：A 的 WEB-07 和其他需求状态。

| 子项  | 可复用证据                                                                                                                                                                                                      | 剩余条件                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 01/03 | Readiness 记录 A 独占实栈在 `3e11d9b50ef3464004debc9b4caa159154ec0981` 的实际 100 MB × 2、零预占、满额再加 1 字节返回 409、单笔并发预占通过；A02 下载摘要一致。基线相比该提交，Space 核心和存储适配文件无差异。 | T0.1 复验本地 A03 容量与并发，核对 UI 单文件、额度、项目和队列提示区分证据；T4 对账回收后的可用额度。                                   |
| 04    | 同一实栈已证取消并回收；本地 WEB-A03 取消/过期用例断言 cleaning、存储确认、额度复用。                                                                                                                           | T0.1 复核 expires 字段与过期清理；T4 补当前 B 真实取消及 multipart 顺序。现有记录的过期边界为受控时钟，B 真实自然过期作为未覆盖项记录。 |
| 05    | WEB-A04 本地双向竞争及同库重开，真实 HTTP、SQLite 与受控存储。                                                                                                                                                  | T0.1 重验完整 A04，记录重复完成或取消、对象和额度对账结果。真实存储的故障竞争未获验证，证据按环境分开记录。                             |
| 02    | T0.1 的本地双 HTTP、SQLite 和 Chromium 删除证据，B 独占 WEB-A13（`36ab687`）证明真实 Worker 和历史结果读回。                                                                                                    | T3 与 T5 均通过才更新 -02。                                                                                                             |
| 06    | WEB-A03 取消实栈与受控时钟清理证据。                                                                                                                                                                            | T4 独立通过才更新 -06。                                                                                                                 |
| 07    | 已有活跃 Run 阻塞项目删除、终态后允许删除的本地双 HTTP 证据。                                                                                                                                                   | 独立未覆盖项，逐状态和引用文件门禁需另行验收。                                                                                          |

PASS：仅按 -02 和 -06 各自结果填写日期、候选、环境、命令、断言及 Not Covered。一级 WEB-03 因 -07 仍待独立验收保留 **部分实现**。其他子项状态沿用现有 Readiness。STOP：候选漂移影响证据或并行 Readiness 更新无法核对。提交前按最新目标分支逐行同步并复验受影响项。

逐提交边界经 MASTER 下发分支后执行。每次先核对 diff 所有权与门禁，再提交本步文件：

1. T1 已选定经验证的私有观察入口，核对并记录协议及证据。若 MASTER 选定仓内观察器，则单独提交 T1 观察脚本，以语法、自检和隔离 probe 为验收门禁。
2. T2 夹具与配置单独提交。用 Playwright `--list` 核对仅匹配预期用例，再通过 B 实栈 T3、T4、T5 和 `pnpm check`。不得为夹具改产品契约或共享执行状态。
3. T6 和 T7 在证据完整且已撤场后收口。Readiness 与本手册清理同一提交。PR 前按实际变更重跑门禁。A 先合入后，同步、逐行核对 Readiness 并复验受影响场景。B 先就绪则将实况交 MASTER 确认顺序。

### T7 — 撤场和收口

前置状态：T6 已记录结果。允许修改：经授权更新上述 Readiness 范围并删除本 RUNBOOK。禁止修改：其他租约、账号、对象及留存证据。

执行：按 T0 核准命令清理 B 专用临时数据、凭据、进程和执行资源。回读基线和实际清理结果；仍待清理则记录原 ID 和阶段并保留租约。所有覆盖与残余风险迁入长期文档后删除本 RUNBOOK，用 `rg -n 'RUNBOOK-WEB-03-DELETION' . --glob '*.md'` 查残余引用，并运行 `git diff --check`。提交及 PR 按 [Commit Rules](../00-governance/COMMIT-RULES.md) 和 [PR Rules](../00-governance/PR-RULES.md) 的授权执行。

PASS：B 专用资源清理可核对，长期证据完整，临时手册及专用引用回收。STOP：原资源可见、清理权限不足、验证未收敛或缺收口授权。只提交明确获准的夹具和 Readiness 范围。本轮复审草稿保留在 B 本地未提交。
