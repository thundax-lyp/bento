# WEB-02 / WEB-03 上传与空间验收 RUNBOOK

状态为交审草稿。建立日期 2026-11-17。范围为 Bento A，目标分支 `main`，干净起点 `646d11a95b12ae89f9952f9c1f13b4ffa3fcdada`，核对时远端 main 同 SHA 且开放 PR 为零。授权执行后使用 `codex/web-02-03-acceptance`。T0 由 MASTER 审核并记录供执行的草稿提交、固定实栈命令与租约；交审阶段仅调查和起草。

## 目标与当前断点

WEB-02 与 WEB-03 共用账号、multipart、预占、登记、读取与删除。按两块预检、六块边界、同账号额度串行验收，再依据 A04/A05 回归收口。

- WEB-02。[上传与续传及 WEB-A02](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)要求浏览器按块并行直传。当前 `apps/workspace/web/src/space-api.ts` 的 `transferFile` 逐次等待签名及 PUT，两块也串行。最小生产改动在该函数。真实边界曾分段验证，续传轮次在保存后断于脚本断言，下载另轮完成。复跑须验证同一次续传、保存和收尾。
- WEB-03。[空间额度与文件生命周期及 WEB-A03–A05](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期)要求存储确认后回收及任务删除门禁。历史真实额度和本地门禁记录提供基线。A04/A05 已有当前代码的真实 HTTP 定向测试，A05 浏览器覆盖另由回环 fixture 验证。没有发现必要的服务端行为改动。
- 依据为[正式验收表](../10-requirements/WEB-REQUIREMENTS.md#验收标准)、[空间契约](../20-interfaces/WEB-INTERFACE.md#我的空间--web-02--web-03)、[项目文件与存储设计](WEB-DESIGN.md#项目文件与存储)、[当前证据](../40-readiness/CURRENT-READINESS.md#上传规格与验证基线)、[部署验收入口](../../deploy/README.md#空间上传实栈验收)与[平台边界](../00-governance/ARCHITECTURE.md)。状态使用[开发完成定义](../00-governance/DOCUMENT-RULES.md#required-structures)。
- 范围限于 WEB-02/03、A02–A05 及其直接回归。设计明确允许用短有效期和受控时钟进行恢复、过期和清理回归。A05 要求以空间入口验证活跃任务阻塞及终态释放，真实 OpenShell、模型、Worker 或生产级 S3 联跑属于其他执行或部署验证。WEB-01 注销、WEB-04 输入契约、存储后端替换、数据库迁移、并行文件批次和部署架构变更不在范围内。

## 接口与不变量

- 浏览器 `CloudProject` → `transferFile(project: string, id: string, file: File, filename: string, partSize: number, notify: (progress: TransferProgress) => void): Promise<void>` → TypeScript API `mySpace().route` → `reserve`、`prepare`、`parts`、`finish`、`clean`、`sweep` → `spaceStorage`。SQLite 拥有业务状态和额度，S3 回读拥有物理分块事实。浏览器选择并生成 UUID，已存在的上传按原 ID 回读。服务端从会话取得 owner。
- 开始 POST 输入必填 `{id: string, path: string, size: number, checksums: string[]}`，项目 ID 来自路径，清单按块号为 Base64 SHA-256。SQLite `space_uploads` 的 `id/project/owner/path/manifest/state: TEXT`、`size/expires/signedUntil: INTEGER` 必填，`storageId/cleanup: TEXT | NULL`，其中 `signedUntil` 默认 0，`expires` 由服务端计算 24 小时。响应 `view` 公开 `{id, project, path, size, state, expires}`，查询附 `parts: number[]`。同 ID 同项目、路径、大小和清单重放复用记录。签名 POST `{number: number}` 返回 `{url: string, checksum: string}`，10 分钟权限绑定 `space/{id}`、multipart ID、块号、长度和摘要。空文件无分块。文件上限 100,000,000 字节，账号 200,000,000 字节，分块 16,777,216 字节。
- 状态为 preparing → uploading → completing → saved。缺块退回 uploading，cancel、expiry、错大小进入 cleaning，物理清理后转 cancelled/expired/failed。已保存文件可进入 deleting → deleted。预占直至保存或清理确认，saved/deleting 计已保存额度。下载和预览只为 saved 签发，重复 complete 返回同一文件，同部署 API 重开从原 SQLite 恢复。仅向 S3 直传正文，API 按 ListParts 的 ETag、Size、SHA-256 和完成后的 HEAD 做登记。
- A05 使用 `GET /api/space/projects/{id}` 的 `files: {id: string, path: string, size: number}[]`，删除前读取 `/deletion` 的 `fileCount/uploadCount/runCount/diffCount: number` 和 `blockers: string[]`。执行门禁先由 Orchestrator 确认，空间负责最终对象清理及额度。活跃 Run 返回 409 project_busy，清理中返回 202 deleting，终态 DELETE 返回 204，原项目、文件、任务和补丁入口按契约失效。单文件删除保留历史任务及补丁。沿用现有错误码和 API；本次客户端并行不引入领域事件、回执表、版本或队列。

## 相关代码计数

以起点的仓库相对路径计数，表内路径均相对 `apps/workspace/`。逐范围剔除空行和纯注释。计入直接实现、需核对的入口及可执行验证。

| 路径                            | 行范围与责任                                               |  LOC |
| ------------------------------- | ---------------------------------------------------------- | ---: |
| web/scripts/verify-web-a02.mjs  | 1–804，真实 Chromium 传输、续传、额度、清理                |  776 |
| api/space-files.test.ts         | 54–974、1460–2138、2150–2969，预览/删除、恢复、额度        | 2366 |
| api/space-storage.ts            | 18–232，S3 签发、回读、登记和清理                          |  211 |
| api/space.ts                    | 13–62、452–695、854–908、911–1189，状态账本、sweep 和 HTTP |  610 |
| web/src/space-api.ts            | 4–110、113–256，浏览器合同、读取及 transferFile            |  239 |
| web/src/space.tsx               | 132–317、318–560，目录、清单、文件树及上传进度             |  419 |
| web/src/space-api.test.ts       | 1–145，续传和传输状态回归                                  |  138 |
| web/e2e/upload-intake.spec.ts   | 1–147，上传清单                                            |  141 |
| web/e2e/upload-progress.spec.ts | 1–406，批次、重选及目录                                    |  394 |
| web/e2e/space-preview.spec.ts   | 1–470，预览及删除界面                                      |  458 |
| 合计                            | 10 个文件                                                  | 5752 |

## 执行者契约与证据

从仓库根目录按序执行。每步最多十个直接处理文件，PASS 后按 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md) 及[提交规则](../00-governance/COMMIT-RULES.md)删除该 STEP 并提交其产物，保留原编号。STOP 保留现场，记录最后一步与 SHA、文件及符号、最小命令、脱敏结果和所需决定。固定断言失败时禁止放宽或转用未列入口。需要修改本稿以外的代码时退回作者定位。

