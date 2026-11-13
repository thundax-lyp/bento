# Bento 需求完成状况

核对日期 2026-11-13，已提交代码基线 `e3b4c86`。需求及验收标准见[需求索引](../10-requirements/README.md)。

| 需求清单                                                                                                       | 完成状况 | 说明                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| [应用与编排边界 · 独立应用入口](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#acceptance-criteria) | 部分实现 | 个人端已有独立认证构建、Web、Go HTTP 入口和 MySQL 账号仓储。缺管理端入口、个人端 Go 业务 API 及两端统一编排接入。 |
| [A1 身份与绑定](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Keycloak 组织准入、账号绑定和执行侧授权。缺完整部署中的身份到 Run、沙盒及卷接线。                            |
| [A2 持久会话](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                        | 部分实现 | 已有会话持久化、检查点、旧代写入防护和回执对账。缺当前真实执行环境的接管接线。                                    |
| [A3 接管状态机](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | TypeScript 执行宿主持有账本、代次和恢复逻辑。缺 Go 接管权威状态及 OpenShell 控制。                                |
| [A4 数据生命周期](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                    | 部分实现 | 已有项目导入、工作区绑定与删除门禁。缺真实共享卷的并发冲突策略和按引用回收。                                      |
| [A5 最终执行链](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Worker、OpenShell 适配和补丁交付。开发环境缺真实模型和 OpenShell 的受信执行接线。                            |
| [A6 调度与池化](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Go Temporal 调度、租户配额和双槽派发。缺 Worker 长期复用和升级排空的部署支持。                               |
| [A7 部署等级](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                        | 部分实现 | 已有单执行宿主部署配置。缺明确的备份、恢复与回滚准备。                                                            |
| [A8 证据与可运维性](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                  | 部分实现 | 已有 Compose、镜像定义和部署手册。缺当前完整部署的审计与告警配置。                                                |
| [WEB-01 账号和访问控制](../10-requirements/WEB-REQUIREMENTS.md#web-01-账号和访问控制)                          | 部分实现 | 已有 Keycloak 登录、组织准入、账号绑定和注销清理。缺待核对结案后继续注销清理。                                    |
| [WEB-02 上传与续传](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)                                  | 已实现   | 支持文件选择、拖放、逐文件进度、分块直传及续传。                                                                  |
| [WEB-03 空间额度与文件生命周期](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期)          | 已实现   | 支持账号额度、原子预占、取消及过期回收、文件和项目删除门禁。                                                      |
| [WEB-04 项目与 Agent 输入](../10-requirements/WEB-REQUIREMENTS.md#web-04-项目与-agent-输入)                    | 部分实现 | 支持项目级工作区初始化和直接文本导入，共用 100 个文件、1 MiB 限额。缺任务级独立工作区。                           |
| [WEB-05 执行环境](../10-requirements/WEB-REQUIREMENTS.md#web-05-执行环境)                                      | 待实现   | 缺平台默认沙盒的空白任务、平台环境版本固定和准备失败修复。                                                        |
| [WEB-06 任务提交与结果](../10-requirements/WEB-REQUIREMENTS.md#web-06-任务提交与结果)                          | 部分实现 | 已有提交、状态回读、待核对和补丁交付。缺可信运维接手及完整结案。                                                  |
| [WEB-07 连续对话与任务控制](../10-requirements/WEB-REQUIREMENTS.md#web-07-连续对话与任务控制)                  | 部分实现 | 已有排队取消、运行取消和待核对门禁。缺续聊和安全重试。                                                            |
| [WEB-08 结果审阅与交付](../10-requirements/WEB-REQUIREMENTS.md#web-08-结果审阅与交付)                          | 部分实现 | 已有单轮文件列表、逐文件补丁预览及下载。缺多轮历史、累计补丁和结构化检查。                                        |

## 开发前准备

- **独立开发栈**。开发 Compose 项目已运行。Web、Orchestrator、MySQL、Keycloak 和 PostgreSQL 健康，Temporal 返回 `SERVING`，开发队列已连接 Workflow 与 Activity poller。Web 可访问 Orchestrator，OIDC discovery 与配置一致。Web 通过受控 SSH 转发访问。
- **开发身份**。独立 `bento-dev` Realm 已创建，配置了 `bento-workspace` OIDC 客户端和 `bento-dev` 组织，三个测试账号已加入组织。凭据保存在宿主机受限配置中。
- **镜像**。宿主机直连 Docker Hub 受限。已从本机下载并导入 Linux amd64 的 Go 1.25、Node 22 和 Temporal 1.10.0 镜像。开发镜像使用仓库源码和本机交叉编译的 Go 二进制构建。
- **S3**。Web 已配置独立 MinIO 私有桶和持久卷，使用配置中的凭据执行 `HeadBucket` 成功。浏览器通过受控 SSH 转发访问对象存储。
- **模型与 OpenShell**。Orchestrator 容器能通过认证读取真实模型列表并找到配置的模型。独立 OpenShell 0.1.6 Gateway 已启动，开发网络内的认证状态 RPC 和 Orchestrator 容器的 mTLS 握手通过。Orchestrator 仍使用本地执行适配器，缺可复用的受信宿主和 DSH Worker bootstrap，真实模型与沙盒尚未进入 Run 路径。
