# WEB-07 连续对话与任务控制验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## WEB-07 分项证据

下列本地记录与 2026-11-20 失败轮为历史基线。当前场景状态以 2026-11-23 实栈和 Readiness 为准。

- WEB-07-01。2026-11-16 本地 Orchestrator、Chromium（`b616304`）覆盖两浏览器重连、历史去重及顺序。A 独占栈（`2f225667`）确认 HTTPS/OIDC 登录与空白任务。
- WEB-07-02。2026-11-18 A 独占真实 Chromium 验收 1/1（部署镜像源码 `6b8eefa`，验收 `918a38b`，实际 DSH/OpenShell Worker 使用脚本化模型响应）。原 Task 续做并验证同 Session、同工作区，逐轮独立读回派发与同代投影。相同正文和键重投为 200 并返回原 Run，异正文同键为 409。Run 列表恰有两轮，用户消息各一条，旧结果、两视图补丁和检查仍可读。正常删除 Space 后对账两个 Task 的沙箱、卷及 S3 对象和未完成上传，独占栈已撤场。另一次 T0 探针发现账号注销重认证回调为 500，根因待查。本项未覆盖真实模型生成工具调用、用户安全重试及 -05～-10。
- WEB-07-03。同项目独立任务使用 #52 的实栈工作区隔离证据。

### WEB-A12 2026-11-20

- **版本与范围**：实栈业务源码 `640bc24ff1adcd3f9b7a7b8a1eb02fb197b92e88`，候选摘要 `2cbb1da3323a1a81b8fc89e87d6acb859c81cbff14402dd602b0b4e9426caca4`；最终验收调用方闭包摘要 `b9ae019e5a2fed2a0a649b4d716a487fa009c22d23eb8ffaab0cdb7ce73710ca`。实际 Chromium、OIDC、OpenShell、SDK mTLS、S3 和 Worker，模型响应为脚本化 DSH fixture。这些镜像使用原生产依赖；不证明后来 main 的 Worker 依赖变化已通过相同实栈。
- **实际通过**：完整 bootstrap 写前预演、五镜像来源与平台、基础设施/OIDC/Gateway、原生卷隔离与恢复探针；Chrome 和 Node 均经正常 TLS 访问，匿名 session 返回 401；登录邮箱与 MySQL `(issuer,subject)` 唯一内部 owner 绑定核验通过。完整 smoke 创建真实 Task 并完成 Run；真实 Playwright worker→原生 Node→原 hook 加载通过。安全重试场景的新 Task 已就绪，首个 Run 为 succeeded。
- **Happy Path 未通过**：`WEB07 fail` Run `e854ceb2-778a-456d-9d94-5da33243db11` 实际为 needs_review，严格期待 failed 的断言等待 90 秒后失败；未进入恢复，retry attempt 为 0。`service.ts::stopAndProve` 的 `host.sdk` 提前返回与实际可信 SDK adapter 不兼容：实际 host 同时具备 SDK、taskRecovery、retryObservation 和 observeWorkerExit，但没有生成 stop proof。普通 SDK 缺乏独立证明时仍应保持拒绝；本轮按用户要求仅记录问题，不交付未完成的生产修复。
- **诊断边界**：原生 generation 2 Worker 退出码 0 且退出发布匹配；旧代 9 项 operation 均 SUCCEEDED，history 无打开句柄或 pending batch。随后 recovery 的 Worker 亦退出 0，当前 authority 已到 generation 4；这个后态不能代替当时应核验的 generation 3 证明，也不能把被 early-return 跳过的后续条件记为通过。诊断原始摘要 `b356e4e58a1f931cf0327be5816632c0514695d9e8f16097c8d7f212be40a85e`，实际 host 形状证据 `40b438aabaaecf7a9692722bc8a775c8da5e189692c7a18b1adae86c7dd771bb`。
- **未覆盖**：浏览器双检查点恢复、重试同键回执及 -05～-10 全部 10 个实栈负例均未完成。已通过 smoke 不代表 WEB-07-04 完成。本地交付基线 `b031ac3` 加本次检查点变更的 service suite 实际 63 项通过、2 项既有可选场景跳过；跳过项为 `Temporal Activity retries a completed Run without repeating its effect` 与 `execution entry enforces two-slot tenant fairness and queue backpressure`。
- **清理与保全**：真实 SDK/S3 清空，登记资源均已消失、端口释放、旧环境与保留镜像不变；本轮测试容器残留 0，5 个临时目录已移除并转存原始证据和保全副本。业务/authority/history 数据库、3 份 workspace 内容及原始失败记录保留于私有验收归档 `a6fdb0ab-6614-4ede-9c35-02fd79774a59`。原 cleanup 失败回执保留；CLI 循环导入和 sandbox image 继承标签导致的清理入口问题经原函数直接盘点、精确身份删除续清理完成，最终 `registeredIdsAbsent / labelsEmpty / listenersReleased / excludedUnchanged / priorIndependentLiveEmptyVerified` 全为 true。Docker logging driver 不支持读取容器日志，未将该项记为已取得。

