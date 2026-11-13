# WEB-A05 目录上传与项目删除验收

状态：草稿，待 MASTER 独立审核。建立日期：2026-11-13（Asia/Shanghai）。工作区：`bento-a`。基线：`1197cc8229d0fd12c6ade37bb7c0de566108db8d`。审核通过并收到派工后使用 `codex/web-a05-space-lifecycle`。当前阶段只允许核对和起草。

## 执行者契约

按 T0、T1、T2、T3、T4 执行。每步只修改列出的文件和本 RUNBOOK，PASS 后按 WORKER 规则删去该步并独立提交。遇到实际契约或命令不符、门禁失败或需要扩大范围时 STOP，记录最后通过步骤、文件和符号、复现命令、脱敏输出和待决定项。保留失败现场。所有测试资源来自本地 Playwright mock 与独立临时目录。共享环境、生产对象存储、Keycloak、Temporal、执行调度、账本和部署配置均在范围外。B 的公平派发 PR 先合入，A 随后同步 main、复验并收口 Readiness。

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

### T1 · 保存文件树和目录传输

前置状态：T0 通过。允许修改：`apps/workspace/web/src/space.tsx`、`apps/workspace/web/e2e/upload-progress.spec.ts`。禁止修改：空间 API、传输实现、删除状态与执行入口。

执行：

1. 在 `space.tsx` 从现有类型导入补入 `ReactNode` 和 `Upload`，定义 `type SavedFileDirectory = { directories: Map<string, SavedFileDirectory>; files: Upload[] }` 和模块内 `function savedFileTree(uploads: Upload[]): SavedFileDirectory`。按上传数组顺序，仅对 saved 项以 `/` 切段，逐层在当前 Map 查找或创建目录，最后把原记录追加到当前目录的 files。根为空时省略树。
2. 在 `CloudProject` 内以 `renderSavedFiles(directory: SavedFileDirectory, label: string): ReactNode` 渲染 `ul` 并以 label 作 aria-label，根标签「已保存文件」，子列表标签为目录段。每目录用一个 li，显示该段和递归列表。目录先于同层文件，目录及文件组内维持原数组首次出现顺序。文件行以 ID 作 key；文件标签保留完整路径用于消歧和既有选择器，在标签外显示 `{file.size} 字节`。原选择、预览、下载、删除动作及禁用状态按 ID 原样接线。原列表只渲染非 saved 记录，保留完整路径、状态和取消按钮。保留原预览、确认区域和初始化按钮。
3. 在 `upload-progress.spec.ts` 的原 `fixture` 增加 `options.captureParts?: boolean`。开启时，保留 fixture 的 `partSize = 2`。签名请求的 `number` 和 PUT 路径中的分块号均须为整数且落在 `1..Math.ceil(file.size / 2)`，按上传 ID 与分块号保存 PUT 的 Buffer。7 字节文件必须包含 1、2、3、4 号，5 字节文件必须包含 1、2、3 号。complete 时逐号断言每块存在，再按分块号升序拼接，断言字节长度等于登记大小后将文件标为 saved。关闭 captureParts 时保留旧分支的分块断言。在 generic GET 前处理开启 captureParts 时匹配 `^/api/space/files/([^/]+)/(preview|download)$` 的 GET。以捕获的 ID 查找记录，要求该文件存在、属于当前 fixture 项目、状态为 saved 且已存完整 Buffer。断言失败即结束用例。preview 返回原 Buffer，download 返回同一 Buffer 并附 `Content-Disposition: attachment; filename="note.txt"`。保留现有 fixture 分支和测试语义。
4. 新增用例「上传目录后按层级查看并下载原文件」。用临时目录构造 `fixture/nested/note.txt`（UTF-8 内容 `你好\n`，7 字节）和 `fixture/root.txt`（`root\n`，5 字节），使用「文件夹」选择 `fixture`，确认上传，等待两个结果均为已保存。刷新后核对「已保存文件」→「fixture」→「nested」列表，nested 仅包含 note，root 文件属于 fixture 且在 nested 外，分别核对字节数。打开 note 预览并核对 pre 的完整文本。点击 note 下载并使用 Playwright 下载对象读取字节，精确比较原 Buffer。finally 删除临时目录。

验证：

```bash
pnpm --filter @bento/web test:e2e upload-progress.spec.ts upload-intake.spec.ts space-preview.spec.ts --workers=1
pnpm --filter @bento/web typecheck
```

