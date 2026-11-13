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

| 层        | 已验证支撑                                                                                                             | 进入实现时必须补充                                                                 | 验收                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| 任务会话  | SessionPersistence/provider/checkpoint；旧代 append/flush/close 拒绝；跨主机历史恢复、批次回执、提交未知与事务故障对账 | 业务 Session/Run/审批生命周期、生产持久化与动态身份、外部工具幂等/查询契约         | A1/A2/A5；EXP-023～025                |
| workers   | 单宿主 Temporal 调度；多 Session 路由；子 Agent 继承；双主机接管；有限 OS 凭据隔离和失权 checkpoint                    | 长期池复用/排空、租户公平性/配额、可信控制器多副本协调                             | A3/A6/A8；EXP-019/020/022             |
| OpenShell | 单节点共享 Volume/删除重挂；SSH/PTC 分离、撤 key+断旧连接+stop；固定插件；mTLS 后端与服务端 SDK/raw 准入               | 真实项目导入、目录/卷 ACL、完整 PTY、资源/出口限制、动态能力签发、多节点存储与备份 | A1/A3/A4/A7；EXP-015～018/020/021/025 |

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
| 5 按服务承诺扩展     | 多控制器、存储/数据库故障、跨执行节点和容量                         | 优先现成数据库/存储/调度能力                                                                         | A7；单节点首版也必须有备份还原；未验 HA 不对外承诺                    |

第一条纵向实现优先完成 A1～A5、A8。调度架构可以同步实现，但 Activity 重试不能越过副作用对账。Temporal 的单执行宿主接入及故障验证见[需求完成状况](../40-readiness/CURRENT-READINESS.md)。首版范围允许明确限定为单执行节点；是否支持 PTY/SSH、真实多租户不可信代码、跨节点卷，应作为产品和部署能力开关及验收边界，而非默认开放。

### 实现与复用

组件复用方案按需求验收，验证进度见[需求完成状况](../40-readiness/CURRENT-READINESS.md)。

| 实现项               | 优先复用                                                          | 平台必须补充                                                     |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Session 状态和历史   | 官方 SessionPersistence、checkpoint；已有 fenced provider/服务    | 生产服务部署、认证、批次恢复契约、可观测性                       |
| 业务绑定和接管       | 数据库事务/CAS、持久 operation/receipt、已验 stop/observe         | 多控制器串行协调、可信 READY 发布、迟到操作屏障、孤儿回收        |
| 执行准入             | OpenShell 原生 TLS/mTLS、官方 SDK schema、现有 ingress/SSH broker | 动态身份与 capability 生命周期、资源 ACL、所有启用入口统一策略   |
| SSH/PTC helper       | 官方 SSH/provider/PTC，固定 helper 构建适配                       | 发布可复现 helper、依赖锁定；要求纯正式接口时推动 helper factory |
| 持久 Workspace       | 外部 Volume 和 OpenShell driver mount                             | 项目导入、卷授权、并发写协议、备份/恢复、资源引用回收            |
| Run 调度和 worker 池 | Temporal Workflow/Activity                                        | 业务工作流、取消/审批、池复用、排空、租户配额                    |
| 运行隔离与资源治理   | 容器/OS 身份、OpenShell policy、现成资源控制                      | 明确信任边界、读写/网络/secret/CPU/内存/PID/磁盘/输出约束        |

OpenShell Gateway interceptor 的固定源码白名单可以管理部分一元控制面 RPC，但不能绑定 ExecSandbox/ExecSandboxInteractive 流式执行。当前可行组合是原生 mTLS 保护后端、平台服务端入口检查业务 generation/READY；入口是新增平台代码，并非已有插件零配置提供。可信管理证书不可下发 worker。
