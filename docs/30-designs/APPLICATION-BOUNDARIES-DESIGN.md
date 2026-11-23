# Bento 应用与编排边界设计

## 目的与范围

落实[应用与编排边界需求](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md)。本文覆盖个人端和管理端接入统一编排、Run 权威状态、Worker 授权与单执行宿主恢复。系统组成与所有权见[Bento 整体架构](../00-governance/ARCHITECTURE.md)。

## 应用接入

- 个人端与管理端的认证前端、业务前端、API 独立构建。各端 API 从各自 Realm 验证身份并管理业务会话。Orchestrator 验证调用服务身份、操作权限与目标资源归属后才读写 Run。Worker 使用当次执行授权访问执行接口。
- 个人端认证构建生成 `apps/workspace/auth/dist/` 下的 `login.html`、`account.html` 和 `style.css`。Compose 将这三项产物复制到运行镜像。NGINX 经 Go 入口反代 `/auth` 到 TypeScript task-entry，后者持有 OIDC 会话并据此选择 HTML。
- 当前 Go Temporal 模块和 TypeScript 执行宿主通过私有 stdio 交接队列快照、Run ID、容量与推进请求。宿主执行状态和容量的条件写入后，才发布 Workflow。Go 子进程退出时宿主停止新增 Temporal 派发，重启后从持久状态恢复。
- 目标 Go Orchestrator 在同一服务边界内持有账本和 Temporal 编排。Workflow 只携带 Run ID，Activity 读回权威账本并沿用同一尝试与执行代次。

## Temporal 执行边界

- Bento 业务 Run ID 是稳定的业务标识。当前 Workflow ID 从该标识派生为 `bento-run-<runId>`。重复启动使用同一 Workflow ID，已存在的 Workflow 视为原派发已接受。启动结果未知时沿用原 ID 对账。Temporal 单次执行的 Run ID 用于流程诊断。
- Workflow 负责确定性的流程编排。数据库、模型、文件和沙盒 I/O 由 Activity 推进受信执行链。当前 `advanceRun` 定期发送 heartbeat，业务进度与会话检查点由持久存储维护。文件正文、完整对话和执行凭据不得进入 Workflow 参数、结果或 heartbeat。
- heartbeat 超时或取消送达时，受信控制面仍须独立观察 OpenShell 与宿主上的旧执行。持久化的执行尝试和代次用于接管校验，Temporal 的 Activity 重试计数不能充当执行授权。

## 状态、授权与恢复

同一部署重启后，Orchestrator 从持久账本恢复 Run、执行尝试、槽位、Session、Workspace 和代次绑定。Temporal 重投读取同一 Run 的既有尝试。发出运行时启动请求前，Orchestrator 持久消费启动权。启动结果未知时，按原尝试观察或清理，并区分对象不存在、查询失败和已确认停止。确认宿主和沙盒两侧的旧执行均已停止后才释放槽位。

恢复依据已提交的 DSH 检查点、业务账本和 Workspace。远端操作的稳定标识与结果引用用于对账。无可靠证据时保留 `UNKNOWN`，阻止重放和新代写入。资源绑定缺失或不一致时拒绝执行，并记录原 Run、执行代次及相关操作 ID，供可信侧排查。

复用固定 npm OpenShell 插件、官方 checkpoint/SessionPersistence、OpenShell 生命周期与认证以及持久卷。平台实现业务绑定、执行授权、派发和恢复协议。以下交接检查适用于单执行宿主。

## 三层职责与交接

| 层        | 已验证支撑                                                                                                             | 进入实现时必须补充                                                                   | 验收                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| 任务会话  | SessionPersistence/provider/checkpoint；旧代 append/flush/close 拒绝；跨主机历史恢复、批次回执、提交未知与事务故障对账 | 业务 Session/Run/审批生命周期、生产持久化与动态身份、外部工具幂等/查询契约           | A1/A2/A5；EXP-023～025                |
| workers   | 单宿主 Temporal 调度；多 Session 路由；子 Agent 继承；双主机接管；有限 OS 凭据隔离和失权 checkpoint                    | 长期池复用/排空、租户公平性/配额、单宿主停止观察                                     | A3/A6/A8；EXP-019/020/022             |
| OpenShell | 单节点共享 Volume/删除重挂；SSH/PTC 分离、撤 key+断旧连接+stop；固定插件；mTLS 后端与服务端 SDK/raw 准入               | 真实项目导入、目录/卷 ACL、已启用入口的权限、资源/出口限制、动态能力签发、单宿主备份 | A1/A3/A4/A7；EXP-015～018/020/021/025 |

