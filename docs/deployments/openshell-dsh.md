# OpenShell / DSH 部署说明

本文说明已验证部署方式及运维检查要求，不记录特定服务器地址、账号、端口、资源名称、部署目录、证书位置或实例标识。实际连接参数和凭据由受控部署配置管理。这里的验证结论对应研究实验，不代表目标环境当前状态已经重新检查。

## 已验证组件组合

| 组件              | 受测版本或方式                        |
| ----------------- | ------------------------------------- |
| OpenShell Gateway | 0.1.6，Docker driver                  |
| OpenShell 插件    | dsh-sandbox-openshell@0.1.0-rc.1      |
| DSH / Cordis      | 0.2.1-rc.4 / 4.0.5                    |
| Bento 适配        | 补充插件目录服务注入声明              |
| Workspace         | 独立外部持久 Volume，挂入沙盒项目目录 |
| Session 历史      | 受信服务保存，独立于沙盒生命周期      |

## 部署结构与权限

worker 经服务端执行入口访问 OpenShell；入口校验业务 capability 对应的 Session、owner、generation、目标沙盒和 Workspace，并要求 READY。持久化服务独立校验日志写所有权。业务授权不依赖 worker 自行声明的代次或客户端装饰器。

原始 Gateway 关闭匿名并启用原生 mTLS 用户认证。后端认证凭据仅供服务端入口与可信管理工具使用，运行时按需挂载，不打入镜像，不下发 worker。worker 不应拥有数据库文件、管理 socket、管理凭据或 Docker 管理接口的访问权。业务 capability 不能用于直连后端。

已验执行入口只放行 GetSandbox、ExecSandbox、ExecSandboxInteractive，并核对目标；其他 RPC 默认拒绝。SSH 会话创建未在该入口开放，启用新 transport 须另行验收。跨主机实验使用受控隧道，不能据此认为公网 TLS 和网络部署已完成。

## Workspace 与生命周期

项目数据使用独立外部 Volume，沙盒删除重建后重新挂回原卷。删除 Session 或沙盒不得默认删除共享项目卷；多个 Session 可以共享 Volume，写入冲突由应用协议处理。

受测 Docker driver 需启用 allow_driver_config；可挂载卷须具备 sandbox-attachable=true、sandbox-attachable-workspace=default 标签。该能力仅由可信部署端配置。镜像的默认工作目录应允许外部卷挂入项目路径；Compose 部署入口显式加载基础配置与持久卷覆盖配置，不能假设环境变量覆盖一定生效。

修改 Gateway 配置或进行 TLS bootstrap 迁移前，先核对资源归属并备份配置及数据。若需重建沙盒，确认旧实例删除后仍保留同一 Volume，恢复授权与挂载后再发布 READY。配置备份、数据库备份和证书须按受控部署配置管理。

## 运维检查

使用目标环境提供的部署与检查入口；参数从受控配置注入，不从本文复制服务器命令。

1. 检查 Gateway、服务端执行入口和持久化服务健康状态；确认 worker 无法绕过入口获得后端认证身份。
2. 检查部署重复执行是否复用正确资源；区分一次性部署任务成功退出与长期沙盒健康。
3. 用固定插件验证文件读写与命令读取同一文件，检查实际挂载与工作目录。
4. 用官方 AgentLoop/checkpoint 完成独立测试 Session 的工具循环，对比内存历史与持久事件。固定模型适配器只证明执行链，不证明真实模型质量。
5. 变更、重建或还原后，对比文件清单、权限、大小和 SHA-256，并复核 owner/generation、READY 及旧代拒写。
6. 验证严格模式对 partial enforcement 的拒绝；诊断所用 allowPartial 必须显式配置，不作为生产强隔离验收通过。

## 验证范围与实现入口

已验证单执行宿主的共享卷与删除重挂、固定插件工具循环、跨主机 Session 接管、工具结果 UNKNOWN 不盲目重放，以及服务端准入对旧代和原始 Gateway 旁路的拒绝。这些来自不同实验阶段，不等于最新入口的完整故障链已联合验收。

受测环境的 confinement 为 partial。生产身份集成、全阶段控制器故障、detached 子进程停止、多控制器、跨节点存储、数据库 HA 与容量仍按[实现验收条件](../research/implementation.md)落实。能力及证据入口见[研究总览](../research/README.md)。历史原始证据单独保留。

## 单执行宿主接入

可信进程从 [Bento 入口](../../src/index.ts)实例化 `SingleHostExecution`。每组 SQLite 文件由一个控制器实例管理。部署端提供 `SingleHostSandbox`，按绑定对指定沙盒执行 stop/start，并通过宿主独立观察进程退出、启动状态、策略与挂载卷。停止观察需要排除旧 stop 延迟生效。以 OpenShell 官方 SDK 的固定 protobuf schema 作为 `sdkIngress` 的解码器，并把 Gateway mTLS 凭据只交给服务端。

1. 部署端导入项目到外部 Volume，验证沙盒挂载及策略，用 `bind` 登记 Session。用 `admit` 领取 Run，将短期 capability 与三个入口地址交给 worker。
2. worker 安装 `remoteSessionPersistence`、官方 DSH checkpoint policy 和 `installOpenShellProvider`。执行有副作用的受控工具前，向 `POST /operations` 提交 `{id, input}`，只在收到 201 后派发。重试须沿用原操作 ID。409 表示该 ID 已登记，仍处于 UNKNOWN 的操作由可信侧查询对账。
3. 接管已有持久历史的 Session 时，调用 `takeover(session, generation)`。入口先撤销执行和日志写权，再持久登记停启意图。回包丢失后可用同一代次重新进入 `takeover`，已有派发意图只观察。只有确认旧执行退出、新沙盒运行且策略和原卷匹配，才发布新代 READY。
4. 新 worker 领取 Run 后调用 `reconcileSessionPersistence` 对账持久批次，再用官方 DSH AgentLoop 恢复原 Session。会话回执只确认历史已提交。工具结果保持 UNKNOWN，副作用以独立观察对账。

执行入口支持 SDK 非 PTY 命令与文件操作。稳定操作 ID 由受信工具适配器提供，此门禁覆盖遵循登记协议的工具。宿主进程、模型配置和外部工具授权由部署端管理。
