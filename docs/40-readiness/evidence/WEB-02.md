# WEB-02 上传与续传验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## 上传规格与验证基线

2026-11-17 北京时间 14:28–14:40，在 A 独占 Compose、真实 OIDC、严格 TLS Chromium 120 和私有 MinIO 上验证候选 `3e11d9b50ef3464004debc9b4caa159154ec0981`。运行镜像 ID 为 `sha256:4e2f74cacf378526aedce2eb52b61a9ba0e7e4f2729e8cca47238def7f9ce040`，验收脚本 SHA-256 为 `7a21204440a20174133c9fead602767d454b8f653488a691286095d21e5f0bd1`。复跑见[空间上传实栈验收](../../../deploy/README.md#空间上传实栈验收)。

- **WEB-A02**。两块预检与 100,000,000 字节边界轮次均输出 `WEB_A02_PASS`。16,777,217 字节预检验证两块的实际长度、保存、下载及清理。边界轮次首块后断网刷新，同大小异内容返回 409，600 秒签名自然过期后 Chromium 的旧 URL 实际 PUT 返回 403，同一上传只补 2–6 块。核对六块实际长度及签名绑定的长度。100,000,001 字节由页面和 API 拒收，未产生预占或 PUT。两轮原文件与下载 SHA-256 分别一致，为 `2cc918b97138410e4ccb5f276f8a663bf3a08c00fed0b5dab8f78d4b92a002ba` 和 `188cad9881a946c221b776a123284ea9fb15e5b34f6c402575cf945179045711`。

### 空间完整性与删除保护补验

2026-11-19，以生产基线 `801f087`，API证据提交 `84bbbe8` / `8e7f60b`，浏览器证据提交 `a5cd3af` 验证。仅新增测试和CI接线，空间API、存储适配器和Orchestrator生产门禁未修改。

- **WEB-02-02**：`node --import ./register-paths.mjs --test apps/workspace/api/tests/space-path-integrity.test.ts apps/workspace/api/tests/space-object-integrity.test.ts` 共17/17通过。路径部分分别拒绝穿越、绝对路径、空段、点段、反斜杠、控制字符、超长路径、重复目标、两个方向的文件/目录冲突和已有上传占用；同ID重放仅预占一次。完整上传行、额度、树与原件字节/摘要保持。
- **WEB-02-08**：同命令的5个独立完整性case通过。使用实际临时分块/对象文件与HTTP数据面，分别观察缺块、块长度错误、ListParts摘要错误、Complete拒绝、对象少1字节；逐项核对上传记录、物理对象、树、下载404和预占。合法补传或清除故障后原ID只保存/记账一次；错对象进入cleaning，删除故障期间保留预占，签名截止后确认物理清理才进入failed/释放，重开不会开放下载。
- **正常Web入口**：`pnpm --filter @bento/web test:space-integrity` Chromium 1/1通过，包含4个独立命名拒收步骤及正常控制上传。真实邀请注册/密码登录、实际选择本地文件/目录、生产mySpace与物理存储HTTP；清单拒绝期间无上传POST/PUT、无预占、原件不变。正常控制项由浏览器直传并保存。无page.route业务JSON替身；API测试由本地check和CI自动发现，专用Chromium命令已接Web Chromium E2E。
- **聚合与打包检查**：`pnpm check` 通过：空间API 55/55，Web单测17/17及构建，Orchestrator 102通过/2个既有skip（Temporal Activity重试、two-slot tenant fairness），Worker typecheck、Go检查、仓库lint/format通过。三项本次必需用例无skip。`npm pack --dry-run --json` 通过，保持原根files范围，无运行数据库、日志或浏览器trace入包；新API测试在原API打包范围内，Web验收源文件由public白名单维护。
- **Not Covered**：身份和存储签名均为本地fixture，非真实IdP/S3；块摘要观测覆盖与Complete错误是受控注入，不证明供应商实际损坏处理。Run/准备/恢复/结案状态为fixture，仅证明持久门禁消费，不证明真实Worker恢复或可信运维观察算法；queued receipt依赖的实际恢复由其他验收负责。mock Date/interval仅用于上传到期与sweep，删除只推进interval，网络与等待保持真实期限。浏览器正常文件选择不能产生非法系统路径，非法路径由API覆盖。未对整项目销毁后的文件DELETE状态作新增契约结论。真实外部模型和S3故障注入未覆盖；既有2026-11-18实栈Happy Path证据继续适用。

`116dc7b` 的分段实栈结果及 `75c78b1` 的本地 A05 结果保留在 Git 历史中供对照。
