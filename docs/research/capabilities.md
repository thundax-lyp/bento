# 已验证能力与证据边界

研究冻结于 2026-11-06。已实测、源码确认、实验实现和未验证不得互换。原始报告、失败、脚本和运行产物受控保存，不随公开仓库发布。

## 已验证能力

| 能力                                                       | 已有证据                                                                | 结论边界                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 同进程多 Session 路由、子 Agent 继承、正常 worker 切换     | EXP-001～003，Session 专题（内部归档）                                  | 固定程序/受测 AgentLoop；不是生产池长时间复用验收                                               |
| 多 Session 挂同 Volume、共享文件、删除重挂恢复             | EXP-004～005，Volume 专题（内部归档）                                   | 单 Docker daemon；真实项目导入、多节点存储未验                                                  |
| 官方 SSH/PTC 双 Session 分离执行，超时/取消及整沙盒 stop   | EXP-007～009，PTC（内部归档）、停止（内部归档）                         | helper 使用固定构建适配；完整 PTY 和逐命令 detached 后代回收未完成                              |
| 控制器阶段强杀与 stop 回包丢失恢复                         | EXP-019，控制器证据（内部归档）                                         | 单机范围；多副本、迟到管理操作与新入口联合链未验                                                |
| 完整 SessionPersistence 与旧代 append/flush/close 拒绝     | EXP-023～024，provider（内部归档）、跨主机服务（内部归档）              | 官方 checkpoint 与 provider 组合必要；有限 OS 隔离，单服务/数据库                               |
| 服务重启、批次回执、调用方崩溃、事务中途崩溃及再次换代对账 | EXP-025，回执（内部归档）、调用方恢复（内部归档）、事务故障（内部归档） | 已提交不重复写、未提交按对账恢复，旧代拒绝；完整网络契约和数据库 HA 未验                        |
| 真实 DSH AgentLoop 工具副作用后崩溃，跨主机恢复同 Session  | AgentLoop 证据（内部归档）                                              | 固定模型适配器驱动真实循环；UNKNOWN 不盲目重放，不代表外部系统 exactly-once                     |
| SSH/PTC 接管、撤旧 key/连接、整沙盒停止及新代 READY 准入   | SSH/PTC（内部归档）、READY（内部归档）                                  | 两 worker 主机、同一执行宿主；撤 key 单独不能停止旧连接/进程                                    |
| 固定 npm 插件及持久卷重建后联合恢复                        | npm（内部归档）、持久重建（内部归档）                                   | 插件 0.1.0-rc.1 + Bento 目录注入适配，42 事件；该阶段 SDK 使用受控客户端准入                    |
| 服务端 generation/READY 与原始 Gateway 旁路拒绝            | 服务端准入（内部归档）                                                  | 无客户端装饰器，官方 SDK/raw RPC；后端 mTLS 及入口白名单，32 事件；本轮未重跑工具后崩溃/UNKNOWN |

各轮版本和部署事实以相应原报告为准。最近 npm 链固定 dsh-sandbox-openshell@0.1.0-rc.1、DSH 0.2.1-rc.4、Cordis 4.0.5；OpenShell Gateway 0.1.6，所查源码/SDK revision ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47。旧 SSH/helper 实验不能自动继承新版 SDK 结论。双主机 worker 接管不等于双执行宿主或数据库 HA。

## 最小改动实现与现成能力

| 实现项               | 优先复用                                                          | 平台必须补充                                                     | 状态                             |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Session 状态和历史   | 官方 SessionPersistence、checkpoint；已有 fenced provider/服务    | 生产服务部署、数据迁移、认证、批次恢复契约、可观测性             | 实验实现已有，生产化待做         |
| 业务绑定和接管       | 数据库事务/CAS、持久 operation/receipt、已验 stop/observe         | 多控制器串行协调、可信 READY 发布、迟到操作屏障、孤儿回收        | 部分原语/单机实验通过            |
| 执行准入             | OpenShell 原生 TLS/mTLS、官方 SDK schema、现有 ingress/SSH broker | 动态身份与 capability 生命周期、资源 ACL、所有启用入口统一策略   | 固定授权实验通过                 |
| SSH/PTC helper       | 官方 SSH/provider/PTC，固定 helper 构建适配                       | 发布可复现 helper、依赖锁定；要求纯正式接口时推动 helper factory | 构建路径通过，稳定扩展点缺口保留 |
| 持久 Workspace       | 外部 Volume 和 OpenShell driver mount                             | 项目导入、卷授权、并发写协议、备份/恢复、资源引用回收            | 单节点挂卷通过                   |
| Run 调度和 worker 池 | Temporal Workflow/Activity                                        | 业务工作流、取消/审批、池复用、排空、租户配额                    | 单执行宿主页面链已验             |
| 运行隔离与资源治理   | 容器/OS 身份、OpenShell policy、现成资源控制                      | 明确信任边界、读写/网络/secret/CPU/内存/PID/磁盘/输出约束        | confinement=partial，全入口未验  |

OpenShell Gateway interceptor 的固定源码白名单可以管理部分一元控制面 RPC，但不能绑定 ExecSandbox/ExecSandboxInteractive 流式执行。当前可行组合是原生 mTLS 保护后端、平台服务端入口检查业务 generation/READY；入口是新增平台代码，并非已有插件零配置提供。可信管理证书不可下发 worker。

## 失败记录与尚未证明的能力

EXP-006 旧 transport 阻塞、EXP-009 detached 后代逃逸、EXP-012 JSONL 锁/旧 worker 写入、单独撤 key 不停旧连接、checkpoint 缺失负控、提交回包丢失、只读 WAL/残留 Unix socket/挂载启动失败均保留。替代路径通过不改写原失败。

当前未证明：生产多租户全入口强隔离、恶意宿主 root 防御、单命令完整子进程回收、外部 HTTP/MCP 副作用 exactly-once、跨执行节点存储、数据库/控制面 HA、完整 PTY、真实模型质量/长期容量。partial 不能作为通用不可信代码强隔离验收通过。