双 worker 主机不等于双执行宿主；部分 AgentLoop 用固定模型适配器；confinement=partial。原始 Gateway 旁路已在受测 worker 权限边界封住，不能继续标成完全未验，也不能据此宣称全入口或恶意宿主隔离已完成。

## 三组交接不变量

| 边界                    | 必须持久化的事实                                                        | 失败场景与通过条件                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会话 ↔ worker           | Session/Run、owner/generation、事件序号、待对账批次与回执               | A 暂停/崩溃、B 接管后 A 恢复；旧代 append/flush/close 拒绝；已提交不重复写，未提交先对账；AgentLoop 失权不再发新副作用                           |
| worker ↔ OpenShell      | 执行 grant、operation 身份、撤权/停止观察、sandbox instance、READY      | 入口/控制器每阶段崩溃、旧连接/重连/子进程、迟到 stop；未完成旧执行停止和 CAS 不放行新代，UNKNOWN 不盲重放。断流与100ms重检不算 detached 停止证明 |
| 会话 ↔ Workspace/Volume | tenant/workspace/session/sandbox/volume mount、导入状态、引用与回收归属 | 创建部分成功、挂错卷、沙盒删除重建、孤儿资源；正确挂载并恢复文件，不静默建空卷，不因删除一个 Session 误删共享卷或撤销其他 Session                |

数据库事务与远端资源变化不构成同一原子事务。intent、observe/reconcile、可信补偿、receipt 与 READY 必须形成可恢复协议；单机阶段强杀、SSH/PTC停止、工具中断恢复和最新SDK入口各有证据，最终实现仍须在同一链做联合故障验收。

## 执行链实施设计

各阶段放行条件见 [交付验收](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)。

### 实施顺序

| 阶段                 | 交付内容                                                            | 复用基础与必要实现                                                                                   | 放行条件                                                              |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 可信绑定和服务入口 | 用户/项目/Session/Run/沙盒/卷映射、动态身份、受控 SDK/SSH 入口      | 现成身份服务、OpenShell 原生认证、已有 ingress/broker；补业务 ACL、capability 生命周期与管理凭据隔离 | A1；未支持入口明确关闭；partial 的部署信任边界明确                    |
| 2 持久会话和接管     | provider 服务、批次回执、checkpoint、持久 operation 与 READY 状态机 | 既有 provider/CAS/SQLite 实验逻辑、官方 checkpoint、OpenShell stop/observe/start；补可信控制器协调   | A2/A3；在最终入口每阶段强杀，旧代拒写、新代不提前放行、未知结果可对账 |
| 3 项目纵向执行链     | 真实项目导入、共享卷、真实任务与子 Agent，故障后继续                | 固定插件、外部 Volume、官方 AgentLoop；补 staging、冲突策略和引用回收                                | A4/A5；同一版本/transport 的历史、文件、副作用和权限联合核对          |
| 4 调度及可运维发布   | Temporal Run 工作流、worker 池、取消审批、限额、部署升级            | Temporal/现成资源控制；补业务流程、池复用/排空与告警                                                 | A6/A8；证据可复跑、依赖固定、回滚可操作、资源超限被拒                 |

单执行宿主交付包含 A7 的备份还原。第一条纵向实现优先完成 A1～A5、A8。调度架构可以同步实现，但 Activity 重试不能越过副作用对账。Temporal 的单执行宿主接入及故障验证见[需求完成状况](../40-readiness/CURRENT-READINESS.md)。首版范围允许明确限定为单执行节点；是否支持 PTY/SSH、真实多租户不可信代码、跨节点卷，应作为产品和部署能力开关及验收边界，而非默认开放。

### 实现与复用

组件复用方案按需求验收，验证进度见[需求完成状况](../40-readiness/CURRENT-READINESS.md)。

