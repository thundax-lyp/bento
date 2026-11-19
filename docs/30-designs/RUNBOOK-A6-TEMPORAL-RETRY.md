# A6-02 真实 Temporal Activity 重投验收 RUNBOOK

## 状态与执行边界

- 建立日期：2026-11-19。
- 状态：`Executable / Implementing`；MASTER审核及计划提交已核对，显式Worker已开工。T1～T7已PASS：全量9/9零skip、CI硬入口与121文件pack正负检查已通过，仅剩完整验证与证据迁移/删除。
- checkout：仅 B；分支 `codex/a6-temporal-retry`，基线 `0f4327470885e32f56296a3afc0ad142d1054a08`，获审计划提交 `acf25388748dc2ac9aeca27af93965c0da5b3cf9`。
- 授权：按MASTER显式Worker派工逐步实施/提交；生产文件保持只读，外部环境仅本任务隔离本地资源。

## 执行者契约

当前按剩余步骤允许修改/验证/提交并向MASTER回报；不扩大到生产修复或共享环境。禁止把 SDK testsuite、TS 同函数调用两次、必需用例 skip 当作真实 Temporal PASS。

后续授权顺序固定为：作者送审本版本 → MASTER `Executable` → 获审分支与独立计划提交核对 → 显式 `$bento-runbook-worker RUNBOOK-A6-TEMPORAL-RETRY.md`。PASS 步骤须删除并与该步产物同次提交；剩余步骤中对已删除STEP的引用替换为实际已存在产物、PASS断言和对应SHA，不改变剩余行为。每步暂存前完整核对diff与公开源范围，不纳入私有工具/证据；最后迁移精确证据、删除 RUNBOOK。

## 目标与当前断点

唯一关闭目标是 [A6-02](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a6-02-bad-case-activity-重试)：Activity 响应丢失或同一尝试重投时复用当前持久执行尝试，并独立核对实际副作用次数和原回执。

预期链路为：内部 HTTP 创建 Task 与 Run → 持久 SQLite 原子预留 → 生产 Go Client 发布 Workflow → 独立真实 Temporal server 调度生产 `bentoRun` / `bridge.advance` → 生产 TS `temporalRuns` / `serveExecution` → 持久授权与本地明确 fixture 的文件副作用、写入回执、Run 结果 → 回包丢失 → Worker/宿主重启 → 原 Workflow 重投 → 原持久 Run 与结果保持一致。

[Readiness](../40-readiness/CURRENT-READINESS.md) 的 A6-02 当前为「部分实现」，`5c8ffb9` 是本地 SDK 重投三轮证据，真实调度仍待验。本轮没有运行新的业务验收，没有改变该状态。

## 正式依据与所有权

