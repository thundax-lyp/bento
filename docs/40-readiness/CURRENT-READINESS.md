# Bento 需求完成状况

核对日期 2026-11-13，代码基线 `75c78b1`。各项验证沿用对应的测试基线。需求及验收标准见[需求索引](../10-requirements/README.md)。

完成状况按[开发完成定义](../00-governance/DOCUMENT-RULES.md#required-structures)记录。对应验收条件纳入开发测试用例。

| 需求清单                                                                                                       | 完成状况 | 说明                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [应用与编排边界 · 独立应用入口](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#acceptance-criteria) | 部分实现 | 个人端已有独立认证构建、Web、Go HTTP 入口和 MySQL 账号仓储。缺管理端入口、个人端 Go 业务 API 及两端统一编排接入。                                                                                                                                       |
| [A1 身份与绑定](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Keycloak 组织准入、账号绑定和执行侧授权。缺完整部署中的身份到 Run、沙盒及卷接线。                                                                                                                                                                  |
| [A2 持久会话](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                        | 部分实现 | 三库停服还原后可读回历史、新代追加及两代批次回执。待验真实 DSH checkpoint、未结批次发现与故障接管。见 A7。                                                                                                                                              |
| [A3 接管状态机](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | TypeScript 宿主已维护账本和执行代次。三库还原后拒绝旧代写入。待实现 Go 权威状态，待验真实 OpenShell 停止与故障恢复。见 A7。                                                                                                                             |
| [A4 数据生命周期](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                    | 部分实现 | 已有项目导入、工作区绑定与删除门禁。缺真实共享卷的并发冲突策略和按引用回收。                                                                                                                                                                            |
| [A5 最终执行链](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Worker、OpenShell 适配和补丁交付。开发环境缺真实模型和 OpenShell 的受信执行接线。                                                                                                                                                                  |
| [A6 调度与池化](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 本地 Temporal SDK、Go Activity 与 TypeScript 宿主验证重投仅写入一次（`5c8ffb9`）及双槽、公平派发、FIFO、429 和幂等（`6e3515f`），两项均连跑三轮。待验真实 Temporal、心跳、OpenShell、资源上限、池复用与升级排空。                                       |
| [A7 部署等级](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                        | 部分实现 | 隔离 Node.js 22.23.2 停服演练通过。单库（`84cb251`）验证终态 Run 和幂等回执，三库（`715b303`）验证会话历史、代次和继续执行。[演练命令](../../deploy/README.md#单节点执行宿主停服备份还原演练)。待验真实卷、外部依赖、生产与在线恢复、多节点及 RPO/RTO。 |
| [A8 证据与可运维性](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                  | 部分实现 | 隔离 Linux/amd64 Compose 在 `1803ad6` 通过[同版本 Web 镜像回滚](../../deploy/README.md#单节点-web-镜像回滚演练)，恢复原镜像且 MySQL、账号和卷校验一致。待验跨版本回退、迁移、真实登录与执行链、S3、生产恢复和审计告警。                                 |
| [WEB-01 账号和访问控制](../10-requirements/WEB-REQUIREMENTS.md#web-01-账号和访问控制)                          | 部分实现 | 已有 Keycloak 登录、组织准入、账号绑定和注销清理。缺待核对结案后继续注销清理。                                                                                                                                                                          |
| [WEB-02 上传与续传](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)                                  | 已验证   | 100 MB 单文件限制已实现。WEB-A02 的两块页面预检、真实六块上传、缺块续传、过期签名重新授权和下载摘要已分段核对。见[上传规格与验证基线](#上传规格与验证基线)。                                                                                            |
| [WEB-03 空间额度与文件生命周期](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期)          | 已验证   | 真实开发栈验证 200 MB 额度、并发预占及回收。上传记录过期由 API 受控时钟验证。WEB-A05（`75c78b1`）本地 Chromium 19/19、API 23/23，覆盖目录、预览下载、路径冲突和删除门禁。待验真实 S3 与外部执行联合场景。                                               |
| [WEB-04 项目与 Agent 输入](../10-requirements/WEB-REQUIREMENTS.md#web-04-项目与-agent-输入)                    | 部分实现 | 支持项目级初始化与文本导入（100 文件、1 MiB）。本地双 HTTP（`5df507f`）验证排队 Run 输入冻结、跨项目隔离及越权 404。待实现同项目多任务与独立工作区，待验环境版本、密钥、OpenShell 和恢复。                                                              |
| [WEB-05 执行环境](../10-requirements/WEB-REQUIREMENTS.md#web-05-执行环境)                                      | 待实现   | 缺平台默认沙盒的空白任务、平台环境版本固定和准备失败修复。                                                                                                                                                                                              |
| [WEB-06 任务提交与结果](../10-requirements/WEB-REQUIREMENTS.md#web-06-任务提交与结果)                          | 部分实现 | 本地 Chromium 与回环 mock（`058a272`，18 项通过）验证查找、重连与待核对隐藏补丁。WEB-A08/A11 已覆盖单账号关页后交付及两浏览器回读。待验真实三账号执行、事件去重、续做与隔离，待实现可信运维结案。                                                       |
| [WEB-07 连续对话与任务控制](../10-requirements/WEB-REQUIREMENTS.md#web-07-连续对话与任务控制)                  | 部分实现 | 已有排队取消、运行取消和待核对门禁。缺续聊和安全重试。                                                                                                                                                                                                  |
| [WEB-08 结果审阅与交付](../10-requirements/WEB-REQUIREMENTS.md#web-08-结果审阅与交付)                          | 部分实现 | 本地 Chromium（`058a272`）验证单轮逐文件审阅、延迟发布重读、预览与下载一致及补丁可应用。WEB-A13 待验两轮执行、累计补丁、历史结果版本和结构化检查。                                                                                                      |

## 开发环境

2026-11-13 的记录确认独立 Compose、开发身份、Temporal 和私有 MinIO 可用。模型列表与 OpenShell mTLS 已验证，Run 仍使用本地执行适配器。环境连接见[开发环境说明](../../ENVIRONMENTS.example.md)。

## 上传规格与验证基线

2026-11-13，在 Chromium、独立 Compose 和私有 MinIO 上验证 `116dc7b`。复跑见[空间上传实栈验收](../../deploy/README.md#空间上传实栈验收)。

- **WEB-A02**。两块预检通过。100 MB 分段实测验证缺块续传、过期签名重授权、错文件与超限拒绝，以及下载摘要一致。签名续传轮次在保存后因脚本断言失败而清理，下载由独立轮次复核。
- **WEB-A03**。两个 100 MB 文件实传占满额度，额外 1 字节被拒绝。并发预占、取消、删除及额度复用通过，测试数据已清理。上传记录过期与存储清理失败由受控时钟 API 用例验证。