当前起点已复跑 A03/A04 和 A05 双 HTTP/单文件门禁，共 13/13；Chromium 指定三文件 9/9；脚本 `--check` 通过。后者是本地自检，不能作为实栈连通或登录的证据。Readiness 的 `116dc7b` 实存及 `75c78b1` A05 历史结果可作对照；此后空间入口及执行接线发生变化，A02/A03 和直接相关回归按本稿在候选版复验。WEB-01 独立验收只复用其租约定位与原环境保全证据。

### T0：锁定起点及实栈租约

前置状态为 MASTER 认可草稿与既有 A 独占资源。允许补齐本 RUNBOOK 的受控入口引用。

- 计划提交前，执行 `git status --short --branch`、`git rev-parse HEAD`、`git ls-remote origin refs/heads/main` 和 `gh pr list --state open --json number,headRefName,baseRefName`。本地 HEAD 与远端 main 均须为 `646d11a95b12ae89f9952f9c1f13b4ffa3fcdada`，工作树仅有待审 RUNBOOK，开放 PR 为零。
- MASTER 审核并确认受控入口后，从该基线建立执行分支，单独提交 RUNBOOK，记录经审核的计划提交完整 SHA。提交后按 T1 前置检查重新核对。

A checkout 没有 ENVIRONMENTS.md，登记的 SSH 入口来自 MASTER checkout 的本地环境说明。唯一私有命令契约为本地权限 0600 的 `/tmp/bento-a-web02-t0/ENTRYPOINTS.md`，从本仓库根目录按其中阶段执行，远端入口和材料复用当前 A 租约。T0 核对独占租约及期限、入口可用、严格 TLS 和 PUT CORS 预检、专用账号成员关系、已受限的 HEAD 及分块列举。禁止将值、连接细节、签名或原始日志放入 Git、PR 或聊天。