| 实现项               | 优先复用                                                          | 平台必须补充                                                     |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Session 状态和历史   | 官方 SessionPersistence、checkpoint；已有 fenced provider/服务    | 生产服务部署、认证、批次恢复契约、可观测性                       |
| 业务绑定和接管       | 数据库事务/CAS、持久 operation/receipt、已验 stop/observe         | 单宿主条件写入、可信 READY 发布、迟到操作屏障、孤儿回收          |
| 执行准入             | OpenShell 原生 TLS/mTLS、官方 SDK schema、现有 ingress/SSH broker | 动态身份与 capability 生命周期、资源 ACL、所有启用入口统一策略   |
| SSH/PTC helper       | 官方 SSH/provider/PTC，固定 helper 构建适配                       | 发布可复现 helper、依赖锁定；要求纯正式接口时推动 helper factory |
| 持久 Workspace       | 外部 Volume 和 OpenShell driver mount                             | 项目导入、卷授权、并发写协议、备份/恢复、资源引用回收            |
| Run 调度和 worker 池 | Temporal Workflow/Activity                                        | 业务工作流、取消/审批、池复用、排空、租户配额                    |
| 运行隔离与资源治理   | 容器/OS 身份、OpenShell policy、现成资源控制                      | 明确信任边界、读写/网络/secret/CPU/内存/PID/磁盘/输出约束        |

OpenShell Gateway interceptor 的固定源码白名单可以管理部分一元控制面 RPC，但不能绑定 ExecSandbox/ExecSandboxInteractive 流式执行。当前可行组合是原生 mTLS 保护后端、平台服务端入口检查业务 generation/READY；入口是新增平台代码，并非已有插件零配置提供。可信管理证书不可下发 worker。

## A1-03 旧执行授权验收接线

[A1-03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-03-bad-case-旧执行授权) 的本地验收入口是 [binding-grants.test.ts](../../apps/orchestrator/tests/openshell/binding-grants.test.ts)，由 Orchestrator 既有 `tests/openshell/*.test.ts` 纳入 `pnpm check`。独立 [fixture](../../apps/orchestrator/tests/openshell/binding-grants/fixture.ts) 经生产 SingleHostExecution.bind/admit 签发真实当次 capability，调用真实 sdkIngress 和 operationIngress；不使用手填 token、手造 grantFor 或 SQL 写授权来替代入口。

[SDK 准备器](../../apps/orchestrator/tests/openshell/binding-grants/sdk.ts) 将 NVIDIA/OpenShell 源码归档缓存到仓库旁的 `../bento-sdk-cache/openshell/<revision>/source.tar.gz`，在独立受控临时目录构建 revision `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47`，校验归档 SHA-256 `4c14a574c0bd2feccbc5198ef9fc64f6e75c7f5ef89b5f2fe478f7688fefa43f`、官方 lock 和生成配置后，以官方锁正常安装、生成和构建。缓存命中时复验归档 SHA-256，不再下载；首次下载仅在完整校验后原子发布，失败或中断的文件不会成为缓存。npm 与 Buf 下载缓存分别复用 `../bento-sdk-cache/npm/` 和 `../bento-sdk-cache/buf/`，测试结束只清理本次临时构建目录。损坏的源码缓存明确失败，不静默替换。官方 protobuf 编码交给生产 schemaDecoder/schemaExecEventDecoder，覆盖 GetSandbox、ExecSandbox、ExecSandboxInteractive、stdin 与 exit；[六项工具探针](../../apps/orchestrator/tests/openshell/binding-grants/sdk-probe.ts) 不计作业务验收。固定 CI 入口缺工具、网络或 SDK 时明确失败，不跳过或退为 JSON mock。

每例先有合法控制，再调用生产 takeover 完成撤权阶段。SDK/operation/持有流 fixture 没有独立沙盒停止证明，stopped 固定 false；精确期待 `old execution unconfirmed`，独立 SQL 保留 UNKNOWN、generation1、原 Run/绑定和 capabilityNULL，只调用一次，不伪造 READY 或清理未知 operation。新 stream、重连、原库 reopen 后旧 token 在生产 grant/authorize 层拒绝为 header16；已授权且未发响应头的持有 interactive 流在撤权时返回 header7，实际观察两侧关闭与后续 stdin 未达 upstream。

真实 mTLS/HTTP2、HTTP 与 SQLite 用于验证平台入口的拒绝；upstream 是独立受控服务器，模型和沙盒观察是 fixture。只读独立连接核对权威状态、operation 与历史；无历史行时按生产 fence 的 absence 契约处理，不冒充真实历史行撤销。历史拒绝另复用既有官方 Provider fixture，先正常 checkpoint，再真实撤权，以旧 writer.append 观察 stage403/SessionOwnershipLostError、四表不变、真实历史行 epoch/owner/handle 栅栏和同库 reopen；该子链不修改原 A2 场景或 flush 时序。

