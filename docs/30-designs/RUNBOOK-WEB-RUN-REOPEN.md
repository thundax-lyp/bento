# Web 单轮任务找回与交付恢复 RUNBOOK

## 状态与执行者契约

2026-11-13，待 MASTER 安排独立审核。绑定 checkout `/Volumes/storage/workspace/bento-a`，调查基线 `1803ad643fde18a470ae6d08cb4d891b94e285c2`。当前阶段只交付草稿。任务分支名由 MASTER 在审核后派发。草稿路径受仓库 ignore 规则约束，获准开工后单独提交时用 `git add -f -- docs/30-designs/RUNBOOK-WEB-RUN-REOPEN.md`。T0 由作者完成，WORKER 获准后按 T1–T4 顺序执行。每步通过后按 [WORKER Skill](../../.agents/skills/bento-runbook-worker/SKILL.md) 移除该步并提交，最后一步删除本文件。B 独占 10.51 的隔离回滚。本任务仅使用本地 fixture。共享 Readiness 时 B 先合入，本任务随后在 B 已合入的基线上复验并更新对应两行。

PASS 须同时满足命令退出码 0、相关用例实际运行和列出的断言。STOP 时保留现场，向 MASTER 报告最后通过的步骤和提交、文件与符号、最小复现、脱敏实际输出和继续所需决定。临时浏览器上下文和 fixture 随测试结束关闭，Playwright 管理本地子进程。本任务没有需要回滚的持久状态。若端口被占用或 Chromium 不可用，停止并报告，不复用外部服务。

## 目标与证据

从工作台的独立「任务」入口选中执行项目，用状态和关键字找到已受理的 Run，进入稳定地址读取原要求、最新状态、摘要及当前 Run 的可交付补丁。临时读取失败可在原地址恢复。重新登录可由同一入口查找原账号记录。