A、B 及原开发栈共用宿主，Compose 网络、挂载和端口隔离，此结论来自原调查移交。已通过仓库登记的 SSH 授权静默连接 A 宿主，重新回读 A 的 Keycloak、MySQL、Orchestrator、MinIO 和 TLS 仍运行，Workspace 已撤下。公钥探测的拒绝结果不影响已登记的静默登录。以 A 私有 CA 在宿主直连 TLS 入口，Workspace 返回 404，未授权 S3 返回 403，PUT CORS 预检返回 204 并允许 PUT。证书到期为北京时间 2026-11-18 14:57:53，本轮检查器策略到期为 14:45。实栈窗口与失败后清理须在两者有效期内。

1. 受限运行记录位于本地仅当前用户可访问的 T0 目录，MASTER 通过该记录核对命令。已在 A 宿主核对 Compose 项目标签、基础文件和既有 overlay 路径，并确认 A 的离线构建脚本存在。受限记录已固定 T1 提交归档、复用缓存离线构建、Compose overlay 顺序、Workspace 独立卷、路由开启、运行镜像摘要校验和撤场命令。Compose 配置与现有 NGINX 路由预检通过。本步骤保持 Workspace 撤下，候选镜像构建及运行核验在 T2 执行。
2. 使用 A 的 Keycloak 管理 CLI 创建本轮用户，并在 Workspace 配置的组织中验证成员关系。A 的 MinIO 已创建独立的限时只读检查身份。对象读取范围为 A 验收桶的 `space/*`，multipart 列举权限在 A 桶级生效。通过随机探测键确认对象不存在、无 multipart 残留，且写入被权限拒绝。浏览器上传继续使用 A 应用自己的直传签名，检查器身份仅用于回读。
3. 唯一正常验收入口为受限记录中的远端 `browser-run`。该入口使用 A 宿主上的隔离 Playwright 和既有 Chromium，浏览器配置保留 Host、SNI，并通过独立 NSS 信任库验证 A 私有 CA。同一入口已实测 `--check` 退出 0 且恰好一次输出 `WEB_A02_PREFLIGHT_OK`，同一 Chromium 启动方式严格验证 Web 404 和私有 S3 403。检查器 `absent` 已通过。
4. 通过同一私有入口记录并立即回读 A 与原开发栈的运行容器、镜像、网络、挂载和端口绑定指纹，当前回读匹配。T3 撤场使用该基线。

PASS 同步基线、独占租约、私有命令入口、浏览器严格 TLS 和 PUT CORS、组织成员关系及只读检查权限均已核对，环境基线已封存。当前技术预检通过，计划提交及 MASTER 审核仍待完成。STOP 任一 T0 核对失败，或验收及清理窗口超出最早到期时间。

### T2：适配并行观测并按序完成 A02

前置状态为当前提交包含四块并行，单元测试 10/10、个人端类型检查及 Chromium 9/9 通过，T0 受控入口就绪。允许修改 `apps/workspace/web/scripts/verify-web-a02.mjs`、`deploy/README.md` 和本 RUNBOOK。禁止改生产代码、存储签名或替换真实 PUT。

