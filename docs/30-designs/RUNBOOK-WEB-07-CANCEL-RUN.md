# RUNBOOK · WEB-07 取消排队与运行中的 Run

- 状态：实施中。建立于 2026-11-12。执行起点为干净的 `main` / `origin/main` `b33c8e7`，由维护者在获授权的执行分支开始。本轮只交付计划。
- 目标：在现有任务详情取消排队任务或请求停止运行中的任务。保留原 Run。运行中的取消由账本记录，确认停止和撤权后才释放槽位，无法确认副作用时进入待核对。
- 依据：[WEB-07](../10-requirements/WEB-REQUIREMENTS.md#web-07-连续对话与任务控制)、[WEB-A12](../10-requirements/WEB-REQUIREMENTS.md#验收标准)、[Web 接口](../20-interfaces/WEB-INTERFACE.md#任务与补丁--现有)、[Web 设计](WEB-DESIGN.md#执行环境与任务交互)、[平台架构](../00-governance/ARCHITECTURE.md#当前实现接线)。[Readiness](../40-readiness/CURRENT-READINESS.md) 的 WEB-07 目前把取消列为待实现。
- 范围包含排队取消、运行中停止及取消结果回读。恢复 Worker、自动重放、安全重试、继续对话、运维结案、项目删除和真实 Docker/Temporal/OpenShell 验收在本轮之外。

## 作者或维护者执行前检查

本节不编号、不计入机械步骤。在仓库根核对 `git rev-parse main origin/main`、`git log -1 --oneline`、`git status --short --branch`。确认两个 main 引用都指向 `b33c8e722a26126556d01794a82756f9b11b42fc`，执行分支从此起点建立，代码和暂存区干净。已另行提交的审核版 RUNBOOK 可作为起点的唯一文件差异。核对 Node 22、锁定 pnpm、Go 和现有 Chromium 依赖。浏览器 fixture 使用 4319/4320，仅在本机 `lsof -nP -iTCP:4319 -iTCP:4320 -sTCP:LISTEN` 返回 1 且无输出时启动测试。缺条件交由维护者处理。执行不依赖主 checkout 的部署配置、凭据或共享服务。WEB-03 单文件删除与本任务均触及 Run 账本和个人端 API。两个任务各自在独立分支验证。并行实施时，维护者先协调这些共享边界的基线；后合入者在实际合并基线上重跑 T1 的排队竞争、T6 的取消竞态和 WEB-03 的文件删除门禁 fixture，再记录证据。

## 状态和接口

权威 Run 在 `apps/orchestrator/execution-service/store.ts` 的 SQLite `runs`。Temporal 的 Go 调度器从 `Store.dispatchSnapshot` 选择候选，`Store.reserveDispatch` 在 `run_dispatches` 写入预留后才发布 Workflow。两种路径均由 `apps/orchestrator/execution-service/service.ts` 的 `driveRun` 获取快照，再由 `Store.start` 条件写入 `running`，之后才调用 Worker。预留、读到候选或开始读快照均不算启动。

- 排队取消的原子条件为同账号、同项目、同 Run，且 `status='queued'`，包括已有 `run_dispatches` 预留。唯一竞争点是 `queued → cancelled` 与 `Store.start` 的 `queued → running`。取消先赢保留历史预留，调度过滤和 `Store.start` 都拒绝该 Run，迟到 Activity 回读 cancelled 后直接返回。启动先赢走运行中取消规则。
- 取消只写 `status`、`updatedAt`（现有服务端 `now()`）和 `summary`（固定 `Cancelled before start.`）。原 Run ID、创建时间、提交键、prompt、项目及 Session 保留。没有基线、receipt、diff 或事件新增。已取消 Run 不计入现有排队上限、活跃项目约束和槽位。重复取消同一 Run 返回原快照，不更新时间。SQLite 持久化原记录，同部署重启后保持终态。
- 运行中取消的原子条件为归属匹配、`status='running'` 且 `receipt=0`。发过 grant 时还须有当前控制器匹配本 Run 和代次的 Worker 退出观察。缺宿主能力或观察时，在写意图前返回 409，原 Run 继续。`Store.received` 已写入完成回执则完成先赢，取消返回 409。取消先赢将状态设为 `cancelling`，旧回执不能覆盖，取消中占用原执行容量并阻止同项目新 Run。只有可信 Worker 闭合和现有控制面旧代撤权、独立停止观察均确认后才可写终态。此前保持取消中。
- 终态为 `cancelled` 或 `needs_review`。可信快照与本轮基线不同、存在旧代 UNKNOWN 操作、旧代曾获得 SDK 入口而无法排除未记账调用，或快照/操作证据不可读取，均在停妥后进入 `needs_review`。该状态沿用既有活跃项目约束，不发布 diff、不启动恢复 Worker。否则写 `cancelled`。复用现有 `takeover` 的同卷控制面再就绪流程，不运行用户工作或恢复 prompt。
- 业务账本新增内部字段 `cancelGeneration: number | null` 和 `cancelWorkerClosed: 0 | 1`。前者默认为 null（没有运行取消意图），0 表示权威账本证明尚未发放 grant，正数为旧代。后者默认为 0，只有没有 grant 或可信宿主对本 Run 发出明确的退出观察才置 1。持久化后方可据此完成取消。生产支持限于声明能力的内置预热宿主，要求受信启动器持有整次 Worker 生命周期。仅对应预热子进程的实际 close 可发出退出观察。冷启动 `processWorker` 和未声明能力的自定义宿主均拒绝已发 grant 的运行取消。测试宿主以显式 barrier 模拟退出观察。普通 Worker Promise settle、abort、客户端断开、发送信号和沙盒停止均不算 Worker 已退出。当前协议没有重启后独立查询旧 Worker 进程的接口。若重启时闭合证据尚未落盘且旧代曾发 grant，继续观察和撤权，保持取消中和原槽位，禁止补发 Worker。旧代 SDK 写入与完成回执未逐操作对账，因此已发 grant 且部署启用 SDK 的中断运行保守进入待核对。真实启动器与额外观察能力留待部署验收。
- 公共和私有入口沿用 `POST /api/projects/{projectId}/runs/{runId}/cancel` 与对应 `/v1/...` 路径，无正文、无新幂等键。同源会话与受信 owner 校验保持原样。成功或同一取消请求重复返回 `200` 和当前详情 Run。排队成功返回 cancelled，运行请求返回 cancelling；运行取消进入待核对后再次请求返回同一 needs_review 详情。重复不改时间。GET 详情和列表增加 cancelling、cancelled，列表仍省略 prompt。DTO 沿用现有详情，新增两个状态值，不公开内部字段。
- 未登录沿用 401。越权、不存在或父子不匹配均为 `404 not_found`。已收完成回执或缺少退出观察能力的 running，以及其他不接受取消的状态返回 409，私有 code `run_not_cancellable`，公共 code `conflict`，文案「当前任务状态不能取消。」。网络结果未知时回读原 Run。原 Run、项目、Session、提交键、基线与记录不删除。无新增领域事件、outbox 或旧部署迁移。

每步 PASS 后，删去本步执行说明并将后续依赖改成可从 Git 或代码验证的事实，保留其余编号。同一步产物和 RUNBOOK 清理在获授权后一起本地提交，最后一步提交删除全文。每步专门核对、改、新增或删的文件合计最多 10 个。STOP 时保留现场，报告步骤、命令、实际结果及待决定项，不跳步。测试 fixture 仅使用临时目录或内存，失败也按 fixture 清理。

## 机械步骤

### T4：个人端 API 转发与权限校验

前置状态：HEAD 标题为「Feat(execution-service): 确认撤权与退出后结束取消」，工作树干净。私有取消路由已接入 Worker 退出与沙盒停止证明。Orchestrator 类型检查和 5 项账本、HTTP、预热 Worker fixture 通过。

文件清单（8）：修改 `apps/workspace/api/{protocol,server,execution-service-http,mock}.ts`、`public-files.json` 和本 RUNBOOK。新增 `apps/workspace/api/cancel-run.test.ts`。专门核对 `apps/workspace/api/go/main.go` 的通用代理。

禁止修改：认证、CSRF、会话归属、既有路径及错误行为。

执行：

1. TS `runStatuses` 加 cancelling/cancelled，Run 路由组加 `cancelRun`。 `publicJson` 用详情投影，并要求取消的 200 状态是 cancelling、cancelled 或 needs_review。 `server.ts` 加 POST cancel，复用原 `decodeId`、同源校验和会话 owner。 `httpBackend` 转发私有无正文 POST，`upstreamError` 对取消 409 用公共固定文案。
2. 当前 Go `main.go` 把 `/api/` 通用代理给 task-entry，未注册 `projects.go` 的直接路由。取消沿用已部署的代理，不修改 Go。新增 `cancel-run.test.ts`，用 Node 回环 HTTP fixture 调 `httpBackend`，断言 POST 私有路径、无正文、owner、200 三种取消状态、404、409 和原 GET 读回。新测试加入公开文件清单。
3. `mockBackend.advance` 保留原计时，拿到 job 后的 queued 仍允许取消。取消 queued 写 cancelled 并从 queue 移除（若已取出，现有计时回调读到 cancelled 时不得启动或 patch，结束回调不写入终态或时间，只释放 busy）。取消 running 写 cancelling；原 mock:review 中间定时器仅在仍为 running 时改 recovering，结束回调遇 cancelling 则写 cancelled、跳过 patch、释放 busy 并继续。重复返回已有详情；两处终态清理/单活跃判断加入 cancelled。

验证：

```bash
pnpm --filter @bento/workspace-api typecheck
node --experimental-strip-types --test apps/workspace/api/cancel-run.test.ts
```

PASS：类型检查与指定 TS 转发 fixture 通过，沿用同账号归属与既有 Go 通用代理。

STOP：任何入口允许绕过归属或同源校验，或无法兼容既有详情读取。

### T5：任务详情展示取消与服务器状态

前置状态：现有公共入口已接线，TS 代理 fixture 通过并提交。

文件清单（5）：修改 `apps/workspace/web/src/{api.ts,pages.tsx}`、`apps/workspace/web/e2e/task.spec.ts` 和本 RUNBOOK。专门核对 `apps/workspace/web/playwright.config.ts`。

禁止修改：其它操作、下载门禁、轮询周期、重试与继续对话入口。

执行：

1. Web `Run.status` 增 cancelling/cancelled，`runLabels` 分别为「取消中」「已取消」。 `isActive` 增 cancelling。新增 `cancelRun(project: string, run: string): Promise<Run>`，使用 `json<Run>` 发无正文 POST，保留 15 秒超时。
2. `RunDetails` 仅在 queued 显示「取消排队」，running 显示「请求停止」，mutation pending 禁用。无乐观状态。200 先取消当前精确详情键的在途请求，再写服务器 DTO、刷新同项目列表；失败重新读取详情并显示现有错误，回读已进入取消相关状态时隐藏该错误。刷新沿用原链接与详情 GET。cancelling、cancelled、needs_review 均无取消按钮或下载。
3. 在现有 `task.spec.ts` 加 `任务详情回读取消状态`，用 route fixture 为两个固定 Run 提供 session/project/GET/POST。排队取消响应 cancelled，刷新后仍为 cancelled。运行取消响应 cancelling，GET 保持 cancelling 直到测试先断言「取消中」，随后才切换为 needs_review。断言轮询读回，按钮和下载都不出现。两次动作各发一次无正文 POST，fixture 校验方法和目标 Run。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test:e2e task.spec.ts -g '任务详情回读取消状态'
```

PASS：用例执行通过，成功、刷新与轮询只显示服务端确认的状态。

STOP：重复 POST、提前显示终态、进入取消相关状态后仍可操作，或 fixture 失败。

### T6：锁定停止不明、旧代与副作用竞态

前置状态：T1～T5 产物各自提交，账本和任务详情的 focused fixture 已通过。

文件清单（5）：修改 `apps/orchestrator/execution-service/service.test.ts` 和本 RUNBOOK。专门核对 `apps/orchestrator/execution-service/{service,store,local}.ts`。

禁止修改：生产实现。发现问题返回对应步骤修复后重跑受影响门禁。

执行：

1. 用 `localHost` 加 `cancellation fault keeps the slot`。声明观察能力，Worker 收到 abort 后先 settle 普通 promise，将第四参数回调留在独立退出 barrier。让 `stopped` 先返回 false，另账号 Run 排队。确认取消中、同项目新提交 409、旧 grant 的 persistence/operation 403。把 stopped 改成 true 并等可信旧沙盒停止被观察，退出 barrier 仍未释放；断言还是 cancelling，另一 Run 未被领取，重复取消返回原 cancelling DTO。再释放 Worker 退出观察，才断言 cancelled、另一 Run 被领取，且原沙盒停止命令一次。
2. 加 `cancellation fault preserves unknown effects`：Worker 先用现有 `reserveOperation` 写入 UNKNOWN。确认 Worker 和沙盒停止后原 Run 为 needs_review，无 diff；同项目新写任务返回 409，没有恢复 Worker 或第二次派发。重复取消返回同一详情。
3. 加 `cancellation fault ignores exit after shutdown`：用同类退出 barrier 持有观察，完成沙盒停止后关闭服务。关闭完成后触发旧回调，断言不抛错、不写账本；同一临时目录重开，原 Run 仍 cancelling 且不放行同项目新 Run，不启动任何 Worker。三项 fixture 均设测试超时，finally 释放 barrier、关闭服务并清理临时目录。

验证：

```bash
node --experimental-strip-types --test --test-name-pattern='cancellation fault' apps/orchestrator/execution-service/service.test.ts
pnpm --filter @bento/orchestrator check
```

PASS：三项故障 fixture 与 Orchestrator 回归通过。覆盖排队、启动与完成竞争、沙盒已停但 Worker 未退出、旧代拒绝、副作用不明和关闭后迟到退出观察。本地 fixture 不证明真实启动器停止或 Temporal 集成。

STOP：任一竞态或回归断言失败，不改判据或扩大到新部署协议。

### T7：同步稳定契约和 Readiness

前置状态：前六个步骤均已分别提交，实际测试结果齐备，工作树干净。

文件清单（5）：修改 `docs/20-interfaces/WEB-INTERFACE.md`、`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md` 的 WEB-07 行，删除本 RUNBOOK。专门核对 `docs/10-requirements/WEB-REQUIREMENTS.md`。

禁止修改：需求、其他就绪条目、部署和实现。

执行：接口记录两种路径、状态、200 回读和 404/409；设计记录原子领取边界、停止证明和待核对。WEB-07 保持「部分实现」，注明实际日期、提交、账本/Worker、TS 代理、Chromium fixture 范围。保留真实启动器/Temporal/OpenShell、重启后缺 Worker 证明、运维结案、安全重试和继续对话的未覆盖边界。检查三个改动文档没有临时 RUNBOOK 引用。通过后删除本文，同次本地提交三个稳定文档和删除。

验证：

```bash
pnpm exec prettier --check docs/20-interfaces/WEB-INTERFACE.md docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md
git diff --check
rg -n '^### WEB-07 |^\| WEB-A12 ' docs/10-requirements/WEB-REQUIREMENTS.md
rg -nF 'RUNBOOK-WEB-07-CANCEL-RUN' docs/20-interfaces/WEB-INTERFACE.md docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md
```

PASS：前三条退出 0，需求搜索命中两项，最后一条退出 1 且无输出。运行 `rm -- docs/30-designs/RUNBOOK-WEB-07-CANCEL-RUN.md && test ! -e docs/30-designs/RUNBOOK-WEB-07-CANCEL-RUN.md`，通过后按本步范围提交。

STOP：任一检查、范围或证据不符时保留 RUNBOOK。

作者自检仅核对正式依据、当前入口、步骤文件上限、链接与命令语法。实现及 fixture 均待授权后执行。
