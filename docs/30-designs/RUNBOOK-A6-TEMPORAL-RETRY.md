# A6 Temporal Activity 重试验收 RUNBOOK

## 状态与执行契约

2026-11-13 起草，等待独立审核。工作区 `bento-b`，调查基线 `5c8ffb99b2065851ee4d262e21ccc396ad089186`。当前授权到 T0 起草和本地调查。T1 由 MASTER 在独立审核通过并确认 B 的 Readiness 合入顺序后派发。仓库忽略新设计文档，本文按本地草稿交审。每步最多 10 个文件，按 T0、T1 顺序执行。PASS 须满足本步所有断言。STOP 保留工作区并回报最后完成步骤、基线 SHA、文件与符号、脱敏命令和结果、继续所需决定。

## 目标、依据与当前断点

[A6 调度与池化、A3 接管状态机](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛) → [平台架构的当前实现接线](../00-governance/ARCHITECTURE.md#当前实现接线) → [执行链实施设计](./APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计) → [A6 Readiness](../40-readiness/CURRENT-READINESS.md)。

A6 要求 Activity 重投时副作用不重复。本轮选择已完成 Run 的成功回包被替换为错误的场景。用 Temporal SDK Workflow testsuite 执行生产 `bentoRun` 和 `(*bridge).advance`，经真实私有 stdio 接线驱动 `serveExecution`、SQLite 和本地文件追加。测试在宿主发出首次成功回复后、Go Activity 收到回复前注入一次协议错误，触发正常 Activity 重试。该注入覆盖明确的失败回复触发重投。真实丢包造成的心跳超时、Temporal Server、进程崩溃、A3 在途副作用 UNKNOWN 和真实 OpenShell/DSH、跨租户派发、Worker 长期复用与升级排空均在本轮范围外。

`apps/orchestrator/temporal_test.go` 的 `TestRunWorkflowRetriesOnlyAdvancement` 用替代 Activity 检查 Run ID 和重试次数，`TestDispatchHonorsCapacityAndTenantFIFO` 检查 Go 选择函数。`apps/orchestrator/execution-service/service.test.ts` 的租户预约用例直接验证 Store，capture 用例验证服务重启后只重试快照。缺少同一条用例连接实际 Workflow、Activity、stdio 和执行宿主，并同时观察重投及副作用。

## 协议、所有权与不变量

- `apps/orchestrator/execution-service/service.ts` 的 `serveExecution.work` 通过 `temporalRuns` 发送 `choose` 与 `enqueue`。前者携带 `Store.dispatchSnapshot` 的 `{slots:number,occupied:{owner:string,status:string}[],queued:{id:string,owner:string}[]}`，结果是候选 Run ID 或空字符串。生产 `chooseRun` 只选候选，`Store.reserveDispatch` 负责原子预约。后者携带服务生成的非空 Run ID 字符串，成功回包值为 `null`。
- `apps/orchestrator/temporal.go` 的 `message` 为 `{id:string,method?:string,value?:JSON,error?:string}`。Activity 每次调用 `bridge.advance` 生成新 `go-<序号>`，发送 `method:"advance"`、`value:<相同 Run ID>`。宿主 `apps/orchestrator/execution-service/temporal.ts` 的 `temporalRuns` 调用实际推进回调，回送同一帧 ID 与 `value:null` 或错误。Go 按帧 ID 将回复交还等待该请求的 Activity。SQLite 持有 Run 状态、完成回执和差异；testsuite 持有 Workflow/Activity 执行状态。
- 首次成功回复到达测试控制器时，`driveRun` 已通过 `settle`、`fence` 和 `finish` 持久化 `succeeded`。同 Run 的再次回调进入 `driveRun` 后直接返回。两个 Activity 尝试必须有不同帧 ID、同一 Run ID，第二次必须收到真实宿主成功回复。测试观察一次 Worker 调用和一次实际文件追加，同时核对公开终态及 diff。
- 无业务接口、数据格式、事件、迁移或部署改动。本轮使用临时 SQLite 和卷。fixture 失败时关闭服务和子进程并删除临时目录，每次重跑使用全新目录。

## 步骤

### T0 核对基线与起草

前置状态：`main` 为调查基线，应用工作区干净。

允许修改：本文。

本步专门核对文件（含本文，共 10 个）：

1. `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`
2. `docs/00-governance/RUNBOOK-RULES.md`
3. `docs/00-governance/DOCUMENT-RULES.md`
4. `docs/00-governance/ARCHITECTURE.md`
5. `docs/10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md`
6. `docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md`
7. `docs/40-readiness/CURRENT-READINESS.md`
8. `apps/orchestrator/temporal.go`
9. `apps/orchestrator/temporal_test.go`
10. `apps/orchestrator/execution-service/service.test.ts`

禁止修改：应用、测试、Readiness、分支和 Git 历史。

执行：核对本文章节所列生产入口和既有测试，复跑本地基线，检查文档链接与差异后交独立审核。

验证（均从仓库根执行）：

```sh
git rev-parse HEAD
GOPROXY=off GOSUMDB=off go -C apps/orchestrator test -count=1 ./...
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='tenant queue limits|a completed Run retries capture' apps/orchestrator/execution-service/service.test.ts
git diff --check
```

PASS：基线为上述 SHA，Go 套件通过，Node 恰好运行两项且全部通过，本文相对链接有效。STOP：基线或生产路径偏离、依赖缓存缺失、命令失败。保留草稿并回报 MASTER。

### T1 验证已完成 Run 的 Activity 重投并收口

前置状态：T0 通过、独立审核和 MASTER 派发均已确认，B 的 Readiness 修改窗口已确认。

允许修改：`apps/orchestrator/temporal_test.go`、`apps/orchestrator/execution-service/service.test.ts`、`docs/40-readiness/CURRENT-READINESS.md`、本文。

本步专门核对文件（含允许修改的 4 个文件，共 9 个）：

1. `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`
2. `docs/40-readiness/CURRENT-READINESS.md`
3. `apps/orchestrator/temporal_test.go`
4. `apps/orchestrator/execution-service/service.test.ts`
5. `apps/orchestrator/temporal.go`
6. `apps/orchestrator/execution-service/temporal.ts`
7. `apps/orchestrator/execution-service/service.ts`
8. `apps/orchestrator/execution-service/store.ts`
9. `apps/orchestrator/execution-service/local.ts`

禁止修改：生产代码、依赖、部署或共享环境。文件计数以本步明确检查或修改的文件为准，仓库级验证命令自动读取的文件不逐项计入。

执行：

1. 在 `temporal_test.go` 新增 `TestTemporalRetryAfterCompletedRun(t *testing.T)`。用 `os.Executable()` 取得当前测试二进制，通过 `exec.CommandContext` 在 30 秒内执行 Node，工作目录为当前 Go 包目录，参数为 `--import ../../register-paths.mjs --experimental-strip-types --test --test-name-pattern=^Temporal Activity retries a completed Run without repeating its effect$ execution-service/service.test.ts`。仅对子进程传 `BENTO_TEST_TEMPORAL_BINARY`，取值为当前测试二进制绝对路径。验证 Node 退出 0 且 TAP 中该具名用例确实通过。
2. 在同一文件新增 `TestTemporalRetryControlProcess(t *testing.T)` 和 `runTemporalRetryControlFixture() error`。前者只在 `BENTO_TEST_TEMPORAL_REPORT` 非空时执行 fixture 并调用 `os.Exit(0)`；错误写 stderr 后退出 1，避免 Go 测试框架的文本写入 stdio 协议。fixture 用生产 `message` 解码 stdin，初始化真实 `bridge`（`pending` 为空 map）。`start` 回复 `null`，`choose` 用生产 `chooseRun`，首次非空 `enqueue` 回复 `null` 并启动唯一 Workflow goroutine，重复或非法请求返回 fixture 错误。该 goroutine 用 `suite.SetLogger(sdklog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, nil))))` 将 SDK 日志送往 stderr，然后创建 testsuite 环境，注册生产 `bridge.advance` 为 `advanceRun`，设 10 秒测试超时并调用 `ExecuteWorkflow(bentoRun, runID)`。读循环持续按生产 `runTemporal` 的锁和帧 ID 读取 `bridge.pending` 并转交宿主响应。只接受两个不同且存在于 pending 的 Activity 回复，两个回复都须为无错误的 JSON `null`。在启动 Workflow goroutine 前创建容量为 2 的回复 ID channel。读循环每次先把经校验的 ID 写入 channel，再投递回复；拒绝第三次回复，由此避免共享可变 slice。第一次把该回复的 `Value` 清空并把 `Error` 设为 `"injected loss of success acknowledgment"` 后投递；第二次原样投递。Workflow 成功返回后检查 channel 恰有两个 ID，按顺序读取，并写入 `BENTO_TEST_TEMPORAL_REPORT` 指定路径，内容为 `{runId:string,replyIds:string[]}`，先在同目录写 `.tmp` 后 rename。用 channel 将 Workflow 成功或错误传给主循环，禁止在 Workflow goroutine 调用 `t.Fatal`。`close` 等待 Workflow 结果后回复 `null` 并退出，Workflow 失败时返回错误。
3. 在 `service.test.ts` 主测试分支新增具名用例 `Temporal Activity retries a completed Run without repeating its effect`，25 秒超时，独立 Node 套件在 `BENTO_TEST_TEMPORAL_BINARY` 缺失时显式跳过。用 `mkdtemp` 创建隔离目录，按现有项目删除 fixture 的 wrapper 方式生成权限 `0o700` 的 `#!/bin/sh` 脚本。用该用例的单引号转义规则引用测试二进制绝对路径和参数，以 `exec` 运行测试二进制 `-test.run=^TestTemporalRetryControlProcess$`。用例将 `BENTO_GO_CONTROL` 指向 wrapper 并给 wrapper 传临时报告路径 `BENTO_TEST_TEMPORAL_REPORT`。用 `serveExecution` 启动 `localHost(join(state, 'volume'))`，使用 fixture token，`retryMs:20`、`workerTimeoutMs:15000`，Temporal 配置 `{address:'fixture',taskQueue:'fixture'}`。包一层 Worker 计数后委托原 `localHost.worker`。按既有 `project` 和 `submit` 走 HTTP 创建项目并提交唯一 Run，初始 README 为 `# Fixture\n`，prompt 为 `retry effect`。提交后用本用例内的轮询等报告，采用单调时钟 `performance.now()` 固定 12 秒预算，每 20ms 重试，仅将 ENOENT 视为待完成。用例超时设为 25 秒，外层 Go launcher 保持 30 秒。报告轮询超时立即抛错，错误包含 Run ID、12 秒预算和最后一次 ENOENT（作为 cause）。保留 Go fixture stderr，并在 launcher 失败时输出 Node 的合并输出，以便区分 SDK 超时与报告写入失败。核对报告 Run ID 等于 Run URL 尾段、回复 ID 恰为 `['go-1','go-2']`、HTTP Run 为 200/`succeeded`、diff 中恰有一条 `+retry effect`，并读取真实卷 `volume/<project ID>/volume/README.md` 严格等于 `# Fixture\nretry effect\n`，Worker 调用总数为 1。用外层 finally 清理。先在内层 try 关闭已创建的服务，再在内层 finally 恢复两个环境变量原值（原值缺失则 delete），并删除临时目录。即使服务启动或关闭抛错，环境变量恢复和目录清理也必须执行，清理后将错误传给测试。
4. 下列聚焦与 Orchestrator 包验证通过后，在 A6 Readiness 保持「部分实现」，记录实际日期、验证基线、环境、聚焦命令、两次 Activity/一次文件副作用及本轮未覆盖项。删除本文。更新 Readiness 并删除本文后，执行下列最终仓库检查与差异检查。最终门禁通过后，按 MASTER 派发的交付授权和 Worker 流程处理提交与 PR。

聚焦与 Orchestrator 包验证（先于 Readiness 更新和 RUNBOOK 删除）：

```sh
GOPROXY=off GOSUMDB=off go -C apps/orchestrator test -run '^TestTemporalRetryAfterCompletedRun$' -count=3 -v
GOPROXY=off GOSUMDB=off go -C apps/orchestrator test -count=1 ./...
GOPROXY=off GOSUMDB=off go -C apps/orchestrator vet ./...
pnpm --dir apps/orchestrator typecheck
pnpm --dir apps/orchestrator test
```

最终仓库检查（Readiness 更新和 RUNBOOK 删除后执行）：

```sh
pnpm check
git diff --check
search_status=0
report=$(rg -n 'RUNBOOK-A6-TEMPORAL-RETRY' docs 2>&1) || search_status=$?
test "$search_status" -eq 1 && test -z "$report"
```

PASS：聚焦用例三次均实际运行并满足全部断言，Go 套件和 vet 通过，TypeScript 类型检查及 Node 套件通过，Node 独立套件允许仅新增用例因缺少 Go launcher 环境而跳过，`pnpm check` 和差异检查通过，残留搜索恰好退出 1 且 stdout、stderr 均无输出。Orchestrator 套件覆盖本轮测试接线及该包的既有回归，仓库级检查覆盖最终交付状态。

STOP：任一断言失败、聚焦用例被跳过、缓存或本地 Node 入口缺失、需修改生产行为、真实宿主未返回两次成功回复、Readiness 合入窗口冲突。报告失败边界，禁止以替代 Activity、手写 SQLite 终态或人工文件写入替代观测。
