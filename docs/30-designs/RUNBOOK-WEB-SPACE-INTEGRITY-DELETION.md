# Web 空间写入完整性与引用删除保护

## 状态与执行者契约

- 状态：Draft，待 MASTER 审核，未获准实施。建立日期：2026-11-19。
- checkout：仅本任务绑定的 bento-b；基线 `801f087fc32f40cd52e93cab57922d5e4ba1fecf`。获审后分支固定为 `codex/web-space-integrity-deletion`。
- 起草授权仅允许调查和本文件未提交修改。MASTER 判定同版本 `Executable` 后，先按指令建分支、单独提交本文件，再收到显式 `$bento-runbook-worker RUNBOOK-WEB-SPACE-INTEGRITY-DELETION.md` 才执行 T1。
- 执行遵循 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)、[Document Rules](../00-governance/DOCUMENT-RULES.md)、[Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。每步 PASS 后删该步并提交本步产物及本文件，最后一步删除本文件。
- 每步最多 10 文件，包含本文件和专门核对的文件。发现生产缺陷时 STOP：报告准确触发、源符号、实际结果和最小修复，修订本计划获审后才能修生产代码。本版本只新增验收，不预授权生产行为调整。
- 不修改 `service.ts`、`service.test.ts`、OpenShell、Session、retry 算法或 WEB-A12。A 独占这些范围及外部窗口。本任务不操作 Docker、真实 IdP、S3 或其他已有进程；只清理本 fixture 创建的临时目录和子进程。
- 当前全流程授权在开工后包括分步提交、push、一个 PR/Ready、显式调用 `$bento-codex-comment-fix`、当前 HEAD 的 CI 和 Codex 明确结论后普通 merge、同步和清理本任务分支。允许主动向 MASTER 报告。merge 前回读最新主线，后合入方复验受影响共享边界。

## 目标、当前断点与范围

共享链路：Web 选择 -> mySpace SQLite 预占 -> 受控对象分块 -> 保存/下载 -> 空间快照引用 -> Orchestrator 持久门禁 -> 删除或拒绝 -> 对象/额度回读。

| 正式场景                                                                                            | 当前断点                                             | 本次交付与终点                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [WEB-02-02](../10-requirements/WEB-REQUIREMENTS.md#web-02-02-bad-case-路径冲突) / WEB-A05           | 原门禁及部分测试存在，逐负例证据不足                 | 无效路径、重复目标、双向文件目录冲突分别 API 拒绝，Web 正常选择显示原因，原字节、摘要、上传和额度不变                 |
| [WEB-02-08](../10-requirements/WEB-REQUIREMENTS.md#web-02-08-bad-case-分块或对象不完整) / WEB-A04   | 缺块/块大小/对象大小已有测试，独立 checksum 证据不足 | 四类各自断言，增加 checksum 错误与存储 Complete 拒绝；对象、树、上传、下载及清理/额度闭环                             |
| [WEB-03-07](../10-requirements/WEB-REQUIREMENTS.md#web-03-07-bad-case-删除命中未结束任务) / WEB-A05 | 活跃 Run 曾验证，但未逐状态和 retry 预留分别对账     | 五种 pending Run 和四种 pending retry 各自经真实双 HTTP 拒绝项目/输入 DELETE；重开保持；终态及受信结案 fixture 后放行 |

三者共同保护同一已保存来源及对象，复用同一 fixture 的存储/空间 API，逐场景独立报告。已保存 Happy Path、真实 multipart 清理、真实资源回收沿用旧证据，不重建外部栈。目标仅在每项规定断言通过后改「已实现」，父项按全部适用必需子项派生。

Non-goals：新 API、迁移、公开调试路由、生产状态机、真实恢复/可信运维证据生成、外部存储故障注入、真实模型、A 的 retry 修复、重跑全产品外部验收。恶意供应商伪造同尺寸对象不在本受控 fixture 所证明范围；不把 ListParts checksum 拒绝等同于真实供应商数据损坏注入。

## 正式依据、代码事实和复用证据

- [架构](../00-governance/ARCHITECTURE.md)：空间元数据/额度由 Workspace API 所有，Run 与 retry 权威账本归 Orchestrator，Worker 独立。
- [WEB-INTERFACE](../20-interfaces/WEB-INTERFACE.md)：空间上传和项目详情章节；Task 冻结、`task_input_refs`、`task_input_delete_holds`、source deletion 及 retry phase 章节。
- [WEB-DESIGN](./WEB-DESIGN.md)：我的空间、上传状态、单文件删除/项目删除，以及 Task pin 与 retry 保留门禁章节。
- [Readiness](../40-readiness/CURRENT-READINESS.md)：上述三行与「上传规格与验证基线」。父项当前均部分实现，其余子项当前均已实现。
- 准确入口：`space.ts::reserve/prepare/parts/finish/clean/advanceProjectDeletion/deleteFile`；不存在 `beginUpload/completeUpload`，不得照派工示意名称实现。
- `parts` 只保留编号、ETag、长度、SHA256 都匹配的块；`finish` 无有效全量块时回 uploading + 409。Complete 抛错时保留 completing，重试/清理使用原上传 ID；对象大小不符触发 failed 清理。
- `finish` 对已存在对象使用 HEAD 大小对账，针对完成回执丢失；本计划不引入重新读取全对象或改写该契约。
- `Store::projectDeletionBlockers/changeInputDeleteHold` 使用 SQL pending 五状态及 pendingRetries 四阶段；不是内存计数。

| 已有 commit / 测试精确范围                                                                    | 适用断言                                                | 本次缺口                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `59ee918`，`space-files.test.ts` 的 `WEB-A04 missing multipart parts recover`，当前 1804–1830 | 缺块、块 Size-- 被筛掉、不调用 complete、补齐后保存     | 分离个案并补实际 bytes 及下载/树回读     |
| `5adc18b`，`WEB-A04 wrong object size stays hidden`，当前 1872–1915                           | cleaning 保留预占、签名过期后 failed、对象删除/额度释放 | 独立 checksum/Complete 完整性错误        |
| `247d3e3 / 62b1d0a / a05c9d4 / 0c2c28c`，A04 同名回执丢失/重开/竞争套件                       | 原 ID、一次保存记账、重开继续                           | 只复验受影响共享边界，不称为真实 S3 故障 |
| `66d6165`，路径/Run 门禁；Readiness 的 2026-11-18 WEB-A05 基线 `6b8eefa` / fixture `e7a4cfb`  | 路径初步负例、活跃 Run、真实正常删除/对象与资源回收     | 逐类别、逐状态和持久账本对照             |

这些是历史适用证据；本轮尚未运行任何 suite，不把历史通过当成本轮新通过。

## 数据、所有权与不变量

生产结构不变。`space.ts::Upload` 的 required 字段：`id/project/owner/path/manifest:string`，`size/expires/signedUntil:number`，`storageId:string|null`，`cleanup:'cancelled'|'expired'|'failed'|null`，state 为 preparing/uploading/completing/cleaning/saved/deleting/deleted/cancelled/expired/failed。manifest 是有序 Base64 SHA256 数组的 JSON。SQLite 是 canonical owner；公开映射仅 `{id,project,path,size,state,expires}`，GET upload 另附 `parts:number[]`，隐藏 owner/manifest/storageId/signedUntil/cleanup。

调用者提供 UUID v4 的 space/upload ID；下载文件 ID 等于 upload ID，key 固定 `space/<id>`，用户路径不用于 key。服务端生成 expires=当前毫秒+24h、signedUntil 签名截止。quota=200000000、fileLimit=100000000、partSize=16777216。checksum/ID 重放不改，异输入 409 space_conflict。路径错误 400 invalid_space_input；重复路径/双向前缀冲突 409 space_conflict。无效输入不得新增预占、上传或存储写入。

只有 saved 提供树和下载，saved/deleting 计已保存额度，preparing/uploading/completing/cleaning 计预占；清理中不提前释放。parts 返回结构来自存储 `{PartNumber,Size,ETag,ChecksumSHA256}`，错误块不能参与合并。Complete 失败不得登记 saved。签名存活时 cleaning 保留 multipart/对象与预占，失效后 abort -> size/remove 确认 -> failed/取消终态再释放。

`spaceExecution::enrollTask/freezeTask/advanceTask`：快照先保存 `space_tasks` 与 `space_task_inputs(taskId,fileId,readPinned)`，冻结内容后经 httpBackend 私有 create 进入 Store。READY readPinned=0，引用行继续保留。Orchestrator `TaskInput` 精确为 `{id:string|null,name:string,sourceSpaceId:string|null,inputFiles:{path:string,text:string}[],inputManifest:{fileId:string,path:string,bytes:number,sha256:string}[],inputDigest:string}`，全部 required；snapshot ID/source 非 null。manifest 按 fileId 排序；bytes=UTF8 长度，sha256=文本十六进制 SHA256；inputDigest=排序后 inputFiles JSON 的十六进制 SHA256。`task_input_refs(taskId,fileId)` 随 create 事务生成，随 Task 清理删除。

单文件：pin 检查 -> `space_file_deletions(fileId,operationId,executionProjectId,phase)` checking -> httpBackend acquire -> Store 同事务判门禁并保存 held/denied -> denied 撤 checking/409 project_busy；held 后 deleting -> 对象不可读 -> releasing -> 原 operationId release -> deleted。operationId API 随机生成，executionProjectId nullable，phase required。GET download 在拒绝前后均应正常 302，following fixture 对象 URL 回读原始 bytes。项目：影响预检 -> holding/commit/release/cleaning -> deleted；活跃 Run/retry 拒绝 409 project_busy，无对象副作用。文件 receipt/source receipt 均经 SQLite 持久化，重开不能丢门禁。

Run pending 精确为 queued/running/recovering/cancelling/needs_review。retry pending 精确为 preparing/workspace_restored/history_restored/blocked；queued 由新 Run 承接，closed 不持门禁。retry required 字段来自 Store schema：id/taskId/sourceRunId/newRunId/key/hash/phase/lastConfirmedPhase/oldGeneration/newGeneration/workspaceSha256/historySha256/createdAt/updatedAt，error nullable。hash=SHA256(JSON.stringify({op:'retry',sourceRunId}))；UUID fixture 随机生成、时间 ISO8601、generation 1->2、摘要来自固定 fixture 字节。禁止通过公开 retry 调用改变 A 的测试链路。

终态 fixture 只证明门禁消费：Run 状态采用 `Store.status` 写入；retry 仅按 T3 固定的 Store.recordStopProof/acceptTaskRetry/advanceTaskRetry/finalizeTaskRetry 构造，在无调度器 fixture 中操作，禁止直接 INSERT/UPDATE retry_attempts。blocked 放行使用 `Store.closeBlockedTaskRetry(id,2,evidenceDigest)`，evidenceDigest 固定为 T3 列出的 fixture JSON 的 SHA256，明确不证明 service 可信观察/结案算法。结案后回读 `task_retry_closure_audit` 和 closedReason=unconfirmed。不得以 SQL 直接删除 pending receipt 假装结案。

Not Applicable：生产新增事件/outbox/Schema/迁移/部署配置；本任务没有这些改动。身份为 sessionAuth + mockAccounts、Worker/host 不执行、对象存储是物理临时文件 fixture，非 S3 实际服务。HTTP 路由、mySpace/httpBackend/Store 与 SQLite 均为生产实现。

## 代码范围账本

以下基线行段均为必须核对的既有实现/验收，单行去重，排除空白与纯注释；新增代码不用于凑门槛。原账本9文件1744有效LOC不变；为本次审核补入Store合法retry构造参考1文件150有效LOC，合计10文件、1894有效LOC。

| 文件                                           | 符号与行段                                                                                                     | 有效 LOC | 关联                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------: | ------------------- |
| `apps/workspace/api/space.ts`                  | advanceProjectDeletion 276–430；reserve/prepare/parts/finish/clean 478–691；deleteFile 804–874；下载 1033–1061 |      459 | 三场景              |
| `apps/workspace/api/space-storage.ts`          | read/create/signPart/parts/complete/empty/size 30–174                                                          |      143 | -08 的受控边界      |
| `apps/workspace/api/space-execution.ts`        | hasTaskPin/taskFiles/enrollTask/freezeTask 361–518；advanceTask 539–632                                        |      246 | -07 来源 pin 与冻结 |
| `apps/workspace/api/execution-service-http.ts` | taskForward/source forwarding 78–131；httpBackend 241–310                                                      |      123 | -07 双 HTTP         |
| `apps/orchestrator/execution-service/store.ts` | projectDeletionBlockers 440–461；input hold/source deletion 1341–1546；source impact 1658–1706                 |      271 | -07 持久门禁        |
| `apps/orchestrator/execution-service/http.ts`  | task-source 路由 193–273                                                                                       |       80 | -07 真实私有路由    |
| `apps/workspace/web/src/space.tsx`             | hasReleasedPath/pathPrefixes/planUpload 174–255；选择表单 831–903                                              |      153 | -02 正常 UI         |
| `apps/workspace/web/src/space-api.ts`          | transferFile 195–290                                                                                           |       79 | 上传入口与重试      |
| `apps/workspace/api/space-files.test.ts`       | A04 缺块 1804–1830；错大小 1872–1915；Task 快照/hold fixture 2970–3090                                         |      190 | 旧证据与接线核对    |

补入代码参考：`apps/orchestrator/execution-service/task-submission.test.ts`，173–323行的retryFixture、四阶段advance、queued finalize及closed审计消费，共150有效LOC；仅T3专门核对，不修改该文件。

## T0：作者调查与开工前复核

允许修改：本文件。专门核对：AGENTS、架构、RUNBOOK/DOCUMENT/COMMIT/PR Rules、ENVIRONMENTS.example、Readiness（含本文件共 10 文件）。代码审计见上账本，分步实施时只按各步专门核对清单加载。

2026-11-19 已观察：`git status --short --branch` 为 main...origin/main，无改动；HEAD/origin/main 均为固定基线；4353/4354 无 LISTEN；node v22.23.2、pnpm 12.15.0；ENVIRONMENTS.md 不存在，纯本地 fixture 无配置依赖。未启动任何服务。

开工前命令（仓库根）：

```bash
git status --short --branch
git rev-parse HEAD origin/main
lsof -nP -iTCP:4353 -iTCP:4354 -sTCP:LISTEN
node --version
pnpm --version
git diff --check
```

PASS：获审 RUNBOOK 是唯一任务变更；基线一致；端口命令退出 1 且无 LISTEN；版本满足现有依赖。审稿 SHA 由 MASTER 保存，获审后单独提交本文件，回读提交内容与 SHA。STOP：归属不明改动、端口占用、基线漂移影响本计划、依赖缺失；不得停旧进程或安装新依赖绕过。

## 机械步骤

已完成前置事实：T1 物理存储/真实 HTTP fixture 已交付于 `apps/workspace/api/space-integrity-fixture.ts`，其导出 SpaceIntegrityFixture/openSpaceIntegrityFixture 为后续步骤的固定契约。API happy path 1/1、API typecheck、两新文件eslint、diff检查通过；实际3字节上传/原件下载/重开/清理后不可连接均通过。backend选项、三类fault setters、suspend/reopen与performance计时边界按获审T1实现，后续不得临场改动核心签名。完整原T1可从本文件前序获审提交读取。

已完成前置事实：T2 路径/完整性两文件17/17通过，包含独立checksum拒绝、Complete拒绝、少1字节物理对象、清理拒绝仍保留额度及重开后failed/不可下载。API typecheck、两测试eslint和diff通过。故障通过T1 setter解除。后续等待固定使用 `performance.now()` 起点、check严格true才成功、5秒真实deadline、`node:timers/promises`的delay(20)，网络AbortSignal.timeout(5000)；禁止mock setTimeout/setImmediate/performance/hrtime。fake Date仅控制上传业务到期，helper见space-object-integrity.test.ts::integrityClock。原T2细节保留在前序提交。

已完成前置事实：T3 `space-deletion-states.test.ts` 13/13通过（5活跃Run、3终态、4retry预留阶段、queued承接），API typecheck通过。每个阻断状态跨实际双HTTP和两SQLite重开验证对象/输入/下载/额度保留；闭合审计与终态只为Store门禁fixture，不证明恢复/可信结案算法。按MASTER获审修订仅mock setInterval，DELETE受理后tick30000，再用performance真实5秒deadline核验；在父项目仍存时验证重复file DELETE两次204，整项目删除后只核对Task/项目/原下载404及重复project DELETE204。未修改生产代码。原T3及两次定向审核内容从前序提交回读。

### T4：正常 Web 选择入口拒收原因

前置状态：T3已提交。
允许修改：新增 `apps/workspace/web/acceptance/space-integrity-fixture.ts`、`apps/workspace/web/acceptance/web-space-integrity.spec.ts`、`apps/workspace/web/playwright.web-space-integrity.config.ts`；`apps/workspace/web/package.json`、`.github/workflows/checks.yml`、`public-files.json`、本文件。专门核对 `space.tsx`、`space-api.ts`、API fixture（合计10）；登录步骤已由作者核实并写死，执行不另加载旧 spec。
禁止修改：生产UI、根package files、其他验收配置、现有端口服务。

执行：

1. 浏览器fixture复用API fixture（跨层用根别名显式.ts），port4353/origin4354；配置Vite4354严格端口/reuseExistingServer=false，workers1/retries0，关闭trace/video/screenshot。由spec beforeAll/afterAll启动关闭fixture；身份保留T1创建的同一accounts/auth，spec用beforeAll/afterAll且只注册一次。密码只存spec局部变量，不输出、不写证据。在 /login 点击「使用邀请码注册」，账号 demo、邀请码 demo-invite、新密码 randomUUID()，注册后用同账号密码登录（复用 web-task-submission.spec.ts::login 的已核实顺序）取得身份，不通过route.fulfill替代业务。

2. 从文件选择真实临时目录/文件和setInputFiles进入清单：两个不同目录同basename以文件选择产生重复目标；已保存同名文件显示「目标路径已被占用」；目录选择生成与既有文件的前缀冲突、以及既有目录被文件占用，逐项显示原因、确认上传不可受理这些项，API无新增上传/预占/PUT，下载原字节摘要保持。正常一个无冲突3bytes控制项仍可上传保存。

3. 不构造浏览器非法系统路径。无效路径只由T2 API完整覆盖；复用现有上传清单测试证明UI invalid path guard，记录浏览器正常选择无法产生穿越路径的分层边界，不宣称真实选择到非法路径。

4. package新增 `test:space-integrity` 精确命令 `playwright test --config playwright.web-space-integrity.config.ts`；CI browser job在原test:e2e后独立执行该script。新路径全部进public白名单；不改已有默认e2e的mock证据。API所有新test由T1的自动发现接入check/CI。

验证：

```bash
pnpm --filter @bento/web test:space-integrity
pnpm --filter @bento/web check
git diff --check
```

PASS：实际Chromium正常选择、真实mySpace/SQLite/物理对象，无page.route业务替身；退出4353/4354无监听。STOP：端口占用、fixture登录不能复用、必须伪造系统路径才能满足断言。提交 `Test(task-entry): 验证真实空间接口下的上传拒收清单`。

### T5：共享边界复验与验收证据迁移

前置状态：T4已提交，MASTER确认与A合入顺序；有新主线时先在安全提交点普通merge，禁止rebase。
允许修改：`docs/40-readiness/CURRENT-READINESS.md`、本文件。专门核对 `WEB-REQUIREMENTS.md`、`WEB-INTERFACE.md`、`WEB-DESIGN.md`、README、API package.json、Web package.json、checks.yml、public-files.json（合计10）。
禁止修改：正式产品语义、无关文档与根npm files。

执行：

1. 在仓库根执行固定完整集合；T2/T3/T4已通过且代码未变的focused suite不无差别重复，pnpm check是规定整体门禁。主线合并涉及空间/任务/Store/HTTP时定向重跑本次三个API文件和Chromium script；只改文档不重跑应用套件。

2. Readiness逐行记录日期、实际基线/步骤提交、方法、case结果与Not Covered。三行均满足才标已实现；父WEB-02/03逐必需子项汇总（当前其余全已实现），不得借本地状态fixture声称真实恢复/结案/外部故障注入。

3. 检查README/架构/启动/发布：本任务只新增测试入口，生产入口/目录/部署未变，无需改生产启动说明。公开白名单逐文件覆盖；npm pack保留原根files，确认无凭据或原始trace入包。持久证据写入Readiness后删除本文件，删除仅指向它的引用。

验证：

```bash
pnpm check
pnpm --filter @bento/web test:space-integrity
npm pack --dry-run --json
git diff --check
rg -n 'RUNBOOK-WEB-SPACE-INTEGRITY-DELETION' docs README.md
```

PASS：所有规定check退出0，无skip替代必需断言；pack文件范围符合原files与公开边界；末条删除后退出1且无残留；所有本任务fixture目录/子进程回收。STOP：任何CI入口漏测、新主线影响证据而未定向复验、生产缺陷或文档冲突。最终提交 `Test(task-entry): 收口空间完整性与逐状态删除验收`，包含Readiness和本文件删除。

## PR、Review 和完成定义

一份RUNBOOK一个PR，按模板写具体行为、真实验证与限制。推送并开Draft，核对完整diff后Ready。显式启动 `$bento-codex-comment-fix` 处理本PR findings；不扩展到A的review。按当前HEAD等待所有必需CI和明确Codex结论，无结论/额度不足不得当通过；约60秒观察，有意义变化才报告。

merge前实时回读ruleset、目标main、HEAD、required checks、review线程和Codex结论。普通merge保留分步提交。新主线后合入者复验上述共享边界，更新证据适用基线。合并后确认merge SHA进入origin/main，快进本checkout，核对任务tip已合入后清理本任务分支及fixture。向MASTER回报PR、merge SHA、Readiness三子项/父汇总、CI/Codex、清理状态及Not Covered。没有审查结果或合入证据时不得宣告已交付。
