# WEB-07 SDK Exec 结果证据 RUNBOOK

2026-11-17。独立代码候选，待审核。基线 `349d09fa24c171aa75d880a0984a18b2264751ff`，分支 `codex/web-07-sdk-outcome`。从 `/Volumes/storage/workspace/bento-a` 执行。T0 审核通过后，只提交本 RUNBOOK，保留未跟踪的 OpenShell 后续稿。每步验收通过后删除该步并提交。STOP 保留现场，回报最后 PASS、具体失败断言与复现命令。

## 目标和边界

[WEB-07/WEB-A12](../10-requirements/WEB-REQUIREMENTS.md) 要求未知副作用阻止重试。[停止与双检查点](./WEB-DESIGN.md) 的现有 SDK retry 门禁继续失败关闭。此切片只建立受信 SDK ingress 的持久结果证据，并证明该证据单独无法开放 retry。#50 的 DSH 检查点校验已在主线。私有卷、实际隔离、部署启用和真实验收分别留给后续。无公开接口、Store 结构、Worker 协议、部署配置或 Readiness 变更。无需 A 实栈租约，也不触碰 B。

正常入口为 `serveExecution → SingleHostExecution.sdkIngress → createSdkIngress → forward`。现有 `Authority.reserveOperation(token,id,input)` 按有效 token 绑定 RUNNING session、generation 与原有 fingerprint，初值 UNKNOWN。 `Authority.observeOperation(session,generation,id,outcome)` 保存终态 SUCCEEDED/FAILED。无新增字段或历史迁移。证据只来自同一上游 mTLS 响应。普通 commandHost 的组装继续不安装可选证据 decoder，现有部署和普通 SDK proxy 路径继续沿用旧行为。

| 基线文件                                              | 行范围                      | LOC |
| ----------------------------------------------------- | --------------------------- | --: |
| `apps/orchestrator/openshell/sdk-ingress.ts`          | 1–267                       | 255 |
| `apps/orchestrator/openshell/worker-gate.ts`          | 20–62                       |  37 |
| `apps/orchestrator/openshell/authority.ts`            | 457–507                     |  47 |
| `apps/orchestrator/openshell/single-host.ts`          | 260–266                     |   7 |
| `apps/orchestrator/execution-service/command-host.ts` | 19–83, 117–145              |  93 |
| `apps/orchestrator/execution-service/service.ts`      | 208–216, 417–427, 1307–1354 |  66 |
| `apps/orchestrator/execution-service/service.test.ts` | 3850–3920, 4171–4259        | 159 |
| 合计                                                  | 7 个代码文件                | 664 |

计数排除空行、纯注释和拟新增测试。用到的既有授权、账本、停止门禁和 HTTP 测试按直接相关段计入。

## T0：锁定独立稿

前置状态：HEAD 为指定基线。允许修改：本文件。禁止修改：原实栈草稿、生产代码与部署。

执行：核对独立审核结论。确认 git 暂存只有本文件后提交审核稿。

验证：

```bash
git rev-parse HEAD
git status --short
pnpm exec prettier --check docs/30-designs/RUNBOOK-WEB-07-SDK-OUTCOME.md
git diff --check
```

PASS：基线、文件范围、审核稿 blob 完全一致。STOP：归属或事实不符。

## T1：用可信 grant 保留 UNKNOWN 并收口严格响应

前置状态：T0 PASS。允许修改：`apps/orchestrator/openshell/{sdk-ingress,single-host}.ts`、`apps/orchestrator/execution-service/command-host.ts`、新增 `apps/orchestrator/openshell/sdk-ingress.test.ts`、本 RUNBOOK。禁止修改：authority schema、公开协议、worker、start 和普通 commandHost 的返回配置。

执行：

