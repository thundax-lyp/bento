# 架构与职责边界

研究冻结于 2026-11-06。本文维护架构决策；能力状态见[capabilities](capabilities.md)，交付门槛见[implementation](implementation.md)。

## 架构决策

- 一个顶层业务 Session 对应一个沙盒，跨多个 Run 存续；内部子 Agent Session 不自动创建独立业务沙盒。
- worker 为共享执行池，领取 Run 后动态绑定 Session、执行授权与沙盒。用户注册不固定占用一个 DSH 进程；同进程多 Session 的可行性已验证，生产并发和池化复用仍须验收。
- Workspace 持有持久 Volume，多个 Session 可以共享该 Volume。沙盒是执行生命周期，Volume 是数据生命周期；删除沙盒不得默认删除项目卷。
- 同 Session 默认一个活跃写 Run；共享 Workspace 不默认全局独占。共同编辑必须定义版本守卫、冲突和锁策略。
- 可信 DSH harness 在沙盒外，用户代码在沙盒内。业务服务端决定 tenant/workspace/session/run/generation/sandbox/volume 绑定，worker 和模型不能任意选择目标。
- Session 日志所有权与沙盒执行权分别撤销，只有 generation/owner 一致、旧执行完成停止/对账、绑定及挂载确认后才能 READY。UNKNOWN 先观察/对账，不能因未收到结果就重放副作用。
- 优先复用固定 npm OpenShell 插件、官方 checkpoint/SessionPersistence、OpenShell 原生生命周期及认证、外部持久卷。平台层补业务授权、绑定、调度和恢复协议；当前没有必须修改 DSH 核心的实验证据。
- Run 编排选用 Temporal、生产业务状态倾向 PostgreSQL；这是实现选型，**尚未部署验证**。实验 SQLite 事务/generation CAS/批次回执提供协议依据，不等于 PostgreSQL 版本已验收，不另造第二套持久调度队列。

## 三层职责与交接

| 层        | 已验证支撑                                                                                                             | 进入实现时必须补充                                                                 | 验收                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| 任务会话  | SessionPersistence/provider/checkpoint；旧代 append/flush/close 拒绝；跨主机历史恢复、批次回执、提交未知与事务故障对账 | 业务 Session/Run/审批生命周期、生产持久化与动态身份、外部工具幂等/查询契约         | A1/A2/A5；EXP-023～025                |
| workers   | 同进程多 Session 路由；子 Agent 继承；双主机领取授权后恢复；有限 OS 凭据隔离和失权 checkpoint                          | Temporal Run 调度、长期池复用/排空、租户公平性/配额、可信控制器多副本协调          | A3/A6/A8；EXP-019/020/022             |
| OpenShell | 单节点共享 Volume/删除重挂；SSH/PTC 分离、撤 key+断旧连接+stop；固定插件；mTLS 后端与服务端 SDK/raw 准入               | 真实项目导入、目录/卷 ACL、完整 PTY、资源/出口限制、动态能力签发、多节点存储与备份 | A1/A3/A4/A7；EXP-015～018/020/021/025 |

双 worker 主机不等于双执行宿主；部分 AgentLoop 用固定模型适配器；confinement=partial。原始 Gateway 旁路已在受测 worker 权限边界封住，不能继续标成完全未验，也不能据此宣称全入口或恶意宿主隔离已完成。

## 三组交接不变量

| 边界                    | 必须持久化的事实                                                        | 失败场景与通过条件                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会话 ↔ worker           | Session/Run、owner/generation、事件序号、待对账批次与回执               | A 暂停/崩溃、B 接管后 A 恢复；旧代 append/flush/close 拒绝；已提交不重复写，未提交先对账；AgentLoop 失权不再发新副作用                           |
| worker ↔ OpenShell      | 执行 grant、operation 身份、撤权/停止观察、sandbox instance、READY      | 入口/控制器每阶段崩溃、旧连接/重连/子进程、迟到 stop；未完成旧执行停止和 CAS 不放行新代，UNKNOWN 不盲重放。断流与100ms重检不算 detached 停止证明 |
| 会话 ↔ Workspace/Volume | tenant/workspace/session/sandbox/volume mount、导入状态、引用与回收归属 | 创建部分成功、挂错卷、沙盒删除重建、孤儿资源；正确挂载并恢复文件，不静默建空卷，不因删除一个 Session 误删共享卷或撤销其他 Session                |

数据库事务与远端资源变化不构成同一原子事务。intent、observe/reconcile、可信补偿、receipt 与 READY 必须形成可恢复协议；单机阶段强杀、SSH/PTC停止、工具中断恢复和最新SDK入口各有证据，最终实现仍须在同一链做联合故障验收。
