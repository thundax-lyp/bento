# DSH / OpenShell 实施设计

本文维护执行链的实施顺序、复用组件和平台需补齐的能力。系统职责见 [平台架构](PLATFORM-ARCHITECTURE-DESIGN.md)，各阶段放行条件见 [交付验收](../40-readiness/DSH-OPENSHELL-ACCEPTANCE.md#验收门槛)。

## 实施顺序

| 阶段                 | 交付内容                                                            | 复用基础与必要实现                                                                                   | 放行条件                                                              |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 可信绑定和服务入口 | 用户/项目/Session/Run/沙盒/卷映射、动态身份、受控 SDK/SSH 入口      | 现成身份服务、OpenShell 原生认证、已有 ingress/broker；补业务 ACL、capability 生命周期与管理凭据隔离 | A1；未支持入口明确关闭；partial 的部署信任边界明确                    |
| 2 持久会话和接管     | provider 服务、批次回执、checkpoint、持久 operation 与 READY 状态机 | 既有 provider/CAS/SQLite 实验逻辑、官方 checkpoint、OpenShell stop/observe/start；补可信控制器协调   | A2/A3；在最终入口每阶段强杀，旧代拒写、新代不提前放行、未知结果可对账 |
| 3 项目纵向执行链     | 真实项目导入、共享卷、真实任务与子 Agent，故障后继续                | 固定插件、外部 Volume、官方 AgentLoop；补 staging、冲突策略和引用回收                                | A4/A5；同一版本/transport 的历史、文件、副作用和权限联合核对          |
| 4 调度及可运维发布   | Temporal Run 工作流、worker 池、取消审批、限额、部署升级            | Temporal/现成资源控制；补业务流程、池复用/排空与告警                                                 | A6/A8；证据可复跑、依赖固定、回滚可操作、资源超限被拒                 |
| 5 按服务承诺扩展     | 多控制器、存储/数据库故障、跨执行节点和容量                         | 优先现成数据库/存储/调度能力                                                                         | A7；单节点首版也必须有备份还原；未验 HA 不对外承诺                    |

第一条纵向实现优先完成 A1～A5、A8。调度架构可以同步实现，但 Activity 重试不能越过副作用对账。Temporal 的单执行宿主接入及故障验证见[开发环境验收](../40-readiness/TEMPORAL-DEV-EVIDENCE.md)。首版范围允许明确限定为单执行节点；是否支持 PTY/SSH、真实多租户不可信代码、跨节点卷，应作为产品和部署能力开关及验收边界，而非默认开放。

## 实现与复用

表中状态反映研究阶段的验证基线。后续验证见 [能力证据](../40-readiness/DSH-OPENSHELL-EVIDENCE.md)。

| 实现项               | 优先复用                                                          | 平台必须补充                                                     | 状态                             |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Session 状态和历史   | 官方 SessionPersistence、checkpoint；已有 fenced provider/服务    | 生产服务部署、认证、批次恢复契约、可观测性                       | 实验实现已有，生产化待做         |
| 业务绑定和接管       | 数据库事务/CAS、持久 operation/receipt、已验 stop/observe         | 多控制器串行协调、可信 READY 发布、迟到操作屏障、孤儿回收        | 部分原语/单机实验通过            |
| 执行准入             | OpenShell 原生 TLS/mTLS、官方 SDK schema、现有 ingress/SSH broker | 动态身份与 capability 生命周期、资源 ACL、所有启用入口统一策略   | 固定授权实验通过                 |
| SSH/PTC helper       | 官方 SSH/provider/PTC，固定 helper 构建适配                       | 发布可复现 helper、依赖锁定；要求纯正式接口时推动 helper factory | 构建路径通过，稳定扩展点缺口保留 |
| 持久 Workspace       | 外部 Volume 和 OpenShell driver mount                             | 项目导入、卷授权、并发写协议、备份/恢复、资源引用回收            | 单节点挂卷通过                   |
| Run 调度和 worker 池 | Temporal Workflow/Activity                                        | 业务工作流、取消/审批、池复用、排空、租户配额                    | 单执行宿主页面链已验             |
| 运行隔离与资源治理   | 容器/OS 身份、OpenShell policy、现成资源控制                      | 明确信任边界、读写/网络/secret/CPU/内存/PID/磁盘/输出约束        | confinement=partial，全入口未验  |

OpenShell Gateway interceptor 的固定源码白名单可以管理部分一元控制面 RPC，但不能绑定 ExecSandbox/ExecSandboxInteractive 流式执行。当前可行组合是原生 mTLS 保护后端、平台服务端入口检查业务 generation/READY；入口是新增平台代码，并非已有插件零配置提供。可信管理证书不可下发 worker。
