# Bento 需求完成状况

核对日期 2026-11-13，代码基线 `75c78b1`。各项验证沿用对应的测试基线。需求及验收标准见[需求索引](../10-requirements/README.md)。

完成状况按[开发完成定义](../00-governance/DOCUMENT-RULES.md#required-structures)记录。对应验收条件纳入开发测试用例。新增或更新证据时引用需求文档中的稳定场景编号。既有证据按原验收组回读。

| 需求清单                                                                                                       | 完成状况 | 说明                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [应用与编排边界 · 独立应用入口](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#acceptance-criteria) | 部分实现 | 个人端已有独立认证构建、Web、Go HTTP 入口和 MySQL 账号仓储。缺管理端入口、个人端 Go 业务 API 及两端统一编排接入。                                                                                                                                                                                                                                                      |
| [A1 身份与绑定](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Keycloak 组织准入、账号绑定和执行侧授权。缺完整部署中的身份到 Run、沙盒及卷接线。                                                                                                                                                                                                                                                                                 |
| [A2 持久会话](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                        | 部分实现 | 三库停服还原后可读回历史、新代追加及两代批次回执。待验真实 DSH checkpoint、未结批次发现与故障接管。见 A7。                                                                                                                                                                                                                                                             |
| [A3 接管状态机](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | TypeScript 宿主已维护账本和执行代次。三库还原后拒绝旧代写入。待实现 Go 权威状态，待验真实 OpenShell 停止与故障恢复。见 A7。                                                                                                                                                                                                                                            |
| [A4 数据生命周期](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                    | 部分实现 | 已有项目导入、工作区绑定与删除门禁。缺真实共享卷的并发冲突策略和按引用回收。                                                                                                                                                                                                                                                                                           |
| [A5 最终执行链](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 已有 Worker、OpenShell 适配和补丁交付。开发环境缺真实模型和 OpenShell 的受信执行接线。                                                                                                                                                                                                                                                                                 |
| [A6 调度与池化](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                      | 部分实现 | 本地 Temporal SDK、Go Activity 与 TypeScript 宿主验证重投仅写入一次（`5c8ffb9`）及双槽、公平派发、FIFO、429 和幂等（`6e3515f`），两项均连跑三轮。待验真实 Temporal、心跳、OpenShell、资源上限、池复用与升级排空。                                                                                                                                                      |
| [A7 部署等级](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                        | 部分实现 | 隔离 Node.js 22.23.2 停服演练通过。单库（`84cb251`）验证终态 Run 和幂等回执，三库（`715b303`）验证会话历史、代次和继续执行。[演练命令](../../deploy/README.md#单节点执行宿主停服备份还原演练)。待验真实卷、外部依赖、生产与在线恢复、多节点及 RPO/RTO。                                                                                                                |
| [A8 证据与可运维性](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)                  | 部分实现 | 隔离 Linux/amd64 Compose 在 `1803ad6` 通过[同版本 Web 镜像回滚](../../deploy/README.md#单节点-web-镜像回滚演练)，恢复原镜像且 MySQL、账号和卷校验一致。待验跨版本回退、迁移、真实登录与执行链、S3、生产恢复和审计告警。                                                                                                                                                |
| [WEB-01 账号和访问控制](../10-requirements/WEB-REQUIREMENTS.md#web-01-账号和访问控制)                          | 已实现   | A 独占实栈通过真实 OIDC、WEB-A01、跨重启注销清理和可信结案。见 [WEB-01 实栈证据](#web-01-实栈证据)。                                                                                                                                                                                                                                                                   |
| [WEB-02 上传与续传](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)                                  | 已实现   | 已在同一实栈完成 WEB-A02 上传、断网续传、重新授权和下载摘要校验，WEB-A04 恢复回归通过。见[上传规格与验证基线](#上传规格与验证基线)。                                                                                                                                                                                                                                   |
| [WEB-03 空间额度与文件生命周期](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期)          | 已实现   | WEB-A03 实栈额度闭环、WEB-A04 恢复和 WEB-A05 删除门禁通过。见[上传规格与验证基线](#上传规格与验证基线)。                                                                                                                                                                                                                                                               |
| [WEB-04 项目与 Agent 输入](../10-requirements/WEB-REQUIREMENTS.md#web-04-项目与-agent-输入)                    | 已实现   | 复用 #52 的 B 独占实栈（`484dcc7`，Chromium 1/1），WEB-A07 真实存储、冻结与轮换、同项目隔离及凭据扫描通过。#49 原文件下载摘要一致。本轮本地（`ec7cd62`）API 25/25、Chromium 5/5，验证逐文件提示、整体拒绝、快照限额与原文件可下载。未重跑实栈。                                                                                                                        |
| [WEB-05 执行环境](../10-requirements/WEB-REQUIREMENTS.md#web-05-执行环境)                                      | 已实现   | 2026-11-17，B 独占 Compose、Chromium 与 OpenShell 实机（Web 候选 `484dcc7`）1/1 通过。真实邀请、关页找回、原址重准备、两次上传、健康后轮换、冻结快照、续写与独立读取均通过。五次 Run 各一次派发和结果回执，凭据扫描零匹配。应用及浏览器已停，STS 已撤销。两条历史待核对 Run 及证据保留。多账号并发与换宿主恢复待验。                                                   |
| [WEB-06 任务提交与结果](../10-requirements/WEB-REQUIREMENTS.md#web-06-任务提交与结果)                          | 部分实现 | 本地 Chromium 与回环 mock（`058a272`，18 项通过）验证查找、重连与待核对隐藏补丁，WEB-A11 覆盖两浏览器回读。[WEB-A08 实栈证据](#web-a08-实栈证据)覆盖顺序三账号关页推进、找回、交付和读取隔离。待验多账号并发、事件去重、续做与执行隔离，可信运维结案仍待完成。                                                                                                         |
| [WEB-07 连续对话与任务控制](../10-requirements/WEB-REQUIREMENTS.md#web-07-连续对话与任务控制)                  | 部分实现 | 本地通过连续任务与安全边界回归。A 独占实栈通过登录、空白任务、Worker/Session 基线与卷隔离恢复。真实浏览器安全重试及异常验收待收口。见 [WEB-07 分项证据](#web-07-分项证据)。                                                                                                                                                                                            |
| [WEB-08 结果审阅与交付](../10-requirements/WEB-REQUIREMENTS.md#web-08-结果审阅与交付)                          | 已实现   | 2026-11-17 B 独占实机（`36ab687`＋私有 Worker）WEB-A13 1/1，三次 Run、同 Session 两次写入、只读与补丁字节对账通过。独立私有标记负例通过，收口 `pnpm check` 与两项 Chromium 回归通过。七服务、两沙箱与传输已停，临时凭据回收；原桶卷及结果保留。B 受控租约保留 `web-a13/full-stack/a13-auth/a13-output.*` 和 `web-a13/orchestrator-state/{business,authority}.sqlite`。 |

## WEB-01 实栈证据

2026-11-17，候选 `76ea4de85fd09f4e81ea6f03da516d8e90bd9814` 在 A 独占 Compose、Chromium、Keycloak/MySQL、Temporal/OpenShell 与 HTTPS 私有 MinIO 上验收。受控结果 `bento-web01-evidence/results.md` 的 SHA-256 为 `a29888cdf0edeba1303ab24c794dcb8b9414c1939066f9eaf1c30f771dc4a33c`。

- A/B/C 真实组织邀请、邮件验证和 OIDC 回跳通过；未验证和非成员被拒，关闭公开注册，Keycloak 重启后主体和认证审计一致。注销回跳实测要求 ID token 包含 `auth_time`，已在 Workspace 客户端补充内置映射。部署要求见[身份配置](../../deploy/README.md)。
- 三个 owner 通过真实 HTTPS 上传嵌套项目并读取自己的预览、Task 与补丁。三组跨租户项目、文件和传输请求与不存在资源一致，补丁下载另有两条跨租户对照。B/C 经服务重启及重新登录仍能回读原项目、文件和补丁。私有 S3 拒绝匿名对象请求和错误键、分块号、方法；原签名到期返回 403。
- A 错身份注销返回 401，正确身份回跳 303，两个旧会话和新签发请求均为 401，已提交 Run 在注销后继续完成。另一 Run 经可信退出与错代拒绝后结案，随后清理 A 的 Task、Run、diff、S3 对象和工作区，保留最小审计、IdP 主体及 MySQL 关闭标记。独立 D 对照在注销后、签发期内重启，原 multipart 保留且可继续使用原签名；到期后自动清理。
- 模型续轮单独验证两次 HTTP 200、同 ID 工具、公开检查和持久 Session。正式浏览器用非模型 fixture 产生 SDK 补丁。未覆盖 WEB-A10 完整多账号并发验收。现有 Chromium 回归 20 项通过。正式服务已撤下，原 A 环境健康，旧 `needs_review` 指纹一致。

## WEB-A08 实栈证据

2026-11-18，B 独占 Compose 候选 `ff15b38` 使用真实 DeepSeek 和 OpenShell。[Chromium 验收配置](../../apps/workspace/web/playwright.web-a08.config.ts)随 `d062a90` 提交，在隔离 Chromium 容器运行 `node node_modules/@playwright/test/cli.js test --config playwright.web-a08.config.ts --reporter=line --output=/tmp/web-a08`，1/1 通过。

三位受邀用户顺序从 Web 上传各自的文本项目并提交。三次原 Run 均在关页时仍处于排队状态，随后在后台成功。重新登录后，三人各自从任务列表找回同一 Run，补丁预览与下载字节一致，应用到各自原文件后与预期内容一致。六个有向跨账号组合读取任务、Run、结果和补丁均返回 404。1 MiB + 1 字节的文本可保存并按原字节下载，选作任务输入时返回 413，页面显示 1 MiB 限制。

## 开发环境

2026-11-13 的记录确认独立 Compose、开发身份、Temporal 和私有 MinIO 可用。模型列表与 OpenShell mTLS 已验证，Run 仍使用本地执行适配器。环境连接见[开发环境说明](../../ENVIRONMENTS.example.md)。

## 上传规格与验证基线

2026-11-17 北京时间 14:28–14:40，在 A 独占 Compose、真实 OIDC、严格 TLS Chromium 120 和私有 MinIO 上验证候选 `3e11d9b50ef3464004debc9b4caa159154ec0981`。运行镜像 ID 为 `sha256:4e2f74cacf378526aedce2eb52b61a9ba0e7e4f2729e8cca47238def7f9ce040`，验收脚本 SHA-256 为 `7a21204440a20174133c9fead602767d454b8f653488a691286095d21e5f0bd1`。复跑见[空间上传实栈验收](../../deploy/README.md#空间上传实栈验收)。

- **WEB-A02**。两块预检与 100,000,000 字节边界轮次均输出 `WEB_A02_PASS`。16,777,217 字节预检验证两块的实际长度、保存、下载及清理。边界轮次首块后断网刷新，同大小异内容返回 409，600 秒签名自然过期后 Chromium 的旧 URL 实际 PUT 返回 403，同一上传只补 2–6 块。核对六块实际长度及签名绑定的长度。100,000,001 字节由页面和 API 拒收，未产生预占或 PUT。两轮原文件与下载 SHA-256 分别一致，为 `2cc918b97138410e4ccb5f276f8a663bf3a08c00fed0b5dab8f78d4b92a002ba` 和 `188cad9881a946c221b776a123284ea9fb15e5b34f6c402575cf945179045711`。
- **WEB-A03**。同账号实存两个 100,000,000 字节对象，HEAD 和 multipart 回读通过，用量到达 200,000,000 已保存、0 预占。额外 1 字节返回 409，删除一个后仅一笔并发预占成功，取消和确认清理后额度可复用，最终输出 `WEB_A03_PASS`。受控时钟 API 5/5，覆盖过期、取消与删除后的存储确认及额度回收。
- **WEB-A04 / WEB-A05**。本地空间 API 18/18（含 A04 六项），使用实际 HTTP、SQLite 和受控存储 fixture，覆盖丢回执、缺块、错大小、同库重开及取消和完成竞态。A05 通过个人 API 与 Orchestrator 双 HTTP 验证活跃 Run 阻塞项目删除，终态后回收及原入口失效。定向 Chromium 9/9 覆盖目录、大小、预览、下载及删除界面。真实 S3 与外部执行联合运行仍待独立验证。
- **撤场**。测试对象和 multipart 均已回收，账号用量归零。已撤下候选 Workspace，现有 A 服务及原开发栈指纹与起点一致。严格 TLS 回读 Web 404 和 S3 403，临时用户、存储授权及验收卷已清理。

`116dc7b` 的分段实栈结果及 `75c78b1` 的本地 A05 结果保留在 Git 历史中供对照。

## WEB-07 分项证据

- 连续任务 MVP（WEB-07-HP01～HP03 / WEB-A11）。2026-11-16 本地 Orchestrator、Chromium（`b616304`）通过两浏览器续聊和重连。A 独占实栈（`2f225667`）通过登录、空白任务及真实 Worker/Session 基线。同项目独立工作区可复用 #52 的实栈证据。
- 用户安全重试（WEB-07-HP04 / WEB-A12）。本地通过撤权、双检查点和崩溃回读。A 独占实栈通过卷交换、崩溃恢复和隔离探针，首轮 T5b 已确认部分写入与停止证明。真实浏览器重试后两个检查点恢复仍待完成。
- 异常验收（WEB-07-BC01～BC06 / WEB-A12）。本地 HTTP（`025c879`）验证 DSH 检查点缺失或损坏时新 retry 回 409，未建 attempt、未恢复卷；受理后、恢复前失效则阻断，卷不变；同键重放原回执。真实环境仍须逐项核对排队取消、运行取消占槽、UNKNOWN、分别缺工作区及 Session 检查点。两项可选 Temporal 场景跳过。
