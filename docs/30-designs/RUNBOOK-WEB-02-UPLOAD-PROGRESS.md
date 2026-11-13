# WEB-02 逐文件上传进度 RUNBOOK

2026-11-13 建立。状态为起草，等待 MASTER 独立审查。工作区为 `/Volumes/storage/workspace/bento-b`，执行基线为 `b55171adc8374437d07af0e164465a845f382a0a`。执行分支为 `codex/web-02-upload-progress`，由 MASTER 审查后单独授权开工。该临时路径受 Git 忽略规则约束。获审后单独暂存时对本路径使用 `git add -f -- docs/30-designs/RUNBOOK-WEB-02-UPLOAD-PROGRESS.md`。

## 执行者契约

按 T0 至 T4 顺序执行。每个实施步骤仅修改列出的文件，验证 PASS 后按 [WORKER Skill](../../.agents/skills/bento-runbook-worker/SKILL.md) 删除该步说明并同次提交。前置事实、正式契约、路径、命令或断言不成立时 STOP。报告最后通过步骤、提交、触发文件及 symbol、复现命令、实际结果和继续所需决定。保留现场及已有改动，禁止绕过验证、扩大范围或自行回滚。发布与合并遵循 [提交规则](../00-governance/COMMIT-RULES.md)及 [PR 规则](../00-governance/PR-RULES.md)，以 MASTER 当前授权为准。

## 目标与依据