[发布检查](../../apps/orchestrator/tests/openshell/binding-grants/check-package.mjs) 在固定 Orchestrator check 中核对实际安装树的 npm pack 清单，保留根 files/patterns，精确登记新源并拒绝依赖、TLS/数据库和私有证据。实际验证结果和未覆盖项见 [A1-03 Readiness](../40-readiness/CURRENT-READINESS.md#a1-03-旧执行授权本地验收)。本接线不证明外部 OpenShell/Docker 进程停止、全部署绑定或 A3 接管就绪，也不关闭 A1 的其他子项。

## A2 Provider 验收接线

[A2-01/02/03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a2-持久会话) 的本地联合验收使用 [固定测试入口](../../apps/orchestrator/tests/openshell/provider-lifecycle.test.ts) 和 [独立 fixture](../../apps/orchestrator/tests/openshell/provider-lifecycle/fixture.ts)，由既有 Orchestrator `tests/openshell/*.test.ts` 纳入 `pnpm check`。Orchestrator 测试依赖将官方 AgentRegistry、AgentLoop、SessionStore、session-projection、LLM、system-prompt、tools、scope、session-checkpoint-policy 固定为 `0.2.1-rc.4`，沿用 SessionPersistence `0.2.1-rc.4` 与 Cordis `4.0.5`；不改变生产 worker 装配。

写句柄只能经官方 `ctx.agents.create/resume` 获取，AgentLoop 保存 constructor/setup suffix，避免裸 prepare/enter 遗漏 seed marker。官方 checkpoint policy 在 pre-step/model dispatch 前调用 `ctx.sessions.flush`，经生产 RemoteSession→真实 HTTP persistenceIngress/WorkerGate→SessionHistory SQLite 完成 stage/append/reconcile/flush；正常轮末再显式等待 checkpoint，然后先处置 Agent 再关闭 root Context。两库同路径重开后官方 resume 保留原历史并允许合法新代续写。

测试代理原样转发生产 ingress，只在上游 append 成功且独立 SQL 确认提交后丢一次下游响应，用原 Provider pending 批次验证原回执重投。三种旧代操作各用独立活句柄，分别观察真实授权拒绝；append 在 stage 入口已被拒，不将该结果描述为 backend append 分支已执行。数据库、HTTP 和官方生命周期为真实实现；模型与沙盒观察为受控 fixture。实际结果及外部边界见 [A2 Readiness 证据](../40-readiness/CURRENT-READINESS.md#a2-官方-provider-本地验收)。

[A2-04/05崩溃恢复验收](../../apps/orchestrator/tests/openshell/provider-crash.test.ts)复用[共享官方runtime](../../apps/orchestrator/tests/openshell/provider-lifecycle/runtime.ts)，由[独立子进程](../../apps/orchestrator/tests/openshell/provider-lifecycle/crash-child.ts)运行真实持久化host与官方DSH caller。子进程入口及cwd从import.meta.url定位仓库根目录，根focused与Orchestrator聚合入口一致。COMMIT前后分别真实SIGKILL持久化进程；caller另在stage/append已提交、下游ACK尚未收到时SIGKILL。测试专用包装仅在子进程拦截公开DatabaseSync.exec边界，不增加生产debug endpoint或复制生产事务写SQL；独立readOnly的priorCommitted与事务自身transactionView分开，合法先提交批次逐项核对，重开四表无半批。

正式恢复沿`runDshWorker`的prior分支，在交给官方AgentLoop前调用`reconcileSessionPersistence`；RemoteSession只用当前Session open(write)→无batch参数reconcile→close。控制面先通过takeover/admit撤旧句柄并授予新代，持久intent仍由SessionHistory自行读取；未提交时以新代提交，已提交时按intent.epoch找到并复用旧receipt，随后删除intent。父进程/旧caller不得向新Worker提供batch/events/receipt来协助发现。共享runtime唯一显式处置AgentHandle与root Context；测试bootstrap以小包装委托官方Agent，WeakMap映射回真实Session作flush identity校验，不伪造或过滤历史。snapshot局部类型适配只校验生产实际消费字段，保留官方header.reason字符串，不能当作完整SDK/生产窄shape兼容证明。

四场景均要求同双库重开、SQL/Provider读回及合法新代正常轮，reconcile本身的seq/revision/receipt变化与之后官方resume后缀单独核对。模型、沙盒观察和bootstrap仍为fixture；本地强杀不等于真实外部OpenShell故障接管或独立停止证明，实际证据见[Readiness](../40-readiness/CURRENT-READINESS.md#a2-崩溃恢复本地验收)。

## Worker 正式 base 与每轮资源所有权

[A6-05](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a6-05-bad-case-跨会话池重用)的正式装配入口为[base-bootstrap.ts](../../apps/worker/base-bootstrap.ts)，由既有[run-worker.ts](../../apps/worker/run-worker.ts)加载；预热模式仍每次请求创建新的官方Context、Agent/SessionStore、AgentLoop、checkpoint和OpenShell provider，正常回执后保留进程，review或异常沿原warmSlot策略退出补位。长期复用验收状态以[Readiness](../40-readiness/CURRENT-READINESS.md)为准，源码接线与单轮单测不能代替四项长期隔离证据。

可信只读配置`BENTO_DSH_RUNTIME_CONFIG`按代码中的BaseBootstrapConfig校验完整字段；SDK模块和模型factory为可信部署文件，tenant/Session/Run/generation/sandbox及grant仅来自本次WorkerRequest。模型factory仅收到provider/model，返回新的官方LlmAdapter和disposer，不能替换ctx/runtime/provider或复用单例；静态WeakSet拒绝重复adapter实例，不强持有其凭据。恢复不创建SDK连接或模型adapter。base没有通用工具目录或publicEvents，Task缺投影沿原Worker门禁返回review，不用空投影冒充结果。

每轮[sdk-transport.ts](../../apps/worker/sdk-transport.ts)只接生产回环`http://127.0.0.1:<port>`，逐请求使用该轮grant，管理凭据和mTLS仍归Orchestrator。官方SandboxClient使用此transport；底层session由Worker显式持有，关闭先拒绝新RPC并以HTTP2 CANCEL结束在途stream，再等真实session close，截止后残留是失败。不能假定固定官方OpenShellClient存在close接口，不能以调用destroy或状态标志代替真实关闭。

资源清理按AgentHandle完整dispose→注销adapter→root fiber/provider/持久化清理→SDK关闭→模型disposer依次执行，失败仍尝试其余阶段并聚合错误；回执必须在清理之后。官方factory也持有结构所有权，base先等显式handle清理结算才卸root，沿其共享teardown避免重复关闭。Agent快照保留原事件，仅断言Worker实际消费的turn/end.reason.kind及tool/result.error.code，不改写request/header.reason或伪称全事件类型兼容。单轮与故障清理验证见[base单测](../../apps/worker/base-bootstrap.test.ts)，其中SDK helper/model是受控fixture，不代表真实沙盒文件系统或生产模型。

长期验收沿[real-reuse.test.ts](../../apps/orchestrator/acceptance/worker-reuse/real-reuse.test.ts)正式prewarmedWorker→run-worker --warm→runDshWorkerLoop→runDshWorker→base链路。默认长时模式为1个reference与64测量Session、8tenant同原生PID运行至少315秒；PR CI使用连续模式，保留相同64轮与隔离断言但不主动补足每轮5秒间隔，main CI仍运行长时模式。连续模式仅验证轮次复用，不代替长时间驻留证据。两种模式每轮持久历史/模型请求独立，凭据/监听器/连接/文件namespace分项负测。旧Context事件在下一base创建之前触发，避免当轮合法200ms批次刷盘干扰归属；父端有界IPC与真实server计数同时覆盖SDK/模型及persistence/operation，整轮与轮间继续查迟到旧身份请求。观测包装不替代生产清理。

R独立验证正式takeover撤权时持有输入流关闭与旧凭据重连拒绝，Worker退出补位；沙盒退出未独立确认时仍为UNKNOWN。E在模型disposer注入失败并确认其余资源关闭；L验证空闲pool停止/同库重开/继续新Session且旧events和receipts完整不变。资源、模型、沙盒helper的实际边界与64轮结果见[验收证据](../40-readiness/CURRENT-READINESS.md#a6-05-worker-长期池复用)，可信运行时配置与恢复操作见[部署手册](../../deploy/README.md#worker-正式运行时与复用验证)。
