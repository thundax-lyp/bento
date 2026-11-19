# WEB 终态结果与非通过检查验收

## 状态与执行者契约

2026-11-19；WORKER B；仅调查起草，未获 Executable，禁止实施、提交和部署。
绑定 checkout 为派工指定的 bento-b；调查基线 `fbbee2f536112ba6e050b469bd1c6134306694d8`，目标分支 main，计划分支 `codex/web-terminal-results`。
本稿为待审草稿，不自行授予 Executable。按 MASTER 2026-11-19 补充口径，失败和非通过检查使用真实投影、HTTP、Store 和 Chromium 的分层 fixture；本轮不部署或调用模型。
收到 MASTER 的同一内容 Executable 后才单独提交本文件；收到显式 worker 开工后才实施。
逐步 PASS 才删除该步并同次提交，最后一步同步长期证据并删除本文件。失败停在原步，不删步骤，不放宽断言。

## Purpose、Scope 与 Non-goals

以 [WEB-06-02](../10-requirements/WEB-REQUIREMENTS.md#web-06-02-happy-path-查询终态和无变更结果) 和 [WEB-08-04](../10-requirements/WEB-REQUIREMENTS.md#web-08-04-bad-case-检查失败或无法执行) 为独立验收边界，合并交付原因是二者共用 Worker 公开投影、冻结结果、查询和下载链。
从正常任务页观察成功非空 diff、成功空 diff、明确失败、结果尚不可用；对 passed/failed/not_run/unavailable 逐项核对公开事件、结果和页面。
已有成功证据适用时复用，新增验证补齐实际缺口。目标是两行均有正式必需断言的适用通过记录。
不改 retry/cancel/checkpoint/Session 恢复、Task 状态语义、鉴权机制、旧部署迁移、模型能力、部署拓扑；不碰 A 的任务控制区和 web-a13 验收文件。
MASTER 已允许 pages.tsx 的 resultVersion=null 提示及 TaskRunResult/checkLabels 的最小修复；未授权顺手整理其他 UI。
A 先使用实栈并先合入，B 在步骤提交的安全点 merge 最新 main，复验共享查询展示和 A 的重试回归。实栈窗口未经 MASTER 放行不得使用。

## 正式依据与当前断点

- [接口](../20-interfaces/WEB-INTERFACE.md) Task 生命周期：TaskEventDTO、ResultDTO、结果及版本化 diff 路由。
- [设计](./WEB-DESIGN.md) Task 生命周期与公开事件：Worker 只传白名单；Store 同事务冻结成功与结果；两个 diff 来自同一快照。
- [架构](../00-governance/ARCHITECTURE.md)：Run/结果权威在 Orchestrator；Worker 仅投影；Web 只查询。
- [Readiness](../40-readiness/CURRENT-READINESS.md)：WEB-06-02 部分实现，WEB-08-04 待核验；WEB-08-01/02/03 已实现。
- pages.tsx::checkLabels 已有四个准确中文标签；TaskRunResult 已先读 metadata 再读固定版本 diff，成功零字节仍提供下载。selected.resultVersion=null 时当前无结果不可用文案，是本次最小生产修复。
- task-projection.ts::projectTaskChecks 把可信 pass/fail/skip/unavailable 映射为四种公开值，固定输出而不复制原工具文本。已有单测四状态不是实栈页面证据。
- service.test.ts 的 Task event projection suite 目前只覆盖 passed，并对私有字段、旧授权、重复事件和补丁字节有 fixture 证据，不能充当真实模型通过。

## 已有证据与缺口

Readiness 记载 2026-11-17 `36ab687` 加私有 Worker 的 WEB-A13 1/1：两轮修改、第三轮只读、补丁应用和字节对账、独立私有标记负例。原始记录位于 B 受控租约 `web-a13/full-stack/a13-output.*` 与 `web-a13/orchestrator-state/{business,authority}.sqlite`。本轮尚未远程回读；记录不等于当前部署通过。本任务本地分层验收不依赖重新部署；无法取得原件时不扩大复用声明。
本地旧 AUDIT.md 多处仍写“未运行”，与最终 Readiness 阶段不同，不能据该候选草稿覆盖最终记录；必须核对实际输出、源码和 launcher 摘要。
复用前核对 `git diff 36ab687..HEAD` 对结果链逐文件的影响，原始输出的用例标题、退出码、Run/version、SHA 和无跳过断言。只复用有真实原件且未被行为变化影响的断言。
缺口：空 diff 独立零字节下载、明确失败及不可用页面、failed/not_run/unavailable 每种状态的实际公开输出、当前版本页面提示。无检查记录 `[]` 不代表 not_run。

## 数据、调用链与不变量

1. 私有 bootstrap `trustedTaskChecks(events)` 产出 `{version:1,offset:number,outcome:'pass'|'fail'|'skip'|'unavailable'}`；三个字段必需，不接受多余字段；offset 为本轮真实事件索引，不重复、不越界。不得从用户正文或模型自述伪造可信结果。
2. `projectTaskChecks(eventCount,visible,checks)` 产出只读 PublicWorkerEvent 数组；check 为 `{offset,kind:'check',name,status,output}`，status 固定四值，output 为 string|null。固定名称“工作区内容检查”；pass 输出“内容与预期一致”，fail 输出“内容与预期不同”，skip 为 null，unavailable 输出“无法读取检查目标”。其他公开事件仅 `{offset,kind,text}`。
3. Worker POST task-events 受 execute grant/binding/generation 守卫；事件按 offset 排序，Store event sequence 为 Task 级递增。公开 payload 不携带 token、路径、卷、命令参数、未知原文或工具 JSON。结构校验不能替代可信 producer 的语义脱敏。
4. Store::publishTaskResult(runId,input,reviewProof?) 的 input 必需五个 string 字段：baselineSha256、initialSha256、afterSha256、incremental、cumulative。最后公开 agent_reply 为 summary，无时固定 Run completed.；checks 从已存 check 事件取。version 固定 1；runId 唯一；补丁以 UTF-8 字节计算 SHA-256；首次 createdAt 与结果持久化。成功状态和结果同事务写入，重放全部内容相同才复用；本任务不改此事务或生命周期。
5. GET tasks/{taskId}/runs/{runId}/results 返回 `{result:{runId,version:1,summary,checks,incrementalSha256,cumulativeSha256,createdAt}}`；checks 每项 name/status/output 全必需，output 可 null。公开 API protocol::taskResponse 再白名单投影并核对 Run/version。Web TaskResult 对应同字段；Run.resultVersion 为 number|null、summary 为 string|null。
6. GET results/1/diff 必需 view=incremental|cumulative；download 可省略或唯一值 1。成功返回 text/plain 的同一字符串，下载附件名 changes.patch；没有已成功结果返回 409 diff_unavailable。越权/错误绑定为 404。下载零字节是成功空结果，不是 409。
7. taskRunView 读取权威状态；失败原因来自服务固定摘要，不输出异常原文。页面只显示服务公开摘要；本任务不新增从原始错误猜测失败原因的 mapper。
8. 同部署重启后沿用 Store 持久化结果与 version；本轮不修改持久化、回执、outbox、恢复、ID/时间来源。不可用不得凭 UI 创建空结果。后轮不能改写旧 Run。只读结果不要求伪造检查。

## 有效 LOC 核算

以下均为验收必须核对的既有代码；不代表预期修改量。按基线行段去重，排除空行和纯注释，不含新测、文档和生成物。合计 **712 LOC / 9 个代码文件**。

| 文件                                             | 行段      | 有效 LOC | 符号与验收关联                                           |
| ------------------------------------------------ | --------- | -------: | -------------------------------------------------------- |
| `apps/worker/task-projection.ts`                 | 1–74      |       67 | projectTaskChecks / outcomes；四状态及脱敏               |
| `apps/worker/task-bootstrap.ts`                  | 1–91      |       85 | bootstrap；可信 producer 与公开投影接线                  |
| `apps/worker/protocol.ts`                        | 62–133    |       68 | PublicWorkerEvent / publicTaskEventBatch；公开字段和限制 |
| `apps/orchestrator/execution-service/store.ts`   | 1233–1311 |       79 | publishTaskResult；冻结结果和检查来源                    |
| `apps/orchestrator/execution-service/http.ts`    | 276–398   |      123 | Task 路由结果/下载分支；不可用门禁与同字节               |
| `apps/orchestrator/execution-service/service.ts` | 1159–1193 |       33 | finish；同快照生成两种补丁                               |
| `apps/workspace/api/protocol.ts`                 | 724–849   |      126 | taskRunDTO / taskCheck / taskResponse；公开白名单        |
| `apps/workspace/web/src/api.ts`                  | 201–240   |       40 | TaskRun / TaskCheck / TaskResult；页面消费者             |
| `apps/workspace/web/src/pages.tsx`               | 1537–1627 |       91 | TaskRunResult；固定版本预览和下载                        |

## Plan

各步文件数包含本 RUNBOOK 与专门只读核对文件。执行期间通用工具加载不额外扩大该步业务核对清单。所有命令从仓库根执行。

### T0：作者核对基线和复用边界（单列）

允许修改：仅本 RUNBOOK。专门核对：WEB-REQUIREMENTS、WEB-INTERFACE、WEB-DESIGN、CURRENT-READINESS、ENVIRONMENTS.example.md、受控环境文件（合计 7）。
执行：核对 Git 干净、main 与派工基线；同一内容获 MASTER Executable 后才开计划分支并独立提交 RUNBOOK。B 根 ENVIRONMENTS.md 缺失，已按派工受控读取主 checkout 环境文件，未复制值、未连接服务。检查原 A13 记录的适用代码差异；检查 T4 的 4333/4334 均可绑定、已安装的 Playwright/Chromium 和 SQLite 运行依赖可用。T4 启动前重复端口检查；占用时 STOP，不接管或停止已有服务。本任务不要求为每种展示状态跑真实模型。成功非空和只读完整实栈事实仅复用 Readiness 所引用原件，无法取得原件则记录未复用，仍以本轮完整本地链路证明当前结果展示，不把本地写成真实模型。
验证：

```bash
git status --short --branch
git rev-parse HEAD
git diff 36ab687..HEAD -- apps/worker/task-projection.ts apps/orchestrator/execution-service/http.ts apps/orchestrator/execution-service/store.ts apps/workspace/web/src/pages.tsx
git diff --check
node --input-type=module <<'JS'
import { createServer } from 'node:net';
for (const port of [4333, 4334]) {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
JS
pnpm --filter @bento/web exec node --input-type=module -e "import { access } from 'node:fs/promises'; import { chromium } from '@playwright/test'; import { DatabaseSync } from 'node:sqlite'; await access(chromium.executablePath()); const db = new DatabaseSync(':memory:'); db.close();"
```

PASS：端口与本地依赖检查退出 0；基线与归属核对、正式需求没有逐状态强制实栈、MASTER 对最终稿 Executable；另显式 worker 开工。A 主线变化影响执行时只复审受影响步骤。
STOP：内容/基线变化影响范围、正式依据冲突或本地依赖不能执行。无外部副作用，不回滚旧现场。
提交边界：通过审核后独立 RUNBOOK 提交。

### T2：锁定冻结结果与不可用接口

前置：Worker bootstrap 四状态真实 POST 接线与投影单测 8/8、Worker typecheck 通过，见上一 STEP 提交中的 task-bootstrap.test.ts。
允许修改：`apps/orchestrator/execution-service/service.test.ts`、本 RUNBOOK。
专门只读：`apps/orchestrator/execution-service/http.ts`、`apps/orchestrator/execution-service/service.ts`、`apps/workspace/api/protocol.ts`，合计 5 文件。
执行：在既有 Task event projection suite 的独立新增用例，使用 localHost fixture，经真实 HTTP 入库四状态，精确核对 results.checks 和 events.check；不得改变旧 suite 的重复/旧代负例。分别创建非空和空结果，比对两种 view 的预览/附件字节、metadata SHA、固定附件名。运行未完成时读取 results 与 diff 均为 409 diff_unavailable；越权均 404。重开服务后只读回查冻结结果一致。fixture 明确标记，不能称真实模型验收。
验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='Task event projection|Task terminal results' apps/orchestrator/execution-service/service.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：新增 suite 名称含 Task terminal results；四状态、空/非空、409、404、重开断言全部执行通过。STOP：生产链缺陷超出本稿，禁止改状态机或绕过发布门禁，交作者修订。fixture 退出清理自己的临时目录，无共享资源变化。
提交边界：`Test(execution-service): 核对终态结果和补丁可用性`，同次删除 T2。

### T3：明确页面尚不可用并覆盖四状态

前置：T2 已提交，MASTER 已确认共享段许可。
允许修改：`apps/workspace/web/src/pages.tsx`、`apps/workspace/web/e2e/task.spec.ts`、本 RUNBOOK。
专门只读：`apps/workspace/web/src/api.ts`，合计 4 文件。
执行：仅在 selected.resultVersion !== null 的现有 TaskRunResult 分支加 else `<p role="status">结果尚不可用。</p>`。不更动 selected.summary、needs_review 提示、retry/cancel 条件与 mutation，不改 TaskRunResult 的查询键和授权。新增独立 mock 路由用例覆盖 succeeded 非空、succeeded 零字节、failed 固定公开摘要、running/null；选择轮次后断言提示互斥，失败和不可用无下载。零字节仍可下载且显示无变更。四状态各项检查名称/标签/输出精确比对，null output 不产生假的通过文案。两种 view 均核对请求版本和字节。
验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test:e2e -- --project=chromium
```

PASS：完整 Chromium e2e 通过，新用例四种结果/四种检查逐项断言执行。STOP：需修改 A 控制区、API 或共享状态，保留 diff 回报 MASTER。只使用本地 mock，不占实栈。
提交边界：`Fix(task-entry): 明确区分未发布结果和空补丁`，同次删除 T3。

### T4：独立实际 HTTP 与页面结果链验收

前置：T3 提交。本地 fixture 不占 Docker/OpenShell/身份实栈窗口。
允许修改：新 `apps/workspace/web/acceptance/web-terminal-results.spec.ts`、新 `apps/workspace/web/acceptance/terminal-results-fixture.ts`、新 `apps/workspace/web/playwright.web-terminal-results.config.ts`、`public-files.json`、本 RUNBOOK。
专门只读：`apps/orchestrator/execution-service/local.ts`、`apps/workspace/api/server.ts`、`apps/workspace/api/auth.ts`、`apps/workspace/api/execution-service-http.ts`、`apps/workspace/api/account-store.ts`，合计 10 文件。
执行：

1. T4 启动前重复 T0 的端口检查命令，4333/4334 任一占用即 STOP。配置仅选择 web-terminal-results.spec.ts，Chromium workers=1/retries=0，timeout=120000；固定 `use: { baseURL: 'http://127.0.0.1:4334', trace: 'off', video: 'off', screenshot: 'off' }`，固定 `webServer: { command: 'pnpm dev --host 127.0.0.1 --port 4334 --strictPort', url: 'http://127.0.0.1:4334', env: { BENTO_API_TARGET: 'http://127.0.0.1:4333' }, reuseExistingServer: false }`。`--strictPort` 禁止端口自动漂移；配置中只启动 Vite，不启动 API。API 4333 仅由 spec 的 beforeAll 调用一次 helper 启动、afterAll 调用 close，helper 绑定失败即报错，不复用已有 API。不改原 web-a13 和默认配置。
2. helper 导出 `startTerminalResultsFixture():Promise<{seedFailure(taskId:string):Promise<string>;close():Promise<void>}>`。创建 mkdtemp 私有目录，serveExecution 使用 localHost、固定合成 service bearer、retryMs=20、workerTimeoutMs=15000。taskEntryServer 使用端口4333、origin4334、sessionAuth(mockAccounts(demoAccounts()),false,false) 与 httpBackend(service.url,bearer,5000)，不带 OIDC/space。UI 走实际 API/server/DTO 映射，不用 page.route 伪造任务 JSON。注册 demoAccounts 中的 demo 账号（demo-invite、运行时 randomUUID 密码），再按既有登录表单登录，不输出密码。helper 保留该 demo.ownerId 以准备同 owner 样本；backend 使用可替换闭包，执行服务重启后重建 httpBackend 而保持公开 API 和登录会话。
3. 仅 localHost.worker fixture 边界选择五个精确 prompt：`terminal-nonempty` 调用 base.worker 写该合成文本；`noop` 调用 base.worker 保持空白；`terminal-checks` 经 projectTaskChecks(4,[],四个 version=1/offset=0..3/outcome=pass,fail,skip,unavailable) 后用实际 grant POST publicEventsUrl，确认200，再以复制 request 且 prompt=noop 调用 base.worker；`terminal-unavailable` 等待 fixture barrier，供页面观察未完成状态；`terminal-failed` 是显式状态注入 fixture，不运行模型。失败样本从页面创建独立空白 task 并等待 ready，不向其发送 prompt；helper.seedFailure(taskId) 先 close 执行服务，new Store(join(state,'business.sqlite'),16)，调用 enqueueTaskRun(demo.ownerId,taskId,randomUUID(),'terminal-failed') 得到 {run}，再 Store.status(run.id,'failed','Run stopped before completion.')，Store.close()；重开 serveExecution 后更新 backend 闭包并返回 run.id。页面直接打开该 Task/Run 地址，由实际查询读取。这一摘要与 service.ts::settle 的公开固定失败摘要一致；注入的终态本身不是生产故障处理证据。注入必须在服务关闭、锁释放后进行，禁止在运行时直接 UPDATE 或更改生产状态机。failed fixture 精确准备的 Store 方法签名已核对；基线变化使签名不符则 STOP，交作者修订。
4. 正常页面创建空白任务、发送上述要求、选择 Run，分别读取结果和点击下载。空任务各建独立 Task，避免跨轮累计补丁影响空结果。非空/空/四状态都从 Worker/Store 经实际私有 HTTP、httpBackend/public DTO 到页面，不只 mock 页面 JSON。尚不可用样本在 barrier 释放前 resultVersion=null，无下载；补充 GET results/diff 均409。测试 teardown 先释放 barrier，再 close 服务和 API，最后只删该 mkdtemp 目录。
5. 两种 view 均比较 metadata SHA、预览响应和下载文件 Buffer，附件名 changes.patch。空结果必须 Buffer.length=0、页面无变更且无尚不可用。failed 固定公开原因且无下载。四状态 checks/events/页面标签和固定输出分别精确比对，不用“包含通过”代替逐项断言。私有金丝雀只放在被拒绝的额外字段或 fixture 私有诊断，不放进合法公开正文；检查公开 API/DOM/补丁无该值。不得声称对任意原始合法公开文本进行通用脱敏。
6. 报告明确标记 synthetic Worker/身份/本地卷；真实执行的是生产投影、HTTP、SQLite、API mapper 和浏览器消费。真实模型、OpenShell、OIDC、S3 本轮 Not Covered，已有 A13 事实按适用版本另列。

验证：

```bash
pnpm --filter @bento/web exec playwright test --config=playwright.web-terminal-results.config.ts --project=chromium
```

PASS：四种结果和四种检查全部逐项通过，无 skip；公开 API、结果与 DOM 一致，字节/SHA 一致，重开失败记录正确；没有真实模型或部署声明。
STOP：本地端口已占用、fixture 无法经真实服务器启动、需绕过鉴权/版本/结果门禁、无法按现有 Store API 注入已关闭服务的独立失败样本。不自行换成页面 JSON mock。无共享资源副作用。
提交边界：`Test(task-entry): 验收终态结果和非通过检查展示`，同次删除 T4。

### T5：完整复验与独立证据收口

前置：T4 已提交、已采用证据的版本边界准确、已纳入 A 的最新 main 并经 MASTER 核对共享行为。若 A 尚未合入，在已提交 T4 的安全点等待并保留只剩 T5 的 RUNBOOK；不得把等待当作前置已满足，不执行 T5、不删除 RUNBOOK、不宣告收口。merge 不改写历史，冲突涉及 A 控制区先 STOP。
允许修改：CURRENT-READINESS.md、本 RUNBOOK。
专门只读：WEB-DESIGN.md、README.md、deploy/README.md（均为现有正式路径），合计 5。
执行：记录日期、准确源码/Worker 版本、环境摘要、各用例结果、已有证据复用边界及未覆盖项。Readiness 仅改 WEB-06-02 和 WEB-08-04 行；父汇总变化交 MASTER 协调，不覆盖 A 内容。未改架构/启动/发布方式，核对三份入口文档后记录无需改写。将适中长度的分项证据直接写入这两行说明列，不新增独立证据文档；不含本机路径、真实身份或连接参数。
验证：

```bash
pnpm check
pnpm --filter @bento/web test:e2e -- --project=chromium
npm pack --dry-run --json
git diff --check
```

PASS：完整检查退出 0；Readiness 分项证据逐项关闭两个需求；共享查询、结果下载和 A 的既有安全重试 Chromium 回归通过。未通过的必需项不得标已实现。删除本 RUNBOOK，rg 核对无仅指向它的链接，再提交。
STOP：完整验证失败、证据版本受改动影响或尚有未验必需项，保留步骤并报告 MASTER。本轮没有实栈撤场，旧服务、卷和资源不动。
提交边界：`Docs(task-entry): 记录终态结果逐项验收证据`，同次删除整个 RUNBOOK。

## 验证矩阵与关闭定义

| 正式场景              | 必需可见断言                                                             | 计划证据                        |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| WEB-06-02 成功非空    | 正常入口、同 Run/version、两 view 预览和下载同字节及 SHA                 | A13 适用原件 + T2/T3/T4         |
| WEB-06-02 成功空      | 结论可读、无变更、两 view 可下载零字节、不出现尚不可用                   | 只读 A13 原件 + T3/T4 补缺      |
| WEB-06-02 明确失败    | failed、公开原因、无结果下载、不包含私有内容                             | T3 mock + T4 持久失败 fixture   |
| WEB-06-02 尚不可用    | null version、明确尚不可用、无下载、409                                  | T2/T3/T4                        |
| WEB-08-04 passed 对照 | 真实 passed，名称和公开输出准确                                          | T1/T2/T3/T4，实栈仅复用适用原件 |
| WEB-08-04 failed      | 实际失败不显示通过，固定公开输出                                         | T1/T2/T3/T4                     |
| WEB-08-04 not_run     | fixture TrustedTaskCheck skip 投影事实、not_run/null、“未运行”           | T1/T2/T3/T4                     |
| WEB-08-04 unavailable | fixture TrustedTaskCheck unavailable 投影事实、unavailable、固定公开输出 | T1/T2/T3/T4                     |

权限、旧代、重放、持久重开覆盖采用既有测试加 T2，不改变生产事务；完整负例扩展、并发恢复和迁移 Not Applicable，本任务无该行为变更。旧 Run 不覆盖复用适用 A13。
全部矩阵满足、长期证据和 Readiness 完成才关闭。WEB-06-02/WEB-08-04 的本地分层验证足以关闭本任务展示与查询契约；不代表真实模型具备全部非通过状态的生产触发工具。PR/Ready/Codex 当前 HEAD 审查、普通 merge、同步清理依 worker 技能和 PR 规则执行，先 A 后 B；本轮授权覆盖这些后续动作，但当前阶段仍只起草。
