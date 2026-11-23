# A7 单节点停服备份还原与进程重启

## 状态、日期与边界

- 建立日期：2026-11-23。
- 状态：**待 MASTER 审核本地执行链；T0-local 已有作者证据，T0-remote 尚未执行且仍为部署前强制门禁**。
- 基线：`da8d34cc6784a833d0d2cb448c87873b5515e643`，`bento-b` 的 clean main；本稿未建分支、未提交。
- 工作边界：只在 B checkout 起草；拟执行分支 `codex/single-node-restore`，尚未建立。
- 远端窗口：A 的 WEB07 验收优先。MASTER明确释放前，不建立隧道、不执行资源/能力探针、不创建容器/网络/卷、不改镜像；仅保留已授权B历史源码和精确身份元数据的SSH只读范围，不读取A私有candidate/状态。
- 用户授权由 MASTER 派工传达；当前阶段仅作者调查和送审，不因全流程授权提前实施。

## 执行者契约

本稿当前仅送审。MASTER审定T0-local及本地链Executable后，进入WORKER执行本地步骤；T0-remote作为后续强制子门禁，在远端部署/恢复之前通过。不能用本地批准替代远端门禁，也不能用尚未构建的镜像ID阻塞纯本地工具。

审核前允许读取已授权来源、写本稿、检查链接/格式，不创建分支/commit或实施。审核后按已继承全流程授权逐步执行/提交，只操作本任务文件；远端资源仍受T0-remote及MASTER窗口控制。禁止修改前任务验收来源，不得把待验断言记为PASS。

执行时每步最多 10 个不同文件，计入 RUNBOOK 和专门核对来源；每步独立验证、提交后，下一步才消费该干净提交部署。失败保留当前步骤和本轮证据；不清理历史数据、不重置用户改动、不静默改 fixture 或降低断言。

## 目标与正式依据

[A7-01/02](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a7-部署等级) 分别验收：

1. A7-01：明确单节点部署承诺，完成真实持久卷及外部依赖下的停服备份、空目标恢复、状态回读与继续执行，记录实际 RPO/RTO。
2. A7-02：执行进程停止重启，按持久状态恢复，逐项对账 Run、回执、Session 与文件。

二者共享同一套独立部署、持久对象清单和对账器，合并交付；验收报告仍分开，不能以一个用例代替另一个。