1. `SdkIngressOptions` 新增可选内部 `decodeExecEvent(payload: Uint8Array): {kind:"output"} | {kind:"exit",code:number}`。新增 `schemaExecEventDecoder(raw: string): Promise<NonNullable<SdkIngressOptions["decodeExecEvent"]>>`，复用 command-host 已有 `createRequire`、buf/protobuf 和 raw schema 动态加载。只识别显式 stdout/stderr/exit oneof。采用 `fromBinary(..., {readUnknownFields:false})` 及同 schema 的重新编码与原始消息逐字节比对，排除未知字段、重复 oneof/exit 字段及非规范编码。退出码必须是 int32。禁止从默认数值或 EOF 推断 exit。固定 SDK 的显式 exit 0 编码为 `1a00`，合法；空消息、无 oneof 或仅有默认字段均不是退出证据。普通 `commandHost` 不安装该 decoder，由后续受信私有工厂显式传入。
2. `SingleHostExecution.sdkIngress(options, allow)` 只有收到上述 decoder 时，向 `createSdkIngress` 传入内部 `reserveExec(grant: WorkerGrant, payload: Uint8Array): (outcome: "SUCCEEDED" | "FAILED") => void`。 `createSdkIngress` 从原 `grantFor(headers.authorization)` 取得 grant，经过 `gate.channel` 和同步 `gate.require(grant)` 校验 session、run、generation 后，将同一可信 grant 显式传给 `forward`，禁用请求 body 或从 binding 重构 token。首次完整 Exec/ExecInteractive frame 在现有方法/目标/workspace/tty 验证完成后、打开 upstream 或写出任何字节前，使用 `Authority.reserveOperation(grant.token, "sdk:" + randomUUID(), firstFrame.toString("base64"))`。若 reserve 返回 false 或抛错，拒绝上游。closure 捕获该 session、generation、id 调用 `observeOperation`。GetSandbox 不登记。命令、帧、token 不新增持久副本。
3. `forward` 保持既有响应转发与撤权。只有进入跟踪模式时，为同一 upstream call 判断 HTTP 200、严格 `content-type` 为单值 `application/grpc` 或 `application/grpc+proto`、 `grpc-encoding` 及 `content-encoding` 缺失或单值 identity。初始响应也用 rawHeaders 确认 content-type 唯一、每个 encoding header 至多一个。缺 rawHeaders、有 grpc-status 或 trailers-only 均不具证明。原始 trailers 必须只出现一个带 END_STREAM 的块，且其中 grpc-status 恰好出现一次、值为原样字符串 `0`。用 Node `trailers` 的 flags、第三参数 rawHeaders 和归一后 headers 共同校验。重复键、值数组、合并值 `0, 0`、缺失 rawHeaders 或非零值均无证明。离线 loopback 已验证 Node 22 会把重复状态合成 `0, 0` 并保留两个原始键。
4. 在跟踪模式下增量解析未压缩 binary gRPC frame，单帧限 1 MiB，最多只保留一个未完成 frame。stdout/stderr 可多次，出口必须恰有一个并位于最后。收到下一帧、重复出口、未完整帧、非零压缩标记、plain body、protobuf 无效或 decoder 抛错均永久取消本次证据。只有完整 upstream END_STREAM、合法 trailers、exit、无剩余字节且未见 reset（含 `rstCode !== NGHTTP2_NO_ERROR`）、abort、frame error、transport error、下游关闭或授权撤回，才在 end 事件中、结束下游前用同一 grant 同步调用现有 `authorize()` / `gate.require(grant)`。只有校验成功才在同一同步调用栈内执行 closure，退出 0 为 SUCCEEDED，非零为 FAILED。授权已失效或校验抛错则保留 UNKNOWN，不调用 `Authority.observeOperation`。不得依赖 WorkerGate 的 100 ms 轮询或假设 observeOperation 会重新校验 grant。下游关闭或撤权沿用原 `deny/dispose`，上游 abnormal 终止保持 UNKNOWN。证据解析失败继续原转发，不补写状态；账本写入失败保持 UNKNOWN。controller 重启不重发旧 SDK 请求或补结清。
5. 新增 `sdk-ingress.test.ts`，用临时 SQLite、真实 `SingleHostExecution` grant、固定测试帧及 loopback TLS HTTP/2 upstream。短期证书用本机 openssl 在临时目录生成，清理测试状态。测试把合法和不完整响应保留在同一转发实现上。离线固定 SDK 样本由 `sdk-transfer.tar.gz` 的 raw schema 复验，测试中不用私有活动 Gateway。确认至少覆盖：
    - 两种 Exec 与 GetSandbox，exit 0/17、拆帧，首个请求抵达 upstream 时已从独立 SQLite 连接回读 UNKNOWN。普通无 decoder 的原路径能转发且无账本记录。
    - stdout/stderr + explicit exit 及多种反例。错误媒体类型、非 identity、headers 状态、缺/重复或非 0 trailers、普通 body、空 oneof、重复 oneof、出口后有帧、截断/压缩帧、收到 exit 后、final trailers 前的上游 reset，其他 transport failure、下游 abort 或撤权均保留 UNKNOWN。以 schema loader 的合成测试验证存在 exit oneof 时才允许默认数值零。
    - 未授权、旧代 grant、错误 sandbox/workspace 和 reserve 失败均无新增上游请求。断流后的 UNKNOWN 在关闭控制器并重开同 DB 后仍存在。补确定性竞态负控：以长轮询间隔的测试 WorkerGate 打开受信 Exec，先读到持久 UNKNOWN，再通过 Authority 令同一 grant 失效。不要显式撤销 channel，立即从 upstream 发出合法 exit 和 END_STREAM，断言尚未触发轮询、同步授权已拒绝、终态回调未运行且账本仍为 UNKNOWN。

