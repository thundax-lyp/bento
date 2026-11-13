# WEB-A05 目录上传与项目删除验收

状态：草稿，待 MASTER 独立审核。建立日期：2026-11-13（Asia/Shanghai）。工作区：`bento-a`。基线：`1197cc8229d0fd12c6ade37bb7c0de566108db8d`。审核通过并收到派工后使用 `codex/web-a05-space-lifecycle`。当前阶段只允许核对和起草。

## 执行者契约

从 T4 继续。每步只修改列出的文件和本 RUNBOOK，PASS 后按 WORKER 规则删去该步并独立提交。遇到实际契约或命令不符、门禁失败或需要扩大范围时 STOP，记录最后通过步骤、文件和符号、复现命令、脱敏输出和待决定项。保留失败现场。所有测试资源来自本地 Playwright mock 与独立临时目录。共享环境、生产对象存储、Keycloak、Temporal、执行调度、账本和部署配置均在范围外。B 的公平派发 PR 先合入，A 随后同步 main、复验并收口 Readiness。

## 目标与断点

在同一空间生命周期中，从目录选择、路径保存、树结构与字节数，到预览及附件下载，再到删除影响、未结束 Run 拒绝及终态清理。正式依据为 [WEB-03 与 WEB-A05](../10-requirements/WEB-REQUIREMENTS.md)、[Web HTTP 契约](../20-interfaces/WEB-INTERFACE.md#项目详情及目标扩展)、[Web 设计](WEB-DESIGN.md#项目文件与存储)、[平台架构](../00-governance/ARCHITECTURE.md)与 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)。

- #37（`89256ee`）交付 WEB-A02/A03 实栈与上传清理改动。已有 `upload-intake.spec.ts` 校验目录选择生成相对路径，但随后放弃选择。已有 `space-preview.spec.ts` 校验只读内容、大小及编码边界和下载链接属性。保存后 `CloudProject` 当前用 `uploads.map` 平铺完整路径，文件行缺少字节数。
- 现有 `mySpace.reserve` 已拒绝点段、重复和前缀路径。补从公开 HTTP 直接请求、拒绝后无预占的断言。浏览器的上传清单拦截只证明前端行为。
- 浏览器现有项目删除用例模拟 `upload_pending`。API 双 HTTP 用例在 Run 已成功后才请求影响和删除。Orchestrator `project deletion execution HTTP` 已覆盖活跃 Run 拒绝、释放后成功及旧 Run 入口失效。补同一 Run 穿过 Workspace HTTP 的前后状态，以及浏览器 `project_busy` 提示和禁止提交。
- #42（`1197cc8`）覆盖原任务详情恢复、重连和选定 Run 的差异交付。`task.spec.ts` 和 `pages.tsx` 用于 T0/T4 回归检查。旧 Run 链接的服务端失效由 T3 验证。

## 契约和不变量

Workspace API 拥有上传路径、大小、状态与额度。浏览器根据 `GET /api/space` 的 `Upload` 记录投影目录和文件。相关字段 `id`、`project`、`path` 为必填字符串，`size` 为必填非负整数字节数，`state` 决定是否属于树，`expires` 为必填毫秒时间戳。真实可访问的项目详情由原 API 回读。文件 ID 始终用于选中、预览、下载、删除，路径只用于显示和组织层级。仅 `saved` 可进入文件树，其他记录仍显示完整路径、状态与原可用动作。树目录由路径分段推导，无目录持久化。附件保持原 API 的 302 与原文件名。

影响为 `{fileCount, uploadCount, runCount, diffCount, blockers}`，前四项为必填非负整数，末项为必填数组，元素为 `project_busy`、`upload_pending` 或 `project_importing`。Run 状态由执行侧拥有。预检查只提示，DELETE 自行检查。活跃时返回 409 `project_busy`，终态后仅在存储及执行清理确认后回收额度，原账号重复 DELETE 读原结果。空间、原文件、旧 Run 和 diff 入口的失效通过 HTTP 读回验证。继续沿用现有 UUID、会话归属、事务、删除回执和重启恢复契约。此任务无新 DTO、迁移、事件、idempotency key、外部权限或执行生命周期。

### 代码范围

以下是基线上为实现或验收须核对的非空、非纯注释 LOC。新增及修改量估算约 230–310 LOC，预计修改 4 个代码文件。

| 文件（仓库相对路径） | 基线范围与符号 | LOC | 动作 |
| --- | --- | ---: | --- |
| `apps/workspace/web/src/space.tsx` | 287–291、571–586、625–671、782–873，阻塞文案、`CloudProject` 文件与确认区域 | 160 | 修改树与文件行 |
| `apps/workspace/web/src/space-api.ts` | 79–108、119–120、138–189、195–257，影响、删除、下载、预览与传输 | 141 | 核对 |
| `apps/workspace/web/e2e/upload-progress.spec.ts` | 23–154，`fixture` 的上传、回读、分块与完成 | 130 | 扩展同一 fixture |
| `apps/workspace/web/e2e/space-preview.spec.ts` | 247–348，项目删除影响与等待 | 102 | 参数化阻塞阶段 |
| `apps/workspace/api/space.ts` | 180–232、351–385、426–540、959–986，影响、删除、路径预占和文件路由 | 228 | 核对 |
| `apps/workspace/api/space-files.test.ts` | 664–875，`project deletion crosses both HTTP boundaries` | 212 | 扩展现有跨 HTTP 用例 |
| 合计 | 6 个代码文件 | 973 | |

## 步骤

### T0 · 复用基线与隔离环境

前置状态：`bento-a` 在指定基线，现有依赖已安装，默认 Playwright 使用 Chromium 及本地端口 4319/4320，测试进程无 MySQL、OIDC、S3 的远端配置。

允许修改：无。禁止修改：全部代码、分支和共享环境。

执行：回读 HEAD、状态及 #37/#42 差异；执行基线命令。

```bash
git status --short --branch
git rev-parse HEAD
node --import ./register-paths.mjs --test --test-name-pattern='preview signs|project deletion (space|crosses)' apps/workspace/api/space-files.test.ts
pnpm --filter @bento/web test:e2e space-preview.spec.ts upload-intake.spec.ts task.spec.ts --workers=1
```

PASS：作者已在基线以 Node.js 22.23.2、pnpm 12.15.0 运行，API 3/3、Chromium 15/15，通过且零跳过。开工核对获审草稿与基线一致。STOP：基线漂移、端口或浏览器不可用、继承远端配置或测试失败，报告实际证据。

### T4 · 回归与 Readiness

前置状态：文件树与目录传输已提交，Chromium 9/9 和 Web 类型检查通过；两种页面删除阻塞已提交，Chromium 4/4 通过；公开 HTTP 路径校验与同一 Run 删除门禁已提交，双 HTTP 用例 1/1 通过。MASTER 已核实 B 的公平派发 PR 合入 main。允许修改：`docs/40-readiness/CURRENT-READINESS.md` 和删除本文件。禁止修改：其他 Readiness 行、其他任务证据和产品代码。

执行：

1. 用 `git fetch origin main` 同步远端引用，再在 A 分支执行 `git rebase origin/main`。用 `git merge-base --is-ancestor origin/main HEAD` 确认已同步，核对 B 的证据与 T1–T3 产物均保留。同步失败、发生冲突或产物有差异时 STOP，交回 MASTER。
2. 在同步后的 HEAD 复验。

```bash
pnpm check:workspace
pnpm --filter @bento/web test:e2e --workers=1
```

3. 保留 WEB-03 已有 WEB-A02/A03 实栈证据和状态，在说明列添加 WEB-A05 本地验收事实，注明实际日期、执行基线、命令、结果、浏览器模拟数据面与临时 API 双 HTTP 环境。分别记录浏览器与双 HTTP 的实际覆盖。真实 S3 与外部执行环境的联合 WEB-A05 场景仍待验证。用 `pnpm exec prettier --write docs/40-readiness/CURRENT-READINESS.md` 格式化并核对只有目标说明列变化，删除本 RUNBOOK，再执行收口门禁。

```bash
pnpm lint
git diff --check
git diff --cached --check
rg -n --hidden --no-ignore 'RUNBOOK-WEB-A05' docs .agents AGENTS.md README.md
```

PASS：同步、两项复验及收口的 lint 和 diff 检查均退出 0，Chromium 无跳过，最后一条残留搜索必须退出 1 且 stdout、stderr 均无输出。STOP：B 尚未合入、同步或验证失败、存在未完成验收、残留搜索返回其他退出码或有输出时，保留测试证据和现场。收口门禁失败时恢复本 RUNBOOK 的 T4 内容后再报告。

## 环境边界

本计划交付上述本地分段证据。正式 WEB-A05 未明确豁免联合实栈验证，Readiness 保留该项。后续实栈验收前由 MASTER 核对 10.51 的独占账号、Web 与私有存储入口、只读对象检查器、可控 Run 暂停/终态入口和清理窗口。仓库中的 [实栈验收手册](../../deploy/README.md#空间上传实栈验收)给出变量与清理流程。当前仓库未提供 10.51 的已核实资源清单或独占窗口。