1. 运行实栈脚本前，用 T0 固定的受控部署入口从 T1 已提交源码构建并部署候选镜像。记录 T1 提交 SHA 和构建得到的镜像摘要，通过 T0 受控入口读取实际承接验收请求的服务实例镜像摘要，逐一对比部署记录；任一不一致或无法读取则 STOP。通过 A 受限记录的唯一远端浏览器入口加载配置。以同一 Chromium 严格访问候选 Web 200 和私有 S3 403，再由 --small 在第一次传输前完成正式 OIDC 登录及零用量检查。T2 和 T3 使用同一候选实例及同一测试账号。候选路由、正式 OIDC 登录或零用量任一断言失败则 STOP，不进入传输。
2. 在 `verify` 的 disconnect 阶段对编号大于 1 的签名请求共用单一闸门，释放函数须幂等。先等待第 1 块实际 PUT 200 并回读 parts=[1]，再置 offline 并释放闸门，验证 reload 离线后恢复与回读。故障退出时先释放闸门，再执行 `await context.unrouteAll({ behavior: 'wait' })`，完成后继续既有收尾。capture/expired 阶段只让编号 2 使用原有捕获或旧签名逻辑，其余缺块的签名请求直接中断。等待该轮全部结算后才进入下一阶段。resume 恢复全部缺块的正常签发和直传。
3. PUT 证据按请求发出时的阶段归属；记录实际请求 Content-Length 和签名中 content-length 绑定位，缺失则 STOP。小文件、边界、额度的完成断言按块号排序后比较，保留长度和重复检测。断言 2 块的长度为 16,777,216 和 1；100 MB 为前五块各 16,777,216，末块 16,113,920。拦截每个 complete 请求，从该请求 URL 的路径解析上传 ID，据此查询同一上传的 API parts，确认全量编号及存储校验结果后再放行该请求。无法解析 ID 或回读不符则 STOP。额度轮次第二个文件从自身 complete 请求取得 ID 并回读自身 parts。
4. 过期签名优先用 Chromium 的实际 PUT 证据，按旧 URL 和 CDP requestId 绑定发送头及 HTTP 状态。现场已在 600 秒自然过期后观察到浏览器 PUT 的线级 502、CORS `MissingAllowOriginHeader`，本轮已清理归零并保留受限恢复快照。仅在新轮复现这一组合时，在同一次验收进程内用同一 Playwright context 的 `request.put` 向 A 的原 HTTPS URL 直接重放真实 PUT。保持证书校验，关闭重定向，发送原文件第 2 块完整字节、原签名对应的 `x-amz-checksum-sha256` 和准确的 `content-length`。要求旧 URL 已按原 600 秒自然过期、直连返回 403、同一上传记录仍仅有第 1 块，再由同一 Chromium 页面获新签名并只补 2–6。任何其他浏览器结果或直接 PUT 非 403 均 STOP。日志仅记录状态、长度和阶段。
5. 起始空间要求 saved=reserved=0。扩展现有检查器调用，仅 saved 模式增加可选第三参数 expectedBytes（缺省仍为 100,000,000），让 --small 在清理前核对 HEAD 16,777,217 及无 multipart 残留。更新部署手册的检查器契约。--quota 的复用测试 UUID 必须在发送 start 前写入 recovery 记录。环境仅通过 T0 受控入口注入。按如下顺序执行，须逐条 PASS。`--check` 必须退出 0 且恰好一次输出 `WEB_A02_PREFLIGHT_OK`。

```bash
python3 /tmp/bento-a-web02-t0/stage-verifier.py
/tmp/bento-a-web02-t0/browser-run --check
/tmp/bento-a-web02-t0/browser-run --small
/tmp/bento-a-web02-t0/browser-run
```

PASS 自检通过；同一候选、同栈同账号先完成 16,777,217 字节两块上传、下载 SHA-256 与清理；再完成 100,000,000 字节断网刷新、同大小异内容 409 且无 PUT、旧 URL 实际 PUT 403、新签名只补 2–6、同 ID 原始下载摘要、100,000,001 字节页面和 API 拒收且无预占/无 PUT。每档应在其本轮输出 WEB_A02_PASS，真实对象和分块清理且用量归零。另轮 --download-boundary 仅供定位。STOP 网络、浏览器、检查器、对象一致性或任一断言异常；按部署手册保留 recovery.json 和原 ID，遵守现有阶段及清理截止。以正常 API 清理本轮项目，达到清理截止仍未确认时保留租约及恢复记录，禁止继续 A03。