验证：

```bash
pnpm --filter @bento/orchestrator exec node --import ../../register-paths.mjs --experimental-strip-types --test openshell/sdk-ingress.test.ts openshell/management.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：上述断言均实际运行，未授权无上游请求，所有不完整响应未被结清。STOP：转发先于 durable UNKNOWN、无可信完整响应仍结清、普通 host 行为发生漂移。

## T2：锁住 SDK retry 生产门禁

前置状态：T1 PASS。允许修改：`apps/orchestrator/execution-service/service.test.ts` 和本 RUNBOOK。禁止修改：`service.ts::stopAndProve`、正常 HTTP/API、生产 host opt-in、Readiness、私有配置。

执行：

1. 在 `service.test.ts` 新增 `SDK evidence does not enable Task retry without trusted workspace recovery`。复用 `taskRetryTestClient`、`taskRetryTestInput`、`localHost`、Task 停止 barrier 和 `fixtureSdk`。给 host 配置非空 `sdk.decodeExecEvent` 和故意返回肯定结论的 `taskRecovery.retryObservation` spy。Worker fixture 写入后等待取消，使用既有可信退出观察，确保 `takeover` 真实推进该测试的控制账本至新代 READY，拿到正确旧代退出记录。此测试特意不发 SDK 请求，账本为空，模拟最容易误判的条件。
2. 断言取消后原 Task Run 为 needs_review、同 Task 的续写和 retry 均 409，retry reason 为 needs_review，无 stop proof/attempt/restore 调用，且肯定 recovery observation 未被消费。对有无 decoder 两个独立临时状态运行相同断言。SDK 已明确完成仍不能让生产重试抢先打开；代码检查确认唯一 SDK guard 保留，默认启动配置同样没有 opt-in。
3. 执行最终验证后按 WORKER 规则删除本 RUNBOOK 并提交同一步。正式设计仍描述现有 SDK retry 门禁。仅本独立切片进入 PR，保留未跟踪实栈草稿。通过当前 HEAD 的 CI 和 Codex 审查后依 MASTER 的合入顺序交付。

验证：

```bash
pnpm --filter @bento/orchestrator exec node --import ../../register-paths.mjs --experimental-strip-types --test --test-name-pattern='SDK evidence does not enable Task retry' execution-service/service.test.ts
pnpm check
git diff --check
```

PASS：正反 decoder 对照场景均运行，保守门禁成立，全仓检查通过，PR 最终差异限本次代码/测试。STOP：空账本、decoder 或肯定宿主返回独立开放 retry；禁止以私有卷后续工作替代该负控。WEB-07 保持「部分实现」。