PASS：9 个浏览器用例及类型检查通过，新增用例覆盖真实浏览器文件选择与 PUT、回读及附件消费。STOP：原预览、选择、删除或续传行为回归、目录用例无法通过或需要改传输契约时停在 T1。运行结束后本地临时文件清除。

### T2 · 浏览器显示活跃任务阻塞

前置状态：T1 通过。允许修改：`apps/workspace/web/e2e/space-preview.spec.ts`。禁止修改：生产逻辑与丢失回执用例。

执行：在原「项目删除显示影响、阻塞并等待完成」用例中，把布尔 blocked 改为 `'upload_pending' | 'project_busy' | undefined`，依次取这三个值。第一次打开时保持原未清理上传、计数及按钮禁用断言，另核对文件计数。取消后设置 project_busy，再打开，等待「项目仍有未结束的任务或文件清理。」出现，确认按钮禁用、下载仍可见且 deletes 仍为 0。再次取消并清除 blocker，沿用原删除、轮询、回执确认、旧空间链接和额度断言。

验证：

```bash
pnpm --filter @bento/web test:e2e space-preview.spec.ts --workers=1
```

PASS：4 个用例通过，两种阻塞均禁止提交，清除后走原删除链。STOP：阻塞文案、计数、请求数量或后续状态不符时停在 T2。浏览器上下文关闭后 fixture 状态丢弃。

### T3 · 公开 HTTP 路径校验与同一 Run 删除门禁

前置状态：T2 通过。允许修改：`apps/workspace/api/space-files.test.ts`。禁止修改：API 生产代码、调度和账本。

执行：

1. 扩展现有 `project deletion crosses both HTTP boundaries`。把原 localHost 存为 base，创建 `let releaseRun = () => {}; const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });` 门闩，在 host.worker 包装中仅对 `request.prompt === 'wait for deletion check'` 等待 `runGate`，再调用 base.worker。finally 先调用 `releaseRun()`，再沿用现有服务关闭及临时目录删除。将 seed 的第三个参数设为 `hold = false`。仅 A 使用 true，提交指定 prompt 后等待 GET Run 为 running 才返回；B 仍用原 prompt 并等待 succeeded。先执行 A 的阻塞检查，再释放和等终态，之后才 seed B。
2. A 的 saved 记录路径使用 `nested/README.md`，B 可使用同一路径。读取 A 的详情文件数组，校验原 ID、路径及实际 Buffer 长度。对 A 的 uploads 注册端点依次 POST 四个不同 UUID、`size: 0, checksums: []` 的输入，路径为 `nested/../escape.txt`、`nested/README.md`、`nested`、`nested/README.md/child.txt`。分别断言 `400 invalid_space_input` 和三次 `409 space_conflict`。用原 HTTP helper 检查 space 的 uploads 只有原 A 文件、saved 等于 A 文件长度、reserved 为零，证明拒绝后无登记和预占。
3. A 仍 running 时，读取影响并断言 `{fileCount:1,uploadCount:0,runCount:1,diffCount:0,blockers:['project_busy']}`。直接 DELETE 应为 `409 project_busy`；原空间详情及文件下载仍分别为 200、302，额度仍为原字节数。调用 `releaseRun()` 并沿用原 waitFor 等同一 Run succeeded。之后保留原影响断言、B 隔离、204 重复删除、对象不存在和 quota 断言。终态删除后另外核对旧影响、Run 详情和原文件预览均为 404。保留原 diff 和附件 HTTP 404 断言。

验证：

```bash
node --import ./register-paths.mjs --test --test-name-pattern='project deletion crosses both HTTP boundaries' apps/workspace/api/space-files.test.ts
```

PASS：目标用例通过，running 与 succeeded 对应同一 Run，未触发真实 worker 或对象存储，测试临时状态已清理。STOP：运行状态无法稳定复现、HTTP 拒绝码或额度不符时停在 T3。不得放宽断言或用 SQL 改 Run 状态。

### T4 · 回归与 Readiness

前置状态：T1–T3 全部 PASS，MASTER 已核实 B 的公平派发 PR 合入 main。允许修改：`docs/40-readiness/CURRENT-READINESS.md` 和删除本文件。禁止修改：其他 Readiness 行、其他任务证据和产品代码。

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