### T3：完成 A03 真实额度闭环

前置状态为 A02 同一候选实栈通过、同账号空间已归零。允许修改本 RUNBOOK。执行如下命令。

```bash
/tmp/bento-a-web02-t0/browser-run --quota
node --import ./register-paths.mjs --test --test-name-pattern='WEB-A03' apps/workspace/api/space-files.test.ts
```

实栈和 HTTP 验收断言满足后，在 T3 PASS 前执行私有命令契约的 Withdrawal 小节。先走正常 API 清理并逐 ID 回读对象和 multipart 均不存在，确认账号用量归零。再撤下候选 Workspace、回读 A 与原开发栈环境指纹、以同一远端 Chromium 核对 Web 404 和未签名 S3 403、撤销本轮临时账号及只读策略。四条命令全部退出 0 且各自输出契约所列标记。清理未确认时保留租约及恢复记录，禁止宣告 T3 PASS。

PASS 撤场和环境回读全部通过。同一账号实际保存两个 100,000,000 字节对象，HEAD 核对且无 multipart 残留；用量为 200,000,000/0，新增 1 字节返回 409 space_quota，仍为原值。删除一个对象后，两笔 100 MB 并发预占仅成功一笔；取消、物理清理、额度再用和最终回到基线得到 WEB_A03_PASS。HTTP 受控时钟 5/5，覆盖签名未失效时取消和上传记录过期、存储清理失败保留预占、确认后额度复用。STOP 按 T2 清理规则处理，保留测试账号原数据和原环境。

### T4：完成 A04 / A05 验收并收口

前置状态为同候选 A02、A03 验收及 T3 撤场回读已记录，测试对象、分块及用量已对账。允许修改 `docs/40-readiness/CURRENT-READINESS.md` 和删除本 RUNBOOK。

```bash
node --import ./register-paths.mjs --test apps/workspace/api/space-files.test.ts
pnpm --filter @bento/web test:e2e upload-intake.spec.ts upload-progress.spec.ts space-preview.spec.ts --project=chromium
```

- A04 要求六个具名 HTTP 用例均通过。针对实际个人 API 和 SQLite，存储层以 fixture 注入丢存储回执、丢客户端 HTTP 回执、缺块、错最终大小、关闭并重开同库及两个竞态顺序。核对原 ID、唯一对象与额度，清理/未保存状态没有下载地址，终态可回读。
- A05 要求 Chromium 九项全部通过，含目录路径和大小、纯文本预览、原附件下载、删除影响与阻塞、丢删除响应回读；实际个人 API 和 Orchestrator 双 HTTP 的 `project deletion crosses both HTTP boundaries` 验证路径穿越、重名和前缀冲突，未结束 Run 时 409 project_busy 且对象仍可访问，结束后原项目、Run、diff、文件入口 404，额度下降。单文件门禁用例核对对象清理与执行门禁都确认后才回收。
- 前两条验收命令退出 0、正式验收无跳过且证据可对应候选代码和镜像后，记录 WEB-02 为已实现及 A02/A04 证据，WEB-03 为已实现及 A03/A04/A05 证据。记录实际 SHA、大小、时间范围、脱敏证据指纹、环境边界、原环境与资源回收核对。草稿执行前的记录注明历史对照。随后删除 RUNBOOK，确认无专指引用或原始日志进入 Git。
  更新 Readiness 并删除本 RUNBOOK 后，从仓库根目录运行最终检查。

```bash
pnpm check
git diff --check
```

PASS 验收、Readiness 更新、RUNBOOK 删除和最终检查全部通过。

- STOP 任一正式用例未通过、缺证据或无法核对清理，不提升 Readiness。修复须落在已批准范围，否则退回作者。最后提交后按 [Worker 技能](../../.agents/skills/bento-runbook-worker/SKILL.md) 和 [PR 规则](../00-governance/PR-RULES.md)处理单个 PR、当前 HEAD 的 CI 与 Codex 审查及授权收尾。