### WEB-A12 2026-11-23

- **应用与方法**：应用提交 `1c4303e384b564a7af237b51e76334ad824cb4f2`，同一 Linux/amd64 Compose 部署、真实 Chromium/OIDC/S3/OpenShell SDK 和沙盒；模型响应为确定性脚本。可信宿主提供独立退出及 SDK 停止撤权观察，服务据此构造既有 canonical StopProof；缺少完整证据仍保守拒绝。HTTP、数据库和持久 proof 格式未改变。
- **业务结果**：Happy 1/1、必需 Bad 10/10，均通过且无 skip。Happy 在新 admit 前逐一回读双检查点摘要、原绑定、停止证明和唯一 attempt/新 Run；新 Run succeeded，原失败 Run、事件前缀与旧结果字节保留，同键仍为原回执。取消复合场景分别覆盖 -05/-06；UNKNOWN、受理前 Workspace/History 各 missing/corrupt、受理后四种失效分别覆盖 -07～-10。UNKNOWN 的只读 recovery 由持久恢复记录及实际容器独立核验，拒绝重试和续写后没有新增执行或重放。
- **验收修正与来源**：在同一部署修正验收等待，不重建应用镜像：按截止时间等待恢复阶段与独立 admit gate 同时就绪；仅为受理的重试 Run 等待异步创建前的暂时 404。观察器区分 execute admission 与已有只读 recovery 的持久证据，保留代次、绑定、容器、撤权与创建计数校验。原失败 case、错误及修改前字节保留。实际浏览器修正源码 SHA-256 `06ccd7fc5aae5c71fba0212864dc25fb26bc1aca2bfe4a7a7df4fc0e615619dc`，最终私有 harness 绑定摘要 `a3cc1514308a520cfaa7816c5958ace01dbacd4c151db13986c2e43d46150c81`；公开浏览器源码仅作格式归一后提交。
- **本地验证**：安全重试组合 50/50（含新增 SDK 26 项）、浏览器宿主身份 24/24、本轮私有时序与恢复观察定向测试 11/11 通过。最终 `pnpm check` 退出 0；两个原有环境条件跳过依赖 `BENTO_TEST_TEMPORAL_BINARY`、`BENTO_TEST_FAIR_BINARY`，不计为本轮覆盖。包清单不含私有环境输入。未把前置装配或 smoke 当作业务通过。
- **清理与保全**：租约 `cf3b6327-a443-464a-8cde-092e3cba32f1` 正常 cleanup 和独立 after 均通过；SDK/S3 实际清空，139 个登记资源独立确认消失，业务监听与执行进程均为 0。`registeredIdsAbsent / labelsEmpty / listenersReleased / excludedUnchanged / priorIndependentLiveEmptyVerified` 全为 true。三个业务数据库备份摘要已回读，失败证据与工作区保全材料保留于私有归档。独立收口记录 SHA-256 `db72e7a8ef9b9f4bf988cf8b1900f4cdab67a4fb6b9fb65073d8fb6d55112039`。共享构建缓存和外部网络代理不在本租约业务资源回收范围。
- **未覆盖**：真实模型生成质量、普通 SDK 自动具备安全重试观察能力及纯基础镜像分层迁移。本轮使用历史应用基底派生并按当前 lockfile 装配 Linux 依赖，不把它登记为已验证的纯基础镜像。WEB-07-01～03 沿用各自原证据，父项仅按全部必需子项状态汇总，不表示整个平台已就绪。