依据：[架构及数据归属](../00-governance/ARCHITECTURE.md#外部依赖与数据归属)、[应用设计](./APPLICATION-BOUNDARIES-DESIGN.md#temporal-执行边界)、[Web 接口](../20-interfaces/WEB-INTERFACE.md)、[部署手册](../../deploy/README.md#单节点执行宿主停服备份还原演练)、[Readiness A7](../40-readiness/CURRENT-READINESS.md)。治理按 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)。

## 当前断点与可复用入口

| 来源                                                                          | 已有事实                                                                    | 本轮缺口                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/orchestrator/tests/execution-service/restore.test.ts` 两项 restore 测试 | `node:sqlite.backup`、三库 integrity/FK/hash 校验、终态幂等、下一代历史追加 | `localHost` 与合成文件；不含真实 OpenShell 卷和外部依赖 |
| `apps/orchestrator/src/execution-service/start.ts` 的 `main`                  | 正式模块/命令宿主、环境版本检查、Temporal 接线与关闭                        | 验收不得使用 `--local`；尚未固定 B 独立宿主装配         |
| `apps/orchestrator/src/execution-service/command-host.ts` 的 `commandHost`    | 受信 control/worker 与官方 SDK schema 解码                                  | control 命令是部署端责任；未发现仓库通用部署备份入口    |
| `apps/orchestrator/src/openshell/authority.ts` 的 `Authority`                 | 持久绑定、代次、授权、管理停启、operation                                   | 需独立只读快照对账，不调用写接口模拟恢复成功            |
| `apps/orchestrator/src/openshell/session-history.ts` 的 `SessionHistory`      | session/events/batch receipts/intents/checkpoints/restores                  | 需官方 provider 回读与 SQL 同时证明恢复，而非复制造数   |
| `apps/orchestrator/acceptance/temporal-retry/host.ts`                         | 真实 Temporal 接线但 host 为 `localHost`                                    | 可借鉴进程生命周期；不能直接当真实卷验收                |
| `deploy/compose.yaml`                                                         | web、MySQL、Keycloak/Postgres、执行数据、开发 Temporal 持久卷               | 没有覆盖全部 owner 的一致停服备份/恢复宿主              |

本轮不改 `service.ts`、`types.ts`、retry/checkpoint 实现、`WEB-DESIGN.md`。若实际恢复需要改这些文件，列出具体 symbol、失败证据与依赖报 MASTER 排程，暂停实施，不自行侵入 A 的范围。

## 部署声明、Scope 与 Non-goals

作者选择：**单执行节点的执行子部署、正常完成持久轮次后计划停服、同一部署身份与绑定、独立新目标存储恢复**。验收走正式执行服务项目 HTTP 入口，使用真实 DSH/OpenShell、真实卷及 Temporal；恢复后在原 Session 提交新轮。没有多节点、HA、在线备份或无损自动故障切换承诺。不可用“SQLite + Docker 卷”推导高可用。

Scope：备份清单/摘要与停写前置检查；独立恢复目标；真实卷文件与权限；外部依赖的明确恢复或保留边界；进程重启；Run/receipt/history/authority 对账；继续执行；可重复入口与部署说明；按实测更新 A7 两行。

Non-goals：Go 权威账本迁移、旧部署兼容、新备份产品、远程 HA、多节点故障、线上热备、其他租户/历史业务清理、改动 A 的安全重试语义、默认开放 PTY/SSH。A7-03/04/05 保持原状态及适用条件。

## 数据所有权、备份集合与恢复顺序

| Owner / 数据                     | 备份窗口与恢复要求                                                           | 可观察断言                                                             |
| -------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| TS 执行宿主：`business.sqlite`   | 关闭全部写者后 SQLite backup；不直接拷运行中主库                             | 原 project/session/run/key/request/result/diff/receipt 不变            |
| Authority：`authority.sqlite`    | 与 business/history 同一持续停写窗口                                         | binding、generation、operation、管理回执保持；旧执行不可复活           |
| SessionHistory：`history.sqlite` | 同上；保留 committed receipt 与未结 intent 原貌                              | header、完整事件顺序、epoch、receipt digest/count 与 provider 回读一致 |
| OpenShell Workspace Volume       | 真实控制面证明 sandbox/worker 无写者；再离线归档卷全量内容                   | 路径、字节、SHA-256、权限及绑定一致；禁止只重建 README                 |
| Temporal                         | 固定 namespace/taskQueue/workflow identity；开发 CLI DB 必须停 server 后归档 | 真实 history 可查，重启/恢复不重复执行已完成 Run                       |
| 个人端：web 数据卷与 MySQL       | 若声明整站部署，web/API 停写后保存卷及数据库一致备份                         | 用户/空间/文件元数据和额度可回读；不暴露密码/会话                      |
| Keycloak/PostgreSQL              | 整站范围内必须备份身份数据库与必要 realm 配置                                | 原身份映射继续可用；认证材料留受控目录                                 |
| S3 原始文件                      | 限定本轮私有前缀，备份实际 object bytes 与元数据                             | 恢复后 GET bytes/hash 与元数据关联一致，无遗漏 multipart               |
| 部署配置、镜像与运行时           | 单独私有配置包/清单，固定 image/policy/SDK identity                          | 环境版本一致；证书、bearer、模型密钥不写 Git 或报告                    |

恢复顺序固定为：验证离线备份清单与 hash → 建立从未运行的目标 → 数据库/对象/卷恢复 → 只读对账 → 先启动外部依赖并查就绪 → 启动控制面及执行宿主 → 认证/API 回读 → 原键重放 → 新 Run 继续执行。源实例始终保持停止，不能同时运行两个相同 authority/namespace/volume identity 的控制器。源数据库和离线卷副本保持不动。只有本轮新建的源 sandbox/volume，可在备份验证、独立离线副本核验及逐项归属核对完成后按下文退役；历史资源不得删除。

本轮声明执行子部署而非整站灾难恢复。项目输入经正式项目导入进入真实 Workspace；该入口不消费个人端 MySQL、Keycloak 或 S3，因此三者保持原服务且禁止操作，并不声称已备份这些系统。模型服务和 OpenShell Gateway 保留原外部服务，受控认证配置保持原身份；Gateway 元数据与沙盒/卷绑定必须在窗口释放后核对，不能假设复制卷即恢复 Gateway。Temporal 使用本轮独立持久实例，停服备份其数据后恢复。若 B 的实际宿主不可脱离 Web/S3，作者必须先修订清单、纳入其数据和精确命令并重新审核，不能执行时静默漏掉依赖。整站数据库恢复、Gateway 控制面整体灾难恢复保持未覆盖。

## 对账字段与报告契约（拟新增，仅验收使用）

`BackupManifest` 拟含 required 字段：`schema:1`、`caseId:string`、`sourceCommit:string`、`deploymentScope:string`、`environmentVersion:string`、`quiescedAt:string`（UTC）、`completedAt:string`、`members:{owner:string,path:string,bytes:number,sha256:string}[]`。不得含密码、token、URL 签名或私钥。实际路径仅在仓库外私有产物。

`CaseReport` 拟含 required 字段：`schema:1`、`case:'A7-01'|'A7-02'`、`sourceCommit:string`、`restoreCommit:string`、`assertions:{name:string,passed:boolean}[]`、`rpo:{lastAcknowledgedAt:string,restoredThroughAt:string,lostAcknowledgedRecords:number}`、`rto:{startedAt:string,readyAt:string,milliseconds:number}`、`cleanup:{sourceStopped:boolean,restoredStopped:boolean,ownedResourcesOnly:boolean}`。未完成的指标用独立 `failure` 报告，不伪填零。

既有结构核对：`Run`（Store）含 `id/projectId/sessionId/status/createdAt/updatedAt/summary/prompt/baseline/receipt/reconciled/diff` 及取消、Task、retry/generation 字段；恢复必须保留整行，不能仅选三个字段比较。`Authority.execution_sessions` 含 session/tenant/project/sandbox/volume/generation/state/run/capability/expires；最后三项可空，持久化 capability 不得输出。历史 receipt 为 `{epoch:number,batch:string,digest:string,first:number,count:number}`，owner 为 SessionHistory；不能将 Temporal retry 次数当成 generation。

对账器只读数据库，规范排序比较全部表行，敏感值仅在内存比较，公开报告输出布尔断言/计数及合成文件摘要。原 HTTP DTO 与同键重放结果另存内存比较。不得写 SQL 修复状态、注入 receipt、篡改 epoch 或补齐假历史。

## 用户当前执行约束

B独立完成本RUNBOOK及PR，不以A进度、A合入或共享测试服务为前置。`sourceBaseCommit`记录当前源码实际共同基线，不表示另一任务已完成。使用B专属测试容器、网络、Gateway、Temporal、业务状态和卷；基础镜像及不可变依赖缓存可复用。以下历史作者记录中与此相反的等待约束不再适用。私有适配器的独立网络endpoint替换已按精确patch和SHA专项3/3验证；工作区只用文件工具，`requireFullEnforcement:true`不改，partial subprocess能力由严格guard实际拒绝，不声明完整subprocess验收。

## 分段前置门禁与执行顺序

执行顺序固定为：**T0-local → T1 → T3 → T1a → T2a → T2b → T4-local → T0-remote → T4-real → T5-real → T6-final**。保留既有步骤编号，按此物理顺序执行，不按编号猜测依赖。T1与T3分别提供可独立验证提交的本地产物，不消费尚未创建的adapter、镜像、配置或远端API。

### T0-local：本地基线、来源与接口门禁

前置状态：作者阶段，尚未创建任务分支或实施。允许修改：本RUNBOOK；专核根AGENTS、RUNBOOK规则、现有restore测试、authority/history、Store、commandHost/start，共9文件。禁止修改production、远端资源、A私有来源。

执行：核基线`da8d34cc6784a833d0d2cb448c87873b5515e643`及草稿归属；核本稿已有本地依赖闭包/SDK签名证据、离线SQLite备份与只读对账签名/输入输出、七个产物步骤的文件边界。T1/T3不读取BENTO_A7_CONFIG、不依赖image ID/平台helper/模型/SDK/Temporal server。A后续新主线在T0-remote前纳入，不能要求A先合入才实现纯本地工具。

验证：

```sh
git rev-parse HEAD
git status --short --branch
git diff --check
```

PASS：HEAD为本稿基线，工作树仅归属明确的本稿，已记录实际import与source SHA，MASTER审定本地链Executable。其后才建任务分支、提交本地步骤。STOP：本地接口仍有产品/架构未决、范围侵入A热点或源码归属不明。**远端窗口未释放、待构建镜像ID未产生不阻塞本门禁或T1/T3**。

本地门禁批准不等于T0-remote通过；未获窗口时可推进并提交T1、T3、T2a/T2b的本地接线与本地验证，到T0-remote停止，不部署/运行/恢复远端资源。

## 验证矩阵

| 需求/保护     | 必须的结果                                                             | 当前证据                   |
| ------------- | ---------------------------------------------------------------------- | -------------------------- |
| A7-01         | 真卷及所声明外部依赖恢复，原状态对账、继续执行、实际 RPO/RTO           | 未执行                     |
| A7-02         | 真执行进程重启前后 Run/receipt/session/files 对账，无重复副作用        | 未执行                     |
| 停写/资源保护 | 未证停写拒绝；外部 owner 与历史资源不操作                              | 待新增 focused test        |
| 备份有效性    | hash、integrity、FK、member 完整性全部通过                             | 仅历史 fixture 可复用机制  |
| 空目标/损坏包 | 拒绝覆盖或恢复，源数据不变                                             | 待新增 focused test        |
| 幂等/权限     | 原键原结果、异输入冲突、其他 owner 不可读                              | 仅历史 fixture，需真实复验 |
| 历史          | 官方 provider 与 SQL 对账，旧历史前缀和 receipt 不变，后继事件合法追加 | 待真实复验                 |
| A 后共享边界  | 新主线的 generation/stop proof/恢复不被绕过                            | 待 A 合入后确定定向命令    |
| 包与清理      | 私有配置/数据库/证据不入包；仅清理本轮资源，失败现场保留               | 待新增检查                 |

Not Applicable：本轮不新增业务状态、事件、HTTP DTO、事务、权限授予或数据库迁移；不验证多节点/在线备份。现有业务错误/状态仍由原生产接口负责；不能因部署工具修改其语义。

## 规模核算与共享文件

只计必须核对的既有代码，不估算未来新增量；逐行去空行、纯注释，同一行只计一次。计数基于本稿基线，以下五个代码文件共 **890 LOC**：

| 路径                                                        | 符号/行范围                           |    有效行 |
| ----------------------------------------------------------- | ------------------------------------- | --------: |
| `apps/orchestrator/tests/execution-service/restore.test.ts` | 首项备份测试 38–195；三库测试 196–611 | 153 + 406 |
| `apps/orchestrator/src/openshell/authority.ts`              | Authority constructor/close 30–65     |        34 |
| `apps/orchestrator/src/openshell/session-history.ts`        | SessionHistory constructor 75–114     |        38 |
| `apps/orchestrator/src/execution-service/command-host.ts`   | commandHost 122–238                   |       115 |
| `apps/orchestrator/src/execution-service/start.ts`          | main/启动关闭入口 20–167              |       144 |

这些范围分别固定现有还原断言、账本所有权、历史结构、正式宿主装配和生命周期，均与本轮直接相关；不为规模修改源码。A 合入导致行号改变时重新核算。

潜在共享写入只有 Readiness、应用设计与部署 README；根 package/public-files 默认不改。Orchestrator package增加独立显式远端验收入口，同时将纯本地backup/audit测试接入既有check:core:fast，确保本地与CI常规检查实际执行；不把远端或私有adapter用例塞入普通CI。新增脚本发布边界由 check-package 固定。

## 完成、恢复与草稿限制

失败报告包含最后成功步骤/commit、精确 symbol、最小命令、脱敏断言与继续条件。不能确认停止的进程/容器保留，不能删除其卷。源数据库、已验证备份与独立卷副本在恢复验收结束前保留；清理必须逐个核对本轮所有权，历史业务与失败证据不删除。

当前缺项：窗口释放后的 B 专属资源/镜像/配置归属、已选装配的实际能力和 helper/依赖闭包证据、A 新主线的定向复验。函数/恢复工程路线/机械命令见第三轮核定；不得把实际能力未验说成可执行。当前本地链可送Executable审核；远端缺项由T0-remote固定命令产生证据，未通过不得部署。不能交给机械执行者自由选择或豁免。

## 第二轮作者调查：复用 B 历史宿主与固定工程选择

### 来源与复用结论

只读核对 B 本地受控源，未连接远端：

- `debug-workspace/web-a08/host-daemon.mjs`：`checkedBinding`、`ownerVolume`、`boundContainer`、`volumeIO`、`volumeAction`。真实宿主已校验 `bento.web08` owner、project、attachable/workspace 标签，核对官方 sandbox ref 与 Docker 实际挂载/镜像，并经官方 SDK stop/start/delete；无需新增备份 HTTP 接口。
- 同目录 `ref-control`：stdin JSON 经本地 Unix socket 发送原 control action；`ref-worker`：当次 grant 创建隔离 relay，调用原 daemon launch，等待真实退出与 receipt。
- 同目录 `setup-gateway.sh` 显示 relay/model-relay/worker-loopback/volume-io 来自旧 B 私有宿主。首轮本地缺少的四个源已在缩小授权下从 B 历史目录只读取回；核对固定目录 owner 和 UID 后只读指定四文件，无 Docker/SDK 或资源探针。完整性见下表。不能读取 A 当前 candidate。
- `debug-workspace/web07-t4c-recheck/debug-workspace/web07-openshell/T4C-EVIDENCE.md` 明确为离线 fake Docker 验证；该框架不替代真实卷宿主，本轮不复制其整套 lease/监督框架。
- `apps/orchestrator/acceptance/temporal-retry/process.ts` 的 `own/stopOwned/freePort/startServer/buildControl`、`tool.ts::acquireTemporal` 可直接复用独立进程与官方工具能力；不复制 `host.ts` 的 localHost。

上述私有来源只作装配来源和审计依据，不加入公开发布包。执行前以实际文件 SHA 固定，缺文件 STOP，不从线上运行容器随意猜补。

### 固定资源与目录契约

新验收入口 `apps/orchestrator/acceptance/single-node-restore/run.mjs` 只读取 `BENTO_A7_CONFIG`（仓库外绝对路径）并调用 TypeScript runner。配置 `schema:1`，required：`caseId`（`bento-a7-b-` 加 16 位小写 hex）、`root`（新建0700私有根）、`dockerDaemonId`、`runtimeImageId`、`workerImageId`（两个均为 sha256 ID）、`hostConfig`、`sdkModule`、`gatewayWorkspace`、`gatewayOwner`、`gatewayEndpoint`、`adapterManifest`、`cli`、`cliConfigHome`、`policy`（后三项均为本轮受控绝对路径）。密钥继续从受控 hostConfig 引用读取，不复制到报告。禁止 shell 拼接；Docker 和 CLI 全部以 execFile/spawn 的 argv 数组调用。

root 固定子目录：`source/state`、`restore/state`、`backup`、`evidence`、`adapter`、`temporal/source`、`temporal/restore`。目录必须独占创建，EEXIST 失败；不得使用用户传入源目录。备份 member 的相对路径不得绝对、含 `..`、反斜杠、软链接或重复；每项 exclusive create。恢复 state 不包含锁文件/WAL/SHM，三库通过 SQLite backup 生成；原 source/state 留存。

每个 Docker 操作先核 daemon ID，再核实 resource 真实 ID 与 owner/project 标签。owner 由本轮 caseId 派生，禁止继承旧 B 租约作为本轮 owner。保留 `openshell.ai/sandbox-attachable` 与 workspace 标签；不用标签推定已停止，必须另查进程与挂载。

### 固定停服和真实卷恢复顺序

1. 正常完成第一轮真实 Run，官方 Session flush/close 完成、receipt 成功且 intents 为空。持久化 API/SQL/真实文件基线。不得引入在途 UNKNOWN 故障。
2. 正常关闭执行服务，等待实际服务/Go/Worker ChildProcess close；daemon `active` 为空、`volumeBusy` 为 false 后继续。停止原 Temporal server 并等 close；关闭 adapter 的新增请求接收。
3. 以已固定官方 SDK `sdk.raw.stopSandbox({name:binding.sandbox,workspaceScope:{selection:{case:'workspace',value:workspace}},requestId:randomUUID()})` 停止本轮 sandbox；轮询 `sdk.get(name,{workspace})` phase=stopped 且实际 Docker container.State.Running=false。检查同 volume 所有挂载容器均停止、无额外挂载者。超过60秒硬失败，保留现场，不用时间等待代替证明。
4. 三库以 `node:sqlite.backup` 输出到 `backup`，逐库 integrity/FK/hash；Temporal 的已停止 DB 同样备份。卷使用固定 runtime image 的 `/bin/tar`，network=none、read-only root、原 volume readonly 挂 `/volume`，私有 backup bind 挂 `/backup`，argv 为 `tar --numeric-owner -cpf /backup/workspace.tar -C /volume .`。归档前后独立 full inventory 相等，包括 regular bytes/hash、mode、uid/gid、目录；本场景禁止 symlink/hardlink/device/socket/FIFO，出现即 STOP（明确本轮支持的合成项目范围）。归档文件 fsync 后记录 hash。
5. 新建本轮只读保全卷（caseId + `-source-preserved`），恢复完整归档，独立 inventory 与源比较；保全卷禁止挂给 worker。验证通过前绝不删除源。备份与保全卷均为本轮数据，不含历史业务。
6. 通过官方 `sdk.delete`/`sdk.waitDeleted` 仅退役本轮 sandbox；核对 Gateway ref absent、绑定卷无任何 container 附着，然后删除本轮源卷。**保留源三库、归档和已核保全卷**。Docker 不支持 volume rename，不能把“改名源卷”写成命令。
7. 排他创建同名 volume（原名已证不存在，标签来自本轮登记），确保空内容后恢复 tar；逐项 inventory 相等。以历史 `volumeAction::provision` 已用的官方 CLI 创建 sandbox：相同 name/workspace、已固定 runtime image、policy 和 `driver-config-json` 中唯一 volume mount，target `/sandbox/project/bento-workspace`，read_only=false。实际 sdk.waitReady、Docker inspect 再核 name/workspace/volume/image/policy。Gateway sandbox ID、container ID 可变化；业务 Binding 的 tenant/project/session/sandbox名/volume名保持原值。
8. 只有部署端 manifest 中 `volumeBindings[project].container/sandboxId` 更新为上述独立观测的实际 ID；不是写业务/authority/history SQL。stage=ready、binding/inputSha256 维持，原 manifest 作为证据保留。不调用 provision(seed) 覆盖已还原文件。
9. 将三库恢复到全新 `restore/state`；Temporal 恢复到新目录，维持原 namespace/taskQueue/Workflow ID，先查旧历史再启动正式执行宿主。核对原已完成 Run 未重派，再在原 project/session 经 HTTP 发新轮；真实模型经官方 runtime 读取原文件、追加唯一新 marker，provider 原历史为精确前缀，原 receipts 不变。

以上只恢复执行节点持有的数据，外部 Gateway 服务与其控制面数据库持续保留。重建本轮 sandbox 使用官方生命周期 API，不声称 Gateway 灾难恢复；模型服务也持续保留。若 runtime image 无可用 tar、固定 policy 不支持同名重建或 Gateway 无法解绑旧容器，则 T0 报具体能力失败，不改为运行中拷贝或直接编辑 Gateway DB。

### 固定新函数职责（T0 细化步骤时沿用）

以下为计划新增签名，不是现有 API：

```ts
// apps/orchestrator/acceptance/single-node-restore/backup.ts
export type BackupMember = {
    owner: string;
    path: string;
    bytes: number;
    sha256: string;
};
export async function backupSqlite(
    source: string,
    target: string,
): Promise<BackupMember>;
export async function verifyBackup(
    root: string,
    members: readonly BackupMember[],
): Promise<void>;
export async function restoreSqlite(
    backupRoot: string,
    target: string,
    members: readonly BackupMember[],
): Promise<void>;
// acceptance/single-node-restore/audit.ts
export async function readLedger(
    state: string,
): Promise<Record<string, readonly Record<string, unknown>[]>>;
export function assertSameLedger(
    before: Record<string, readonly Record<string, unknown>[]>,
    after: Record<string, readonly Record<string, unknown>[]>,
): void;
// acceptance/single-node-restore/resources.ts
export async function restoreWorkspace(
    config: A7Config,
    binding: Binding,
    archive: string,
): Promise<void>;
```

`backupSqlite` 只负责已停服数据库的 SQLite backup 与健康检查；停服证明由 runner 在调用前完成，函数名不宣称自动跨库快照。`restoreSqlite` 只接受三库及 Temporal DB 白名单、验证全部 member 后才建立空目标，任何失败删除仅本次未发布 staging；不碰 source。`readLedger` 以 readOnly DatabaseSync 按 sqlite_schema 枚举非内部表、稳定排序全行，BigInt/Buffer 必须稳定编码；比较包含 capability 但不输出其值。权限错误、未知表结构、失效 member 均失败。

四个缺失源已补齐。下文固定 bootstrap、命令与逐步白名单；剩余 T0 为远端窗口释放后的具体镜像/资源/能力证据，不能以本地源码核对代替。

## 第三轮：历史源码取回、bootstrap 与机械命令落点

2026-11-23，经 MASTER 明确授权的 SSH 只读文件操作：先核固定 B 历史目录（来自本地 ref-adapter 路径与 setup-gateway 引用）的非软链接、当前 UID 及 manifest owner=`bento-web08-huh7stju`；只读取四个白名单源文件。未读取凭据、数据库、业务日志，未执行 Docker/SDK/资源操作。私有本地调查目录为 `debug-workspace/a7-author-investigation/historical-source/`，不进入 Git/npm；路径仅为本机作者来源，正式部署文档不照抄历史目录。

| 源                  | bytes | SHA-256                                                          |
| ------------------- | ----: | ---------------------------------------------------------------- |
| relay-host.mjs      |  1480 | a6bdd4b1ed9f9c04dd2ceb1761c800b9fcc52ab1c0bee1ff45099dacf71d0bed |
| model-relay.mjs     |  5119 | d2e4a70a8987c134151dde41cad3e126fb4513cb83cc08faf1dfdf727d17e854 |
| worker-loopback.mjs |  4930 | 0ec9745b5052a6a2a4c0ca7507abd2ef075d9fbfbd405e4a01598b258c67f350 |
| volume-io.mjs       |  2994 | e1188ad9b0878f7960d2761490d9e699cc93b7db8f1ac5516e6673fc9553509c |

### Bootstrap 与生产链路决定

不能直接复用 `entry.a13.ts`：它要求 WEB-A13 精确 prompt/publicEventsUrl，验收项目入口无这些字段。也不能把新的 production base 当成已验证通用工具装配：当前 base 本身未注册 filesystem tools。作者固定使用历史 `base.candidate.ts::createBootstrap` 的正式私有 bootstrap 装配路径，复用其官方 AgentRegistry/AgentLoop/SessionStore/provider/filesystem tools，不重写 Agent 框架或 `runDshWorker`。

在本轮私有 adapter 根新增 `a7-bootstrap.ts`（随 adapterManifest 单独 SHA 固定，不公开发布），其 default 为 async `(request,effect)`，只接受 mode=execute、受控两个 prompt 且无 publicEventsUrl；new DeepSeekAdapter 使用历史官方 `resolveAdapterOptions`/`resolveAuth` 能力，禁止 WEB-A13 model guard 改写请求；每轮独立 adapter。SDK 使用本轮 worker 的 gateway/grant.token 连接，interactiveClient 的 sandbox 仅允许 request.binding.sandbox，workspace 来自固定 config。provider 的 helper/fileSystemHelper 沿原镜像安装位置，workspaceRoot 固定 `/sandbox/project/bento-workspace`，`defaultMode`固定为`workspace-write`、`requireFullEnforcement:true`，不能沿用历史只读probe的read-only设置。调用 `createBootstrap({adapter,agentOptions,provider})`，返回 runtime，并以 finally 关闭实际 SDK/model 资源；不手写历史事件/SQL/工具结果。

原 daemon/worker-loopback 在本轮 adapter 副本中只做四类适配：本轮独立根/owner 的严格校验、将 bootstrap 路径切到 `a7-bootstrap.ts`、启用已有 model socket 路由与私有 model.env 挂载、receipt 不要求 WEB08 专用 guard 字串。保留 network=none/只读挂载/UID1000/容器实际 ID 和退出校验、控制面原 action 协议，不改变生产 service 或 worker。每处变化在 adapter manifest 中记录 before/after SHA 与精确补丁；不能原地修改历史源。旧 `volume-io` 只用于业务文本 snapshot；新增全卷 inventory 单独实现，不把文本 snapshot 当全量备份。

两个 prompt 唯一固定为：第一轮要求读取 README.md 并创建 `a7-proof.txt`，内容恰 `a7-first\n`；第二轮要求先读取该文件，再将内容改为恰 `a7-first\na7-second\n`。官方模型可能不按要求执行，最终必须由独立卷读取核对，否则用例失败，不以模型自报代替；重跑使用新 caseId，不篡改文件挽救结果。

### T1–T6 命令与文件白名单补充

本节固定本地与远端的分段执行；当前等待MASTER审核本地链。新增文件在对应步骤创建后验证并提交，后步才消费干净提交；远端能力不作为前序本地提交的条件。

### T4-local 接线产物与配置契约（随实质代码提交）

MASTER已采用提前本地driver的依赖修订：`driver.ts`、`run.mjs`、`real-restore.test.ts`、`driver.test.ts`与本RUNBOOK共5产物文件，专核已核host/backup/audit接口、项目HTTP fixture与Temporal process接口共5文件，总10。消费此前资源提交，不改production/已PASS接口；实际远端场景不会在本步运行。验证固定为：

```sh
node --import ./register-paths.mjs --test apps/orchestrator/acceptance/single-node-restore/driver.test.ts
pnpm --filter @bento/orchestrator typecheck
pnpm exec eslint apps/orchestrator/acceptance/single-node-restore/driver.ts apps/orchestrator/acceptance/single-node-restore/driver.test.ts apps/orchestrator/acceptance/single-node-restore/run.mjs apps/orchestrator/acceptance/single-node-restore/real-restore.test.ts
```

本地测试仅证明拒绝/阶段顺序/四库恢复布局/历史规范比较，不调用runCase成功路径、不产生A7报告。真实suite只有restart/restore两个显式case，无fixture模式/skip或可豁免门禁flag。

`CaseConfig`在原A7Config基础上增加下表字段，全部required；由部署端基于当前干净提交及实际构建/控制端配置产生，不能用占位ID补齐：

| 字段               | 类型与来源                                                                | 消费/证明                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| sourceCommit       | 40位hex string，当前B独立验收的干净source HEAD                            | 必须与proof.sourceCommit及实际应用/Worker image revision label一致                                                                            |
| environmentVersion | sha256前缀摘要string，实际image/policy身份                                | proof同字段、commandHost实际版本一致                                                                                                          |
| gateProof          | 仓库外绝对路径string，完整T0-remote私有回执                               | schema/source/自身源码基线/实际daemon与三镜像/adapter/lock/Dockerfile/control摘要/平台/构建时间/五项能力全部校验                              |
| serviceTokenFile   | 绝对路径string，部署端新建独占服务身份文件                                | 普通单链接0600文件，32–1024可见ASCII；只用于API bearer，不入proof/report                                                                      |
| controlBinary      | 绝对路径string，从上述Orchestrator构建产物提取的生产Go控制器              | 可执行普通文件，实际字节SHA与proof.controlBinarySha256一致；仅本case进程设置既有BENTO_GO_CONTROL，finally恢复原环境，不在测试中临时改生产接线 |
| temporal           | `{namespace:string,taskQueue:string}`，本轮独立部署身份，二者以caseId开头 | source/reopen均沿用；port由既有freePort动态取得并保持到还原，官方工具由既有acquireTemporal核验                                                |

原A7Config的root是已准备私有部署根，basename必须等caseId且权限0700；source/restore/backup/evidence/temporal子树由driver排他创建，拒绝复用旧执行状态。source、restore、Temporal各数据路径固定，四库先整体验证还原到新staging，再仅移动新target的Temporal DB至独立目录并各自复验；不拆manifest绕过完整集合校验。

GateProof.required：schema=1、sourceCommit/sourceBaseCommit 40位hex、dockerDaemonId与config相等、environmentVersion相等、adapterManifestSha256为实际manifest字节SHA、lockSha256/dockerfileSha256/controlBinarySha256均64位hex、platform=`linux/amd64`、实际orchestratorImageId/workerImageId/runtimeImageId、builtAt有效UTC构建时间、checks中linuxImports/helpers/native/officialLifecycle/sameNameRecreate各严格true。后续完整T0生成器只能从实际构建及命令回执写这些字段；短probe33.011s仅支持官方生命周期/同名重建子项，不能填造其余true。

driver实际启动前再次核控制器字节、daemon和三镜像的ID/平台/源码标签。宿主停启不拼虚假generation：从真实authority三库规范快照构造现有stop/start参数，绑定不匹配/整数越界拒绝。运行时阶段序列约束先gate、停服、完整四库与保全，再还原、重新观测官方ref/mount；只更新本轮部署manifest容器/sandbox ID，不写权威SQL。RTO在原执行停止接收起算，到还原服务实际回读且第二轮成功时取单调时长，不将清理时间当服务恢复时间。报告仅在全部实际断言及本轮清理成功后输出。

### T6-local：常规检查与发布边界（已提前独立完成）

MASTER确认本地范围为package/public-files/check-package/RUNBOOK四改文件，专核现有CI workflow、既有check-package和根files三项，不新增CI job或扩大根files/patterns。已将backup/audit/resources/driver四个纯本地suite精确接`test:single-node-restore:local`，再由`check:core:fast`消费；现有Orchestrator CI job本就调用该corefast，无须变更workflow。真实suite只由显式`test:single-node-restore --case restart|restore`执行，私有adapter专项不入普通CI。

验证实际结果（2026-11-23，代码对应本轮实质提交）：

- `pnpm --filter @bento/orchestrator test:single-node-restore:local`：41/41，fail0/skip0；这四组是本地工具/拒绝/编排证据，不是A7实栈PASS。
- `pnpm --filter @bento/orchestrator check:core:fast`：exit0，实际经过旧Node suite155项（153PASS、2项既有条件skip）、本轮四suite41/41、Go test/vet、旧包契约、Worker runtime14/14及新增包检查。既有skip不计为本任务验收；该入口不运行远端A7或私有adapter用例。
- 新`check-package.mjs`：实际installed-tree npm pack dry-run为188文件，13个新源逐项存在、相对/@包内source import闭包完整；root files与三patterns未变、公开登记无重复；依赖/DB/WAL/日志/归档/证书/密钥/env/私有部署JSON及A7受控目录负向检查通过。
- `pnpm lint`与`pnpm format:check`：全仓exit0；`git diff --check`通过。CI接线按现有workflow实际调用链核对，尚未发起本任务远端PR/CI，不把本机结果写成GitHub结果。

保留T0-remote、T4-real/T5-real和T6-final；Readiness未标已实现，RUNBOOK不删除。过程日志与短probe证据留受控目录，不单独提交过程记录。

### T0-remote：构建产物身份及真实能力门禁

构建缓存补充（2026-11-23，与部署配置同一实质提交）：MASTER授权本步同步修改`deploy/orchestrator/Dockerfile`、`deploy/compose.yaml`、`deploy/README.md`及本RUNBOOK。两处Go阶段的下载与编译共享BuildKit缓存`bento-go-mod-1.25`挂载`/go/pkg/mod`；编译另用`bento-go-build-1.25`挂载`/root/.cache/go-build`。依赖版本、运行镜像与业务契约不变。案例清理不得prune共享builder缓存。缓存复用的实际验证须在同builder二次构建观察命中；目前仅配置检查通过，尚未证实热缓存复用。

当前源诊断已实际尝试：首个Orchestrator构建在`go mod download`下载既有Go模块时连接超时，未到DSH安装/导入；本案清理与独立容器/镜像清零均通过。环境说明中已有代理候选对同下载目标的定向探针返回`EHOSTUNREACH`。因此先恢复既有授权网络入口，再基于含缓存改动的干净源码、源码包与Dockerfile新摘要重试；不得盲目重试、改依赖版本或把缓存挂载当作冷缓存网络已恢复。该诊断不替代A合入后完整T0，实际restart/restore与Readiness保持待验。

前置状态：T1/T3/T1a/T2a/T2b已各自通过并提交（T2b：resources8+adapter3合计11/11、fail0/skip0，typecheck/eslint通过）；MASTER明确释放B所需窗口。允许修改：本RUNBOOK；专核T2a私有manifest、T2b host/resources、两份已有Dockerfile，共6文件。未释放窗口时留在此门禁，不阻止之前本地步骤提交。

执行：

1. 使用B当前干净源码及其实际共同基线独立验收，不等待A合入。测试runner、Gateway、Temporal、业务库、卷和网络由B排他创建；不使用A服务或状态。其他任务后续变更只有实际影响共享生产符号时，才定向复验相应契约。
2. 消费T4-local干净源码提交，通过已有Dockerfile构建本轮应用/Worker；构建是本门禁的产物，不是T1/T3前提。固定调用：`docker build --file deploy/orchestrator/Dockerfile --label org.opencontainers.image.revision="$BENTO_A7_SOURCE_SHA" --tag "$BENTO_A7_CASE_ID-orchestrator" .`，Worker同形使用`deploy/worker/Dockerfile`及`"$BENTO_A7_CASE_ID-worker"`。只用部署环境已授权的网络/代理配置，不自行新建代理或复用A租约。构建失败保留本轮回执，不降级到旧应用镜像。
3. 从精确tag的image inspect读实际ID；proof必含schema=1、sourceCommit、sourceBaseCommit、dockerfileSha256、lockSha256、controlBinarySha256、adapterManifestSha256、dockerDaemonId、platform、orchestratorImageId、workerImageId、runtimeImageId、environmentVersion、builtAt及checks五项真实命令断言。runtime image可为已核历史sandbox运行镜像，但必须另验helper与固定SDK/provider；不声称它带本轮源码。构建后才将image ID写入本轮私有config并以proof约束不可变身份。
4. 执行末节已固定的Linux实际import、tar/helper、SDK官方卷生命周期及挂载核验。资源只属本轮；生成脱敏断言，原始证据留受控目录。全部关闭并独立确认资源状态后才发布门禁通过回执。

验证：末节“必须等待MASTER释放窗口的精确证据”表及“最终调用约束”的固定命令/argv全部实际通过；并执行`git diff --check`。本门禁使用的是已提交接线和已有官方能力，不在此临时开发新的业务API。

PASS：实际daemon/平台/image/proof一致，Linux import/helper/tar、官方create/stop/start/delete及精确volume挂载通过；配置image值均来自本次构建/独立观察，非猜填。PASS后按原已审核RUNBOOK直接进入T4并回报MASTER，不新增审批层；窗口授权仍必须已存在。STOP：窗口未释放、任何能力失败、必须改生产接口或资源无法证归属。T1/T3既有PASS/commit继续有效，不回退也不借此降低A7完整验收。

### T4-real：真实 A7-02 正常进程停止重启

前置状态：T4-local接线已提交且完整T0-remote通过；本轮构建proof/配置/镜像/资源identity不变；复核既有能力未漂移，不补造T0证据。
允许修改：同目录 `run.mjs`、`real-restore.test.ts`、本 RUNBOOK；专核 host.ts/resources.ts/audit.ts，合计6文件。
执行：run 支持 `--case restart|restore` 两个枚举；BENTO_A7_CONFIG必填且私有；固定超时每轮180秒、生命周期单步60秒、整体15分钟。先执行 restart：独立实例完成第一轮，查原 receipt/intents空和文件；服务正常退出，保留同数据库/卷与外部Gateway，重新启动后 readLedger/HTTP/官方provider对账，提交第二轮，再验原历史前缀与实际文件。正常停止场景不注入 SIGKILL、不引入在途恢复。
验证：

```sh
node apps/orchestrator/acceptance/single-node-restore/run.mjs --case restart
```

PASS：实际生产HTTP→Temporal→生产worker→官方provider/SDK→真实文件链路两轮均成功；原Run未重派，Run/receipt/session/files逐项 true，独立 A7-02报告与清理记录齐全。STOP：fixture替换、跳过、端口监听代替业务验证、模型结果不匹配、退出未证。失败目录保留，不自动递归删除；本步骤完成后提交测试与实际脱敏边界。

### T5-real：真实 A7-01 停服备份还原

前置状态：T4-local干净提交及T4-real已验证，另用新 caseId/全新目录执行，不复用前案数据；T0-remote能力仍匹配。
允许修改：real-restore.test.ts、resources.ts、本 RUNBOOK；专核 backup.ts/audit.ts，合计5文件。
执行：严格按九项恢复顺序；备份与保全验证后才删本轮源资源，创建同名空卷。source/state不变；启动restore/state及restore Temporal DB。原API/全部表对账后，在原Session继续真实第二轮。记录从停止接收新任务到第二轮业务验证完成的单调RTO，明确包含模型时间；报告精确 lastAcknowledged/restoredThrough 与丢失确认记录数。
验证：

```sh
node apps/orchestrator/acceptance/single-node-restore/run.mjs --case restore
```

PASS：真实卷完整inventory/权限一致、四库健康、三库整表一致、原键同输入返回原Run/异输入冲突、他owner不可读、Temporal原history可查且无重复执行、原Session新轮读旧文件/历史并追加成功，A7-01完整报告。STOP：无法同名绑定恢复、额外写者、Gateway对象错归属、任何缺失外部依赖。保留备份/保全卷/源库与失败证据，禁止手工补文件/SQL。通过后提交本步实际产物。

### T6-final：真实验收后的长期落点与删除 RUNBOOK

前置状态：T6-local已通过并提交，T4-real/T5-real均在B独立环境实际通过；以当前任务源码及实际验收证据收口，不等待其他任务。
允许修改：deploy README、应用设计、Readiness、Orchestrator package、`apps/orchestrator/acceptance/single-node-restore/check-package.mjs`、`public-files.json`、本 RUNBOOK；专核根package files，合计8文件。根package无需新增files模式，新源均由现有apps/orchestrator覆盖；backup.test.ts及runner只以显式.ts路径导入同目录backup.ts，pack正向同时检查消费者与backup.ts，禁止出现包内悬空依赖。部署README经既有run入口引用备份能力，不扩根files或旧pack白名单。
执行：保留T6-local已接入的精确四suite/corefast/CI和13源公开登记及打包闭包检查，不使用acceptance通配符引入real-restore/adapter私有用例。实际完整门禁对齐最终合入版本，按受影响范围复验；Readiness分别写A7-01/02及声明范围、实际commit、四库/卷/外部Gateway保留边界、真实结果与RPO/RTO；原fixture和A证据保留。删除本RUNBOOK并检查残留引用。
验证：

```sh
pnpm check
node apps/orchestrator/acceptance/single-node-restore/check-package.mjs
node apps/orchestrator/acceptance/single-node-restore/run.mjs --case restart
node apps/orchestrator/acceptance/single-node-restore/run.mjs --case restore
git diff --check
```

PASS：backup/audit本地测试由check:core:fast实际执行且无skip；远端及私有adapter用例仍仅显式执行；本轮所有新用例无skip；全量门禁exit0；两场景在本任务已固定源码版本通过；包边界通过；至少A7-01完整已实现，A7-02独立通过后已实现。STOP：任何范围扩大、远端未释放、缺当前版本证据。所有scope满足后迁移并删RUNBOOK，按既有授权执行单PR、当前HEAD Codex和CI门禁、普通merge与同步清理；未通过不删RUNBOOK、不将失败写成已实现。

## 最终 T0 未核定清单（2026-11-23，本地闭包检查后）

### 已完成的本地作者检查

以下均为实际检查，未执行本任务接线：

1. Node 22.23.2 实际 import `command-host.ts`/`service.ts`/Temporal `process.ts`/`tool.ts` 成功，`commandHost/schemaDecoder/serveExecution/own/stopOwned/startServer/buildControl/acquireTemporal` 为函数。源码签名与本稿引用一致；import 未调用这些函数，不启动服务或下载工具。
2. 当前 Worker 安装树实际 import 官方8个核心runtime包成功；`dsh-tool-fs` 与 `dsh-llm-deepseek` 不在该树，首次 import 返回 MODULE_NOT_FOUND，不能假称直接复用生产Worker依赖。
3. 按相同已核 B 目录所有权，只读取 bootstrap/check-tool.ts、package.json、pnpm-lock.yaml。SHA分别为 `7571dccb938b6a344d8780e714bf730334e1cbc95e54df6e69245d257d656498`、`a2d31033f517f5a2d446d795dafb94efe36bffa38b292d4b6531476e691989a0`、`d89ebd14c446153818495f1d4dcc57a4cc645962e8f452fadf06b0eabd103755`。全为源码/依赖清单，不含配置凭据或业务数据。
4. 在独立临时目录复制该package/lock，恢复lock内同一overrides配置，仅 `pnpm install --offline --frozen-lockfile --ignore-scripts`：49包复用、0下载，exit0。曾因隔离调用加 `--ignore-workspace` 不读取overrides而失败，已通过读取该私有目录自身配置修正；未变更仓库package/lock，也未放宽frozen或引入新版本。临时目录不作为部署源。
5. 在上述隔离树中，历史 createBootstrap 完整静态闭包、dsh-tool-fs、dsh-llm-deepseek 实际 import 均exit0；DeepSeekAdapter/resolveAdapterOptions/createBootstrap 目标导出均为function。只做import，未创建Agent、连接Gateway或调用模型。历史check-tool限定web-a13.txt的额外检查工具仍存在，A7不调用它，文件验收只用独立卷检查；不宣称它证明A7文件。
6. SDK固定源码归档 SHA=`4c14a574c0bd2feccbc5198ef9fc64f6e75c7f5ef89b5f2fe478f7688fefa43f`，与仓库 sdk.ts 锁定常量相同。只读 archive 中 client.ts 确认 SandboxClient.connect/get/waitReady/delete/waitDeleted/raw 入口。未运行SDK准备器、网络下载或RPC。

因此本地来源/依赖闭包/目标导出已核；**远端平台、原镜像内实际依赖、helper与挂载、官方RPC可用性未核**。不将macOS import结果外推为Linux镜像执行通过。私有runtime依赖保持独立package/lock；不修改生产Worker声明、不把未声明依赖从宿主node_modules偷渡入镜像。T2a必须把该package/lock identity纳adapterManifest，并在目标Worker实际module路径解析同一闭包。

### 必须等待 MASTER 释放窗口的精确证据

执行这些命令前由作者在私有环境导出下列值：`BENTO_A7_CONFIG`、`BENTO_A7_RUNTIME_IMAGE`、`BENTO_A7_WORKER_IMAGE`、`BENTO_A7_ADAPTER_ROOT`、`BENTO_A7_CASE_ID`。全部来自本轮已核配置；caseId严格`bento-a7-b-[a-f0-9]{16}`；两个image值必须为完整sha256 ID；adapter root不得指向A或历史运行状态。读取配置不得打印凭据。缺任一值STOP，不提供默认值。命令仅在窗口释放后执行，当前未运行。

| 核验                 | 精确命令                                                                                                                                                                                                                         | 预期断言与范围                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| daemon与不可变镜像   | `docker info --format '{{.ID}}'`；`docker image inspect "$BENTO_A7_RUNTIME_IMAGE" "$BENTO_A7_WORKER_IMAGE"`                                                                                                                      | daemon ID等于本轮登记；镜像ID/平台/OCI revision与当前基线构建回执一致。image inspect仅私有保存，公开只记匹配布尔；不inspect其他容器                                                                          |
| Linux工具能力        | `docker run --rm --network none --read-only --label "io.bento.a7=$BENTO_A7_CASE_ID" --entrypoint /bin/sh "$BENTO_A7_RUNTIME_IMAGE" -ec 'command -v node; command -v tar; tar --help >/dev/null'`                                 | 准确持有本轮新容器，exit0，node/tar存在；无卷/凭据/网络。若tar方言不支持计划参数，作者修订固定命令后复审，不能执行者换工具                                                                                   |
| Worker真实import闭包 | 见本表后固定命令                                                                                                                                                                                                                 | model入口按实际package exports使用createRequire.resolve，禁止猜测lib路径。readonly独立adapter含已锁私有闭包，无凭据/网络；不执行bootstrap                                                                    |
| helper文件存在       | `docker run --rm --network none --read-only --label "io.bento.a7=$BENTO_A7_CASE_ID" --entrypoint /bin/sh "$BENTO_A7_RUNTIME_IMAGE" -ec 'test -f /opt/dsh-runtime/confine.mjs; test -f /opt/dsh-runtime/fs.mjs; command -v node'` | 两个helper真实存在且与SDK/provider预期身份匹配；此项不能由本地文件名推定；若实际固定镜像不含则STOP回作者，不临时下载                                                                                         |
| Gateway官方RPC/挂载  | 在T0私有Node会话调用已核 `SandboxClient.connect`，只以本轮新随机sandbox和volume名完成官方CLI create→sdk.waitReady→raw.stopSandbox→sdk.get(stopped)→raw.startSandbox→sdk.waitReady→delete/waitDeleted                             | 仅本轮精确登记的新资源；Docker inspect核owner/实际volume mount及镜像，最后ref absent/卷无附着。CLI argv与SDK顺序固定于下节；仅配置实值及目标平台能力待窗口后核。不能从历史运行容器推断，也不以缺窗口取消验收 |

Worker import闭包使用如下唯一固定命令：

```sh
docker run --rm --network none --read-only --label "io.bento.a7=$BENTO_A7_CASE_ID" --mount "type=bind,src=$BENTO_A7_ADAPTER_ROOT,dst=/app,readonly" --entrypoint node "$BENTO_A7_WORKER_IMAGE" --input-type=module -e 'import {createRequire} from "node:module"; import {pathToFileURL} from "node:url"; const r=createRequire("/app/package.json"); const b=await import("/app/base.candidate.ts"); const a=await import("/app/a7-bootstrap.ts"); const m=await import(pathToFileURL(r.resolve("@deepseek-ai/dsh-llm-deepseek")).href); if(typeof a.default!=="function"||typeof b.createBootstrap!=="function"||typeof m.DeepSeekAdapter!=="function"||typeof m.resolveAdapterOptions!=="function") process.exitCode=1'
```

**当前本地链已获审并实施，T0-remote未通过**。新基线/本轮镜像与资源、helper及官方RPC/挂载证据只约束远端阶段；历史源码和本地依赖闭包已核。远端失败报告具体symbol/镜像/断言，不否定无依赖的T1/T3本地证据。

## DSH 版本核对与冻结（用户追加，2026-11-23）

用户要求检查官网是否升级撤销两包；如是，先按低版本开发并锁住。本次查 [DSH官网](https://deepseek.com/harness/)、官网链接的官方源码和 npm 发布元数据：

- 官方 master 的 `packages/fs/tool-fs/package.json` 与 `packages/llm/llm-deepseek/package.json` 均仍存在，版本为 `0.2.3-alpha.2`；没有两包撤销的证据。不得把本地 MODULE_NOT_FOUND 归因于官方删除。
- npm官方registry两包均HTTP200、`0.2.1-rc.4` version存在且无deprecated字段。tags为latest=`0.0.1-rc.1`、next=`0.2.2-rc.5`、alpha=`0.2.3-alpha.2`；不用latest猜测兼容版本。
- 当前仓库Worker未声明这两包，历史私有runtime已显式声明并精确锁为`0.2.1-rc.4`，隔离离线完整import成功。因此已证原因是两套依赖声明/装配范围不同；不是已证DSH升级破坏。
- 本任务继续沿现有已验版本：DSH全部相关包精确`0.2.1-rc.4`，Cordis=`4.0.5`，OpenShell插件=`0.1.0-rc.1`；私有runtime沿原package/lock/overrides/integrity。禁止`^`/`~`/latest/next/alpha、自动升级或混入新DSH包版本；不需要降到更老DSH。
- 此为作者稿版本约束，未修改生产依赖或实施接线。官方新版本的升级作为独立任务；本轮不因master仍有包就默认兼容。

官方来源：[tool-fs当前源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/package.json)、[llm-deepseek当前源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/package.json)、[原版本tool-fs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.4/packages/fs/tool-fs/package.json)、[原版本llm-deepseek](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.4/packages/llm/llm-deepseek/package.json)。

## T0 最终调用约束与审阅边界

本地可确定项已完成，不再以“待确定CLI命令”为缺项。以下是作者固定的 argv 构造契约（运行时变量来自已核私有config，不是允许执行者自由选择），实际命令必须用execFile/spawn数组执行：

```ts
// 命令构造契约，尚未实现或执行。
const project = randomUUID();
const sandbox = 'b-' + caseId.slice(-16);
const volume = 'bento-workspace-' + project;
const runtimeTag = caseId + '-runtime';
const dockerTag = ['tag', runtimeImageId, runtimeTag];
const createVolume = [
    'volume',
    'create',
    '--label',
    'bento.web08=' + caseId,
    '--label',
    'bento.web08.project=' + project,
    '--label',
    'openshell.ai/sandbox-attachable=true',
    '--label',
    'openshell.ai/sandbox-attachable-workspace=' + gatewayWorkspace,
    volume,
];
const createSandbox = [
    '--gateway',
    gatewayOwner,
    '--gateway-endpoint',
    gatewayEndpoint,
    '--workspace',
    gatewayWorkspace,
    'sandbox',
    'create',
    '--name',
    sandbox,
    '--from',
    runtimeTag,
    '--policy',
    policy,
    '--detach',
    '--no-auto-providers',
    '--label',
    'bento.web08=' + caseId,
    '--driver-config-json',
    JSON.stringify({
        docker: {
            mounts: [
                {
                    type: 'volume',
                    source: volume,
                    target: '/sandbox/project/bento-workspace',
                    read_only: false,
                },
            ],
        },
    }),
];
// execFile(cli, createSandbox, {env:{...controlledEnv,XDG_CONFIG_HOME:cliConfigHome}})
```

调用前：caseId/image/path/schema验证；docker info ID一致；docker volume inspect与SDK get分别证明该随机目标不存在，必须区分明确not-found与查询失败。禁止用其他错误当不存在。镜像tag若存在且不等runtimeImageId则STOP；不得覆盖其他tag。原Gateway服务不得停启，namespace仅使用本轮已有独立Gateway身份，不能借A租约。

调用顺序固定：docker tag → createVolume → 官方CLI createSandbox → `sdk.waitReady(sandbox,60,{workspace:gatewayWorkspace})` → 核ref/容器实际ID/volume和image → raw.stopSandbox（workspaceScope的selection固定workspace，requestId新UUID）→ 最长60秒轮询ref stopped与Docker实际stopped → raw.startSandbox同shape → waitReady与实际挂载复核 → `sdk.delete(sandbox,{workspace:gatewayWorkspace})` → `sdk.waitDeleted(sandbox,60,{workspace:gatewayWorkspace})` → 精确容器absent且volume无附着 → 仅删除本次create返回且标签吻合的volume → 删除仅本轮新建的runtimeTag（不删image ID）。对这一次T0空卷不做业务backup/restore，不将其算A7证据。失败只处理已经拿到实际ID且仍匹配本轮登记的资源；归属/停止不明保留并报告。

T0调用不修改production或本任务接线。其结果只确定既有官方生命周期/挂载能力与环境可用性；真实卷归档/保全/恢复和Run继续执行仍在T4/T5消费干净提交后验收。T4的“完整能力探针”措辞限于复核T0已通过能力未漂移，不能把T0结果留到实施后补造。

当前等待项严格为：MASTER窗口释放、A新主线/镜像身份、目标Linux实际import/helper/tar结果、上述CLI/SDK同名资源能力结果。当前无本地源码/包撤销/命令选择决策缺口。T0-remote缺证时禁止远端部署/恢复；T0-local审核通过后的本地步骤可独立执行提交。

### B 历史身份只读核对结果

2026-11-23，MASTER追加精确Docker inspect授权后，先对同一已知B历史根核owner/UID，再只执行该历史记录中明确ID的 container/image inspect；未执行全局list、exec、run、build、SDK或资源操作。结果：

- 旧B Orchestrator容器`d65897c…5f0eeb`明确not-found；旧应用镜像`sha256:75733203…d99cbd`明确not-found。不能取得已不存在容器的当前挂载，也不扩大查询去找替代实例。
- B历史manifest明确引用的两个image仍存在：`sha256:4124547c03b00df0889ad5fa3dc6aa21f9942ebc920654a0415c349d68374ef2`与`sha256:ddec611f69017f6d88252033a21ff0c7a6557a41584f2549ce3bc62c19ea00e8`，两者平台均`linux/amd64`、Config.User均`node`，无OCI revision/owner标签。只能证明这两个准确image ID仍存在，不能证明本轮源码、包依赖、helper或实际挂载。
- 因目标容器已不存在，没有已证当前挂载卷名；未进一步遍历卷或运行环境。历史volume名称不能从应用数据库或全机搜索补找。
- inspect原始JSON只在内存筛选，未保存/输出Config.Env；私有只选字段回执位于本地调查目录，SHA256=`3f496e97c407ee0b902a9a079d9fb0c770ca8cd13be92b58e08c92ea00185389`。
- 本稿两段TypeScript签名/argv构造片段已用Node `stripTypeScriptTypes`语法解析通过；这不是新增函数实现或真实部署验证。

未决项因此不再包括“B历史镜像是否存在”的泛化调查，而是：A窗口释放及合入基线、新应用镜像身份、本轮独立受控配置、目标Linux导入/helper/tar与官方RPC/挂载能力。仅凭历史镜像仍在不能放行T0-remote；T1不依赖这些镜像。T0-remote保持未通过，等待窗口后针对本轮真实目标补证；不再阻塞获审本地步骤。

T1 本地PASS：2026-11-23，backup.ts/backup.test.ts已实现四种owner、离线SQLite backup/健康检查/hash、完整成员预验证与排他空目标恢复；固定六类测试6/6，无失败或跳过，typecheck及定向eslint通过。此为本地工具证据，不代表A7真实部署验收。

T3 本地PASS：2026-11-23，audit.ts/audit.test.ts七项通过，覆盖全部SQL值类型、精确integer、空表/带引号表名、全字段/receipt/history/表缺失拒绝、源hash不变、用户sqliteX表和物理行顺序、报告白名单与RPO实际集合差。typecheck/定向eslint通过；此非真实A7报告。

T0-remote同名能力补齐：第一次官方delete/waitDeleted及实际容器卸载后，只删除本轮空卷，明确volume absent，再排他创建**相同volume名和sandbox名**，沿同一固定CLI argv重新创建。同名卷必须先证明空内容再挂载；Docker volume无独立稳定ID，不断言volume-ID变化、不靠CreatedAt秒级差。第二次必须SDK waitReady、独立核新sandbox ref.id与新container.Id均不同于首次，且tenant/project/session语义绑定不变、volume名字/labels/实际mount目标与image一致。核第二次stop状态后再官方delete/waitDeleted，精确卸载/删本轮卷/tag。只有第二次同名重建和清理全PASS，T0-remote才通过；T5不再作为首次同名重建试验。任何失败保留两次实际ID和断言，不假定第一次create证明恢复。

T1a PASS：verifyBackup对root受管DB名集合与manifest.path集合精确比较；四库root+slice(1)拒绝，source/archive/occupied target canary摘要不变；独立单库root合法。固定backup suite7/7、typecheck/eslint通过。T0-remote已补两次同名创建与sandbox/container ID变化、卷absent→排他create→空内容→实际mount；不虚构volume ID。

T2a PASS：2026-11-23，仅本地生成三个私有源（daemon、worker-loopback、a7-bootstrap），原source三项SHA不变；shared model-relay/volume-io沿已核SHA不改。MASTER已定向批准专核来源替换为daemon/loopback/base及现有sdk-transport/provider，总10文件。官方SandboxClient无close，实际用既有createRunSdkTransport+new SandboxClient(transport)，finally关闭真实transport，不虚构SDK方法。adapter.test.ts 3/3、fail0/skip0，Node语法/精确patch/隔离argv/绑定与生命周期检查、Orchestrator typecheck/定向eslint通过。私有manifest SHA256=`0d2a60a353a249dc985d9eafe7892ecfb75c5a47eb01a6535bcbc56c4f25048a`，源位置和完整before/after仅留私有调查回执。执行adapter专项需显式BENTO_A7_ADAPTER_MANIFEST与BENTO_A7_ADAPTER_MANIFEST_SHA256，不进常规CI。未调用bootstrap/模型/SDK/Docker；Linux实际import新增a7-bootstrap.default检查，仍待T0-remote。

T2b PASS：2026-11-23，resources.ts/resources.test.ts/host.ts落盘；host复用commandHost/serveExecution，不用localHost。资源实现daemon/owner/image/mount/无写者检查、完整inventory、tar归档fsync、独立保全卷验证、同名空卷恢复、固定官方delete与CLI create；恢复后waitReady/实际ID发布由T4runner下一强制阶段执行。source保全/摘要坏/写者/额外挂载负例在command double下验证，零真实Docker/SDK调用；inventory helper另在本机临时目录实际运行验证字节及单反斜杠文件名拒绝。固定resources+adapter专项11/11、fail0/skip0，Orchestrator typecheck、三文件eslint、格式/diff通过。command double不证明真实卷/官方RPC能力；下一步停在T0-remote，等MASTER窗口与实值证据。T6仍须将backup/audit纯本地测试接常规corefast，当前尚未将远端或adapter私有用例接CI。

退役保护定向修复（2026-11-23）：resources的源卷实际容器必须具备与binding sandbox/name、gateway workspace/namespace一致的OpenShell标签和真实完整container ID（ps使用--no-trunc），其sandbox-id与官方get ref.id/name/workspace/owner/stopped逐项一致；delete子进程在实际SDK delete前再get并重验相同预期。格式合法错sandbox及官方ref不符均零SDK/卷delete，另以真实本地Node子进程+synthetic SDK模块直接证明ref不符时delete marker不存在。恢复入口及workspace归档入口均先核`backup/manifest.json`（schema1/caseId/四库members恰完整），调用verifyBackup核健康/hash/实际集合；workspace proof绑定该manifest原始SHA，退役前重新验证。缺库/manifest漏项/坏摘要拒绝链零删除，保留原坏archive/保全不符/额外挂载/运行写者保护。resources focused14/14、typecheck/eslint通过；仍无远端或真实SDK调用。后续RUNBOOK进度随实质代码/测试/稳定交付文档同提交，禁止连续RUNBOOK-only提交；不改写既有历史。

T4-local 本地PASS：driver独立测试13/13、fail0/skip0，类型/四文件eslint及格式检查通过；包含真实库文件布局与源hash不变、五项T0缺证拒绝、源码/镜像/daemon/adapter身份拒绝、CLI非法/缺配置拒绝、阶段序列拒绝提前报告/跳过保全、原历史/receipt前缀与实际授权快照提取。未执行真实suite，未生成A7 PASS，未操作远端。后续纯本地常规检查入口还应精确纳driver.test.ts，不纳real-restore/adapter私有用例。
