# Orchestrator 双槽公平派发与背压验收 RUNBOOK

## 状态与执行者契约

2026-11-13，审核草稿。工作目录 `/Volumes/storage/workspace/bento-b`。审核基线 `1197cc8229d0fd12c6ade37bb7c0de566108db8d`，已包含 PR #42。执行入口与调查基线相同，#42 的 Readiness 改动仅涉及 WEB-06 和 WEB-08。独立审核通过且收到显式开工指令后，才允许执行 T0–T4。B 的 PR 先合入，A 随后同步 B 的 Readiness。每步只能修改其列出的文件并按顺序执行。PASS 要求命令退出 0 且各断言满足。STOP 时记录最后通过步骤、路径、符号、命令、预期与实际脱敏输出，按本手册清理测试资源，保留代码现场供复核。

## 目标、依据与范围

[应用与编排边界需求 A6](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)要求提供配额、公平性和背压证据。[平台架构的当前实现接线](../00-governance/ARCHITECTURE.md#当前实现接线)及[边界设计的 Temporal 执行边界](APPLICATION-BOUNDARIES-DESIGN.md#temporal-执行边界)规定 Go 负责选择与编排，TS 条件预留并推进稳定 Run ID。证据缺口是同一条启动与请求链尚未联合验证这些现有行为。

验收链从 [Compose 所使用的 Node 入口](../../deploy/compose.yaml) `apps/orchestrator/execution-service/start.ts:main` 启动，走受信宿主模块、实际私有 HTTP、真实 SQLite、TS stdio 客户端、Go 的 `chooseRun` 与 `bridge.advance`、宿主双槽和本地文件卷。Temporal Server 由现有 Go SDK testsuite 替代。子进程为测试二进制的独立测试模式，真实 Go `runTemporal` 的 Client/Worker、网络 poll 和部署镜像不在本次证据内。受信模块使用本地 fixture 实现文件与会话 I/O。外部模型、OpenShell、真实长期池复用、资源上限、升级排空、A3 接管故障以及调度算法变更不在范围内。排空契约缺口记录于既有本地调查稿。跨租户公平断言限于“一个 A 占槽，B 无占用，B 优先于 A 等待队头”的可控场景。

## 接口、所有权与不变量

- `execution-service/http.ts:executionHttp` 校验服务 bearer 和 `x-bento-owner-id`。`POST /v1/projects/<projectId>/runs` 请求体为 `{prompt:string}`，必需 `Idempotency-Key`。`store.ts:Store.addRun/enqueueRun` 在事务内校验项目和 owner，原 key 和 prompt 重放返回 200 和原 Run ID。新 Run 返回 202，ID 由 SQLite 写入前的 `randomUUID()` 生成，时戳来自现有 `now()`。满额返回 429，JSON 为 `{error:{code:"tenant_queue_full",message:string}}`。上限针对同 owner 的 `queued` 行，包含已预留排队行。
- `service.ts:work` 从 `Store.dispatchSnapshot` 取得必需的 `{slots:1|2,occupied:{owner:string,status:string}[],queued:{id:string,owner:string}[]}`，数组按 SQLite 顺序；Go `temporal.go:chooseRun` 返回 Run ID 字符串或空串。TS 检查返回前后的快照并调用 `Store.reserveDispatch` 进行容量和状态条件写入，然后对 `Store.schedulableRuns` 发布 `enqueue`。`running/recovering/cancelling` 与已预留的 `queued` 计入容量。空闲租户先行，同租户仍有排队预留时跳过，其他情况依序选择。生产 Workflow ID 是 `bento-run-<runId>`，测试环境按业务 ID 隔离 Workflow。
- Go `bentoRun` 只接收 Run ID，`bridge.advance` 以同一 ID 经 stdio 调用 TS。宿主回调检查状态与预留，分配槽号 0 或 1；`driveRun` 用 `Store.start` 条件写入 `running` 后才给 Worker 启动授权。执行授权来自现有账本，模式为 `execute`，`request.grant.run`、`request.binding.tenant/project` 与 HTTP 接受结果一致。完成回执与 fencing 经现有路径落账，HTTP 可见 `succeeded`，本地卷可独立读取。测试观测仅保存 ID、owner、项目、槽号和顺序。
- 不新增业务字段、Schema、协议帧、错误码、领域事件、数据迁移或公开入口。既有持久化、重启恢复与 UNKNOWN 行为沿用现有契约。测试用信号、清理与文件标记只作用于本轮临时进程和目录。

## 规模和文件边界

基线代码范围相对 `apps/orchestrator/`。计数排除空行、纯注释、生成物与文档。包括直接复用和为验收必须核对的既有链路。同一行只计一次。

| 路径                                | 行范围与 LOC                                |
| ----------------------------------- | ------------------------------------------- |
| `temporal.go`                       | 90–128（36），230–255（26）                 |
| `temporal_test.go`                  | 23–45（22），71–210（138）                  |
| `execution-service/temporal.ts`     | 10–160（145）                               |
| `execution-service/service.ts`      | 606–690（76），710–724（13）                |
| `execution-service/store.ts`        | 518–594（76），752–823（68），852–865（13） |
| `execution-service/service.test.ts` | 637–742（106），1644–1708（64）             |
| `execution-service/http.ts`         | 189–210（22），229–245（17）                |
| 合计                                | 822 LOC，7 文件                             |

此外核对 `execution-service/start.ts:main`、`execution-service/local.ts:localHost`、[部署手册](../../deploy/README.md#temporal-配置)和 `deploy/compose.yaml` 的入口。计划改动含两个现有测试文件、一个 POSIX Go 测试文件、公开文件清单中的对应条目和收口用 Readiness。T4 删除临时草稿。

## T0：固定基线与执行边界

前置状态：PR #42 已合入。独立审核通过且显式开工指令已记录。该指令须给出审定稿 SHA-256，执行者将它原样赋值给 `BENTO_APPROVED_RUNBOOK_SHA256` 并导出。该值来自审核记录，不能从本地文件重新推导。

允许修改：0 文件。T0 两阶段之间仅允许在获授权的执行分支上提交审定 RUNBOOK 本身。

禁止修改：审定稿、生产代码、测试和 Readiness。

本步计入 10 个文件，含本 RUNBOOK、`apps/orchestrator/temporal.go`、`apps/orchestrator/temporal_test.go`、`apps/orchestrator/execution-service/{start,temporal,service,store,service.test,http}.ts` 六个文件及 `docs/40-readiness/CURRENT-READINESS.md`。核对入口、测试、符号及 A6 行。

### T0.1 计划提交前

执行：在执行分支首次提交前确认源码基线和审定稿内容，复验执行宿主。验证通过后，按开工授权仅将审定 RUNBOOK 纳入独立计划提交。当前草稿路径受 Git 忽略规则约束，仅对该精确路径强制暂存。

验证：

```bash
(
  set -eu
  runbook=docs/30-designs/RUNBOOK-ORCHESTRATOR-FAIR-DISPATCH.md
  test "$(git rev-parse HEAD)" = 1197cc8229d0fd12c6ade37bb7c0de566108db8d
  test -z "$(git status --porcelain=v1 --untracked-files=all)"
  test "$(shasum -a 256 < "$runbook")" = "${BENTO_APPROVED_RUNBOOK_SHA256:?缺审定稿 SHA-256}  -"
  GOPROXY=off GOSUMDB=off pnpm check:orchestrator
  git diff --check
)
```

PASS：命令均退出 0，Node 单 Run 跨进程用例直接调用时允许预期跳过，由 Go 入口执行；Readiness 的 A6 现有证据完整。STOP：基线、工作树、审定稿 SHA、符号、环境或验证结果与本节不一致。

### T0.2 计划提交后、T1 开始前

执行：确认源码基线是当前 HEAD 的祖先和直接父提交，计划提交仅新增审定 RUNBOOK，提交对象与工作树文件都匹配审定 SHA-256。

验证：

```bash
(
  set -eu
  base=1197cc8229d0fd12c6ade37bb7c0de566108db8d
  runbook=docs/30-designs/RUNBOOK-ORCHESTRATOR-FAIR-DISPATCH.md
  approved=${BENTO_APPROVED_RUNBOOK_SHA256:?缺审定稿 SHA-256}
  git merge-base --is-ancestor "$base" HEAD
  test "$(git rev-list --parents -n 1 HEAD)" = "$(git rev-parse HEAD) $base"
  test "$(git diff --name-only --no-renames "$base" HEAD)" = "$runbook"
  test "$(git diff --name-only --no-renames --diff-filter=A "$base" HEAD)" = "$runbook"
  test -z "$(git status --porcelain=v1 --untracked-files=all)"
  test "$(git rev-parse "HEAD:$runbook")" = "$(git hash-object --no-filters "$runbook")"
  test "$(shasum -a 256 < "$runbook")" = "$approved  -"
  git diff --check "$base" HEAD
)
```

PASS：命令均退出 0，当前 HEAD 是唯一计划提交，源码基线与审定稿均得到验证。STOP：祖先、提交内容、工作树、哈希或空白检查不匹配；停止在 T1 前，报告 HEAD、计划变更路径与实际哈希。

作者已于 2026-11-13（Asia/Shanghai）在 `1197cc8` 上复验。macOS arm64、Node 22.23.2、Go 1.25.3。类型检查、Go 测试和 vet 通过。Node 29 项通过，1 项预期跳过。新场景尚未实现或执行。

## T1：多 Run Go 测试控制进程

前置状态：T0.1 和 T0.2 均 PASS。

允许修改：`apps/orchestrator/temporal_test.go`（1 文件）。本步计入 3 个文件，另核对本 RUNBOOK 和 `apps/orchestrator/temporal.go`。

禁止修改：已有单 Run 丢回包 fixture、生产 Workflow、stdio 协议及调度策略。

执行：

1. 新增 `TestTemporalFairDispatchControlProcess(t *testing.T)`。`BENTO_TEST_FAIR_DIR` 为空时 `t.Skip`；有值时调用 `runTemporalFairDispatchControl(dir string) error`，成功用 `os.Exit(0)` 防止 Go test 把 PASS 写进 stdout，失败将原因写 stderr 并 `os.Exit(1)`。用现有 `message`、`bridge` 和与 `runTemporal` 相同的 scanner 缓冲区（初始 64 KiB，上限 8 MiB）。stdio 上每行一个 JSON；stdout 仅协议输出。
2. `start` 只接受一次，校验 `value` 的 `address:"fixture"`、`namespace:"default"`、`taskQueue:"fair-dispatch"`、`slots:2`，回复 `{id,value:null}`。启动后的 `choose` 解码生产 `dispatchSnapshot`，只接受 2 槽，调用生产 `chooseRun`，原 ID 回复 `value` 为选择字符串。空字符串正常。
3. `enqueue` 必须在 start 后，`value` 为非空、通过 `^[a-f0-9-]{36}$` 校验的业务 Run ID。reader goroutine 持有已发布 ID 集合，重复 ID 立即报错退出。先回复 `{id,value:null}` 再为该 Run 启一个独立的 `testsuite.WorkflowTestSuite` 环境，执行生产 `bentoRun`，超时 40 秒。testsuite logger 写 stderr。注册 Activity 名 `advanceRun`，用同一共享 `bridge` 调 `advance(ctx, id)`。每个 Workflow 的 Activity 调用计数使用独立 `atomic.Int32`，第一次校验收到本 Run ID 后调用 `b.advance`，任何 ID 不符或重试返回 `temporal.NewNonRetryableApplicationError`，错误类型固定 `FairDispatchFixture`。运行结束还须断言一次 Activity 调用，成功创建空文件 `done-<runId>`，以同目录临时文件再 rename 发布。任何 Workflow、次数或标记 I/O 失败，诊断写 stderr 后退出 1。
4. 无 method 的入站帧是 Activity 回包。按现有 `b.pending` 加锁查找，未知 ID 立即报错。成功帧必须是 `value:null` 且无错误。每个回包 ID 仅可出现一次，由 reader 的集合检查。合法帧交给该 ID 的通道。拒绝其他 method、start 之前的请求和提前 EOF。 `close` 仅在所有已发布 Workflow 均结束、成功标记齐备时确认；用 `sync.WaitGroup` 等待已启动的 Workflow，再回 `{id,value:null}` 并结束 scanner 循环。由于 T2 在发 SIGTERM 前验证全部 `done-<runId>`，该等待不依赖 reader 再消费帧。fixture 用测试父进程的进程组超时兜底；生产 Go 关闭协议没有变化。

验证：

```bash
gofmt -w apps/orchestrator/temporal_test.go
GOPROXY=off GOSUMDB=off go -C apps/orchestrator test -run '^(TestDispatchHonorsCapacityAndTenantFIFO|TestTemporalRetryAfterCompletedRun|TestTemporalFairDispatchControlProcess)$' -count=1
```

PASS：现有 Go 策略与单 Run 测试通过，直接调用的多 Run helper 因无环境变量跳过。T2 经真实入口驱动 helper。

STOP：生产帧或符号漂移、既有测试失败、或 helper 需引入生产改动。

## T2：生产入口的双槽纵向场景

前置状态：T1 PASS。

允许修改：新增 `apps/orchestrator/temporal_fair_entry_test.go`，修改 `apps/orchestrator/execution-service/service.test.ts` 和 `public-files.json`（3 文件）。本步计入 10 个文件，另核对本 RUNBOOK、`apps/orchestrator/temporal_test.go`、`apps/orchestrator/execution-service/{start,service,store,http,local}.ts` 五个文件。

禁止修改：`start.ts`、生产 TS/Go 代码、worker 模块、部署配置及 HTTP 契约。

执行：

1. 在 `public-files.json` 的 `apps/orchestrator/temporal_test.go` 条目后添加 `apps/orchestrator/temporal_fair_entry_test.go`。在 `temporal_fair_entry_test.go`（`//go:build darwin || linux`，`package main`）新增 `TestTemporalFairDispatchThroughExecutionEntry(t *testing.T)`，沿用 `TestTemporalRetryAfterCompletedRun` 的 `os.Executable`、子 Node TAP 检查与诊断写法。Node 用同一现有 `--import` 和 `--experimental-strip-types` 参数，`--test-name-pattern` 精确匹配 `^execution entry enforces two-slot tenant fairness and queue backpressure$`，子进程环境注入绝对路径 `BENTO_TEST_FAIR_BINARY`。Go 创建外层临时目录（`os.MkdirTemp`，前缀 `bento-fair-entry-`），以 `BENTO_TEST_FAIR_DIR` 传给 Node 测试。Go 用 `SysProcAttr{Setpgid:true}` 启动 Node 测试，该进程 PID 是专用组 ID。实际服务和 Go stdio 子进程继承此组。使用 `Start`，保存组 ID 后通过 goroutine 调用 `Wait`。Go 在 75 秒超时或 `Wait` 失败时以 `syscall.Kill(-pid, syscall.SIGKILL)` 清理整组，仅忽略 ESRCH。正常路径 `Wait` 返回后，以信号 0 验证组消失；若仍存在，强杀整组并判失败。强杀后最多等 5 秒回收主进程并每 20 ms 检查组是否消失。只有确认组消失才删除外层临时目录，否则保留目录并报告 PID。stdout 和 stderr 共用一个由 `os/exec` 写入的缓冲区，Wait 回收后才读取；未回收时只报告超时和组 ID。必须找到 `ok 1 - execution entry enforces two-slot tenant fairness and queue backpressure`，并确认该行无 `SKIP`。
2. 在 TS 测试文件新增上述精确名称的测试，超时 65 秒，缺 `BENTO_TEST_FAIR_BINARY` 时显式 skip。使用 Go 创建并传入的 `BENTO_TEST_FAIR_DIR` 作为本轮状态目录，在其中生成 0700 POSIX shell wrapper，沿用现有 shell 单引号转义，`exec` 测试二进制并带 `-test.run=^TestTemporalFairDispatchControlProcess$`。另生成受信 `host.mjs`，以 `new URL('./local.ts', import.meta.url).href` 在父测试解析为绝对文件 URL 后嵌入模块源码。状态、卷、标记与 wrapper 都放在该临时目录。Go 外层负责删除目录和异常进程组兜底。
3. 受信模块默认导出 `({state}) => ExecutionHost`，从 `localHost(join(state,'volume'))` 展开，设 `workerSlots:2`、`warmWorker:()=>async()=>{}`，以现有 `fixtureSdk` 的值提供隔离 SDK 配置（本地回环不可达的 upstream，空凭据，workspace default，decode 抛错）。Worker 包装 `base.worker(request,signal,slot)`。仅接受 `request.mode==='execute'` 和指定的五个 prompt `A0,A1,A2,A3,B0`。在第一次 await 前从进程内计数器取得单调 `sequence`、增加当前活动数并计算 `peak`。先同步完整写入 `entered-<prompt>.tmp-<sequence>`（`wx`），再用同目录 `linkSync` 原子发布到 `entered-<prompt>` 并在 finally 删除临时名。最终文件内容必须为 `{sequence:number,active:number,peak:number,slot:0|1,run:string,tenant:string,project:string}`。最终名已存在时保留原始记录，写空的 `duplicate-<prompt>` 作为失败证据，再抛错。只把 link 的 EEXIST 视作重复，其他异常直接抛出。Worker 每 20 ms 用可被 `signal` 中止的等待检查 `release-<prompt>`，上限 35 秒，超限抛错；存在时调用本地 Worker，最终在 finally 减少活动数。Worker 进入记录使用同步独占写入，release 标记使用异步文件检查。异常除缺 marker 的 ENOENT 外直接向上抛出。
4. 像已有 `documented startup installs trusted review and waits for its cleanup` 用 `process.execPath`、`process.execArgv` 和实际 `start.ts` 路径启动服务，设置 `detached:false`，继承 Go 外层专用组，stdin ignore，stdout/stderr pipe，持续消费 stderr 并保存最后 8 KiB。环境从 `process.env` 排除全部 `BENTO_` 项，再精确设置 `BENTO_STATE_DIR`、`BENTO_SERVICE_BEARER=testToken`、`BENTO_BIND_HOST=127.0.0.1`、`BENTO_PORT=0`、`BENTO_HOST_MODULE`、`BENTO_TENANT_QUEUE_LIMIT=2`、`BENTO_GO_CONTROL`、`BENTO_TEST_FAIR_DIR` 为临时目录、`BENTO_TEMPORAL_ADDRESS=fixture`、`BENTO_TEMPORAL_NAMESPACE=default`、`BENTO_TEMPORAL_TASK_QUEUE=fair-dispatch`。URL 来自 stdout 首行，与启动退出和 5 秒截止竞速。fixture 地址只传给 Go 测试模式。
5. 使用现有 `client/project/submit` helper，为 owner `fair-a` 创建五个独立 ready 项目 A0/A1/A2/A3/A4，为 `fair-b` 创建一个 B0。必须先建立全部项目，再发首个 Run。每次提交使用相同的 prompt 和 key（例如 A0 的 prompt 与 key 均为 `A0`）。用 `until` 观察 marker 或 HTTP 状态，marker 读取只吞 ENOENT。每个进入 marker 校验 Run ID、owner、project 与对应 HTTP 路径一致。
6. 按下表执行屏障。释放动作仅通过父测试用 `writeFile(...,{flag:'wx'})` 写空文件。等待下一阶段前读取当前可观测证据，不用固定 sleep 推断调度结果。

| 阶段         | 动作                                                                         | 通过断言                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 占满两槽     | 提交 A0，等 entered A0；提交 A1，等 entered A1                               | 顺序 1/2，槽 0/1，两个 HTTP Run 均为 running，A1 记录 active=2、peak=2                                                                                                                                                                   |
| 观察背压     | 提交 A2、A3；在 A4 项目用 key/prompt A4 提交；同 key/prompt 重放 A2；提交 B0 | A2、A3、B0 均为 queued；A4 返回 429 与 `tenant_queue_full`，A4 的 GET runs 返回 200 且 JSON 深比较精确等于 `{runs: []}`；A2 重放 200 且 ID 不变                                                                                          |
| 空闲租户优先 | 只释放 A0，等待 entered B0                                                   | B0 sequence=3、slot=0、active=2、peak=2；A1 仍 running，A2/A3 仍 queued                                                                                                                                                                  |
| 租户内 FIFO  | 释放 B0，等待 entered A2；释放 A2，等待 entered A3                           | A2/A3 分别 sequence=4/5、slot=0、active=2、peak=2，A1 仍 running                                                                                                                                                                         |
| 收尾         | 释放 A3 和 A1                                                                | 五个 HTTP Run 均 succeeded；每个 Run 对应一个 `done-<runId>`；entered 集合正好是五个指定文件，duplicate 集合为空；五个本地卷的 `<state>/volume/<projectId>/volume/README.md` 全文分别为 `# Fixture\n<prompt>\n`，A4 为原文 `# Fixture\n` |

7. 成功时给服务 PID 发 SIGTERM，5 秒内等 close，退出必须是 `[0,null]`。失败时停止发 HTTP，向服务 PID 发 SIGKILL 并最多等 close 5 秒。只在成功取得本轮服务 PID 时发送信号。统一关闭 readline，并向外层 Go 返回成功或失败。Go 按步骤 1 核对并清理组内残留，服务 PID 的 close 不作为整个组退出的证明。断言失败附最后 8 KiB stderr，保留可复现的阶段信息。不得保存 bearer 或授权 token。

验证：

```bash
gofmt -w apps/orchestrator/temporal_fair_entry_test.go
pnpm exec prettier --check apps/orchestrator/execution-service/service.test.ts
GOPROXY=off GOSUMDB=off go -C apps/orchestrator test -run '^TestTemporalFairDispatchThroughExecutionEntry$' -count=3
```

PASS：连续三轮每轮均出现精确 PASS，所有 HTTP、顺序、槽位、卷文件、Workflow 标记和退出断言成立。

STOP：环境缺 Node 22、POSIX 进程组、Go 或本地依赖；存在测试超时、夹具错误、非 fixture 地址、断言失败或需要改变生产代码。按步骤 7 清理，不放宽断言或增加重试掩盖失败。

## T3：完整验证

前置状态：T2 PASS。

允许修改：0 文件。本步计入 7 个文件，含本 RUNBOOK、`public-files.json`、根 `package.json`、`apps/orchestrator/package.json`、`apps/orchestrator/temporal_test.go`、`apps/orchestrator/temporal_fair_entry_test.go` 和 `apps/orchestrator/execution-service/service.test.ts`。禁止更新证据或改变验证范围。

执行：在主线同步后的工作目录从仓库根执行以下命令。

验证：

```bash
GOPROXY=off GOSUMDB=off pnpm check:orchestrator
pnpm exec eslint apps/orchestrator/execution-service/service.test.ts
pnpm exec prettier --check apps/orchestrator/execution-service/service.test.ts public-files.json
rg -n -F '"apps/orchestrator/temporal_fair_entry_test.go"' public-files.json
git diff --check
```

PASS：全执行宿主测试、Go test/vet、类型、lint、格式和 diff 检查全部退出 0；T2 的真正通过由 Go 外层检查，TS 全量测试直接跳过须由 Go 纵向测试补足。仅增加测试文件的公开清单条目，生产代码、产品接口和 Compose 配置无差异，因此本次完整验证覆盖执行宿主而无需构建 Web 或容器。

STOP：任一命令失败或主线变化影响步骤；按审计后的基线复核，不自行扩大改动。

## T4：Readiness 与草稿收口

前置状态：T3 PASS，#42 已包含在审核基线中。B 的 PR 先合入，A 随后同步 B 的 Readiness。

允许修改：[Readiness](../40-readiness/CURRENT-READINESS.md) 和本 RUNBOOK（2 文件）。本步计入 2 个文件，无额外专门核对文件。禁止修改其他 Readiness 行。

执行：保留 A6「部分实现」。在 A6 说明追加实测日期、基线、平台、Node/Go 版本、T2 命令和三轮结果。记录真实入口 + SDK testsuite 的覆盖范围，写明 429、幂等重放、两槽、空闲租户优先、同租户 FIFO、五次独立文件观测。未覆盖真实 Temporal Server、OpenShell/DSH、长期复用、升级排空、资源上限及 A3。保留现有 A6 证据。删除本 RUNBOOK，核对仅指向它的引用。

验证：

```bash
pnpm exec prettier --check docs/40-readiness/CURRENT-READINESS.md
git diff --check
test ! -e docs/30-designs/RUNBOOK-ORCHESTRATOR-FAIR-DISPATCH.md
code=0
result=$(rg --hidden --no-ignore -n 'RUNBOOK-ORCHESTRATOR-FAIR-DISPATCH' docs README.md deploy 2>&1) || code=$?
test "$code" -eq 1 && test -z "$result"
```

PASS：命令退出 0；Readiness 仅 A6 证据追加；当前任务文件集合只有三个测试文件、公开清单和 Readiness。

STOP：证据与测试输出不匹配、A6 现有证据会被覆盖、或同步后复验未通过。