- [WEB 需求](../10-requirements/WEB-REQUIREMENTS.md)「页面与入口」要求任务按项目和状态筛选、搜索并显示摘要和更新时间。现有 `apps/workspace/web/src/pages.tsx::Composer` 的「最近任务」跟随提交草稿所选项目，缺独立入口、状态过滤、关键词和时间。保留该快捷入口。独立完成「任务」入口在当前单轮模型下的可验收行为。
- WEB-06、WEB-A08、WEB-A11、WEB-A13 的原 Run 找回和状态回读。已有 `apps/workspace/web/e2e/task.spec.ts` 的刷新、越权、待核对转成功和取消回读，基线 4 个通过。作者用临时 Playwright route 探针复现：首次详情持续返回 503 时 `apps/workspace/web/src/main.tsx` 的详情 loader 落入通用路由错误页，无重试控件。随后让同一详情成功、diff 首次返回 409，保持页面并让服务端变为 200，3.5 秒内请求仍为一次且无下载。探针已清理。另用原 demo/guest 注册与导入流程验证 T3 的关闭时序，独立启动 8 次本地 Chromium 与 mock，8 次均捕获相同 Run 关闭前后为活跃且关闭期间成功。该探针仅覆盖关闭窗口，已清理。
- WEB-06、WEB-08、WEB-A08、WEB-A13 的单轮结果交付。现有 `apps/workspace/web/src/pages.tsx::RunDetails` 已使用同一地址读取和下载，`apps/workspace/web/src/ui.tsx::DiffPreview` 已支持逐文件、原文降级和空补丁。详情和补丁错误缺显式恢复入口，现有下载和预览仅凭缓存存在性渲染。继续使用 `apps/workspace/web/src/file-diff.ts::splitFileDiff` 的完整解析和原文降级。该文件无需改动。
- [Web 接口](../20-interfaces/WEB-INTERFACE.md#任务与补丁--现有) 固定现有路径、内容类型及 401、404、409 语义。[Web 设计](WEB-DESIGN.md#提交与交付) 指定原地址、单轮基线、轮询、公开摘要与待核对行为。[整体架构](../00-governance/ARCHITECTURE.md) 固定执行状态归 Orchestrator，浏览器只读投影。

## 契约与不变量

- 只读请求依序使用 `GET /api/session` 的 `{account:string}`、`GET /api/projects` 的 `{projects:Project[]}`、所选执行项目的 `GET /api/projects/{projectId}/runs` 的 `{runs:Run[]}`、原 Run 的 `GET /api/projects/{projectId}/runs/{runId}` 和同路径追加 `/diff`。下载追加 `?download=1`。服务端负责 owner 校验和所有 ID、状态、时间与补丁；客户端从项目列表和各 Run 详情消费数据。禁止从本地缓存重建授权，禁止在恢复链路 POST。
- `Project` 的 `id,name,createdAt` 为必需 string，`status` 为 `importing|ready|failed`。`Run` 的 `id,projectId,sessionId,createdAt,updatedAt` 为必需 string，`status` 沿用现有八值，`summary?:string`，详情另有 `prompt?:string`。更新 Web 类型时补齐这些正式必需字段，不给运行时缺字段合成值。摘要、要求、检查数据不存在时不推断。项目与 Run 查询 key 沿用账号、项目和 Run 隔离。运行状态和结果使用服务端原值。
- 工作台任务页读取所选项目列表，切换项目时不显示上一项目缓存。详情路径继续为 `runUrl(projectId,runId)`，路由缺参数仍为 404。详情 401 走既有会话失效流程；404 与越权同样隐藏历史数据和动作。临时读取错误可显示最后确认的详情。取消和交付只使用当前账号、项目、Run 的查询快照，并要求 `run.isSuccess && run.fetchStatus === 'idle' && online`；后台回读中的成功缓存也冻结入口。待核对固定显示「上一次操作结果未确认」，保留服务端摘要，不读取 diff。取消 POST 和写入缓存的现有机制保持。
- 补丁仅在详情满足上述门控且状态为 `succeeded` 时读取。HTTP 200 文本原样预览，空串同样允许下载。409 表示成果尚未发布，允许主动重新读取；网络错误及 5xx 同样允许重新读取。401 和 404 隐藏交付入口。重读期间收起补丁和下载，失败时也收起。只支持当前后端提供的单轮补丁。首轮可验证相对初始文本快照应用，不把第二次独立提交或 fixture 叫作续聊。
- 不涉及 Schema、错误码、接口扩展、幂等键、事务、持久化、日志事件、worker、Temporal、部署变更或旧数据迁移。服务重启后的权威恢复由现有服务承担。浏览器可以重新读取，页面测试不证明服务端重启恢复。

## 逐文件预计范围

按语义改动估计约 535–650 行，含端到端测试，不含文档。审计以实际有效改动为准。

| 文件 | 符号和职责 | 预计代码行 |
| --- | --- | --- |
| `apps/workspace/web/src/pages.tsx` | `Workbench` 导航，新增 `TaskList`，`RunDetails` 与读取状态联动 | 165–195 |
| `apps/workspace/web/src/main.tsx` | 注册任务路由，详情去掉阻断详情挂载的预取，保留参数校验 | 15–25 |
| `apps/workspace/web/src/api.ts` | 补齐 DTO，详情和列表恢复配置，区分读错误 | 25–35 |
| `apps/workspace/web/src/ui.tsx` | 新增 `ReadFailure`、`RunResult`，统一交付门控和可重试状态 | 75–95 |
| `apps/workspace/web/e2e/task.spec.ts` | 分项目找回、两浏览器重连、补丁字节及应用验证、失败与权限回归 | 255–300 |

### T0：确认基线、已知失败与独占资源

前置状态：调查 checkout 位于派工指定 SHA，起始工作树干净。

允许修改：仅本草稿。禁止修改：生产文件、fixture、分支、远端；基线探针为调查临时文件，已移除。

执行：

1. 核对 Node、pnpm、Chromium 及本地默认 fixture。由 Playwright 启动环回的 Web 4320、mock API 4319，固定使用 Chromium。
2. 读回基线 `task.spec.ts`、`RunDetails`、详情 loader 和 `diffQuery`，核对上文探针的请求边界及与生产路径的一致性。执行阶段开始前由 MASTER 确认独立审核结论、草稿提交、B 的 Readiness 合入顺序及 10.51 边界。

验证：

```bash
git rev-parse HEAD
git status --short --branch
pnpm --filter @bento/web check
pnpm --filter @bento/web test:e2e task.spec.ts
```

PASS：作者已核对上述 SHA，基线 Web check 通过（11 个单测），Chromium 4 个任务用例通过，临时探针的两个失败表现均出现。进入执行时工作树干净，草稿已审核且提交，MASTER 确认并行边界。若 B 已合入，T0 命令在新执行基线重跑并核对 Web 入口无变化。

STOP：基线、checkout、审核版本、固定端口、命令结果或共享边界不符，报告具体差异和失败输出。

### T2：在原详情恢复状态读取

前置状态：`/runs` 独立任务入口已提交且「任务列表找回」用例通过。允许修改：`apps/workspace/web/src/main.tsx`、`apps/workspace/web/src/api.ts`、`apps/workspace/web/src/pages.tsx`、`apps/workspace/web/src/ui.tsx`、`apps/workspace/web/e2e/task.spec.ts`、本文件。禁止修改：认证回调、取消接口、文件解析及补丁格式。

执行：

1. 详情 loader 先走既有 `requireSession`，检查 `project` 和 `params.runId`，返回原 `{project,run}`，移除 loader 中的 Run 请求。由 `RunDetails` 中既有 `useQuery(runQuery(account,project,runId))` 负责读取。给 `runQuery` 和 `diffQuery` 设 `staleTime: 0`、`refetchOnReconnect: 'always'`。保留 1500 ms 活跃轮询，收到 401 或 404 后停轮询。无缓存的失败可主动重读或等网络重连。
2. `api.ts` 增加 `isUnavailableRun(error: unknown): boolean`，仅判断 `ApiError` 的 401 或 404。详情 404 渲染标题「找不到这个页面或任务。」和到 `/runs` 的「返回任务」链接，隐藏之前的详情与操作。详情 401 隐藏数据并让现有 QueryCache / Workbench 重新验证会话。
3. `ui.tsx` 增加 `ReadFailure({message,label,pending,onRetry}: {message:string;label:string;pending:boolean;onRetry:()=>void})`，组合 `Notice` 与重试 Button。详情非 401/404 的读错误保留最后确认的原要求和摘要，显示「暂时无法读取任务状态。」及「重新读取任务」，按钮 refetch，正在 fetch 时禁用。用 React `useSyncExternalStore` 订阅 TanStack Query 的 `onlineManager`（订阅函数调用 `onlineManager.subscribe`，snapshot 返回 `onlineManager.isOnline()`）。在当前 `runQuery(account, project, runId)` 的 observer 上计算 `const detailReady = run.isSuccess && run.fetchStatus === 'idle' && online`。只有 `detailReady` 且状态是 `queued` 或 `running` 时显示对应取消按钮；只有 `detailReady` 且状态是 `succeeded` 时启用 diff 请求。预览和下载还须满足当前 diff observer 的 `diff.isSuccess && diff.fetchStatus === 'idle'`。取消成功写入缓存不改变此门控。离线或暂停时显示「连接中断，正在等待重新连接。」。首次等待显示「正在读取任务…」。保留 task record 的单份快照渲染，待核对时另显示「上一次操作结果未确认」。详情 observer 保持按当前 key 查询，禁用跨 key 的占位数据。现有取消 mutation 及精确 query key 仍保留。
4. 增加标题含「原详情恢复」的用例。cold 503 后重读同一 URL 恢复，验证按钮、原 prompt、恢复中状态和无 diff 请求。另用 `browser.newContext()` 建立两个独立 context，两个 context 均显式传入 Playwright fixture 的 `baseURL`，以现有 route fixture 返回同账号和同 Run，首个 context `setOffline(true)` 保留已确认 prompt，另一个读到进展；模拟服务端改为 `needs_review` 后恢复第一个 context，两个页面各只有一条原 prompt 和一份待核对提示，皆无补丁请求、下载、提交。fixture 给被切断的一侧以真实网络失败，避免 route fulfill 绕过断线；可观测的失败由 `route.abort('internetdisconnected')` 配合 `setOffline` 固定。随后将同一 Run 详情 fixture 切换为 404，等待活跃详情下一次轮询，断言旧 prompt、摘要和操作都不可见。
5. 新增标题含「原详情恢复」的同一 SPA 缓存重访回归。用可手动释放的 route gate 控制同一 Run 的详情 GET。先访问成功 Run 并确认预览和下载，记下 diff 请求数。通过「任务」导航离开，再用任务列表链接重访，等待详情 GET 进入 gate。挂起期间断言详情路由已打开、无 diff 请求增量、无预览和下载。释放为 404 后确认找不到、无预览和下载、diff 请求计数不变。再用任务列表重访同一 URL，保持 GET 挂起并重复门控断言；释放为 200 后才可看到预览和下载。再对一个缓存为 `running` 的 Run 做同一 SPA 重访：挂起期间「请求停止」不可见，释放为 200 且仍为 running 后可见。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test:e2e task.spec.ts -g '原详情恢复|任务详情回读取消状态|登录、导入文本'
```

PASS：首次失败和断线均能回到原地址的同一 Run，重复回读不增加渲染条目；同一 SPA 内已缓存的成功详情在 GET 挂起或返回 404 时都无交付，成功回读后才开放；已缓存的运行状态在 GET 挂起时无取消操作；现有取消和原账号隔离用例保持通过。STOP：重连后无法从相同 key 读回、已有取消失效或授权内容泄露，报告请求方法、路径及脱敏状态。

### T3：单轮补丁读取、恢复和字节验证

前置状态：T2 通过。允许修改：`apps/workspace/web/src/ui.tsx`、`apps/workspace/web/src/api.ts`、`apps/workspace/web/src/pages.tsx`、`apps/workspace/web/e2e/task.spec.ts`、本文件。禁止修改：`splitFileDiff`、服务端、下载契约。

执行：

1. 保留 T2 的 `diffQuery` 重读配置和现有响应 text、AbortSignal 消费。保留全局有限网络/5xx 自动重试。409 不开启后台轮询，由用户主动重新读取，或浏览器重连后回读。保持 `downloadUrl` 的同源 GET。
2. 从 `RunDetails` 提取 `RunResult({account,project,runId}: {account:string;project:string;runId:string})` 到 `ui.tsx`。父组件仅在 T2 的 `detailReady` 成立且 status 为 `succeeded` 时挂载，key 使用 `JSON.stringify([account,project,runId])`。其他状态下文件变更区显示「当前没有可审阅的补丁。」。结果组件查询 `diffQuery`；初次读取或重新读取时显示「正在读取变更…」。409 显示「结果尚未可用。」及「重新读取补丁」。网络错误或 5xx 显示「暂时无法读取补丁。」及同一重试控件。401/404 隐藏内容并显示「当前没有可审阅的补丁。」；其他 4xx 显示公开错误文本和同一重试控件。仅当当前 diff query 的 `isSuccess && fetchStatus === 'idle'` 成立才显示预览和下载。成功且空串时渲染 `DiffPreview` 已有空状态和下载链接；非空时沿用逐文件和完整补丁交互。下载放在文件变更区紧接标题下，链接名继续为「下载 diff」。
3. 增加标题含「单轮交付恢复」的用例。用同一 Run fixture 先返回 409，确认无 diff 内容或下载。切换为已发布补丁并点击「重新读取补丁」，验证新增、修改、删除三类文件的按钮及点击后仅显示所选补丁块，切回「完整补丁」恢复完整文本。下载响应同时由相同 fixture bytes 提供并附附件头，断言收到的 download 文件字节与 preview 原文响应字节严格相同。第二个独立 Run 返回零字节和只读结论，核对可下载零字节，且不显示上一 Run 的路径或原要求。两个 Run fixture 都使用既有协议，不构造续聊或检查结果。
4. 扩展现有「登录、导入文本、提交任务、刷新找回并下载修改」用例，将标题更新为「登录、导入文本、提交任务、关闭后找回并下载修改」。沿用该用例的 demo、guest 预置账号和现有注册、登录、Workspace 导入步骤。在提交前为页面安装 `/\/api\/projects\/[^/]+\/runs\/[^/?]+$/` 的一次性详情拦截，并用 `page.waitForResponse` 监听 Run 创建 POST，在该 promise 的 `.then` 中立即解析并保存响应状态和 JSON（关页后不能再读该响应 body）。在 route 回调中调用 `route.fetch()` 读取真实 mock 详情，检查 200 并读出 `{id,projectId,status}` 及原请求 URL，通过下列 `firstDetail` promise 同步交给测试主体，成功时调用 `resolveFirstDetail`，失败时调用 `rejectFirstDetail`，最后 abort 原详情请求。点击「发送任务」后直接等待 `firstDetail` 并立即 `await page.close()`，两者之间不等待 URL、状态文本、详情渲染或 POST JSON。关闭后断言首次 GET 返回 queued 或 running，核对创建 POST 返回 202 及相同的 Run ID 和项目 ID。用原 context 的 `request.get` 回读同一详情 URL，断言首个关页后响应仍为 queued 或 running；再用 `expect.poll` 重读，每次确认原页已关闭、HTTP 200、响应属于同一 Run，直到 succeeded。新页面从工作台「任务」找回相同 URL 和原要求。预览并下载同一补丁，把下载文件应用到临时目录内原始 README，通过 `execFileSync('git', ['apply', '--check', patchPath], {cwd: scratch})` 和 `execFileSync('git', ['apply', patchPath], {cwd: scratch})`，确认 README 严格等于 `# 手册\nBento 模拟任务已完成。\n`。临时目录用 `finally` 清理。保留后半段原地址刷新和 guest 越权断言，使用新页面及稳定原 Run URL。fixture 的实际推进只证明本机 mock，不作为真实模型或 OpenShell 验收。


   在注册详情 route 之前声明：

   ```ts
   type FirstDetail = Pick<Run, 'id' | 'projectId' | 'status'> & { url: string };
   let resolveFirstDetail!: (detail: FirstDetail) => void;
   let rejectFirstDetail!: (reason: unknown) => void;
   const firstDetail = new Promise<FirstDetail>((resolve, reject) => {
       resolveFirstDetail = resolve;
       rejectFirstDetail = reject;
   });
   ```

   在测试文件中用 `import type { Run } from '../src/api.ts'` 引用现有类型。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test:e2e task.spec.ts -g '单轮交付恢复|关闭后找回|可信核对结束'
for iteration in 1 2 3 4 5 6 7 8; do
    pnpm --filter @bento/web test:e2e task.spec.ts -g '关闭后找回' --workers=1 || exit 1
done
```

PASS：三个场景实际运行。关闭后找回定向重复 8 次均通过，每次独立启动 mock，恢复预置账号的初始状态。满足读错误、逐文件、原文字节、空补丁、关闭前后均活跃及关闭期间到终态断言。STOP：补丁下载或应用结果不一致、关闭时无活跃证据或 409/401/404 仍暴露缓存补丁。记录错误和脱敏的测试输出，禁止延长 fixture 进程时序或模拟缺失的后端能力。

### T4：完整本地验证、同步设计与 Readiness

前置状态：T3 通过，B 已先合入共享 Readiness；若期间基线推进，按 MASTER 派发同步并在同步后执行本步。允许修改：`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`、本文件。禁止修改：接口与需求、B 的证据、部署和白名单。

执行：

1. 更新 WEB-DESIGN 的路由树、「组件功能说明」和「提交与交付」，记录独立任务列表、失败回读、状态及补丁门控、现有单轮基线和待覆盖范围。说明搜索范围为 Run id 与摘要。
2. 完整 Web 验证覆盖 typecheck/lint/format、单测、构建、Chromium 的任务和其他 Web 用例。仅 Web 消费行为变化，API 契约、执行层和部署未变，本地完整验证采用 Web 套件。CI 仍走仓库标准门禁。
3. 按实际执行日期、基线/代码提交、命令和通过结果更新 WEB-06、WEB-08 两行，保留「部分实现」。WEB-06 增记独立任务查找、原 Run 恢复、待核对隐藏补丁和可重读的空/非空交付。WEB-08 增记单轮逐文件、原补丁与下载一致、应用到 fixture 初始快照和空补丁交付。逐项记录：
   - WEB-A08 仅验证本地单账号、原 Run 在关闭期间推进及补丁可应用。远端同环境三个账号、真实模型/OpenShell、真实大文件保存下载及不支持输入的组合验收仍待验证。
   - WEB-A11 仅验证两个浏览器对同一 Run 的状态、原要求和现有摘要快照回读。执行事件、检查去重、追加要求产生独立 Run、原 Session/Workspace 续做和任务隔离仍待相应真实链路。
   - WEB-A13 仅验证单轮文本快照找回、逐文件、补丁应用和零变更/只读结论展示。两轮依赖执行、增量与累计双视图、累计下载、历史版本固定与结构化检查仍待后端契约和验证。
   - WEB-06 的可信运维接手和结案，以及 WEB-08 的结构化检查与累计交付维持原有未覆盖状态。
4. 在删除草稿前用下列命令验证本草稿中的相对路径链接。删除本文件，同次提交 Readiness 与设计。以 `rg` 核查无草稿残留引用，要求原始退出码为 1 且 stdout/stderr 均为空。

验证（删除草稿前）：

```bash
node --input-type=module -e 'import {readFileSync,existsSync} from "node:fs"; import {dirname,resolve} from "node:path"; const p="docs/30-designs/RUNBOOK-WEB-RUN-REOPEN.md"; for(const [,target] of readFileSync(p,"utf8").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)){if(!existsSync(resolve(dirname(p),target))) throw Error(target)}'
```

验证（删除草稿后）：

```bash
pnpm --filter @bento/web check
pnpm --filter @bento/web test:e2e
pnpm exec prettier --check docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md
git diff --check
test ! -e docs/30-designs/RUNBOOK-WEB-RUN-REOPEN.md
sh -c 'status=0; output=$(rg -n "RUNBOOK-WEB-RUN-REOPEN" docs .agents 2>&1) || status=$?; if [ "$status" -ne 1 ] || [ -n "$output" ]; then printf "rg exit=%s\n%s\n" "$status" "$output"; exit 1; fi'
```

PASS：完整 Web 套件通过且无跳过的本任务用例，设计、Readiness、实际证据一致，草稿与引用已移除。STOP：B 尚未合入、出现未验证的产品声明、任何规定命令失败或测试被跳过时，保留步骤并报告具体差异。