- [架构](../00-governance/ARCHITECTURE.md)：Orchestrator 持有 Run 权威状态，Temporal 持有调度历史；当前 TS 宿主持有 SQLite 与授权，Go 负责 Temporal Client/Worker。
- [应用边界设计：Temporal 执行边界](./APPLICATION-BOUNDARIES-DESIGN.md#temporal-执行边界)：Workflow ID 为 `bento-run-<runId>`；Workflow/Activity 只携带业务 Run ID，重投读取权威账本、沿用当前尝试与执行代次。
- [同一部署重启恢复](./APPLICATION-BOUNDARIES-DESIGN.md#状态授权与恢复)：持久账本保留执行尝试和绑定；UNKNOWN 不得因结果未收到而重放。
- [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)、[Document Rules](../00-governance/DOCUMENT-RULES.md)、[Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。

## 已核实生产入口与现有证据范围

| 文件与 symbol                                                                                                   | 已核实事实                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/orchestrator/temporal.go`：`runTemporal`、`temporalCommand`                                               | 真实 `client.DialContext`，真实 `worker.New`；注册 `bentoRun`、`advanceRun`。`enqueue` 使用稳定 Workflow ID、`REJECT_DUPLICATE`，AlreadyStarted 视为接受。        |
| 同文件：`bentoRun`、`bridge.advance`                                                                            | Activity StartToClose=3 小时、HeartbeatTimeout=10 秒，MaximumInterval=10 秒；初次及每 2 秒 heartbeat。`advance` 仅发送 Run ID，等待宿主回包；成功结果为 void。    |
| `apps/orchestrator/execution-service/temporal.ts`：`temporalRuns`                                               | 生产 Go 子进程由 `BENTO_GO_CONTROL` 指定；stdio 收到 advance 后调用传入 callback，成功发送 null。子进程退出拒绝 pending；close 等待子进程 close 和全部 callback。 |
| `apps/orchestrator/execution-service/service.ts`：`serveExecution`、内部 `driveRun`、`worker`、`settle`         | 重投重新 `findRun`，终态 Run 的 driveRun 直接返回；只有 queued 路径启动执行。Task admission 记录 generation/binding；结果持久化后返回 Activity callback。         |
| `apps/orchestrator/execution-service/store.ts`：`Store`、`received`、`recordTaskAdmission`、`publishTaskResult` | 权威 `business.sqlite` 持有 Run、admittedGeneration、receipt、任务结果；业务 Task retry 与 Temporal Activity retry 是不同概念。                                   |
| `apps/orchestrator/execution-service/local.ts`：`localHost`                                                     | 明确 fixture，不调用模型或用户代码；通过生产 operation reservation 后实际 append 文件；Task 写入持久 `FixtureWriteReceipt` 和独立退出记录。                       |
| `apps/orchestrator/openshell/authority.ts`：`Authority`、`operation`                                            | `authority.sqlite` 的 operations 主键为 `(session,id)`，记录 generation/digest/state；不是 Temporal retry attempt。                                               |
| `apps/orchestrator/temporal_test.go`：`runTemporalRetryControlFixture`                                          | 使用 `testsuite.WorkflowTestSuite.NewTestWorkflowEnvironment()`；复用了生产 bridge.advance 与 bentoRun，但没有真实 server。                                       |
| `apps/orchestrator/temporal_test.go`：`runFairDispatchWorkflow`                                                 | 同样使用 SDK testsuite，不是真实 server。                                                                                                                         |
| `apps/orchestrator/execution-service/service.test.ts`：completed Run Temporal retry case                        | 依赖 Go test binary wrapper；普通 TS suite 可 skip；现有副作用/workerCalls 断言不补齐真实 server 缺口。                                                           |

派工提及的 `execution-service/serve.ts` 实际不存在。正常入口是 `apps/orchestrator/execution-service/service.ts` 的 `serveExecution`，不得创建同名替代生产入口。

## 输入、回包与持久证据

### 生产控制协议

`message` 为 `{id:string, method?:string, value?:JSON, error?:string}`，每行一个 JSON。TS 产生 `host-N` 请求 ID，Go 产生 `go-N` callback ID；这些是连接局部请求 ID，不是执行尝试标识。

- start value：`{address:string, namespace?:string, taskQueue:string, slots:1|2}`；namespace 默认 default。测试必须显式专属 namespace，taskQueue 需匹配 `[a-zA-Z0-9_-]{1,128}`。
- choose value：`{slots:number,occupied:{owner:string,status:string}[],queued:{id:string,owner:string}[]}`；返回唯一 Run ID 或空串。
- enqueue value：非空业务 Run ID string；成功返回 null。
- advance value：同一业务 Run ID string；TS 成功 `{id,value:null}`，失败 `{id,error:"Run advancement failed"}`；Go 映射为 Activity error，不返回文件、凭据或业务回执。
- close：成功返回 null；必须等待正常关闭和对应 child close。

### Task 输入与结果

内部 `POST /v1/tasks` 的 body 精确六字段：`id:UUIDv4|null`、`name:string`、`sourceSpaceId:UUIDv4|null`、`inputFiles:{path:string,text:string}[]`、`inputManifest:{fileId:UUIDv4,path:string,bytes:number,sha256:string}[]`、`inputDigest:string`。digest 使用 `snapshotSha256`，文件 sha256 对实际 UTF-8 字节求值。测试固定一个 `README.md`、`# Fixture\n`，每例新 UUID 和创建幂等 key；返回 202 `{task}`，准备完成 GET task.status 为 ready。

冻结快照fixture按[Task生命周期契约](../20-interfaces/WEB-INTERFACE.md#task-生命周期--目标契约)区分blank/snapshot：本轮是非空snapshot，id、sourceSpaceId、manifest.fileId分别使用本例新UUIDv4；sourceSpaceId仅为本地fixture来源标识，不连接真实Space。blank的id/sourceSpaceId均为null、inputFiles/manifest均空，本轮不改该nullable类型或生产语义。逐项对照 `Store.createTask`（store.ts:737–774）及既有 `taskRetryTestInput`（service.test.ts:4151–4171）：六字段仍仅id、name、sourceSpaceId、inputFiles、inputManifest、inputDigest；name固定A6 Temporal Task，README及其原字节不变，manifest仍单条fileId/path/bytes/sha256，inputDigest仍由生产snapshotSha256(inputFiles)计算。T4只把原错误的snapshot sourceSpaceId=null改为randomUUID，不能改其余输入、生产校验或扩展调用链。

`POST /v1/tasks/<taskId>/runs` body 仅 `{prompt:string}`，独立 UUIDv4 idempotency-key；返回 202 `{run}`。GET 同 Run 读取 succeeded；结果从 `/v1/tasks/<taskId>/runs/<runId>/results/1/diff?view=cumulative` 读取 text/plain。重放相同 POST 应为 200、原 Run ID。生产 service bearer 与 owner 仅使用固定无效外部权限的 fixture 值，不读取真实身份环境。

`WorkerRequest` 必需 mode、binding、grant、persistenceUrl、operationUrl；prompt/publicEventsUrl 按生产执行分支产生。binding 为 tenant/project/session/sandbox/volume 五个 string；grant 为 token/session/run/generation，token 禁止进入公开证据。WorkerResult 是 completed/review/recovered。本轮只接受正常 completed，不触发业务 retry。

`FixtureWriteReceipt` 精确字段：sessionId、runId、generation、bindingDigest、operationId、inputDigest、relativePath（README.md 或 bento-demo.txt）、fileSha256。operationId 为 `operationId(runId,'local-demo')`，generation 来自生产 grant，inputDigest 为 prompt sha256。独立父进程读取原始 JSON 字节及目标文件；重投前后必须字节相同，文件中本例唯一 prompt 恰出现一次。

Run 的 receipt 是整数完成标记，不等于完整原回执。须同时比较：business Run 行的 id/projectId/sessionId/status/receipt/admittedGeneration/admittedBindingDigest/diff、结果行、authority operations 行及写入回执字节。不要把 authority 当前 session 的 generation 与原 admittedGeneration 混为一谈：正常 settle 中的 fence 可推进 session generation，重投不得再次推进。

## Scope、Non-goals 与不变量

范围仅 A6-02 的真实调度与成功回包丢失重投，正常派发是前置 Happy Path。单宿主、真实 server、真实生产 Go/TS stdio 和持久 SQLite；执行适配器是明确 localHost fixture。

不覆盖 A6-01 的审批和完整资源策略，不闭合 A6-03～06，不验真实模型、OpenShell、Docker、IdP、S3、共享/远端 Temporal、在途用户代码停止与未知副作用重放。禁止修改 A 的 `service.ts` retryReason/advanceTaskRetry、旧 service retry suite、业务 history checkpoint/restore。若验收暴露必须修改 service.ts，STOP 交 MASTER 排顺序。

必须保持业务 Run ID、Workflow ID、Temporal execution Run ID（同一 Workflow execution）、原 admittedGeneration、operationId 和原回执不变。Temporal Activity attempt 可以增加，但不能生成新业务 Run、业务 retry_attempts 或新执行授权。必须单独观察真实 server 历史及实际文件写入，不能依赖 wrapper 自报 PASS。

## 必要代码规模

以下是已读取且为验收必须核对的既有范围，按非空、非纯注释行去重；不含文档、生成物或未来新增代码。

| 路径                                              | 行范围 / 责任                                                                  | 有效 LOC |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | -------: |
| `apps/orchestrator/temporal.go`                   | 28–275，bridge、Workflow、真实 Client/Worker、发布                             |      239 |
| `apps/orchestrator/execution-service/temporal.ts` | 1–160，生产子进程交接与关闭                                                    |      153 |
| `apps/orchestrator/execution-service/service.ts`  | 1027–1255，执行/回执/settle；1384–1483，driveRun/Temporal callback；两段无重叠 |      316 |
| `apps/orchestrator/execution-service/store.ts`    | 2288–2325，完成与恢复持久标记                                                  |       33 |
| `apps/orchestrator/execution-service/local.ts`    | 530–683，实际文件副作用与写回执                                                |      154 |
| `apps/orchestrator/openshell/authority.ts`        | 34–65，持久执行/operation Schema                                               |       31 |
| `apps/worker/protocol.ts`                         | 3–63，绑定、grant、operation reservation                                       |       55 |
| 合计                                              | 7 个不同代码文件，未把新增测试估算计入                                         |      981 |

## T0：作者独立前置门禁

前置状态：本轮只起草。允许修改：仅本 RUNBOOK。专门核对文件预算为 8：本文件、正式 requirements/design/readiness、`temporal.go`、`temporal_test.go`、`temporal.ts`、`service.ts`。治理和其他 Schema 调查已由作者在 T0 前完成，不让机械执行者扩读。

初轮调查事实（第 5/6 项的未通过状态已由下方最后一次工具恢复覆盖）：

1. `git status --short` 无输出；HEAD、origin/main 均为上述基线，当前分支 main。远端最新 ref 核对以作者最终送审回报为准。
2. 本 checkout 无 ENVIRONMENTS.md。没有使用共享服务或配置；拟使用完全自建 loopback server，无需已有部署连接。仅检查主 checkout 环境文件存在及标题，不复制内容、地址或秘密。
3. Darwin arm64，Node v22.23.2、Go 1.25.3、pnpm 12.15.0。PATH、`/usr/local/bin/temporal`、`/opt/homebrew/bin/temporal` 未发现 CLI。
4. 官方 release API `https://api.github.com/repos/temporalio/cli/releases/tags/v1.5.1` 返回有效 release；published_at=2025-11-03T22:19:38Z。该版本是可固定候选，不声称最新版本。
5. 官方固定 tag 源码 `https://raw.githubusercontent.com/temporalio/cli/v1.5.1/temporalcli/commands.server.go` 可读，证实 dev server 的 frontend IP、port、namespace、持久 DatabaseFile、headless 路径；尚未通过实际 binary help/version 和启动验证。
6. 下载 macOS ARM64 archive 第一次 60 秒零字节超时；第二次在单次 Node 子进程中仅补齐已有 http/https/all/no proxy 大小写，curl 有界 connect-timeout=10、max-time=60，仍以 curl 28、零字节超时结束。没有关闭 TLS 校验、修改全局代理或下载第三方替代工具。

官方 release API 返回的候选 archive digest：

| 平台          | 精确文件名                             | SHA-256                                                          |
| ------------- | -------------------------------------- | ---------------------------------------------------------------- |
| 本地          | temporal_cli_1.5.1_darwin_arm64.tar.gz | cca01b7ea35ad56e2a328d9ae596bf716bd22313ef63c7a761c88354457c2415 |
| CI            | temporal_cli_1.5.1_linux_amd64.tar.gz  | ddc95e08b0b076efd4ea9733a3f488eb7d2be875f8834e616cd2a37358b4852d |
| checksum 清单 | checksums.txt                          | 1b674a6e62e2e582cfd5cd84fa09f58844a2507d4621e0f4278a587ef9095a90 |

精确下载前缀为 `https://github.com/temporalio/cli/releases/download/v1.5.1/`，来源为官方 GitHub release API，传输使用正常 HTTPS。本地 archive 的实际校验见下方“最后一次限定官方传输与工具前置结果”；Linux archive 只核实官方元数据，实际下载/运行留给 CI。

### 官方 asset API 与源码构建追加调查

2026-11-19，MASTER 指定继续作者工具前置调查；以下均在仓库外权限 0700 的任务专属临时目录进行，不涉及业务实现或共享服务。

1. 固定 asset API 为 `https://api.github.com/repos/temporalio/cli/releases/assets/312122449`，请求头 `Accept: application/octet-stream`。官方元数据 size=50272315 bytes，digest 为上表 macOS ARM64 archive 值。第一次有界请求以 curl 18 `Transferred a partial file` 退出，仅收到约 10 MB；本地部分文件 hash 与官方摘要不同，未解压或执行。随后唯一一次 `curl -C -` 有界续传又收到 5544460 bytes 后以 curl 28 超时，仍未得到完整 archive。不继续循环下载；不完整 archive 已删除。
2. 官方 tag API `https://api.github.com/repos/temporalio/cli/git/ref/tags/v1.5.1` 返回 commit `2445cdaeca0d2501a09837e388aa78ba1d65edaa`；`git ls-remote https://github.com/temporalio/cli.git refs/tags/v1.5.1` 独立返回同一 commit。
3. 固定 commit 的 `go.mod` 与 `cmd/temporal/main.go` 正常 HTTPS 可读。模块为 `github.com/temporalio/cli`，go directive 为 `1.25.0`，本机 `go1.25.3 darwin/arm64` 满足；入口为 `./cmd/temporal`，调用 `temporalcli.Execute`。依赖固定包括 Server `v1.29.1`、SDK `v1.37.0`、API `v1.53.0`、SQLite `v1.34.1`、UI `v2.42.1`。
4. 使用单次进程环境 `GOPROXY=https://proxy.golang.org`、`GOSUMDB=sum.golang.org`、`GOTOOLCHAIN=local`，正常 TLS，未修改全局 Go 配置。`go mod download -json github.com/temporalio/cli@v1.5.1` 首次因 sumdb tile TLS `bad record MAC` 失败；一次有界重试退出 0，返回 Origin.Hash 为上述 commit、Origin.Ref 为上述 tag。模块 Sum=`h1:0RZMk14BWxz44Xg6ciDQvpfAMffoG3J7/K03ql80teY=`，GoModSum=`h1:8lfULNGZ1Y2sobXSpY+2qQ4vgR4hYLuTLpqnCIl9Au4=`。这里只证明 CLI 源模块获取与校验，不证明依赖全部可构建。
5. 校验后的源模块 `go.mod` SHA-256=`c3112c2c55745bcc2a6c67d5ed97c6f6aba95e250ad35e24ff63b8a897626737`，`go.sum` SHA-256=`01e147d5b1eda0dc1f7a15b8560807fdca0a3cbe7ced27bf2d1c89760d33c924`。从官方固定 commit 单独取得的 go.sum 与后者一致。源码复制到私有任务目录；没有修改源文件、依赖版本或 Bento lockfile。
6. 唯一一次源码构建固定命令为 `go build -mod=readonly -trimpath '-ldflags=-X github.com/temporalio/cli/temporalcli.Version=1.5.1' -o ../temporal ./cmd/temporal`，cwd 为上述校验源码副本，另固定 `CGO_ENABLED=0`，使用当前 Go 1.25.3。父 Node 持有构建 ChildProcess、600 秒总上限、exit/close 回收；日志权限 0600。构建正常退出 1，尚未触及总上限，未产生 binary。
7. 最小失败原因是必需依赖下载中断：例如 `go.temporal.io/server@v1.29.1: read "https://proxy.golang.org/go.temporal.io/server/@v/v1.29.1.zip": unexpected EOF`；`modernc.org/sqlite@v1.34.1`、`go.temporal.io/api@v1.53.0` 和 `google.golang.org/grpc@v1.72.2` 同类 EOF。未换镜像、关闭 sumdb 或 TLS，也未改版本绕开。

该轮历史结论为 `Blocked`：官方 release archive 不完整，源码必要依赖不可完整获得。以下最后一次限定传输随后解除工具阻断；源码构建没有继续重试，也没有被选为正式工具路径。

### 最后一次限定官方传输与工具前置结果

MASTER 限定最多 8 分钟或 12 次请求，每次不超过 60 秒；正常 HTTPS 与已有系统代理，最多连续两次无进展。实际使用 HTTP/1.1，固定 asset API 一次请求取得 HTTPS 官方 release-assets 重定向，签名 URL 仅在下载进程内存，不写证据或聊天。随后 10 次 Range 请求，每段不超过 5 MiB；均为 206，逐次验证精确 `Content-Range: bytes <start>-<end>/50272315` 和实际字节长度，只有验证通过才按 offset 写入，不接受 200 拼接。累计 11 次请求，无失败重试，未达到预算上限。

最终 archive 大小为 50272315 bytes，SHA-256=`cca01b7ea35ad56e2a328d9ae596bf716bd22313ef63c7a761c88354457c2415`，与官方 release 摘要完全一致。验证后 tar 清单仅 LICENSE、temporal，再提取 binary。binary 权限 0700，SHA-256=`1bde16fafe3ac67706ec90b4b16ce5c42097cf4d0203447a4a59bb44e5c65be7`。这是官方 archive 中的本地提取产物摘要，不是前述失败源码构建的产物。

`temporal --version` 实际返回 `temporal version 1.5.1 (Server 1.29.1, UI 2.42.1)`；`temporal server start-dev --help` 实际确认下列参数。唯一选定工具路径为官方 v1.5.1 release archive，下载器必须保持精确 size/digest 与来源校验，不选择源码构建 fallback。本地 darwin-arm64 已通过，CI linux-amd64 仍须在后续固定 CI 门禁中执行对应 archive 校验与真实测试；不得把本地运行当作 CI 运行。

工具探针使用独立 0700 临时 server 目录、0600 日志和空 env YAML。逐进程移除 `TEMPORAL_*` 与 `BENTO_TEMPORAL_*`，CLI 参数固定 `--disable-config-env --disable-config-file --env-file <私有空env文件>`；不读取部署地址或用户 CLI profile。仅 Node 持有自有 ChildProcess；临时端口由 127.0.0.1 的 port 0 分配并在启动前关闭探针 listener。首次参数为 `server start-dev --ip 127.0.0.1 --port <临时端口> --headless --db-filename <私有temporal.sqlite> --namespace <本次唯一namespace>`。所有角括号参数由探针运行时产生，不是机械执行命令占位符；后续 T1 必须封装到唯一可直接执行入口。

实际结果：首次 `operator cluster health` 退出 0，专属 namespace describe JSON 含原 namespace，DB 已创建；向准确持有的 server child 发 SIGINT，等待 close，退出 0。用原 DB、原端口重启，第二次**不传 namespace 创建参数**；再次 health=0，原 namespace 查询成功。再次 SIGINT/close=0；15 秒正常关闭上限内未使用 SIGKILL；确认 loopback 端口关闭后删除 server 目录。失败路径预设升级 KILL 并 wait close，本次未触发，不声称故障清理路径已实测。

受控脱敏 transfer evidence SHA-256=`d6f897924d3ee287ffb7a48f8139c1746025b2e5c5660c4f9e7740eee3c24dbf`；server probe evidence SHA-256=`060bbe752c86604c2d7d6ced667b9649ed25751bb15465e55f12fb775c1eed55`。工具、完整 archive 和证据留在本任务仓库外私有工具目录供继续作者阶段复用；server DB/日志临时目录已删除，无服务残留。工具不得进入 Git、npm 包或公开白名单。

工具子门禁 PASS：官方 archive 完整大小与摘要、实际 version/help、独立 server 启动/健康/namespace、正常 close、原 DB 重启查询与清理均通过。本轮没有启动 Workflow/Activity 或业务 Run，不构成 A6-02 通过证据。

### T0 baseline 与复用规则

作者已在上述基线执行根 `pnpm check`，退出 0：Workspace API 55/55；既有 Orchestrator 113 tests，111 pass、2 个既有可选 Temporal skip；Go test/vet、Web check/build、Worker typecheck、lint、format 均成功。两个既有 skip 不计入 A6-02；本计划的新 suite 是独立必需门禁，不复用它们的成功判定。作者 `npm pack --dry-run --json` 当前 113 文件，无 node_modules，五个已核实正向文件见 T7。

工具前置、既有检查、生产入口与 Schema 调查构成 T0 PASS；不包含真实业务验收。WORKER 启动时只核对获审计划 commit、上述 baseline 和本地已验 archive SHA，T0 不与 T1 合并。MASTER 若要求纳入新主线，先在安全点报告正式契约、生产只读入口及共享文件变化，作者复审受影响步骤；不得默默更换基线。

## 唯一新增文件、签名与证据契约

所有新增代码限于 `apps/orchestrator/acceptance/temporal-retry/`，以下路径均相对此目录。没有生产逻辑修复。`root` 固定从 `fileURLToPath(new URL('../../../../', import.meta.url))` 得到仓库根（此目录深度为 4），所有 import 跨两级父目录用 `@/`，TypeScript import 显式 `.ts`；.mjs 显式导入 process/console 等 Node 全局依赖，遵循现有 lint。

唯一文件与签名如下。以下类型均为必需字段，无隐式 optional；Node/生产类型用 type import。process.ts 在对应 STEP 创建符号，不提前 import 未来文件。

- `tool.ts`：固定官方工具获取。

```ts
export type TemporalTool = {
    binary: string;
    archiveSha256: string;
    binarySha256: string;
    platform: 'darwin-arm64' | 'linux-x64';
};
export async function acquireTemporal(
    directory: string,
    signal: AbortSignal,
): Promise<TemporalTool>;
```

- `process.ts`：只管理本任务子进程、构建与服务。

```ts
export type OwnedProcess = {
    child: ChildProcess;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
export function own(
    command: string,
    args: readonly string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        log: string;
        ipc: boolean;
    },
): OwnedProcess;
export async function stopOwned(
    owned: OwnedProcess,
    graceMs: number,
): Promise<{
    forced: boolean;
    code: number | null;
    signal: NodeJS.Signals | null;
}>;
export async function runCommand(
    command: string,
    args: readonly string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        timeoutMs: number;
        signal: AbortSignal;
        input: string | null;
    },
): Promise<{ stdout: string; stderr: string }>;
export async function buildControl(
    directory: string,
    signal: AbortSignal,
): Promise<string>;
export async function startControlTransport(
    controlBinary: string,
    directory: string,
    signal: AbortSignal,
): Promise<ControlTransport>;
export async function buildBinaries(
    directory: string,
    signal: AbortSignal,
): Promise<{ control: string; probe: string }>;
export async function startServer(
    tool: TemporalTool,
    directory: string,
    identity: {
        port: number;
        namespace: string;
        createNamespace: boolean;
    },
    signal: AbortSignal,
): Promise<TemporalServer>;
export async function startHost(
    config: HostConfig,
    signal: AbortSignal,
): Promise<HostProcess>;
```

- `control-proxy.mjs`：可执行 stdio 透明代理；从 `BENTO_A6_PROXY_CONFIG` 读取唯一配置路径，连接父验收进程持有的真实Go control transport，帧与关闭契约见下文；不注册Workflow/Activity。
- `probe/main.go`：独立 `package main`；`func readEvidence(ctx context.Context,c client.Client,workflowID,executionID,historyPath string)(Evidence,error)`、`func main()`。真实 Describe/GetWorkflowHistory，不使用 testsuite。
- `host.ts`：导出下文完整 `HostConfig`，`async function main(): Promise<void>` 从 argv[2] 读取该配置并调用生产 serveExecution/localHost；wrapper仅记录worker调用，不改变业务返回。
- `evidence.ts`：独立只读SQL/文件核对。

```ts
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export async function captureBusiness(
    state: string,
    volume: string,
    taskId: string,
    runId: string,
): Promise<BusinessEvidence>;
export function assertOriginal(
    before: BusinessEvidence,
    after: BusinessEvidence,
): void;
export function assertTemporal(
    evidence: TemporalEvidence,
    expected: {
        runId: string;
        queue: string;
        executionId: string;
        retried: boolean;
    },
): void;
```

- `real-retry.test.ts`：唯一Node test入口；`async function runScenario(kind: 'happy' | 'lost-host' | 'lost-server-host', t: TestContext): Promise<void>`，9个固定top-level tests，不并发运行。
- `check-package.mjs`：无参数可执行，root从import.meta定位，实际已安装依赖树npm pack及public白名单正负检查，成功输出固定JSON，失败退出1。

新增 8 个代码文件；必要既有代码仍为前述 7 文件/981 有效 LOC。没有为了达到门槛而要求新增 LOC。

步骤中短文件名只表示以上唯一新目录中的同名文件；生产只读文件短名只表示前文已核实的 `apps/orchestrator/execution-service/` 文件，禁止同名替换。完整预算如下，M为允许修改，R为专门读取，运行编译时的正常依赖加载不计作额外人工读文件。

| STEP | M 完整路径（每行都含本 RUNBOOK）                                                                                                                                                                                                                                                                                  | R 完整路径                                                                                                                                                                                                                        | 总数 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| T1   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/tool.ts`；`apps/orchestrator/acceptance/temporal-retry/process.ts`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`public-files.json`                                                            | `apps/orchestrator/tsconfig.json`                                                                                                                                                                                                 |    6 |
| T2   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/control-proxy.mjs`；`apps/orchestrator/acceptance/temporal-retry/process.ts`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`public-files.json`                                                  | `apps/orchestrator/temporal.go`；`apps/orchestrator/execution-service/temporal.ts`                                                                                                                                                |    7 |
| T3   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/probe/main.go`；`apps/orchestrator/acceptance/temporal-retry/process.ts`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`public-files.json`                                                      | `apps/orchestrator/go.mod`；`apps/orchestrator/temporal.go`                                                                                                                                                                       |    7 |
| T4   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/host.ts`；`apps/orchestrator/acceptance/temporal-retry/evidence.ts`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`apps/orchestrator/acceptance/temporal-retry/process.ts`；`public-files.json` | `apps/orchestrator/execution-service/service.ts`；`apps/orchestrator/execution-service/local.ts`；`apps/orchestrator/execution-service/store.ts`；`apps/worker/protocol.ts`                                                       |   10 |
| T5   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`apps/orchestrator/acceptance/temporal-retry/evidence.ts`；`apps/orchestrator/acceptance/temporal-retry/process.ts`                                                                             | `apps/orchestrator/acceptance/temporal-retry/host.ts`；`apps/orchestrator/acceptance/temporal-retry/control-proxy.mjs`；`apps/orchestrator/execution-service/service.ts`；`apps/orchestrator/execution-service/temporal.ts`       |    8 |
| T6   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`apps/orchestrator/acceptance/temporal-retry/process.ts`；`apps/orchestrator/acceptance/temporal-retry/evidence.ts`                                                                             | `apps/orchestrator/acceptance/temporal-retry/control-proxy.mjs`；`apps/orchestrator/acceptance/temporal-retry/host.ts`                                                                                                            |    6 |
| T7   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`apps/orchestrator/acceptance/temporal-retry/check-package.mjs`；`apps/orchestrator/package.json`；`.github/workflows/checks.yml`；`public-files.json`                                                                                                            | `package.json`；`apps/orchestrator/acceptance/temporal-retry/real-retry.test.ts`；`apps/orchestrator/acceptance/temporal-retry/tool.ts`                                                                                           |    8 |
| T8   | `docs/30-designs/RUNBOOK-A6-TEMPORAL-RETRY.md`；`docs/40-readiness/CURRENT-READINESS.md`；`deploy/README.md`                                                                                                                                                                                                      | `docs/10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md`；`docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md`；`README.md`；`apps/orchestrator/package.json`；`apps/orchestrator/acceptance/temporal-retry/check-package.mjs` |    8 |

固定 root `package.json.files` 比对值如下；T7 checker 必须逐项/顺序 JSON 相等，不从当下package.json动态抄一份当expected。

```json
[
    "register-paths.mjs",
    "shared/text-snapshot.ts",
    "apps/orchestrator",
    "apps/workspace/api",
    "apps/workspace/auth",
    "!apps/workspace/auth/dist",
    "apps/worker",
    "docs/00-governance/ARCHITECTURE.md",
    "assets/architecture.svg",
    "docs/10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md",
    "docs/10-requirements/WEB-REQUIREMENTS.md",
    "docs/20-interfaces/WEB-INTERFACE.md",
    "docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md",
    "docs/30-designs/WEB-DESIGN.md",
    "docs/40-readiness/CURRENT-READINESS.md",
    "deploy/README.md",
    "public-files.json",
    "!apps/**/node_modules/**"
]
```

固定 public.patterns 仅为 `apps/orchestrator/index.ts`、`apps/orchestrator/execution-service/*.ts`、`apps/orchestrator/openshell/*.ts`。临时工具、archive、binary、日志、运行DB和证据都不登记。公开新增正向恰为上述8源，public-files.json现有项保持原样，后合入时只保留MASTER确认的他方新增项，不用本任务固定新增列表删除他方项。

### 工具平台、来源与网络规则

唯一平台分支按 `process.platform + '-' + process.arch`：`darwin-arm64` 选择 asset 312122449、size 50272315、SHA `cca01b7ea35ad56e2a328d9ae596bf716bd22313ef63c7a761c88354457c2415`；`linux-x64` 选择 asset 312122450、size 50408448、SHA `ddc95e08b0b076efd4ea9733a3f488eb7d2be875f8834e616cd2a37358b4852d`；其他平台立即抛 `Unsupported Temporal acceptance platform`，不得 skip。

仅接受可选 `BENTO_A6_TEMPORAL_ARCHIVE`：已存在、绝对路径、位于仓库外的本平台官方 archive。设置时先按固定 size/SHA 全量校验，任何错误立即 fail，不 fallback。未设置时调用固定 asset API，正常 HTTPS 与已有代理，仅单次子进程补齐 proxy 大小写，固定 HTTP/1.1。总上限 480 秒/12 次 HTTP 请求，单请求 45 秒、connect 10 秒；只允许一次官方 API 重定向到 `https://release-assets.githubusercontent.com`。其签名 URL 只在下载进程内存，不写 header 文件、日志或异常消息；Range 响应 header 仅保留 status/content-range/content-length。

下载器通过持有的 curl ChildProcess 以 stdin config 传递 URL（不将签名 URL 放命令行或输出），一次请求接收一个最多 5 MiB 的区间。收到 206 且精确区间/总长/长度匹配后，才以该 offset 写入 0600 archive；200、416、认证失败立即 fail，两次连续无完整合法段或预算耗尽立即 fail，失败删除所有部分 archive。成功需 size 与完整 SHA 同时匹配。`tar -tzf` 20 秒上限，只允许文件名集合 LICENSE、temporal（忽略相同名称的 `./` 前缀），拒绝额外、重复、绝对路径和 `..`；再仅提取 temporal 到 0700 私有目录，chmod 0700，计算本地产物 SHA。Darwin 提取产物必须匹配已核实 `1bde16fafe3ac67706ec90b4b16ce5c42097cf4d0203447a4a59bb44e5c65be7`；Linux 记录提取 hash，来源信任根是已固定 archive SHA，不发明未经核实的 Linux binary hash。实际 `--version` 需精确包含 CLI 1.5.1、Server 1.29.1、UI 2.42.1。不得接受 PATH 任意 binary、源码 fallback、镜像或关闭 TLS/sumdb。

作者本地每个 focused 命令统一使用已验 archive：`BENTO_A6_TEMPORAL_ARCHIVE=/tmp/bento-b-temporal-author-aaOJQ2/release.tar.gz`；该路径只在临时计划及本地命令使用，稳定文档与源码不硬编码。CI 不设置此变量，从官方 asset 按相同校验规则获取。每次调用都重新校验 archive 来源与摘要，不信任历史缓存标记。

### 生命周期和超时

所有路径均来自 import.meta root 或本任务 mkdtemp，不能把 process.cwd 当源码 root。Node父验收进程持有server、真实生产Go control、host和所有命令子进程句柄；host的生产temporalRuns只持有proxy。父以本例私有Unix socket透明连接Go stdio与proxy，不改写正常业务帧。即使生产temporal.ts请求超时SIGKILL proxy，真实Go仍由父的准确ChildProcess句柄管理，不会丢失回收所有权。各层只关闭自己的句柄，不按PID/name/端口搜索杀进程。

`own` 的 stdio 固定 stdin/stdout/stderr 三项 pipe，ipc=true 时第四项ipc；stdout/stderr写入本例0600 log，同时保留pipe供协议读取，不将日志当协议。host启动精确使用当前 process.execPath，args 为 --import、root/register-paths.mjs、--experimental-strip-types、host.ts绝对路径、config路径。`own` 在 spawn 返回后立即绑定 error、exit、close；error 仍需等 close，closed Promise 只由 close 结算，文件日志 fd 在 close 后关闭。`runCommand` 的 input 必需，普通命令传 null、curl config 传内存文本后 stdin.end；输出仅在内存返回，不自动写日志，tool将header筛选后才记证据。stdout/stderr 各上限 8 MiB；超时/abort 先 SIGINT，2 秒后 SIGKILL，再等 close 最多 5 秒；不把 HTTP 响应、命令失败或无输出当成功。进程发送 kill 必须检查返回值，已 close 则不重复发信号。`stopOwned` graceMs 到期后 SIGKILL，5 秒内必须 close；forced 是可观察事实，正常 server/host case 出现 forced 即 FAIL，即使资源已清理。

Server 每例独立 0700 directory，0600 DB/env/log。子进程清除 `TEMPORAL_*`、`BENTO_TEMPORAL_*`，使用禁config-file/env、显式空env YAML；仅连接server的CLI健康/namespace探针另传 `--identity bento-a6-probe`，server start-dev本身不传此client flag；保留既有代理但不得输出。先由 127.0.0.1 port 0 分配端口，关闭探针 listener 再启动；竞争导致占用直接 fail，不换固定端口或连别的服务。namespace=`bento-a6-`+randomUUID，queue=`bento_a6_`+UUID 去连字符；各例唯一且同例重启不变。

`TemporalServer={address:string;namespace:string;port:number;directory:string;process:OwnedProcess;close:()=>Promise<void>}`。startServer 使用已实测 headless/db/ip/port 参数，createNamespace=true 才传 namespace；重启固定 false。健康探针与 namespace describe 最多等 60 秒，CLI 单次 5 秒 deadline/3 秒 connect、外层 8 秒、轮询 500ms；成功前必须确认 server child 未退出。正常 close SIGINT/15 秒，禁止把 KILL 说成正常关闭。关闭后 port connect 必须 ECONNREFUSED；timeout/其他错误不算端口关闭。

`HostConfig={schema:1;state:string;volume:string;proxyDirectory:string;controlBinary:string;address:string;namespace:string;taskQueue:string;mode:'pass'|'drop'}`，全部必需；state/volume/proxyDirectory均位于本例根，controlBinary位于本轮suite工具目录且是本轮编译产物，address 仅 127.0.0.1:临时端口。配置 JSON 0600。host.ts argv 只能该配置路径；其 service 参数固定 token=`fixture-only-bento-a6-service-bearer`、bindHost=127.0.0.1、port=0、workerPort 三项=0、retryMs=20、workerTimeoutMs=15000、host=localHost(volume) 包装、temporal 使用配置。单槽，不启用 warm pool。

startHost先创建父持有的真实Go control/ControlTransport，再启动host；HostProcess另必需 control:ControlTransport 和 dropControl:()=>Promise<void>。host.ts为Node IPC子进程，消息仅 `{type:'ready',url:string}`、父发 `{type:'close'}`、子发 `{type:'closed'}`、错误 `{type:'error',code:'host_start_failed'|'host_close_failed'}`。ready 最长 25 秒。close、IPC disconnect、SIGINT/SIGTERM 均进入同一个幂等 close Promise：await service.close → 发送 closed（IPC仍可用时）→ disconnect → 自然退出；不调用 process.exit 抢先丢 stdio。close 后父等 host close 最长 25 秒。若超时，父直接调用持有的control.close（stdin.end/5秒→KILL/5秒并等close），结束transport，等proxy/5秒，再对准确host句柄SIGKILL/5秒；记录 FAIL，不修改断言或删掉未确认停止的目录。host 的进程 env 单独设置 BENTO_GO_CONTROL，不修改父进程 process.env。

为启动 .mjs proxy，host 在 proxyDirectory 写 0700 `control` shell wrapper，仅 `exec` 当前 Node 绝对路径与 `control-proxy.mjs` 绝对路径，逐参数使用 POSIX 单引号且转义内嵌单引号；不得插入 `eval` 或命令替换。proxy 忽略生产传入的单个 temporal argv，拒绝其他参数。配置通过独立 env `BENTO_A6_PROXY_CONFIG`；Go由父startControlTransport以固定argv `['temporal']` 启动。proxy正常关闭仍暂扣Go的close ack，待父准确观察Go close并落control-closed marker、结束socket后才向TS转发ack；proxy本身没有Go子进程。

父 test 的 `t.after` 与 try/finally 共用幂等 scope close，顺序：取消等待 → 关闭host（先service/proxy，再父持有的Go control/transport）→ 关闭所有探针/构建命令 → server.close → 验证 control/proxy/host/server close 和端口关闭 → 删除本例状态/volume/DB/log 目录。任一失败仍尝试后续自有清理，以 AggregateError 返回；close 未确认时保留该例私有目录并输出脱敏失败阶段，不宣称已清理。SIGINT/SIGTERM 触发同样清理。父 host IPC 断开和 proxy stdin EOF 均下传关闭。外部 SIGKILL 整个 Node 测试 runner、机器掉电和 OS 泄漏清扫不属本轮证明范围；不得把这些未测边界写入成功证据。

### 代理故障与审计文件

`ControlTransport={socketPath:string;process:OwnedProcess;close:()=>Promise<void>}`由父startControlTransport创建。每个业务case根目录固定`mkdtemp('/tmp/bento-a6-')`，两平台均使用该本地路径，权限0700。socket为各host incarnation目录中的c.sock，UTF-8路径须小于100bytes，chmod0600；不得占用/覆盖既有socket。父先listen该socket、spawn真实生产Go（cwd=root/apps/orchestrator、argv仅temporal、stdio三项pipe、继承env但不读BENTO_GO_CONTROL）；stdout缓冲到唯一客户端接入后透明转发，socket data原样写Go stdin。socket结束/错误要求父关闭Go stdin，按5秒→KILL/5秒回收；必须等真实child close后写control-closed marker，再结束连接、关闭listener。stdout EOF不能充当child close。父始终保留OwnedProcess，proxy被KILL或host异常都能准确回收Go。

proxy配置精确`{schema:1,socketPath:string,directory:string,mode:'pass'|'drop'}`，不接受binary路径或外部网络地址。proxy只连接该私有socket，与生产temporalRuns保持JSON line stdio。每个host incarnation新directory/socket，重启modepass且沿用业务state/volume/server identity。每帧上限8MiB，验证id:string、method?:string、error?:string；只转发生产JSON，不重命名Run或生成结果。

`events.ndjson`每条`{schema:1,seq:number,event:'connected'|'advance'|'reply-forwarded'|'reply-held'|'control-closed'|'proxy-closing',runId:string|null,frameId:string|null}`，seq从1递增，不含token/prompt/config。收到真实Go advance时记真实runId/frameId；对应TS成功null帧在pass模式转发，在drop模式第一次暂扣并flush/原子写`held.json={schema:1,runId:string,frameId:string}`。Go heartbeat继续供父独立观测，不伪造error或testsuite重投。

父完成held边界独立证据后调用host.dropControl，原子写`command.json={schema:1,command:'drop'}`。proxy每20ms检查，仅drop模式且已held才接受，丢弃暂扣frame并写`drop-ready.json={schema:1,discarded:true,runId:string,frameId:string}`。父等drop-ready/5秒，再对自己持有的真实Go child SIGKILL，等close/5秒；父落`control-closed.json={schema:1,code:number|null,signal:string|null,reason:'normal'|'dropped'|'shutdown'|'spawn-error',closed:true}`，dropped必须signal=SIGKILL，然后关闭socket。proxy读到EOF且回读父control-closed后写`proxy-closed.json={schema:1,controlClosed:true}`并自然退出。代理不能自行写control-closed或声称Go已停；父必须以实际OwnedProcess.closed另核同一事件。

正常Go close ack先被proxy暂扣；父观察Go close/code0，写reason=normal marker后结束socket；proxy确认marker后先落proxy-closed.json，再转发原close ack并自然退出；真实proxy close由host的生产temporalRuns.close等待确认，marker本身不代替实际close。command=shutdown、proxy stdin EOF、SIGINT/SIGTERM或协议错误均结束socket，父进入同一control.close；父也可直接control.close，不等待proxy协作。spawn error由父own等close后落reason=spawn-error，不启动host/proxy。协议错误退出非0，不输出原frame。marker同目录.tmp写入+rename、0600、flush=true，拒绝重复/非指定命令。held最多30秒，超时结束socket并FAIL。socket EOF而无control-closed最多等5秒，仍无marker则FAIL，不伪造close成功。

`worker-calls.ndjson` 由 host wrapper 在调用 localHost.worker 前 flush 一条 `{schema:1,runId:string,sessionId:string,generation:number,mode:'execute'|'recover',bindingDigest:string}`；不写 token。每次传入全部原 request/signal/slot/onWorkerExit，不改变本地 fixture 的结果。固定追加到 state/worker-calls.ndjson，同例重启不清空；父读取该文件，即已汇总所有 incarnation，必须恰一条 execute、零 recover。文件实际内容与原回执另独立验证。

### 真实 server history Probe

Go probe 使用现有 orchestrator go.mod 的 SDK/API，无新增 dependency。旗标全部显式：`--address`、`--namespace`、`--workflow`、`--execution`、`--history-out`；首次 execution 为 `""`，其余查询使用首次真实 Describe 返回的 execution Run ID。address 校验 loopback，namespace 前缀 bento-a6-，workflow=`bento-run-`+业务UUID；history-out 绝对路径且位于本例 directory。命令 context 总上限 8 秒，父 runCommand 10 秒。任何 Dial/Describe/history iterator/payload decode/写证据错误退出 1，不打印部分成功 JSON。

先 DescribeWorkflowExecution 得到 WorkflowExecutionInfo 的 workflowId/runId/type/taskQueue/status 和 pendingActivities；然后 GetWorkflowHistory 使用**该 execution Run ID**、wait=false、ALL_EVENT，遍历全部 pages。protojson 原 history 写入 0600 history-out；stdout 用 encoding/json 输出以下完整 `TemporalEvidence`：

```ts
type TemporalEvidence = {
    schema: 1;
    workflowId: string;
    executionRunId: string;
    workflowType: string;
    taskQueue: string;
    status: 'running' | 'completed' | 'other';
    workflowInput: { count: number; runId: string };
    workflowStarted: number;
    workflowCompleted: number;
    workflowFailed: number;
    continuations: number;
    scheduled: {
        eventId: string;
        activityType: string;
        taskQueue: string;
        input: { count: number; runId: string };
    }[];
    started: { eventId: string; scheduledEventId: string; attempt: number }[];
    completed: { scheduledEventId: string; startedEventId: string }[];
    pending: { activityId: string; attempt: number; started: boolean }[];
    historySha256: string;
};
```

int64 event ID 以十进制 string 输出。status 显式对比 API RUNNING/COMPLETED 枚举，其他=other；pending.started 对比 PENDING_ACTIVITY_STATE_STARTED，不依赖枚举 String 命名。workflow/activity payload count 必须为 1，使用 SDK DefaultDataConverter 解出 string，失败即错误。由真实 event 类型计数，不用“成功回包两次”代替 history。activity retry 的中间 started 事件可能被 server 合并；最终以 ActivityTaskStarted.attempt≥2 证明 retry，不强求 history 出现两条 Started。completed 的 scheduled/startedEventId 必须关联原同一 Scheduled 和最终 Started。

### 独立业务证据

`BusinessEvidence` 所有字段必需：`run:SqlRow`、`results:SqlRow[]`、`checkpoints:SqlRow[]`、`exits:SqlRow[]`、`projectionEnds:SqlRow[]`、`events:SqlRow[]`、`retryAttempts:SqlRow[]`、`dispatches:SqlRow[]`、`session:SqlRow`、`operations:SqlRow[]`、`receiptBytes:string`、`exitBytes:string`、`workspaceText:string`、`workerCalls:SqlRow[]`。文件原始 UTF-8 string 保留精确字节，hash 另外计算；SQLite null-prototype rows 转为普通对象。每次 DatabaseSync readOnly=true，BEGIN 一致读取该库后 COMMIT/finally close，不写状态或跑恢复。

business.sqlite 固定查询：`SELECT * FROM runs WHERE id=?`（必须一行），`task_run_results/task_run_checkpoints/worker_exit/task_projection_ends` 各按 runId 查询，`task_events WHERE runId=? ORDER BY sequence`，`retry_attempts WHERE taskId=? ORDER BY id`，`run_dispatches WHERE runId=?`。authority.sqlite 读 `execution_sessions` 只选 session/tenant/project/sandbox/volume/generation/state/run 和 `(capability IS NOT NULL) AS hasCapability`，禁止复制 capability/expiry 凭据；operations 按 session 读 session/generation/id/digest/state、ORDER BY id。两库仅在 held/terminal 安静边界分别读取，不能声称跨库单事务。

文件路径：volume/<taskId>/task-volume 为 localHost 受控 symlink；readlink 后需 `volume-UUIDv4` 且 realpath 位于该 task 私有目录，才读该卷的 README.md。写回执位于 volume/<taskId>/writes/<runId>.<admittedGeneration>.json，退出记录同根 exits/<runId>.<generation>.json；均独立读取并与上方生产 receipt/exit 类型逐字段比对。receipt.operationId 使用生产 operationId(runId,'local-demo')、bindingDigest 使用生产 executionBindingDigest，generation 必须等于 admittedGeneration，文件 hash 与 receipt.fileSha256 相同；exit 中 sessionId/runId/generation/bindingDigest/exitedAt 全部非空匹配，exitedAt 为有效日期。

正常预期：Run succeeded、receipt=1、taskSequence=1、retryOf=null、admittedGeneration=1；结果、checkpoint、worker exit、projection end 各恰一条；零业务 retry_attempts；authority session READY、run=null、hasCapability=0、generation=2；operation 恰一条，generation=1、id=原 operationId、digest=sha256(sha256(prompt))。成功路径可保留 UNKNOWN operation 状态，此处固定按现有代码断言 UNKNOWN，不擅自把它标 SUCCEEDED，也不扩大为未知副作用恢复验收。README 精确 `# Fixture\n`+唯一 prompt+`\n`，原文件中 prompt 整行只出现一次；workerCalls 恰一 execute/零 recover。

结果 body 是持久 `task_run_results.body` 原 string，字段固定 version=1、baselineSha256、initialSha256、afterSha256、incremental、cumulative、incrementalSha256、cumulativeSha256、summary、checks=[]；summary=`Run completed.`，createdAt 独立列保留。每次 GET cumulative diff 须等于 body.cumulative，增量同理。held 与最终 snapshot 的所有业务/authority 数组、原 receiptBytes/exitBytes/workspaceText 原样 deepEqual；workerCalls 允许把各 incarnation 文件合并，但合并后仍恰一条。Temporal callback 日志的次数另计，不混进业务相等性。

输出证据 `CaseReport={schema:1,case:'happy'|'lost-host'|'lost-server-host',head:string,cliVersion:'1.5.1',serverVersion:'1.29.1',workflowId:string,executionRunId:string,activityAttempt:number,workerExecutions:1,receiptSha256:string,workspaceSha256:string,sqlBeforeSha256:string,sqlAfterSha256:string,historySha256:string,passed:true,cleanup:{hostClosed:true,controlClosed:true,serverClosed:true,directoryRemoved:true}}`。只在断言和清理全部成功后输出 passed。可选 `BENTO_A6_EVIDENCE_DIR` 仅接受仓库外绝对目录，创建0700；设置时复制脱敏 before/after JSON、写回执/退出记录、history、proxy events 与 CaseReport（0600），不复制 token/config/binary/DB。未设置时只打印 CaseReport，不保留状态目录。保持证据目录与必须清理的运行目录分离。

## 机械执行步骤

下列命令 cwd 均为仓库根。各步只有获审 Worker 可执行；本作者回合不执行。验证使用 test-name-pattern 选择已创建的固定用例，允许 Node 对不匹配用例显示未选中，但所选 case 必须实际 PASS、不得 skip；T7/T8 全量运行九项，必须 skip=0。pnpm typecheck 运行时读取的依赖不等于专门人工核对文件预算，专门读文件已逐步穷举。

### T8：完整验证、证据迁移与临时计划删除

前置状态：全量suite9/9、0skip已实际PASS（运行代码HEAD3b3ecf1898f53b0c9f1dda44f7d893df5311c87f），pack121文件正负/八源精确public/原rootfiles/类型/lint/format均通过，门禁接线源码和前置提交可回读；尚未修改Readiness。共享文件若被A合入，先由MASTER固定新基线与复验窗口；本步不自选合入顺序。
允许修改：本 RUNBOOK、docs/40-readiness/CURRENT-READINESS.md、deploy/README.md（3）；专门核对：正式APPLICATION-BOUNDARIES-REQUIREMENTS、APPLICATION-BOUNDARIES-DESIGN、README.md、apps/orchestrator/package.json、check-package.mjs（合计8）。禁止修改：正式需求/架构口径、相邻A6状态、生产代码和A任务证据。

执行：

1. 根完整 `pnpm check` 使用以下私有evidence目录输出三例运行记录；本轮代码head用实际git rev-parse，记录与测试产物一致，不能用未来commit。该次包含新9项、既有Go/TS/Web/API等和pack检查；成功后不重复没有受影响的新全量检查。
2. Readiness A6-02改为已实现，仅依据本轮全部必需case适用PASS；A6父项仍部分实现，更新真实调度/重投范围及未覆盖项。A6-01只可在原说明追加“本轮正常派发为A6-02前置，不覆盖审批/完整资源”，状态保持原值；A6-03～06、A3等不动。证据section写日期/实际代码SHA/CLI1.5.1和Server1.29.1/独立localHost fixture/真实Go+TS+Temporal/3case/9tests0skip/原receipt及SQL/文件独立核对/三类关闭与清理事实、证据摘要、真实模型/OpenShell及未知在途恢复等未覆盖边界。
3. deploy/README.md新增“独立本地 Temporal Activity 重投验收”小节，仅引用稳定脚本 `pnpm --dir apps/orchestrator test:temporal-retry`，说明平台规则、官方版本/SHA验证、内部loopback/独立DB/正常关闭清理、网络或依赖失败硬停止及使用本平台已验archive env的规则（不写个人绝对路径）；不改Compose启动/共享服务命令。不改ARCHITECTURE或正式design，因为本轮没有生产语义变化；README现有deploy入口覆盖此小节，无新增一级入口则保持。
4. 文档证据迁移后删除本 RUNBOOK，用下方rg核对无仅指向它的残留；对收口文档format/check-package与diff检查。任何验证失败留在本步，不能删除RUNBOOK提交。最终提交只含本步骤文档同步/删除，随后按Worker Skill的一PR/Codex/同HEAD CI/普通merge全流程另行交付。

验证：

```bash
BENTO_A6_TEMPORAL_ARCHIVE=/tmp/bento-b-temporal-author-aaOJQ2/release.tar.gz BENTO_A6_EVIDENCE_DIR=/tmp/bento-b-temporal-author-aaOJQ2/business-evidence pnpm check
node apps/orchestrator/acceptance/temporal-retry/check-package.mjs
pnpm exec prettier --check docs/40-readiness/CURRENT-READINESS.md deploy/README.md
git diff --check
rg -n 'RUNBOOK-A6-TEMPORAL-RETRY' --glob '!RUNBOOK-A6-TEMPORAL-RETRY.md' docs deploy README.md public-files.json
```

PASS：pnpm check与后续检查全成功，三例CaseReport代码SHA一致、九项真实执行无skip；rg期望无匹配（退出1），全部正式事实和Not Covered已迁移，临时RUNBOOK删除。检查文件链接指向存在的稳定源；检查最终diff无秘密/本地私有路径/原始日志。提交 `Docs(execution-service): 记录真实 Temporal 重投证据与验收入口`，向MASTER报告分支/commit与原证据位置，进入PR交付。
STOP：任何必需结果缺失/受新代码影响、文档需要更改正式语义、删除后残留引用或A共享窗口未定；保留计划、明确最后PASS STEP和SHA、命令/实际脱敏输出与恢复所需决定。不把工具探针/SDK模拟当三例业务PASS。

## 验收矩阵与完成定义

本轮没有新增公开 API、授权、数组批量操作或数据库业务转换，因此公开非法输入/跨owner/capability/stale version/数组部分非法原子性/业务事务注入为 `Not Applicable`（不改变这些行为，既有 baseline 仅作为回归，不冒充本轮新验收）。适用的幂等/终态/持久恢复/原回执与文件结果一致性都由上述三个真实case验证；内部代理非法帧、子进程spawn/超时/关闭失败属于本轮新增测试设施错误语义，必须硬失败并清理，不能映射为业务成功或公开新错误码。

| 用例                   | 必须独立观察的 PASS                                                                                                                                                                                                                  | 失败处理                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 正常派发               | 新 Task ready、新 Run succeeded；真实 server 历史含 bentoRun、advanceRun、原 Run ID；文件一次写入、写回执与结果一致；Activity 首次成功。                                                                                             | STOP，不能先做故障用例凑完成。               |
| 成功回包丢失与宿主重启 | 丢弃发生在宿主持久成功之后且 server 尚未确认 Activity 完成；生产 Go Worker 确实退出；同 SQLite、namespace/queue 重启后 server 实际重投；原 Workflow/execution、业务 Run、admission、operation/receipt/结果保持一致，实际文件仅一次。 | 保留脱敏诊断，关闭自有进程；不放宽断言。     |
| server 与宿主重启      | 同故障边界停止独立 server，原持久 server DB reopen；同 workflow execution 最终完成，满足上一行全部不重复断言。                                                                                                                       | 不转新 namespace/新 DB 掩盖恢复失败。        |
| 幂等重放与终态         | 相同 Run 请求原 key 返回原 Run；所有故障重投均无新业务 retry_attempts、无新 operation、原结果和原写回执字节一致。                                                                                                                    | 不把 Activity attempt 当业务新 attempt。     |
| 资源归属与故障清理     | 所有自有子进程 close；正常与失败路径均无残留监听或临时目录，无共享资源操作。                                                                                                                                                         | 报准确残留及最后关闭点，禁止粗暴杀共享进程。 |
| CI 与发布              | 必需 suite 进入固定 CI，实际执行且无 skip；已安装依赖树 npm pack --dry-run --json 按原 files/patterns 验证，排除所有 node_modules、CLI/Go 私有 binary、日志与 DB；新增公开源逐项登记。                                               | 网络/下载缺失是门禁失败，不是假 PASS。       |

原始历史与诊断仅留受控目录；公开证据不含 token、环境秘密或私有地址。公开 Readiness 需记录日期、精确代码 SHA、CLI/server 版本、三类用例、独立副作用和原回执断言、实际命令与无 skip 结果。A6 父项保持部分实现；A6-01 和 A6-03～06 不因此闭合。真实模型/OpenShell、未知在途副作用、心跳/双侧停止、配额资源、长期池与升级排空明确 Not Covered。

只有完整范围与必需门禁实际通过、长期证据迁移完成才可删除 RUNBOOK。本轮没有完成上述验收，不能删除或声明完成。
