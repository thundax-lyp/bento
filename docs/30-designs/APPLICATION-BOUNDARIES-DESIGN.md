# Bento 应用与编排边界设计

## 目的与范围

落实[应用与编排边界需求](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md)。本文覆盖个人端和管理端接入统一编排、Run 权威状态、Worker 授权与单执行宿主恢复。系统组成与所有权见[Bento 整体架构](../00-governance/ARCHITECTURE.md)。

## 应用接入

- 个人端与管理端的认证前端、业务前端、API 独立构建。各端 API 从各自 Realm 验证身份并管理业务会话。Orchestrator 验证调用服务身份、操作权限与目标资源归属后才读写 Run。Worker 使用当次执行授权访问执行接口。
- 个人端认证构建生成 `apps/workspace/auth/dist/` 下的 `login.html`、`account.html` 和 `style.css`。Compose 将这三项产物复制到运行镜像。NGINX 经 Go 入口反代 `/auth` 到 TypeScript task-entry，后者持有 OIDC 会话并据此选择 HTML。
- 管理端通过独立 OIDC 会话提供 Workspace 诊断提交与回读。管理 API 和 Orchestrator 各自校验 Workspace 授权，Orchestrator 将固定诊断指令交给现有项目 Run 链路。请求与错误语义见[应用 API 与 Orchestrator](../20-interfaces/APP-ORCHESTRATOR-INTERFACE.md#管理端诊断)。
- 当前 Go Temporal 模块和 TypeScript 执行宿主通过私有 stdio 交接队列快照、Run ID、容量与推进请求。宿主执行状态和容量的条件写入后，才发布 Workflow。Go 子进程退出时宿主停止新增 Temporal 派发，重启后从持久状态恢复。
- 目标 Go Orchestrator 在同一服务边界内持有账本和 Temporal 编排。Workflow 只携带 Run ID，Activity 读回权威账本并沿用同一尝试与执行代次。

## Temporal 执行边界

- Bento 业务 Run ID 是稳定的业务标识。当前 Workflow ID 从该标识派生为 `bento-run-<runId>`。重复启动使用同一 Workflow ID，已存在的 Workflow 视为原派发已接受。启动结果未知时沿用原 ID 对账。Temporal 单次执行的 Run ID 用于流程诊断。
- Workflow 负责确定性的流程编排。数据库、模型、文件和沙盒 I/O 由 Activity 推进受信执行链。当前 `advanceRun` 定期发送 heartbeat，业务进度与会话检查点由持久存储维护。文件正文、完整对话和执行凭据不得进入 Workflow 参数、结果或 heartbeat。
- `advanceRun` 以 Temporal 最近确认的 heartbeat 为本地执行期限。确认超时、Activity 失效或控制连接中断时，执行服务按本次 Activity 关联的 Run 和代次撤权，等待 Worker 退出并核验 OpenShell 沙盒停止后才释放槽位。持久化尝试及代次用于接管校验，Activity 重试计数只用于流程诊断。

## 状态、授权与恢复

同一部署重启后，Orchestrator 从持久账本恢复 Run、执行尝试、槽位、Session、Workspace 和代次绑定。Temporal 重投读取同一 Run 的既有尝试。发出运行时启动请求前，Orchestrator 持久消费启动权。启动结果未知时，按原尝试观察或清理，并区分对象不存在、查询失败和已确认停止。确认宿主和沙盒两侧的旧执行均已停止后才释放槽位。

恢复依据已提交的 DSH 检查点、业务账本和 Workspace。远端操作的稳定标识与结果引用用于对账。无可靠证据时保留 `UNKNOWN`，阻止重放和新代写入。资源绑定缺失或不一致时拒绝执行，并记录原 Run、执行代次及相关操作 ID，供可信侧排查。

复用固定 npm OpenShell 插件、官方 checkpoint/SessionPersistence、OpenShell 生命周期与认证以及持久卷。平台实现业务绑定、执行授权、派发和恢复协议。以下交接检查适用于单执行宿主。

### Go 权威账本与双侧停止证明

单宿主部署已把执行授权和代次写入交给 Go。Compose 在执行宿主中配置 `BENTO_GO_AUTHORITY`，TypeScript 经私有子进程管道调用 Go 的领域命令。Go 使用原 `authority.sqlite` 提交绑定、准入、撤权、启停预约、停止确认、代次 CAS 和操作状态。SDK 入站继续读取同一账本。Go 在原代已经 `STOPPED` 时核对业务准入和持久 Worker 退出记录，再写入双侧停止证明。槽位释放和升级排空按同一证明摘要提交业务消费记录。

启用 Go 权威入口后，Go 在原 `business.sqlite` 中提交初始入队、重试申请及恢复完成后的重试 Run，并在创建 Run 的同一事务追加对应任务事件。队列配额同时计入排队 Run 和未完成的重试预约。重试完成恢复后，同一事务将预约转换成排队 Run、追加重试事件并推进预约状态。TypeScript 处理个人端认证、请求校验和幂等回执读取。Go 另外负责派发预约与容量检查、取得和释放持久槽位，以及 Run 的开始、恢复、取消和结果发布。Go 排空先写入准入门禁，再等待活跃 Run 和槽位租约收口，最后消费槽位已用过的停止证明。已入队但尚未启动的 Run 可由接手的部署继续调度。

Go 持有 Run、资源绑定、执行尝试和槽位租约。个人端 API 从已认证会话解析用户与 Workspace 归属。账本冻结 Run、Task、Session、Workspace、独占卷、执行代和尝试的绑定，并记录运行时实例身份。Worker 仅获取当次执行所需的短时 grant。控制面凭据留在受信进程，Worker 的环境、挂载和服务可达范围按真实部署复验。

1. 接管事务按旧代和尝试做条件更新，撤销 grant，持久化停止意图并保留槽位。工具接受执行前持久化操作身份。回执缺失时，重投读取原操作的 `UNKNOWN`。控制器重启和停止、观察、启动回包丢失时，从同一尝试恢复。启动请求在途时保留原实例身份和启动权消费记录，直到完成对账。
2. 两条受信观察路径分别提交宿主和 OpenShell 证据。宿主核对原 Worker 执行单元及其子进程退出、旧代无运行中的可写卷附件。OpenShell 核对原 sandbox 实例及其执行已停止。证据绑定原 Run、尝试、代次、实例和卷，并关联持久撤权记录。观察失败或身份不一致时保留待确认状态。迟到的 stop 始终按原实例身份寻址。
3. Go 在同一账本事务中校验证据身份与撤权状态，持久化旧代停止证明。工具结果未知时继续保留原操作及禁止重放状态。新代放行还需满足恢复与历史对账条件，再以代次 CAS 转入 READY。现有 TypeScript 恢复回执要求 READY 且未知操作数为零。该回执继续服务历史恢复，旧代停止证明可先在操作仍为 `UNKNOWN` 时落账。
4. 槽位释放按原租约消费已持久化的停止证明，重复消费幂等。控制器重启取得独占锁后，在恢复准入的同一事务回收已达终态且满足停止证明条件的残留租约。升级进入排空时停止新增领取，待所有旧版活跃尝试的租约完成释放后切换。部署失败或回滚后仍从账本恢复未释放租约，并保留同一审计链。

[单宿主执行控制](../../apps/orchestrator/src/openshell/single-host.ts)在受信宿主启用对应能力时按以下方式执行接管。

- 接管、执行失联和 Session 撤权先调用 `freezeGeneration`，确认原实例及卷已停写，再提交撤权。原实例保持暂停直至终止。Worker 退出与沙盒停止仍分别取证。
- 旧代停止结果未知时先独立观察原实例。观察尚未确认停止时，可经 `stopGeneration` 对原实例续投并再次观察。
- 持久启动预约进入 `START_UNKNOWN` 后，控制器经 `startGeneration` 交付原预约。宿主按 Session 和原代持久去重，控制器独立观察后继实例、策略和卷后通过 CAS 发布 `READY`。

命令宿主能力开关与回退行为见[部署手册](../../deploy/README.md#openshell-执行宿主)。实栈范围见 [A3 接管验收](../40-readiness/CURRENT-READINESS.md)。

### Task Run 审批

启用审批时，Go 在创建 Task Run 时写入 `pending_approval`。该状态保留 Task 的单活跃 Run 约束并占用租户队列额度。派发器只领取已入队的 Run，因此待审批期间没有 Workflow、槽位或 Worker 授权。受信运维决策和审计在同一事务落账。批准将原 Run 转为 `queued`，拒绝将原 Run 转为 `cancelled`。所有者取消和账号关闭也可终止待审批 Run。操作入口见[部署手册](../../deploy/README.md#task-run-审批)。

### 单宿主实栈验收

实栈验收从个人端提交 Run，并核对登录主体到独占卷的完整绑定。实际工具向独占卷追加带稳定操作 ID 的记录，受信观察确认写入后，在工具回执持久化前中断 Worker。随后使用同一 Run 核对宿主与 OpenShell 停止、旧连接与重连拒写、`UNKNOWN` 查询及重投。由独立只读路径在中断后和重投后核对同一操作 ID 的记录数均为 1，同时核对期间没有新的工具执行。取得这一组证据后，再以同一停止证明验证槽位未提前释放、后续派发和升级排空。

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

Docker/OpenShell 故障验收遵循[故障注入约束](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#dockeropenshell-故障注入)。控制器在持久阶段边界中断，Worker 在按 Run、执行代和沙盒实例定位后中断。启动在途时由恢复侧观察原 Docker 请求及容器，再决定是否继续原尝试。

数据库事务与远端资源变化不构成同一原子事务。intent、observe/reconcile、可信补偿、receipt 与 READY 必须形成可恢复协议；本地进程中断、SSH/PTC 停止、工具中断恢复和最新SDK入口各有证据，最终实现仍须在同一链做联合故障验收。

## 项目导入与共享卷生命周期

- **导入与绑定**。Orchestrator 按 owner 和幂等键保留导入回执。同键同输入返回原项目，同键异输入返回 `409 idempotency_conflict`。新卷在 staging 校验文件树、受支持的权限和内容哈希后进入 READY。已有 READY 卷再次绑定时只核对身份和挂载，保留当前工作树。一个 Workspace 可显式绑定多个同租户的合法 Session，每个 Session 使用独立 sandbox、授权和代次。绑定记录固定 tenant、Workspace、volume、Session 与 sandbox，拒绝越权和挂载不符。重建 sandbox 使用原卷并重新核对绑定。
- **并发写入**。采用卷级独占写入。Orchestrator 在启动可写 Run 或授予其他写入口前，原子登记 volume、Session、Run（如适用）与 generation 的写入权。另一合法 Session 的写请求返回可重试的 `volume_busy` 冲突，保持无副作用。文件工具、Bash、子 Agent 及启用的 PTY、SSH 均受此门禁约束。租约过期或撤权后，确认旧代进程、连接与写挂载均无法再写，才允许下一写入者。存在未决写入证据时保持阻塞并对账。
- **撤权与引用**。Orchestrator 持久记录 Session 绑定、释放回执及卷回收回执。当前项目卷的持有者是各个 Session，项目元数据可以在卷回收后按项目删除流程清理。撤权只使目标 Session 的授权失效并停止该 Session 的执行，保留它的持久绑定直到显式解除。删除 Session 时先拒绝该 Session 的新执行，确认停止与卸载后释放它的引用。其他有效引用继续保有同一卷及访问权限。
- **最终回收**。最后一个持久引用释放时，原子将卷标为待回收并拒绝新绑定。可信宿主核对卷所有权、零挂载、零写入者后删除，Orchestrator 持久化已删除回执。启动及运行时自动按原卷身份继续对账，区分确认不存在与观察失败。最后一个引用删除与待回收状态在同一 SQLite 事务提交。待回收及回收成功的卷 ID 均拒绝重新绑定。

可信控制面通过 Orchestrator 的 `sharedSessions` 管理绑定与 Run 授权，首个 Session 仍随项目导入建立。项目 Run 可显式绑定同卷的第二个 Session，调度和接管从 Run 保存的 Session ID 读取权威绑定。外部命令宿主须启用共享卷并实现独立的 attach、detach、reclaim 观察。当前实现用于项目执行路径，Task 恢复路径保持独占卷。部署接线和运行方式见 [部署手册](../../deploy/README.md#共享卷宿主)，逐项实测见 [A4 验收](../40-readiness/evidence/A4.md)。

## 执行链实施设计

各阶段放行条件见 [交付验收](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)。

### 实施顺序

| 阶段                 | 交付内容                                                            | 复用基础与必要实现                                                                                   | 放行条件                                                                        |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1 可信绑定和服务入口 | 用户/项目/Session/Run/沙盒/卷映射、动态身份、受控 SDK/SSH 入口      | 现成身份服务、OpenShell 原生认证、已有 ingress/broker；补业务 ACL、capability 生命周期与管理凭据隔离 | A1；未支持入口明确关闭；partial 的部署信任边界明确                              |
| 2 持久会话和接管     | provider 服务、批次回执、checkpoint、持久 operation 与 READY 状态机 | 既有 provider/CAS/SQLite 实验逻辑、官方 checkpoint、OpenShell stop/observe/start；补可信控制器协调   | A2/A3；在最终入口逐阶段中断目标控制器，旧代拒写、新代不提前放行、未知结果可对账 |
| 3 项目纵向执行链     | 真实项目导入、共享卷、真实任务与子 Agent，故障后继续                | 固定插件、外部 Volume、官方 AgentLoop；补 staging、冲突策略和引用回收                                | A4/A5；同一版本/transport 的历史、文件、副作用和权限联合核对                    |
| 4 调度及可运维发布   | Temporal Run 工作流、worker 池、取消审批、限额、部署升级            | Temporal/现成资源控制；补业务流程、池复用/排空与告警                                                 | A6/A8；证据可复跑、依赖固定、回滚可操作、资源超限被拒                           |

单执行宿主交付包含 A7 的备份还原。第一条纵向实现优先完成 A1～A5、A8。调度架构可以同步实现，但 Activity 重试不能越过副作用对账。Temporal 的单执行宿主接入及故障验证见[需求完成状况](../40-readiness/CURRENT-READINESS.md)。首版范围允许明确限定为单执行节点；是否支持 PTY/SSH、真实多租户不可信代码、跨节点卷，应作为产品和部署能力开关及验收边界，而非默认开放。

单执行节点的计划停服恢复采用四库（执行账本、授权、Session 历史、Temporal）及真实工作区卷的一致停写集合。恢复仅写入独立空目标，先校验摘要、数据库健康及资源绑定，再通过正式入口回读原 Run 并在原 Session 继续执行。Gateway 身份与模型服务作为保留依赖；账号、身份数据库及 S3 的整站灾备另行验收。命令与失败保全方式见[部署说明](../../deploy/README.md#单执行节点真实备份恢复与重启验收)，实测版本和 RPO/RTO 见[A7 证据](../40-readiness/evidence/A7.md#a7-单执行节点真实恢复验收)。

### 双执行宿主的人工故障转移

首版多节点以两个可独立管理的执行宿主承载一个部署，任一时刻只有一个宿主有权运行该部署的控制器和执行单元。备用宿主保存已校验的恢复点。运维从独立于执行网络的管理面发起切换。故障恢复承诺以已复制并校验的检查点为界，RPO 以源端最后已确认记录与恢复点的差异衡量，RTO 计至备用宿主经正式入口完成后续执行。当前状态及双宿主基线见 [A7 验证证据](../40-readiness/evidence/A7.md)。

切换按以下顺序推进。

1. 在源端确认准入关闭、已执行的副作用已归档或标为 `UNKNOWN`、Worker 和沙盒已停止。故障时通过独立管理面隔离旧端并禁止重启写入单元。执行网络超时、SSH 失联或备用端单方面请求均不能作为停写证明。管理面也无法确认隔离时，保留原控制权，暂停切换。
2. 以原部署标识和受信停止证据核对恢复点。复用四库一致停写快照、卷清单和资源绑定校验。先核对独立副本，再恢复到空目标。若最后一次确认边界无法确定，记录缺失范围为未知。恢复后仍未对账的执行尝试保留 `UNKNOWN`，禁止重放。
3. 切换控制面使用部署级的持久控制权记录，以原宿主和原控制世代做条件更新。竞争请求只能为同一恢复点选出一个目标。目标端启动前核对当前控制权与恢复点摘要，当次选择和原端隔离证据一并持久化。隔离必须在切换服务退出、网络恢复和旧端重启期间持续生效。旧端回归时按备用宿主重新加入。
4. 分别演练数据库故障、工作区存储故障、宿主失联、运行中网络分区和并发切换。每项从正式入口回读 Run、Session 和文件，独立观察 Worker 与沙盒。记录源端隔离以及实际接管次数，复算一致性、RPO/RTO，确认同一 Run 不出现第二次执行。

以上为多节点实施设计。当前单宿主启动入口中的本地文件锁只覆盖同一路径；独立账本副本仍可同时发放启动权。管理面通过 `recovery-owner` 在独立数据库中按部署和控制世代持久化控制权。命令接收已由受信调用方核验的恢复点与隔离证据摘要。控制权提交可按同一来源、目标、世代和证据幂等重试。执行服务在多节点启用 `BENTO_RECOVERY_GATE` 时，在打开本地业务状态和初始化执行宿主前实时查询控制权记录。返回的宿主、世代或任一证据摘要不符，以及管理面不可用时，进程退出。外部隔离仍负责已运行的源进程和容器。备用端准备步骤复用 A7 的成员核验。它先校验四库清单、原资源绑定、卷归档和管理面指定的检查点，再向空目录恢复四库，并向新卷恢复工作区及回读文件清单。此步骤无需访问原宿主。实栈已分别验证数据库目录不可达、工作区卷丢失、执行网络分区、执行服务失联及并发接管。测量与边界见 [A7 验收证据](../40-readiness/evidence/A7.md#a7-04-运行中执行宿主失联与网络分区)。源端沙盒退役要求 Docker 与 OpenShell 独立确认原实例已停止，退役后核对同卷已无附件，并保留源卷。备用端创建沙盒前重新比对卷清单，并实时确认管理面将同一检查点授予本宿主。正式接管时独立核对 Worker 退出或未运行、源端禁启和备用端继续执行。

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

## A1-02 资源绑定隔离验收接线

[A1-02](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-02-bad-case-伪造资源绑定) 的三个独立入口套件为 [绑定控制](../../apps/orchestrator/tests/openshell/binding-forgery-control.test.ts)、[持久历史](../../apps/orchestrator/tests/openshell/binding-forgery-persistence.test.ts)和 [SDK 目标](../../apps/orchestrator/tests/openshell/binding-forgery-sdk.test.ts)。测试使用生产 `SingleHostExecution`、权威库和历史库，以及三个独立本机卷。READY 绑定仅替换 tenant、session 或 volume，必须在 `Authority.checkPurge` 拒绝且不进入资源删除回调；合法完整绑定仍可删除自己的卷。每次拒绝前后由独立只读连接比较全表及文件字节，同库重开后再次核验。

历史通过生产 HTTP 的 create/stage/append/reconcile/flush/close 写入两套非空事件，再分别合法读回。A 的当次 capability 请求 B 的 stat/open/read，或 create 提交不匹配的 header.id，均须返回 403 GrantDenied，不改变历史或资源。SDK 复用官方源码准备器和 protobuf 编解码，通过生产 ingress 到独立真实 mTLS HTTP2 服务；GetSandbox、ExecSandbox、ExecSandboxInteractive 分别检查跨 sandbox 请求返回 gRPC 7、上游调用数为零，合法请求实际读取自己的卷。两类网络入口均在同库重开后复验。

三个 suite 由既有 Orchestrator 测试通配符自动执行，[打包检查](../../apps/orchestrator/tests/openshell/binding-forgery/check-package.mjs)核对七个显式公开源文件及私有材料排除。测试不改变生产授权契约，不证明外部 OpenShell 的实际挂载、Docker/OS 隔离或恶意宿主防护，也不替代 A1-03 撤权与 A3 停止观察。实际基线、结果和未覆盖范围见 [A1-02 验收记录](../40-readiness/evidence/A1.md#a1-02-伪造资源绑定本地验收)。

## A1-03 旧执行授权验收接线

[A1-03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-03-bad-case-旧执行授权) 的本地验收入口是 [binding-grants.test.ts](../../apps/orchestrator/tests/openshell/binding-grants.test.ts)，由 Orchestrator 既有 `tests/openshell/*.test.ts` 纳入 `pnpm check`。独立 [fixture](../../apps/orchestrator/tests/openshell/binding-grants/fixture.ts) 经生产 SingleHostExecution.bind/admit 签发真实当次 capability，调用真实 sdkIngress 和 operationIngress；不使用手填 token、手造 grantFor 或 SQL 写授权来替代入口。

[SDK 准备器](../../apps/orchestrator/tests/openshell/binding-grants/sdk.ts) 将 NVIDIA/OpenShell 源码归档缓存到仓库旁的 `../bento-sdk-cache/openshell/<revision>/source.tar.gz`，在独立受控临时目录构建 revision `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47`，校验归档 SHA-256 `4c14a574c0bd2feccbc5198ef9fc64f6e75c7f5ef89b5f2fe478f7688fefa43f`、官方 lock 和生成配置后，以官方锁正常安装、生成和构建。缓存命中时复验归档 SHA-256，不再下载；首次下载仅在完整校验后原子发布，失败或中断的文件不会成为缓存。npm 与 Buf 下载缓存分别复用 `../bento-sdk-cache/npm/` 和 `../bento-sdk-cache/buf/`，测试结束只清理本次临时构建目录。损坏的源码缓存明确失败，不静默替换。官方 protobuf 编码交给生产 schemaDecoder/schemaExecEventDecoder，覆盖 GetSandbox、ExecSandbox、ExecSandboxInteractive、stdin 与 exit；[六项工具探针](../../apps/orchestrator/tests/openshell/binding-grants/sdk-probe.ts) 不计作业务验收。固定 CI 入口缺工具、网络或 SDK 时明确失败，不跳过或退为 JSON mock。

每例先有合法控制，再调用生产 takeover 完成撤权阶段。SDK/operation/持有流 fixture 没有独立沙盒停止证明，stopped 固定 false；精确期待 `old execution unconfirmed`，独立 SQL 保留 UNKNOWN、generation1、原 Run/绑定和 capabilityNULL，只调用一次，不伪造 READY 或清理未知 operation。新 stream、重连、原库 reopen 后旧 token 在生产 grant/authorize 层拒绝为 header16；已授权且未发响应头的持有 interactive 流在撤权时返回 header7，实际观察两侧关闭与后续 stdin 未达 upstream。

真实 mTLS/HTTP2、HTTP 与 SQLite 用于验证平台入口的拒绝；upstream 是独立受控服务器，模型和沙盒观察是 fixture。只读独立连接核对权威状态、operation 与历史；无历史行时按生产 fence 的 absence 契约处理，不冒充真实历史行撤销。历史拒绝另复用既有官方 Provider fixture，先正常 checkpoint，再真实撤权，以旧 writer.append 观察 stage403/SessionOwnershipLostError、四表不变、真实历史行 epoch/owner/handle 栅栏和同库 reopen；该子链不修改原 A2 场景或 flush 时序。

[发布检查](../../apps/orchestrator/tests/openshell/binding-grants/check-package.mjs) 在固定 Orchestrator check 中核对实际安装树的 npm pack 清单，保留根 files/patterns，精确登记新源并拒绝依赖、TLS/数据库和私有证据。实际验证结果和未覆盖项见 [A1-03 Readiness](../40-readiness/evidence/A1.md#a1-03-旧执行授权本地验收)。本接线不证明外部 OpenShell/Docker 进程停止、全部署绑定或 A3 接管就绪，也不关闭 A1 的其他子项。

## A2 Provider 验收接线

[A2-01/02/03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a2-持久会话) 的本地联合验收使用 [固定测试入口](../../apps/orchestrator/tests/openshell/provider-lifecycle.test.ts) 和 [独立 fixture](../../apps/orchestrator/tests/openshell/provider-lifecycle/fixture.ts)，由既有 Orchestrator `tests/openshell/*.test.ts` 纳入 `pnpm check`。Orchestrator 测试依赖将官方 AgentRegistry、AgentLoop、SessionStore、session-projection、LLM、system-prompt、tools、scope、session-checkpoint-policy 固定为 `0.2.1-rc.4`，沿用 SessionPersistence `0.2.1-rc.4` 与 Cordis `4.0.5`；不改变生产 worker 装配。

写句柄只能经官方 `ctx.agents.create/resume` 获取，AgentLoop 保存 constructor/setup suffix，避免裸 prepare/enter 遗漏 seed marker。官方 checkpoint policy 在 pre-step/model dispatch 前调用 `ctx.sessions.flush`，经生产 RemoteSession→真实 HTTP persistenceIngress/WorkerGate→SessionHistory SQLite 完成 stage/append/reconcile/flush；正常轮末再显式等待 checkpoint，然后先处置 Agent 再关闭 root Context。两库同路径重开后官方 resume 保留原历史并允许合法新代续写。

测试代理原样转发生产 ingress，只在上游 append 成功且独立 SQL 确认提交后丢一次下游响应，用原 Provider pending 批次验证原回执重投。三种旧代操作各用独立活句柄，分别观察真实授权拒绝；append 在 stage 入口已被拒，不将该结果描述为 backend append 分支已执行。数据库、HTTP 和官方生命周期为真实实现；模型与沙盒观察为受控 fixture。实际结果及外部边界见 [A2 Readiness 证据](../40-readiness/evidence/A2.md#a2-官方-provider-本地验收)。

[A2-04/05崩溃恢复验收](../../apps/orchestrator/tests/openshell/provider-crash.test.ts)复用[共享官方runtime](../../apps/orchestrator/tests/openshell/provider-lifecycle/runtime.ts)，由[独立子进程](../../apps/orchestrator/tests/openshell/provider-lifecycle/crash-child.ts)运行真实持久化host与官方DSH caller。子进程入口及cwd从import.meta.url定位仓库根目录，根focused与Orchestrator聚合入口一致。COMMIT前后分别真实SIGKILL持久化进程；caller另在stage/append已提交、下游ACK尚未收到时SIGKILL。测试专用包装仅在子进程拦截公开DatabaseSync.exec边界，不增加生产debug endpoint或复制生产事务写SQL；独立readOnly的priorCommitted与事务自身transactionView分开，合法先提交批次逐项核对，重开四表无半批。

正式恢复沿`runDshWorker`的prior分支，在交给官方AgentLoop前调用`reconcileSessionPersistence`；RemoteSession只用当前Session open(write)→无batch参数reconcile→close。控制面先通过takeover/admit撤旧句柄并授予新代，持久intent仍由SessionHistory自行读取；未提交时以新代提交，已提交时按intent.epoch找到并复用旧receipt，随后删除intent。父进程/旧caller不得向新Worker提供batch/events/receipt来协助发现。共享runtime唯一显式处置AgentHandle与root Context；测试bootstrap以小包装委托官方Agent，WeakMap映射回真实Session作flush identity校验，不伪造或过滤历史。snapshot局部类型适配只校验生产实际消费字段，保留官方header.reason字符串，不能当作完整SDK/生产窄shape兼容证明。

四场景均要求同双库重开、SQL/Provider读回及合法新代正常轮，reconcile本身的seq/revision/receipt变化与之后官方resume后缀单独核对。模型、沙盒观察和bootstrap仍为fixture；退出证据适用于测试直接持有的本地子进程。真实 OpenShell 接管需要独立观察宿主和沙盒实例，现有本地证据见[Readiness](../40-readiness/evidence/A2.md#a2-崩溃恢复本地验收)。

## Worker 正式 base 与每轮资源所有权

[A6-05](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a6-05-bad-case-跨会话池重用)的正式装配入口为[base-bootstrap.ts](../../apps/worker/base-bootstrap.ts)，由既有[run-worker.ts](../../apps/worker/run-worker.ts)加载；预热模式仍每次请求创建新的官方Context、Agent/SessionStore、AgentLoop、checkpoint和OpenShell provider，正常回执后保留进程，review或异常沿原warmSlot策略退出补位。长期复用验收状态以[Readiness](../40-readiness/CURRENT-READINESS.md)为准，源码接线与单轮单测不能代替四项长期隔离证据。

可信只读配置`BENTO_DSH_RUNTIME_CONFIG`按代码中的BaseBootstrapConfig校验完整字段；SDK模块和模型factory为可信部署文件，tenant/Session/Run/generation/sandbox及grant仅来自本次WorkerRequest。模型factory仅收到provider/model，返回新的官方LlmAdapter和disposer，不能替换ctx/runtime/provider或复用单例；静态WeakSet拒绝重复adapter实例，不强持有其凭据。恢复不创建SDK连接或模型adapter。base没有通用工具目录或publicEvents，Task缺投影沿原Worker门禁返回review，不用空投影冒充结果。

每轮[sdk-transport.ts](../../apps/worker/sdk-transport.ts)只接生产回环`http://127.0.0.1:<port>`，逐请求使用该轮grant，管理凭据和mTLS仍归Orchestrator。官方SandboxClient使用此transport；底层session由Worker显式持有，关闭先拒绝新RPC并以HTTP2 CANCEL结束在途stream，再等真实session close，截止后残留是失败。不能假定固定官方OpenShellClient存在close接口，不能以调用destroy或状态标志代替真实关闭。

资源清理按AgentHandle完整dispose→注销adapter→root fiber/provider/持久化清理→SDK关闭→模型disposer依次执行，失败仍尝试其余阶段并聚合错误；回执必须在清理之后。官方factory也持有结构所有权，base先等显式handle清理结算才卸root，沿其共享teardown避免重复关闭。Agent快照保留原事件，仅断言Worker实际消费的turn/end.reason.kind及tool/result.error.code，不改写request/header.reason或伪称全事件类型兼容。单轮与故障清理验证见[base单测](../../apps/worker/base-bootstrap.test.ts)，其中SDK helper/model是受控fixture，不代表真实沙盒文件系统或生产模型。

长期验收沿[real-reuse.test.ts](../../apps/orchestrator/acceptance/worker-reuse/real-reuse.test.ts)正式prewarmedWorker→run-worker --warm→runDshWorkerLoop→runDshWorker→base链路。默认长时模式为1个reference与64测量Session、8tenant同原生PID运行至少315秒；PR CI使用连续模式，保留相同64轮与隔离断言但不主动补足每轮5秒间隔，main CI仍运行长时模式。连续模式仅验证轮次复用，不代替长时间驻留证据。两种模式每轮持久历史/模型请求独立，凭据/监听器/连接/文件namespace分项负测。旧Context事件在下一base创建之前触发，避免当轮合法200ms批次刷盘干扰归属；父端有界IPC与真实server计数同时覆盖SDK/模型及persistence/operation，整轮与轮间继续查迟到旧身份请求。观测包装不替代生产清理。

R独立验证正式takeover撤权时持有输入流关闭与旧凭据重连拒绝，Worker退出补位；沙盒退出未独立确认时仍为UNKNOWN。E在模型disposer注入失败并确认其余资源关闭；L验证空闲pool停止/同库重开/继续新Session且旧events和receipts完整不变。资源、模型、沙盒helper的实际边界与64轮结果见[验收证据](../40-readiness/evidence/A6.md#a6-05-worker-长期池复用)，可信运行时配置与恢复操作见[部署手册](../../deploy/README.md#worker-正式运行时与复用验证)。

## 独立 Go Run 账本试验

私有 `run-ledger` 命令用于验证独立 SQLite 账本的 Task/Run 原子提交、代次拒绝、派发重投及桥接撤权。它只打开带独立应用标识的账本。可用 `pnpm --filter @bento/orchestrator test:go-run-ledger` 复验。当前单宿主部署的 Run 写入和执行授权入口分别由 `business` 与 `authority` 命令提供。