[WEB-02](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)要求上传前清单、逐文件进度和批次中未完成项可继续。[WEB-DESIGN](./WEB-DESIGN.md#上传与续传)规定重选原文件复用上传身份，上传记录独立展示进度和失败原因。[WEB-INTERFACE](../20-interfaces/WEB-INTERFACE.md#现有接口)定义 `parts` 为对象存储已验证的分块编号，完成响应为 `saved`。[架构](../00-governance/ARCHITECTURE.md#外部依赖与数据归属)将上传状态和额度归个人端 API，浏览器直传私有对象存储。

当前 `apps/workspace/web/src/space.tsx` 的 `CloudProject` 用单个字符串显示活跃项，等 mutation 返回后才列结果。其 `planUpload` 已支持重选同路径同大小原文件并传入原上传 ID。当前 `apps/workspace/web/src/space-api.ts` 的 `transferFile` 在首个新 PUT 成功后才报告分块数，跳过已验证分块的续传无法立即看到起点。服务端 `apps/workspace/api/space.ts` 仅在 `uploading` 查询中返回已验证分块，`completing` 查询的空数组不代表零进度。该文件的 `finish` 在完成对象核对后才标为 `saved`。

本次链路为清单确认 → 按清单顺序创建行 → 本地校验、注册与续传回读 → 签名和存储 PUT → 完成回执 → 逐项结果 → 重选原文件恢复未完成项。沿用顺序处理、预检、刷新、空间文件及取消入口。排除新增重试按钮、目录拖放、活跃取消、并行上传改造、服务端修改、真实 S3 或真实认证联调。

## 本地结构与不变量

`space-api.ts` 导出以下浏览器内部回调值，所有字段均必填，无默认值。

```ts
export type TransferProgress =
    | { phase: 'checking' }
    | { phase: 'transferring'; confirmedParts: number; totalParts: number }
    | { phase: 'completing' };
```

`transferFile(project: string, id: string, file: File, filename: string, partSize: number, notify: (progress: TransferProgress) => void): Promise<void>` 同步通知本地阶段。计数为查询返回的已验证编号与本次成功 PUT 编号的去重并集大小。总数为摘要清单长度。计数表示分块已获存储响应或已回读验证，文件可用性由 `saved` 回执和原文件查询决定。校验及确认阶段本身不生成计数，空文件不显示 0 / 0。

`space.tsx` 在 `UploadItem` 旁声明以下类型。

```ts
type UploadRow = {
    path: string;
    status: string;
    parts?: { confirmedParts: number; totalParts: number };
};
```

`CloudProject` 持有 `uploadRows: UploadRow[]`，初值为空。路径取自已通过清单校验的唯一相对路径。首次确认和每次后续确认都以当次可提交项、按原顺序整体替换行列表，状态为「等待上传」，`parts` 缺省。选择或放弃选择时保留上一批结果。每行只由当前批次负责该路径的循环分支更新，完成、失败或跳过后保留至下一次确认或离开当前账号/项目组件。刷新页面与登出后通过既有空间记录及重选原文件入口恢复。行数据不写入缓存、存储或 API；既有 `sessionStorage` 的账号、项目、路径、大小键与上传 ID 复用规则继续生效。只有当前确认收到 `saved` 后才清除缓存 ID。账号鉴权边界继续由现有会话逻辑处理，组件卸载时释放行数据。

API DTO、权限、幂等、请求哈希、后端状态、事件、数据库、配额、清理、部署、发布配置和同部署重启契约均沿用原实现。新增本地结构不参与服务端投影。合并前检查 Readiness；当前文档未将逐文件进度列为已验证。

### T0 起草基线与执行前复核

前置状态为起草时工作区干净，执行时 MASTER 已确认独立审查通过的草稿与分支，并确认 #31 WEB-A04 已合入及端口窗口。允许修改为无。禁止修改主线。本任务独用固定 4319/4320，额度任务使用动态端口。T0 专门核对 8 个文件，分别为本 RUNBOOK、`WEB-REQUIREMENTS.md`、`WEB-INTERFACE.md`、`WEB-DESIGN.md`、`CURRENT-READINESS.md`、`space.tsx`、`space-api.ts` 和 `playwright.config.ts`。

2026-11-13 初查基线为 `48ff053357902e0d5a4e1b5059ef43eb4ade7ccc`。#31 WEB-A04 合入后以快进同步至执行基线。本地 HEAD、`origin/main` 与 GitHub `thundax-lyp/bento` main 一致。基线差异仅为 `apps/workspace/api/space-files.test.ts` 与 Readiness；需求、设计、HTTP 契约、生产路径和 Chromium 配置无变化。T4 以合入后的 WEB-02 行为起点，保留 WEB-A04 的本地 HTTP、SQLite 和 S3 adapter fixture 证据。Node v22.23.2、pnpm 12.15.0 下，执行基线的 `pnpm check` 退出 0，Chromium 全量 9 项通过、无跳过，用时 15.7 秒。

执行时在仓库根核对状态、提交和 GitHub main。MASTER 若批准基线前移，先对比下列文件与执行基线的差异。针对变化复审直接受影响步骤及 Readiness 合并顺序，由 MASTER 记录实际执行基线。启动 Chromium 前运行 `lsof -nP -iTCP:4319 -iTCP:4320 -sTCP:LISTEN`，无监听、退出 1 才可使用。不得终止其他任务进程。

```bash
git status --short --branch
git rev-parse HEAD origin/main
git ls-remote origin refs/heads/main
git diff --name-only b55171adc8374437d07af0e164465a845f382a0a origin/main
pnpm check
```

PASS 为基线已核对，工作区无未授权改动，执行分支在获审基线之上且只包含单独提交的获审 RUNBOOK，`pnpm check` 通过，MASTER 确认 #31 与浏览器窗口。STOP 为主线漂移影响本任务但未复审、环境检查失败、端口占用或缺少审核证据。浏览器基线在窗口内以 `pnpm --filter @bento/web test:e2e` 验证，现有 Chromium 用例全过且无跳过才开始 T1。

各步骤涉及文件数含本 RUNBOOK。T0 专门核对 8 个文件，T1 修改 4 个，T2 修改 2 个，T3 修改或新增 3 个，T4 修改或删除 3 个。T3 专门核对既有 `playwright.config.ts` 与 `upload-intake.spec.ts`，含这两项共涉及 5 个文件。

### T1 传输阶段与确认分块

前置状态为 T0 PASS。允许修改 `apps/workspace/web/src/space-api.ts`、`apps/workspace/web/src/space-api.test.ts`、`apps/workspace/web/src/space.tsx` 和本 RUNBOOK。禁止修改 HTTP 请求序列、分块并行度、文件选择或批次生命周期。

1. 使用上述类型修改 `transferFile`。哈希前发 `checking`。注册及状态查询的 `saved` 直接返回。GET 为 `completing` 时忽略该查询的分块数组，只调用并返回 `complete()`。其他路径沿用 `new Set(status.parts)` 与原分块循环。当摘要清单非空时，创建 Set 后、进入分块循环之前发一次 `transferring`。只在 PUT 的 `response.ok` 后更新 Set 并再次通知。循环结束只调用并返回 `complete()`。两条路径共用函数内 `async function complete(): Promise<void>`，仅此函数发送一次 `completing`，随后执行原 POST，返回状态不是 `saved` 时抛出 `new Error('暂未确认上传结果，请重选原文件核对。')`。
2. 暂时在 `CloudProject` 现有回调内把三种事件转成原单行字符串。使用「正在校验文件…」「已确认 X / Y 块」「正在确认上传结果…」及现有路径前缀。T2 直接接管这处回调。
3. 在 `space-api.test.ts` 现有两块续传测试断言事件依次为 `checking`、`transferring 1/2`、`transferring 2/2`、`completing`，签名 mock 入口断言已经收到 `1/2`，保留原请求断言。新增参数化用例分别断言注册直接 `saved`、查询直接 `saved`、查询 `completing`、空文件、非 `saved` 完成响应及 PUT 失败。两个直接保存分支仅有 `checking`，请求分别为注册及注册加查询。确认中与空文件只发 `checking`、`completing` 且不签名。非 `saved` 完成响应拒绝。PUT 失败只发 `checking`、初始 `0/1`，不发完成请求。

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test src/space-api.test.ts
git diff --check
```

PASS 为所有命令退出 0，目标文件的断言全过且无跳过。STOP 为接口无法按现有回执区分成功，或命令/断言失败。保留本步改动，无服务端状态需回滚。

### T2 批次行与逐项结论

前置状态为结构化传输事件已通过单测。允许修改 `apps/workspace/web/src/space.tsx` 和本 RUNBOOK。禁止修改服务端文件列表、现有选择规则、账户鉴权及恢复入口。

1. 使用上述 `UploadRow` 与 `uploadRows` 替换 `progress`。在 `send` 的原 guard 后、调用 mutation 前初始化行。定义组件内 `updateUploadRow(path: string, status: string, parts?: UploadRow['parts']): void`，用函数式 setter 按路径 map。传入分块时覆盖计数，缺省时保留此前计数。
2. 移除 mutation 的临时 results 和返回值。当前项进入 ID 查找前写「正在准备上传…」。在传输回调把 `checking` 映射到「正在校验文件…」，`transferring` 映射到「上传中」及对应计数，`completing` 映射到「正在确认上传结果…」。传输成功后立即写「已保存」，再做现有缓存清理。
3. 401 判定使用现有 `ApiError`。缓存 ID 的探测 GET 遇到 401 时抛回本项 catch，其他探测失败仍返回 undefined。当前项 401 写「登录已过期，请重新登录。」，余项写「未开始，请重新登录后重选文件。」并沿用短路。非 401 写「本次上传未确认：」加现有 `message(error)`，继续处理后续项。保留 `onSuccess` 清除选择、`onSettled` 刷新及现有全局异常 Notice。真正失去页面访问权时沿用会话层路由，禁止跨登录恢复本地展示。
4. 在原进度与结果处渲染唯一的 `ul`，`aria-label="上传结果"`，`aria-live="polite"`。行使用 `li key={path}`，显示「路径 · 状态」，当 `parts` 存在时追加「 · 已确认 X / Y 块」。列表从确认时可见，直到下一批或组件卸载。原清单和原已保存文件区域继续使用原入口与数据。

```bash
pnpm --filter @bento/web check
git diff --check
```

PASS 为类型、lint、格式、单测、构建均退出 0，无测试跳过，页面保留既有「文件名 · 已保存」文本供原 Chromium 用例定位。STOP 为需要调整鉴权路由、重写恢复入口或检查失败。保留本步现场，无服务端状态需回滚。

### T3 Chromium 分批与恢复验收

前置状态为逐文件列表和原上传入口通过 Web 检查，MASTER 分配 4319/4320 窗口。允许新增 `apps/workspace/web/e2e/upload-progress.spec.ts` 并修改根目录 `public-files.json` 与本 RUNBOOK。禁止修改既有测试、端口、生产文件及真实环境。采用既有 Playwright 配置和同源 route fixture。各测试拥有独立上下文，禁止固定睡眠。用测试文件内的 `function gate(): { wait: Promise<void>; release: () => void }` 构造门闩，先以空函数初始化 `release`，再用 `new Promise<void>` 的同步 executor 将其赋为 resolve。分别挂起指定 PUT 或完成回执，在断言后释放，`finally` 也释放全部门闩。

1. 定义测试「批次逐项显示已确认分块和续传结果」。使用 `partSize: 2`、额度和文件上限各 100 字节、空执行状态、同一项目、有效模拟会话。依次选择 `first.txt`（2 字节）、`resume.txt`（4 字节）、`last.txt`（2 字节）。初始空间有同路径同大小的 `resume.txt` 原 `uploading` 记录。确认前断言无写请求。挂起首项 PUT，断言首项 0/1，后两项等待。放行 PUT 并挂起首项完成，断言首项确认中且保留 1/1。放行首项完成。第二项注册必须复用原 ID，状态查询返回 `parts: [1]`，挂起第 2 块 PUT。断言首项已保存、第二项 1/2、第三项等待，且第二项唯一签名编号为 2。第 2 块 PUT 返回 500，断言第二项保留 1/2 且本次未确认，并且从未请求其完成。第三项走成功请求，断言三行按清单顺序保留，首尾已保存。模拟刷新后的空间列表返回首尾 `saved` 和第二项原 `uploading`。仅重选第二项，断言清单为「待校验续传」，确认后仅注册原 ID、查询、签第 2 块、PUT、完成，行列表替换为第二项且最终显示已保存。
2. 定义测试「上传鉴权失效后保留当前批次逐项结论」。选择 `first.txt`、`expired.txt`、`skipped.txt`，均为 2 字节，开始时空间为空。首项成功。第二项在 API 分块签名返回 401，后续空间及 session GET 维持 fixture 可读，以观测重新登录提示直到页面仍可访问。断言第一项已保存，第二项保留 0/1 并提示登录过期，第三项明确未开始。断言仅注册前两项，第二项无 PUT 及完成请求，第三项无写请求。PUT 使用同源 fixture URL，签名和状态响应只使用测试数据。
3. 定义测试「缓存上传探测鉴权失效后停止批次」。以空 `config.uploads` 和可读的空间、项目、会话 GET 开始。通过 `page.addInitScript` 在 sessionStorage 以 `JSON.stringify(['bento:upload', account, project.id, 'cached.txt', 2])` 为键写入固定上传 ID `cached-upload`。按顺序选择两个 2 字节文件 `cached.txt`、`skipped.txt` 并确认。仅 `GET /api/space/uploads/cached-upload` 返回 401。断言缓存探测 GET 恰好一次，当前行显示「登录已过期，请重新登录。」，后续行显示「未开始，请重新登录后重选文件。」。断言批次无注册、签名、PUT 或完成请求。
4. 所有行断言限定在 `getByRole('list', { name: '上传结果' })`。对等待、确认中、失败、鉴权和完成均断言同一列表内的对应路径与状态。首个测试的完成回执释放前断言首项对应行无「已保存」。
5. 在 `public-files.json` 将 `"apps/workspace/web/e2e/upload-progress.spec.ts"` 紧接既有 `upload-intake.spec.ts` 条目加入同一数组，保留其余条目。

```bash
pnpm --filter @bento/web test:e2e upload-progress.spec.ts --workers=1
rg -n -F '"apps/workspace/web/e2e/upload-progress.spec.ts"' public-files.json
git diff --check
```

PASS 为三个新 Chromium 用例执行且通过，无重试或跳过，发布清单查询恰好匹配一行。STOP 为 mock 与现有协议冲突、需要改生产代码或断言失败。只清理本测试上下文和 Playwright 启动的本次进程。无真实对象需回滚。

### T4 完整验证与收口

前置状态为三个新 Chromium 用例通过，端口窗口仍有效。允许修改 `docs/30-designs/WEB-DESIGN.md` 的「上传与续传」、`docs/40-readiness/CURRENT-READINESS.md` 的 WEB-02 行及删除本 RUNBOOK。禁止修改正式需求、HTTP 契约、其他 Readiness 行和生产代码。

1. 在设计的「上传与续传」补充本地批次行的生命周期、计数来源、确认阶段及重选原文件。保持原设计其他上传行为。
2. 在 WEB-02 行保留已有清单与恢复覆盖及未覆盖项，追加实际日期、执行基线、T3 PASS 提交、测试命令及通过数量。明确真实对象存储、真实会话失效后重新登录、目录拖放和活跃取消未覆盖。保留 WEB-02「部分实现」。
3. 检查上述文档中的新增相对链接，删除本 RUNBOOK。检查引用并执行完整验证。最终提交同时包含设计、Readiness 和 RUNBOOK 删除。Readiness 表格的纯列对齐空白随 Prettier 更新，其他行的内容沿用合入后的主线。回读最终提交的文件清单及其父提交。PR 记录实际证据与 #31 合入顺序。

```bash
git diff --check
rg -n 'RUNBOOK-WEB-02-UPLOAD-PROGRESS' --glob '*.md' .
pnpm check
pnpm --filter @bento/web test:e2e
```

PASS 为链接目标存在、`rg` 无匹配并退出 1、其余命令退出 0。完整 Chromium 包含既有上传清单、三个新增用例和其余回归，共 12 项，全部通过且无跳过。STOP 为文档引用缺失、共享文件冲突、证据记录与实际不同或完整检查失败。保留当前工作树，禁止提交收口；从本步重新验证。没有外部运行状态需回滚。

## 验证矩阵

| 范围                                           | 固定步骤与证据                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| 续传、空文件、确认中、已保存快速返回、PUT 失败 | T1 单测验证通知时点、分块和完成回执                                            |
| 多文件等待、传输、确认与逐项留存               | T3 首个 Chromium 用例验证各阶段快照和请求顺序                                  |
| 错误后继续后项、原 ID 续传、鉴权停止后续项     | T3 三个 Chromium 用例验证请求与各行结论，签名和缓存探测 401 分别断言           |
| 原有清单、构建及回归                           | T0 基线与 T4 的完整 Web Chromium、仓库 `pnpm check`                            |
| 后端权限、事务、持久化及真实 S3                | 本次仅变更浏览器本地投影，沿用原契约；真实运行与服务器恢复专项验收不在本次范围 |

完成证据归入 [Readiness](../40-readiness/CURRENT-READINESS.md)，规则见 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)。
