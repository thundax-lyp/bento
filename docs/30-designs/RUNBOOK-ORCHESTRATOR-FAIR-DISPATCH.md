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

## T3：完整验证

前置状态：生产入口双槽用例已提交，`TestTemporalFairDispatchThroughExecutionEntry` 连续三轮通过。

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

PASS：全执行宿主测试、Go test/vet、类型、lint、格式和 diff 检查全部退出 0；纵向用例的通过由 Go 外层检查，TS 全量测试直接跳过须由 Go 纵向测试补足。仅增加测试文件的公开清单条目，生产代码、产品接口和 Compose 配置无差异，因此本次完整验证覆盖执行宿主而无需构建 Web 或容器。

STOP：任一命令失败或主线变化影响步骤；按审计后的基线复核，不自行扩大改动。

## T4：Readiness 与草稿收口

前置状态：T3 PASS，#42 已包含在审核基线中。B 的 PR 先合入，A 随后同步 B 的 Readiness。

允许修改：[Readiness](../40-readiness/CURRENT-READINESS.md) 和本 RUNBOOK（2 文件）。本步计入 2 个文件，无额外专门核对文件。禁止修改其他 Readiness 行。

执行：保留 A6「部分实现」。在 A6 说明追加实测日期、基线、平台、Node/Go 版本、纵向测试命令和三轮结果。记录真实入口 + SDK testsuite 的覆盖范围，写明 429、幂等重放、两槽、空闲租户优先、同租户 FIFO、五次独立文件观测。未覆盖真实 Temporal Server、OpenShell/DSH、长期复用、升级排空、资源上限及 A3。保留现有 A6 证据。删除本 RUNBOOK，核对仅指向它的引用。

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
