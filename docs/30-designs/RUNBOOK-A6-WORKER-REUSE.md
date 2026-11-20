# A6-05 生产运行时与跨 Session 池重用

## 状态与执行者契约

- 建立日期：2026-11-20。状态：T0/T1/T2/T3/T4通过，待执行T5；定向只读stat fixture修订已获MASTER批准并通过。T2使用获审本地受控SDK输入，不宣称默认网络准备已恢复。
- 唯一 checkout：`/Volumes/storage/workspace/bento-b`。调查基线：`fe12c24ddb6d2a061559173e623419d5aa97b99b`；此 SHA 不是未来验收通过声明。
- 原计划及受控SDK输入修订已获MASTER审核Executable；T2已完整验证，按全流程授权继续剩余步骤。最终merge仍须MASTER明确放行A安全点。
- 实施继承 WORKER 全流程授权；按 [Worker Skill](../../.agents/skills/bento-runbook-worker/SKILL.md)逐步验证、删除已完成步骤并提交。每步文件数包含本文、允许修改及专门核对的文件，最多 10。
- PASS 必须同时满足实际退出码、断言与版本；缺项、skip、版本漂移、隐藏选择、额外依赖均 STOP。STOP 保留现场，回报最后通过步骤、SHA、复现命令、脱敏结果和所需决定。
- A 冻结当前候选的 Worker 镜像生产依赖。B 可在独立 checkout 实施、本地安装和验证新闭包，不触碰 A 的锁文件、镜像或候选；合入 main 前必须等 A 冻结 T5/T6 安全点并取得 MASTER 显式顺序放行。不预设 B 先合入，不要求 A 当前候选因 B 本地工作提前重建。

## 目标、正式依据与当前断点

正式依据：[A6-05](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a6-05-bad-case-跨会话池重用)规定长期重用后凭据、监听器、连接、缓存不串 Session；[架构](../00-governance/ARCHITECTURE.md#架构决策)规定共享 Worker、当次授权、可信 harness 在沙盒外；[部署手册预热约定](../../deploy/README.md#配置执行服务)要求每轮独立 runtime，回执前关闭 Agent、连接和监听器。引用锚点已按当前标题核对。

交付一条生产链：可信配置 → `apps/worker/base-bootstrap.ts` → 每轮官方 Cordis/DSH runtime、真实 OpenShell provider 与当次 SDK client → 正常 `run-worker.ts --warm` → 原 `prewarmedWorker` → 下一 Session 同 PID；旧授权撤销后拒绝，review/异常则旧 PID 退出后补位。

| 当前入口                                                                                 | 已确认事实                                                          | 本次处理                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| `apps/orchestrator/execution-service/command-host.ts::commandHost`                       | `prewarmWorker` 选择生产 `prewarmedWorker`                          | 只读，不改宿主及 retry                    |
| `apps/orchestrator/execution-service/warm-worker.ts::startSlot/warmSlot/prewarmedWorker` | 正常回执保留进程；review/异常等待退出后补位                         | 保持语义，用真实生产子进程验收            |
| `apps/worker/run-worker.ts::main`、`dsh-worker.ts::runDshWorkerLoop/runDshWorker`        | 每轮 bootstrap，finally 等 dispose 后才回执                         | 只读；bootstrap/dispose 抛错不能回成功    |
| `apps/orchestrator/openshell/provider-lifecycle/runtime.ts::createOfficialRuntime`       | A2 官方装配，无 OpenShell provider/client；不构成 execute 生产 base | 只读参考，禁止改共享 runtime              |
| `apps/worker/task-bootstrap.ts`                                                          | 加载私有 base；缺投影时 Task fail closed                            | 保持；本次 base 不承诺 Task 投影/工具目录 |
| `apps/worker/provider.ts::installOpenShellProvider`                                      | 固定 rc.1 provider 每次装配；工作目录注入修正在此                   | 原样复用，不复制和修改安全原语            |

A6-01/04 暂缓：`service.ts::reviewRun` 是 UNKNOWN 恢复复核，不能当正常审批；槽位、排队和输出限制不能代替 CPU/内存/PID/磁盘上限。两项 Readiness 不改。A6-05 单独验收，不要求把 A6-01 一并判为已实现。

## Scope 与 Non-goals

Scope：补交正式 Worker base、明确官方 SDK 连接所有权、正常同 PID 多 Session 长期重用、四项独立证据、撤权及清理失败后的安全退出补位、默认门禁和打包验证。

Non-goals：A 的镜像/私有 bootstrap/远端资源；`service.ts`、`store.ts`、`remote-session.ts`、checkpoint、OpenShell 生产安全原语的修改；新增模型厂商协议、模型选择、通用工具目录、Task 投影、PTY/SSH、CPU 等资源治理、多节点、容器/真实 OpenShell 进程停止证明。模型与远程 helper 为受控服务器，不能据此宣称 A5 或真实部署就绪。禁止改 CI、TLS、安全策略或降低既有九项真实 Temporal 门禁。

## 固定官方依据与连接选择

以下版本源码已作者核对，不猜测 `client.close()`：

- [OpenShell client.ts](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/sdk/typescript/src/client.ts)：公开 `new SandboxClient(transport)`；`execInteractive` 返回 `closeInput()`、`cancel()`、`done`。`OpenShellClient.connect()` 没有公开 close。
- [官方 transport.ts](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/sdk/typescript/src/transport.ts)：bearer 是 interceptor 的逐请求 header；固定 SDK package-lock 的 Connect/connect-node 均 `2.1.2`。
- [Connect transport](https://github.com/connectrpc/connect-es/blob/v2.1.2/packages/connect-node/src/node-transport-options.ts)：`createGrpcTransport` 接受公开 `sessionManager`。
- [manager 结构接口](https://github.com/connectrpc/connect-es/blob/v2.1.2/packages/connect-node/src/node-universal-client.ts)：仅 `authority`、`request(method,path,headers,options):Promise<ClientHttp2Stream>`、`notifyResponseByteRead(stream):void`。
- [官方 manager](https://github.com/connectrpc/connect-es/blob/v2.1.2/packages/connect-node/src/http2-session-manager.ts)：`abort(reason?):void` 不等于等待 session close。因此本次只实现上述公开结构接口，持有单个原生 Node HTTP/2 session 并等待其 close，不读取官方 manager 私有字段，不复制其重连算法。
- 固定 `dsh-sandbox-openshell@0.1.0-rc.1`：`OpenShellSubprocessRuntime` 的 fiber teardown 终止 interactive handle 并等 `transportClosed`；filesystem 有每实例 `namespace/paths`，旧 targetKey 在新实例 `processPath` 拒绝。连接配置的 interactiveClient 由调用方拥有。
- 固定 Cordis `4.0.5`：`on()` 由 fiber.effect 持有，dispose 移除 listener；固定 SessionStore 的 `get/list` 可查询存活 Session。

SDK 源码以官方 `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47` 为唯一版本，接受现有 `openshell/binding-grants/sdk.ts::prepareSdk` 校验的完整归档 SHA、lock、生成配置及官方 build；验收从返回 `raw` 的同目录取得 `index.js`。生产部署配置引用该已准备的只读模块；本次不把尚未发行的 SDK 当作 npm 固定版本，不把版本声明字段当源码完整性证明。

## 生产 API、配置及数据所有权

新增 `apps/worker/sdk-transport.ts`：

```ts
export function createRunSdkTransport(
    gateway: string,
    token: string,
): {
    transport: import('@connectrpc/connect').Transport;
    close(): Promise<void>;
};
```

- gateway 必须精确为 `http://127.0.0.1:<port>`，port 为 1..65535；URL 不含 username/password/path（除 `/`）、query、fragment。输入必须是可信 WorkerRequest 的 gateway，不读 Gateway/mTLS/用户传入 URL。现生产 `service.ts::listen` 正是此格式。其他协议/host/端口一律拒绝；不设置 insecure TLS 或外部代理。
- token 仅捕获当次 grant.token，校验无控制字符；interceptor 每次覆盖 `authorization=Bearer <token>`。没有配置级服务 bearer、mTLS 或刷新 token API。
- 私有 manager 每轮只持有一个 `node:http2.connect(origin)` session，禁止关闭后重连。状态仅 opening/open/closing/closed；connect/stream error 使在途 promise 拒绝，不吞错伪装 completed。
- ready 最长 5 秒。`request` 等 ready，再检查未 closing，调用原 session.request，并跟踪 stream close；`notifyResponseByteRead` 为无 keepalive 的空操作，不缓存用户数据。GOAWAY 后新请求拒绝，不自动新建连接。
- close 单次 promise：先置 closing 拒绝新请求，销毁仍在途 stream，session.close；2 秒仍未关闭则 destroy，5 秒仍无 close 以资源残留错误拒绝。必须观察真正 session 的 close，不能以调用 close/destroy 或 manager.state 代替。错误只含阶段、stream 数、closed 布尔值，不含 URL/token/header。

新增 `apps/worker/base-bootstrap.ts` 默认导出 `DshWorkerBootstrap`，并导出 `BaseBootstrapConfig`、`ModelAdapterFactory` 类型：

```ts
export type BaseBootstrapConfig = {
    schema: 1;
    sdkModule: string;
    modelAdapterModule: string;
    provider: string;
    model: string;
    workspaceRoot: string;
    helper: string;
    fileSystemHelper: string;
    node: string;
};
export type ModelAdapterFactory = (options: {
    provider: string;
    model: string;
}) => Promise<{
    adapter: import('@deepseek-ai/dsh-llm').LlmAdapter;
    dispose(): Promise<void> | void;
}>;
```

所有字段 required、非 nullable、无默认；schema 固定 1。`BENTO_DSH_RUNTIME_CONFIG` 是可信、只读 JSON 的绝对路径；未知字段拒绝。sdkModule/modelAdapterModule 是绝对现存文件，provider/model 非空；后三个 helper/node 与 workspaceRoot 都是沙盒内绝对路径，无 NUL/CR/LF。配置不能指定 Session/Run/tenant/sandbox/token/gateway；它们唯一来自 WorkerRequest。sdkModule 必须导出函数型 SandboxClient，modelAdapterModule 默认导出 factory；不提供任意 ctx/plugin/runtime/provider 替换接口。

Model factory 每轮调用，只收到 provider/model；必须返回新 LlmAdapter 和该轮 disposer，不能返回 singleton、跨轮缓存或未关闭传输。base 用 WeakSet 拒绝重复 adapter 实例（不强引用旧实例/授权），拒绝多余返回字段。模型凭据由受信 adapter 自己读取并持有到本轮清理，不把 grant 交给 factory。验收厂商/模型响应为 fixture，此扩展契约不能证明任意第三方恶意 factory 的内部安全性；生产部署必须选满足该契约的 adapter。

每轮 owner 与调用顺序固定：

1. 校验 config/request 的 binding.session===grant.session、run 非空、generation 为正整数；配置错误在创建资源前拒绝。recover 不创建 SDK transport，不安装 provider，不调用模型 factory。
2. 每轮新 Context、AgentHandle Set。execute 创建 transport、官方 SandboxClient；provider 固定 helper/node/workspaceRoot、`defaultMode='workspace-write'`、`requireFullEnforcement=true`，sandbox 来自 binding；SDK 调用必须携带既有 provider 强制的无 PTY 语义。
3. 返回 runtime.ctx；`runDshWorker` 原入口先装 remoteSessionPersistence。runtime.initialize 顺序：AgentRegistry → SessionStore → SessionProjectionRegistry → LlmRuntime → SystemPrompt → ToolRuntime → AgentLoop → checkpointPolicy，然后注册本轮 adapter。创建/恢复 AgentHandle 都加入 Set。保留官方原事件，不重写/filter 历史。
4. `runDshWorker` 原入口调用 installOpenShellProvider 后才执行该轮。agents facade 只映射真实 handle.agent；使用弱映射将消费侧 agent 还原为官方 agent；flush 精确校验 ctx.sessions.get(grant.session) 与 handle.agent.session 同一对象，再官方 flush。沿 A2 已核实的最小字段断言适配生产消费的事件类型，不使用全形状 `as unknown as`。
5. `userMessage` 用官方 createUserMessage。base 不增加工具目录，不实现 publicEvents；收到 Task 投影请求时沿原 Worker 入口 fail closed，不能回空投影冒充 Task 完成。effect 参数不被模型 factory 获得；本次没有新工具副作用包装，实际 SDK 执行仍经既有生产 SDK ingress 账本。
6. dispose 为单次 promise：从本轮Set取快照并先clear（不再由base二次显式调用），逐一await真实AgentHandle.dispose（即使某个失败继续下一项）→注销adapter→await ctx.fiber.dispose（含RemoteSession/真实provider teardown）→await SDK transport.close→await adapter.dispose。全部错误收集，非空则抛单错或 AggregateError，不返回 completed/recovered。bootstrap 自身在返回前失败也执行同一清理链，保留原错及清理错误。recover 无 adapter/transport 时跳过对应阶段。

AgentHandle双重结构所有权已按固定`dsh-agent`声明及`dsh-agent-loop/lib/index.js`核对：consumer持有handle，AgentLoop factory/fiber也是structural owner；内部`teardown()`用`disposing ??= promise`共享同一次清理，`dispose()`的finally释放owner/scope effect，`untrack()`在teardown finally移出liveAgents。Cordis原effect wrapper在首次结束后被移除，重复调用可返回undefined，不能把通用effect disposer误当“每次都等待”的API。因此base必须先显式await每个handle的完整dispose结算，再开始root fiber dispose，不并行跑二者；不能通过对handle.dispose打第二层patch改变官方owner关系。正常路径每个Agent只发生一次底层teardown/session detach；失败路径仍untrack/继续下一handle及其余阶段。错误按阶段handle→unregister→fiber→transport→adapter顺序收集，保留各阶段实际错误及其官方AggregateError，不按message去重吞错；最终单错直接抛、多错AggregateError。观察facade不额外disposehandle/fiber/transport。T3用真实官方handle正常/撤权路径验证先handle后fiber不会重复close；用独立部分失败单测验证所有后续阶段仍执行，不以fake计数替代官方正常幂等验证。

不新增持久表/公开 HTTP/DTO/事件。Run、generation、capability、事务、receipt/outbox 仍由既有生产控制面持有；base 仅用当次 request，不缓存授权。同部署重启沿现有 SessionPersistence stat/open/reconcile 和 generation fencing；本次不增加恢复规则、迁移或双写。

## 必要代码规模与依赖闭包

已逐文件按基线全文件非空、非纯注释行计数，以下既有代码必须专核，均只计一次：

| 路径/范围                                                  | 必须核对的符号与理由                                                 | 代码 LOC |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | -------: |
| `apps/orchestrator/execution-service/warm-worker.ts:1-162` | startSlot/warmSlot/prewarmedWorker：同 PID、取消、异常补位及回执时序 |      153 |
| `apps/worker/dsh-worker.ts:1-190`                          | runDshWorker/Loop：实际安装、恢复、finally、帧回执                   |      177 |
| `apps/worker/remote-session.ts:1-399`                      | RemoteSession/Handle：凭据闭包、监听器、写句柄/缓存生命周期；只读    |      366 |
| `apps/worker/provider.ts:1-34`                             | installOpenShellProvider：真实 provider 与工作目录                   |       30 |
| `apps/worker/run-worker.ts:1-21`                           | main：真正生产 --warm 入口                                           |       19 |

以上 5 个必要既有代码文件共 745 LOC，已超过 500；不靠生成代码、文档或填充行达标。新生产 2 文件预计 300–450 LOC，单元测试 2 文件约 200–300；验收新代码 9 文件（新增SDK wrapper及其单测各一）约 1150–1800，仅为评估，不把预计值冒充实测修改量。执行后记录实际 diff，不要求达到预计行数。

Worker 必需直接运行依赖：`@deepseek-ai/cordis=4.0.5`；`@deepseek-ai/dsh-agent`、`dsh-agent-loop`、`dsh-llm`、`dsh-session`、`dsh-session-projection`、`dsh-system-prompt`、`dsh-tools`、`dsh-session-checkpoint-policy` 各 `0.2.1-rc.4`；`@connectrpc/connect`、`@connectrpc/connect-node` 各 `2.1.2`。保留已有 persistence/provider 版本。官方 SDK 用上述只读外部制品，不加 git/NPM floating dependency。pnpm lock 只允许这些 importer、其必需依赖/peer 解析的机械变化；其他升级 STOP。

与 A 冲突：Worker package/lock 将改变 deploy/worker/Dockerfile 的 prod install 闭包，A 当前镜像不能复用为 B 新闭包的验收证据。B 在独立 checkout 可实施、本地安装和验证，不修改 A 镜像、Dockerfile、锁文件或 private，不要求 A 当前候选提前重建。禁止 B 合入 main，直到 A 冻结 T5/T6 安全点且 MASTER 显式放行最终顺序；届时按实际较新 main 核对差异、测试与闭包，不能预设 B 先交。root package files 保持原样；public-files 和 Readiness 若交叠，后合入方按 MASTER 顺序保留双方证据并复核。

## 测试文件尺寸与拆分约束

用户补充要求：测试文件尽量控制在1000物理行以内（含空行/注释，使用`wc -l`核对），按职责拆分，不能压缩格式、删除断言或合并测试来达标。本任务新建的`base-bootstrap.test.ts`、`sdk-transport.test.ts`、`sdk.test.ts`、`fixture.test.ts`、`real-reuse.test.ts`均以此为门槛；共享fixture/observer同样避免超过1000行。计划当前每文件预计低于1000行，若执行超过，不临场新建未列文件，先回作者给出唯一拆分路径并重新审核相关步骤及文件数。保留所有case、名称、skip条件、超时、串行/并行边界和默认发现入口，不依赖跨文件执行顺序。

基线发现既有超限测试：`apps/orchestrator/execution-service/service.test.ts`6032行、`apps/workspace/api/space-files.test.ts`3359行、`apps/workspace/web/e2e/task.spec.ts`1225行。现有`acceptance/temporal-retry/real-retry.test.ts`950行，禁止向其中堆入新验收。用户随后明确本次旧文件拆分的新增加删除总量不得超过4000行，超出暂不拆。经MASTER独立排序，仅Web E2E拆分以PR #72普通合并（c7b12901de46dc8be25a772f54497a2cbb0c64b4，5文件822新增/794删除）；service/API拆分已原字节撤回。该独立拆分不计作A6验收；A6于7649f3019ac207f22d9bbe564e9e600de1e29aac普通合流最新main，Web/Go/OIDC/deploy与main一致，保留A6及Web白名单。拆分验收必须对照前后测试清单/实际执行数量和断言、专门子进程入口/测试发现/共享清理，不能只以文件行数或编译通过作为完成。

## 独立验收结构与不变量

新增目录 `apps/orchestrator/acceptance/worker-reuse/`，唯一新符号：

- `fixture.ts::createReuseFixture(sdk:PreparedSdk,sessionCount:2|65)`：在 mkdtemp 0700 中创建 authority/history SQLite、生产 SingleHostExecution、生产 persistence/operation/SDK ingress；随机回环端口，独立 mTLS 受控 upstream。只用 controller.bind/admit/takeover，不写生产 SQL。模拟 sandbox running/stopped 只用于本地契约，不能证明沙盒进程退出。
- `observer.ts::readReuseSnapshot(paths, sessions)`：独立只读 SQLite；父进程记录 ingress/upstream stream 与 HTTP/2 session open/close、实际请求绑定及 grant 摘要。记录者不得替 Worker 清理资源来制造 PASS。另提供 `readWorkerProcesses(parentPid:number)`，用本机 `ps -axo pid=,ppid=,args=` 的私有输出筛选 parentPid 的直接子进程及正式 run-worker.ts --warm 命令，返回仅 pid/ppid 数组；必须与 trace PID 和连接时序一致，不保存或回显无关进程命令。
- `model-adapter.ts`：实现 ModelAdapterFactory，以真实本地 HTTP 服务返回确定性文本，使用官方 LlmAdapter；每轮独立取消器，dispose 等当前请求结束。该模块不获得 ctx/SDK/provider/grant。
- `observed-bootstrap.ts`：默认调用生产 base 默认导出并返回同一 runtime facade；仅包装 initialize/flush/dispose 进行观测，不能替换 ctx、agents、persistence、provider、adapter 或清理。trace 另写私有文件，stdout 仅生产帧。观测配置由fixture独立生成，目录0700、文件0600；模型HTTP地址用 `BENTO_REUSE_MODEL_URL`，父端仅允许 http://127.0.0.1 随机端口，其他地址立即失败；不是生产base新配置字段。
- `real-reuse.test.ts`：调用原 prewarmedWorker，command 是当前 node，args 为 root register-paths + 正式 run-worker.ts --warm。BENTO_DSH_BOOTSTRAP 指向 observed-bootstrap，其内部唯一装配为生产 base；不调用 A2 runtime。生产 base 直接执行的对照轮与观测包装轮都必须通过。
- `check-package.mjs`：实际安装树 npm pack 正/负路径检查。

`ReuseSnapshot` 必须是下列精确脱敏结构，不把内部授权行整个输出：

```ts
export type ReuseSnapshot = {
    schema: 1;
    sessions: Array<{
        tenant: string;
        session: string;
        run: string;
        generation: number;
        historySha256: string;
        receiptsSha256: string;
        handle: string | null;
        intents: number;
    }>;
    sdkConnections: number;
    sdkStreams: number;
    upstreamCalls: number;
    workerPids: number[];
};
```

`readReuseSnapshot(paths:{authority:string;history:string}, sessions:readonly WorkerRequest[], resources:{sdkConnections:number;sdkStreams:number;upstreamCalls:number;workerPids:number[]}):ReuseSnapshot` 只读查询history的sessions/events/batch_receipts/batch_intents与authority的execution_sessions；只按session取行，events按seq、receipts按epoch/batch排序。historySha256为该Session完整events规范JSON的SHA256，receiptsSha256为排序完整receipt数组规范JSON的SHA256；SQL前后不变断言比较私有内存原行，不仅比较摘要。连接/stream/upstream/workerPids由observer读取实际server事件和原生进程快照合并，不从Worker回报赋值。`fixture.snapshot()` 返回该合并结构，存储证据时不附grant或capability。resources参数required，不得默认0。

SDK取得统一调用下节`prepareReuseSdk`：无显式本地输入时原样委托原prepareSdk，入口/构建来源与预算不变；本地受控输入仅绑定已审核制品，隔离复制、全量校验和原六探针后使用。不修改原工具，不把本地输入通过当成默认下载/build路径恢复。upstream 用同 sdk.raw 的 protobuf schema 编解码 GetSandbox/ExecSandboxInteractive start/stdin/output/exit，不能字符串伪造 codec；SandboxResponseSchema、ExecSandboxEventSchema 与输入schema均从同一sdk.raw取得，经createRequire(sdk.raw)解析的官方protobuf create/toBinary/fromBinary处理。gRPC帧为identity压缩字节0+四字节BE长度+protobuf，HTTP trailers固定grpc-status=0；拒绝场景使用正式ingress实际status，不伪造。stdout/stderr payload.value.data为字节，exit为exitCode。每个 frame 上限 1 MiB，不支持的请求拒绝。helper只返回固定rc.4协议下resolve/stat/readText结果和受控长流，不实际运行用户代码。文件 target 通过真实 `ctx.fs.resolve()` 取得，不手工构造 namespace。官方WorkingDirectory.ensure在模型前还会stat根目录；fixture仅对method=stat且path精确workspaceRoot（/sandbox/project）返回rc.4的value:{type:directory}，其余stat拒绝，不把该受控响应当真实沙盒文件系统证据。

观测 facade 在 Agent 请求前、provider 已正式安装后，通过一次性 `agent/request` 监听器完成真实 fs.resolve/readText 和 SDK stream 探针，再原样 next。保留前轮真实 SessionStore 对象、ctx.emit 绑定、真实 listener 回调计数和一个旧 FsTarget；新轮必须使用新 provider 的 processPath 拒绝旧 target。私有探针引用是主动保留用于负测，不以堆残留 canary 扫描误判资源泄漏；不读私有 Map，不注入虚假计数。旧 Context 派发真实已捕获 session/event 后旧回调不再触发，不能以新 Context 本来没有旧 listener 代替。SQL、wire 与 worker trace 三侧按 run/session/generation/轮次对应。

正常P0/P1/P2期间不调用takeover、不撤销reference及64轮grant，也不向任一运行中slot发abort；因此跨Session同PID证据与撤权退出证据互不混用。正常完成不自动令独立controller签发的grant失效，本验收不预期旧grant访问其自身Session必然403，不将旧Session自身正向访问当泄漏。P2只证明当轮凭据使用与跨目标拒绝；它是绑定隔离，不能记录为“已撤销旧grant”。R独立fixture在实际持有stream/模型轮尚未完成时父端调用controller.takeover撤权，controller返回或拒绝的状态与真实stream关闭分别记录；Worker因此review或抛错，原warmSlot等待退出后补位。P1结束后的fixture清理发生在长期同PID断言之后，不计为R证据。

| Case              | 固定动作与必需断言                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 生产 base 对照 | 无 observed wrapper，真实生产 --warm 连续两轮不同 Session，官方模型轮/持久历史可回读，同 PID；真实 SDK 操作另由 T4 和 P1 对同一 base 的 provider 独立触发，不声称无工具模型轮自动产生工具调用；关闭后父端归零                                                                                                                                                                                       |
| P1 长期重用       | 同一Worker先执行1个独立reference Session预热，随后64个不同Session/Run、8个轮换tenant；每轮开始时间不早于首轮开始+轮次×5 秒，首尾跨度≥315秒；每轮成功且同一个实际 PID，无 restart；前后所有历史仅自身 marker，模型实际请求无前轮 marker；每轮回执后父端 SDK session/stream=0，下一轮全新连接；只读 SQL 当前句柄关闭、批次无未提交 intent                                                             |
| P2 四项独立负测   | P1 每轮分别记录 credential/listener/connection/cache 四个布尔结果和来源；每轮实际wire header摘要等于该轮grant摘要；拿前轮token访问本轮Session的persistence请求、以本轮sandbox为目标的SDK请求均被正式绑定校验拒绝，SQL四表及upstream调用数不变；当轮token同目标正向成功；旧 ctx 事件不触发旧 callback/新网络请求；新 fs拒旧 target、正向resolve/readText成功；上一SDK session真实close先于下一次请求 |
| R 撤权            | 独立当前 Session/真实持有 stream，用正式 controller.takeover 撤权；旧 capability 重连及持有 stream 后续输入拒绝，父端确认关闭；Worker review或异常必须旧 PID 退出，下一 Session 在新 PID成功，其他绑定/历史不变。不得要求撤权后旧 PID仍复用；不得把 fixture stopped当独立真实沙盒停止                                                                                                               |
| E 清理失败        | 独立 adapter.dispose 人工抛固定 fixture 错，生产 base 仍执行ctx/provider与SDK关闭；正式loop不得输出completed/recovered，父端等exit后才补位，新Session正常；错误无凭据                                                                                                                                                                                                                               |
| L 关闭/恢复       | 正常宿主pool lifetime abort后await关闭，残留stream/session/子进程/监听socket全0；重开同两库，已完成Session事件/receipt逐项保持，继续一个新合法Session；不宣称未知副作用恢复                                                                                                                                                                                                                         |

五个独立test严格为P0、P1+P2、R、E、L，无skip。P0/R/E/L各用`{timeout:120000,concurrency:false}`；P1+P2仅一个`test`，用`{timeout:600000,concurrency:false}`，在同一个callback内create fixture→64轮正向/四项负测→finally close，不能拆成两个test隐式共享fixture或依赖执行顺序。P2生成64条分项结果：P1+P2先在同一常驻Worker执行request(64)这一reference Session，取得真实旧ctx/listener/fsTarget/token；它不计64个测量轮但必须与随后64轮同PID。测量轮0使用该reference，轮1..63使用真实前一测量轮，因而64轮都有实际前驱可逐项负测，不用首轮空对象/缺省true代替。P1+P2显式createReuseFixture(sdk,65)；P0/R/E/L与fixture.test各用createReuseFixture(sdk,2)，不共享fixture。SDK在before hook准备、timeout=600000，仅共享只读SDK制品；每个case独立fixture/DB/pool，after仅清理SDK，不能代清case资源制造PASS。全文件`--test-timeout=1200000`。没有墙钟跨度/同PID/正向SDK调用的证据则不能判长期复用PASS。

### 监听器的全部 fixture 网络观察契约

固定方案：fixture在原persistence/operation server追加只读request监听器，保留逐请求interface、Bearer摘要、path、父端performance时间，仅返回数组getter；不读取/保存原始token/body、不回复请求、不改handler。SDK沿原wire/upstream计数，模型沿父端实际HTTP请求计数，统一由父端取样。

只读HTTP观察器已由T5a独立交付；下列IPC和整轮断言在T5允许文件实现。

observed-bootstrap仅在存在真实前驱时，在调用生产base(request,effect)之前发出trace `old-event-ready`；此时前轮正式dispose及receipt已完成，本轮Context/adapter/SDK尚未创建，避免把本轮200ms持久化批次刷盘误当旧事件触发。真实fs/namespace/当前listener正向观察仍在原agent/request且provider已安装之后；父端独立观察四类服务端计数100ms不变后，向既有私有trace文件旁的`.ack`写0600 JSON `{session,phase:'ready'}`。Worker等该session/phase的ACK后才调用真实旧ctx.emit，验证旧callback不增，等待100ms（仅测试IPC使用本阶段5秒deadline signal，启动阶段无agent payload.signal；case关闭原Worker进程即结束等待）并写trace `old-event-ended`。父端核与baseline计数相同，再连续观察100ms不变，写phase=`done`的ACK。Worker见done后才调用原生产base；后续initialize/flush/dispose原样委托，agent/request仍执行正式provider正向探针再next。两端ACK仅本测试IPC，不带grant、URL、模型或请求替身；单阶段最长5s，检查deadline signal/父端停止条件；失败抛错并继续原正式finally清理，不在清理阶段等ACK，不自行dispose任何生产资源。

父端watcher只读trace、实际server计数并写ACK；有异常保存脱敏fixture错误，测试必须失败，case finally停止/等待watcher后关闭原owned资源。父端从每轮dispatch前一直检查到receipt后：persistence/operation新观察行均须为当前grant摘要；SDK沿原当轮摘要断言、模型仍仅当前Session一次。父端跨绑定HTTP负测精确产生1条旧摘要HTTP记录，额外条目失败；各轮间等待及最终shutdown后核观察cursor无额外旧请求。这个更宽区间用来捕获ACK短窗口后迟到的旧身份请求，不能仅验证100ms窗口后忽略其余记录。所有长期64轮记录listener网络分项及各面counter前后值，未有真实前驱不得填true。

## 已核实前置状态

T0已于2026-11-20通过：计划提交`7b829986238e4a6b9f10b3773d1dcc492d03fbd0`仅本文、parent=`fe12c24ddb6d2a061559173e623419d5aa97b99b`、获审blob=`7f25770725298fb54c793f0b7ff362d9a76eec88`；提交后clean，远端main同基线。Worker typecheck exit0；原Orchestrator check:core在B既有系统回环代理下exit0，wall=137110ms，123 tests中121通过/0失败/2既有条件skip，Go test/vet及原pack检查通过。代理值仅本地私有使用，未写入Git。初次未注入代理的baseline进程树已取消，最终采用完整代理运行结果，不把取消运行算PASS。T0不包含本任务新单测/长期case/九项真实Temporal，后续仍须执行完整固定门禁。独立本地实施已授权，最终merge仍等待MASTER确认A安全点。

T1已通过：新增11项直接运行依赖，旧13项中原2项版本不变；lock仅Worker importer和Connect 2.1.2/Connect-node 2.1.2所需peer protobuf 2.17.0（3个新增节点及对应snapshots），无其他升级。`pnpm install --frozen-lockfile`、Worker依赖list和typecheck exit0，diff检查通过；A checkout/镜像未修改。

## 独立受控 SDK 输入契约（本轮仅作者修订）

新增唯一实现`apps/orchestrator/acceptance/worker-reuse/sdk.ts::prepareReuseSdk():Promise<PreparedSdk>`，PreparedSdk直接引用原`openshell/binding-grants/sdk.ts`公开类型。新增单测`apps/orchestrator/acceptance/worker-reuse/sdk.test.ts`。原prepareSdk及sdk-probe、SDK源码、锁、Buf配置、来源、TLS、默认下载/安装/生成/build预算全部只读。

### 输入与固定身份

唯一可选输入为`BENTO_A6_WORKER_REUSE_SDK_BUNDLE`：undefined时必须调用原prepareSdk，不读取任何缓存目录；设置但为空或非绝对路径必须拒绝，不悄悄退回默认网络。输入仅允许仓库外的既存目录，不接受模块URL/可执行命令/代码片段/任意入口。宿主路径只作为目录定位器，不写入源码、CI或公开证据；代码与测试不固定Mac私有路径。

目录布局唯一如下，所有payload路径来自已审核两份清单的并集：

```text
bundle/
  source.tar.gz
  sdk-source-manifest.json
  sdk-built-manifest.json
  tree/
    LICENSE
    buf.yaml
    proto/...
    sdk/typescript/...  # 两份清单包含的源码、dist、配置及完整3包运行闭包
```

原字节身份固定在wrapper常量中，不从调用方清单自述决定可信度：

| 文件                       | 完整字节数 | SHA256                                                             |
| -------------------------- | ---------: | ------------------------------------------------------------------ |
| `source.tar.gz`            |    8487132 | `ef434dd44746c5ee14a24e8dc4f09654134ee362f5a09fb08d31eb27c81b02ad` |
| `sdk-source-manifest.json` |       6708 | `dea96c0430e92329c7a3989ad3a6c64306b44da403737011b017942cf27cce13` |
| `sdk-built-manifest.json`  |     180172 | `ea5b35268fe278d330f6578893be2c84c155de7262c66cf1a843bb2718fb6d2e` |

先核manifest原字节大小/hash，再JSON解析；禁止归一化、重排、重算调用方metadata以绕过该hash。source manifest为44条`{path,bytes,sha256}`；built manifest的files为697条`{path,role,bytes,sha256}`。所有path必须POSIX规范相对路径，不含空段、点段、反斜线/NUL、绝对路径；bytes为安全非负整数，sha为64位小写hex。并集735 payload文件、4384258 bytes，6条重叠记录必须size/hash相同；加三控制文件总738 regular文件、13058270 bytes。允许目录仅为这738条路径的父目录；不接受额外文件、额外空目录、symlink、hardlink或特殊文件，不把本轮完整诊断目录（含cache/dev包/log）当bundle输入。

同时断言已固定built metadata：sourceRevision为官方ac7f615，source archive同上，lock SHA256为256dbfb9d87fe8a89a3e8a8fe9c60fc70bab4446bd1f6fa066a8a77a670ca38a、buf.gen.yaml SHA256为6fd9a0b948f988cd73c6bf19d48ff8292369d3aaeea0ec8e6fc0053c3c387595；对应实际payload必须再次逐文件匹配。运行闭包恰3包：protobuf2.12.1、Connect2.1.2、Connect-node2.1.2；实际package.json、全部包文件与官方lock各条integrity均包含在已固定清单覆盖内。dist完整52文件，index/raw分别固定SHA256 1c204795a5fa29ef2867b234a3d0db7427ddff1a77bc83414da8b9bde09e454a / a9e978d239c9138bdb66e4abfb711e2fc7e6774f33d8a62c6e993527fbd38156。

该清单是已回读的历史诊断记录，含当时darwin生产者与7687/1985ms事实，不是可重构的跨平台canonical inventory。只允许本地受控输入使用这份历史清单原字节；禁止给当前Linux或其他新build套旧provenance/耗时来伪造身份。bundle不含node_modules Buf平台包，不运行源码、安装脚本、生成器或平台bin；实际消费为纯JS的上述3包与SDK dist，消费实现没有Mac私有路径或darwin专属分支。Linux CI默认无输入，仍调用原工具真实build；本次不要求CI正向受控SDK分支，也不新增canonical inventory。

### 全量校验、隔离与销毁

生产wrapper只有两个直接函数，不引入可配置校验器/构建器/生命周期框架：

```ts
export function prepareReuseSdk(): Promise<PreparedSdk>;
export function isolateVerifiedSdkFiles(
    inputRoot: string,
    files: readonly { path: string; bytes: number; sha256: string }[],
): Promise<{ directory: string; dispose(): Promise<void> }>;
```

第二个是共享的不可执行数据复制/校验原语，既给wrapper复制固定738文件，也给单测复制两项普通文本数据；它不解析SDK身份、不import、不运行命令、不返回module/ctx/runtime。真实wrapper只传三固定控制文件加已固定两manifest的并集，先完成上节固定身份/长度与成员集合核对；不能由环境或caller传入自定义files或hash来授权SDK加载。

1. 输入root先realpath并核仓库外、root本身非symlink；允许系统`/tmp`之类父目录系统别名归一化，不接受bundle内symlink。仅准预期文件和其父目录，额外文件/空目录/链接立即拒绝。叶子用O_NOFOLLOW打开，fstat须regular且nlink=1，读取前后dev/ino/size与原lstat相符，realpath须仍在root内；任何漂移拒绝。
2. 按64KiB块读取，最多expected bytes+1，未知大小文件先拒绝而非整体读入；每项实际长度/hash与预期一致。复制前核完整白名单，mkdtemp创建仓库外`bento-worker-reuse-sdk-`owned目录mode0700，子目录0700、文件0600，按固定白名单逐项校验并复制，目标再次核长度/hash和完整成员。失败清理本次owned目录；不删除caller input。这里只是约13MB固定数据复制，不生成inventory、不下载或调用tar/npm/BuF/CLI。
3. 返回的dispose为同一个单次Promise，仅清理owned目录；部分复制失败或dispose失败抛阶段级脱敏错误，原错和清理错以AggregateError保留。普通文本单测测试同一复制/拒绝/清理实现，不让测试用自选hash变成SDK可执行入口。
4. prepareReuseSdk在全部固定738文件校验/隔离完成后，只加载目标固定`tree/sdk/typescript/dist/raw.js`及同目录`index.js`，createRequire仅从固定raw解析该隔离树已核protobuf；不接受caller指定入口，不从仓库/global解析替代依赖。此前不import任何输入文件。
5. 以真实官方schemas的create/toBinary实现原PreparedSdk.encode/exit，decode/decodeExecEvent调用原公开schemaDecoder/schemaExecEventDecoder，字段/错误/bytes与原工具一致，不造codec。无论默认或受控分支，返回前实际执行原probeSdk六探针；失败绝不返回SDK，必须清理该次owned资源。默认分支dispose单次委托原SDK.dispose，受控分支单次委托隔离目录disposer；导入/探针失败也走同一清理，原错+清理错聚合，不删原bundle/诊断制品。返回结构不增加runtime/provider/ctx/decoder替换参数；源码/安装脚本不被执行。删文件不被当作卸载Node模块或撤销Worker grant的证明。

### 受控输入单测与CI复现

本地bundle已于T2获审后仅从已核本轮source archive、两份历史manifest原字节及对应735项payload隔离复制制作；禁止重写metadata或重签清单。CI没有该本地输入，不能重构历史诊断manifest或伪造达尔文build记录。

`sdk.test.ts`固定包含：

1. **选定来源真实SDK**：before按实际环境调用prepareReuseSdk，timeout600000；本地有输入则真正验证本地受控SDK、六探针与隔离路径，CI无输入则真正运行原prepareSdk build及六探针。调用returned.dispose两次是同一Promise，raw路径消失；受控输入原树保持。输出实际source=controlled-local或official-build，不把一种来源当另一种来源证据。CI正向受控SDK分支在本任务明确Not Covered，既不创建该test再skip，也不声称小夹具证明其身份。
2. **默认身份拒绝**：另建小型不可执行伪bundle（普通文本、错误/缺失控制文件），显式输入必须拒绝，不能fallback网络或加载任何入口；空/相对路径、仓库内目录、root symlink同样拒绝。该case只能证明顶层拒绝，不能写成全SDK正向证据。
3. **共享数据复制校验**：两个不含代码的txt夹具，预期size/hash由固定文本得出；调用同一isolateVerifiedSdkFiles验证成功复制、隔离后修改/删除本test输入副本不影响目标、重复dispose及保留输入的独立场景。它不构造任何SDK manifest、不import数据、不使用测试SDK/codec。
4. **拒绝矩阵**：对该小型数据夹具逐一同长度单字节损坏、截断/超长、额外文件/空目录、symlink、hardlink、`../`与绝对路径、读取前后身份变化；均须在返回隔离目录前拒绝。不是用自述manifest给未知代码授权。
5. **失败清理**：只在本test私有数据副本上用Node mock注入fs.open/writeFile/rm的确定失败，验证部分复制失败清理owned目录、错误聚合/脱敏、dispose失败不回成功；最后恢复mock并清理本test刻意制造的残留，不把finally清理冒充正常PASS。不能mock原prepareSdk、官方schema/probe、TLS或网络响应。

测试concurrency=false、各test120000、无skip；真实SDK选择与数据IO单测分开记录结果。原T2五项transport测试在同来源SDK上完整执行，CI默认是真实Linux SDK build→六探针→实际HTTP/2 RPC，不依赖Mac路径。本地使用受控输入时只证明该显式来源，全量默认网络准备失败事实保留；日志不写原始路径/token/header。T6将wrapper单测加入默认test:worker-reuse，CI不注入BENTO_A6_WORKER_REUSE_SDK_BUNDLE、不改workflow、不打包本地bundle/cache或历史manifest；本轮不为跨平台输入增加canonical inventory或新发布流程。

## T5：同生产 base 的长期四项隔离与补位

前置状态：T4已实现生产ingress/mTLS fixture与独立observer，下方记录本地受控SDK来源fixture两项2/2无skip；本步以前一T4、T5a及下方T5b只读HTTP观察器补强通过提交为基线。
允许修改：新目录 `model-adapter.ts`、`observed-bootstrap.ts`、`real-reuse.test.ts`、`public-files.json`、本文（5）。
专核：`apps/worker/base-bootstrap.ts`、`apps/worker/sdk-transport.ts`、`apps/worker/run-worker.ts`、`apps/orchestrator/execution-service/warm-worker.ts`、`apps/worker/dsh-worker.ts`（共10；MASTER定向批准新增正式loop只读专核）。
禁止修改：全部专核文件、生产测试探针/临时endpoint、旧验收。

执行：实现P0/P1+P2/R/E/L共五个独立测试（P1与P2同一个长期case，先1个reference预热后64个测量轮，保留逐轮四项分项结果）。observed facade只观察，实际返回字段逐一委托生产base；PID由父端独立进程/socket证据交叉确认，不仅相信worker自报。model-adapter只持有当次模型HTTP请求。每轮RPC与历史独立核对。轮次/时间/无串Session均assert，不将warning或计数代替。测试失败输出case+轮次+四项失败名及残留计数，不能输出原始request/config/header。finally不改变失败结论，清理失败同样失败。

验证：

```bash
node --import ./register-paths.mjs --test --test-concurrency=1 --test-timeout=1200000 apps/orchestrator/acceptance/worker-reuse/real-reuse.test.ts
pnpm --dir apps/orchestrator typecheck
pnpm --dir apps/worker typecheck
git diff --check
```

PASS：五测试无skip；长期case64/64四项全真，跨度≥315秒，同PID；R/E旧进程真实退出后新PID成功；L关闭/同库重开无残留。STOP：任意一项只能靠fake/warm标志/自报证明；发现生产缺陷先回作者固定文件/修复/API与验证后重新审核，不能进入A冻结范围。

## T6：默认门禁、证据与删除

前置状态：T5全部断言通过，已记录实际实现与验收SHA；仍在B独立checkout。可完成本地收口、PR与审核，但最终merge必须另等MASTER放行A/B顺序。
允许修改：`apps/orchestrator/package.json`、新目录 `check-package.mjs`、`public-files.json`、`README.md`、`docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`、`deploy/README.md`、本文（8）。
专核：根`package.json`、`deploy/worker/Dockerfile`（共10）。
禁止修改：专核文件、CI、原Temporal脚本、原四项未闭合需求状态。

执行：新增Orchestrator script `test:worker-runtime`，精确命令为`node --import ../../register-paths.mjs --experimental-strip-types --test ../worker/sdk-transport.test.ts ../worker/base-bootstrap.test.ts`，使T2/T3新单测进入默认门禁；新增`test:worker-reuse`，精确命令为`node --import ../../register-paths.mjs --experimental-strip-types --test --test-concurrency=1 --test-timeout=1200000 acceptance/worker-reuse/sdk.test.ts acceptance/worker-reuse/fixture.test.ts acceptance/worker-reuse/real-reuse.test.ts`，即新增wrapper单测与T4/T5三个test文件同次Node运行且串行；`check`原值保持不变，保留原`check:core`、`test:temporal-retry`及原pack入口；在`check:core`原命令末尾追加`pnpm test:worker-runtime && pnpm test:worker-reuse && node acceptance/worker-reuse/check-package.mjs`，使根check和现有CI的check:core均执行新验收，无重复运行，不改workflow。pack脚本读取真实`npm pack --dry-run --json`，要求新生产/验收源精确收录，禁止node_modules、私有config、临时SDK、DB/key/trace；根files数组逐项与原基线相等。公开白名单精确登记新源，不登记临时RUNBOOK。

README/deploy说明默认生产base配置、可信模型factory范围、官方SDK准备版本、当次授权及无Task投影限制；部署引用入口，不复制源码。设计保留稳定owner/关闭顺序。Readiness新增日期、真实代码SHA、官方依赖/SDK、命令/五case/64条四项结果/315秒/PID/资源残留/同库重开及Not Covered；只有全部PASS才把A6-05改已实现，A6父项仍部分实现。A6-01/04保持缺项，A6-02九项原证据保留并重新执行默认门禁。最后迁移长期结论，删除本文及仅指向本文的残留引用，再同提交收口。正文末的链接脚本只在终端执行，不新增Git跟踪的Python文件。

验证：

```bash
pnpm check
npm pack --dry-run --json
node apps/orchestrator/acceptance/worker-reuse/check-package.mjs
pnpm exec prettier --check README.md deploy/README.md docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md docs/40-readiness/CURRENT-READINESS.md public-files.json apps/orchestrator/package.json
rg 'RUNBOOK-A6-WORKER-REUSE' README.md docs deploy .agents
git diff --check
```

另执行`wc -l apps/worker/base-bootstrap.test.ts apps/worker/sdk-transport.test.ts apps/orchestrator/acceptance/worker-reuse/*.ts`并核对新增测试/fixture各文件≤1000行，以及下方“文档链接检查”原命令。PASS：check全exit0，新Worker两套单测实际执行、新五case与fixture都无skip，真实Temporal九项9/9无skip；pack正负边界成立；文档本地路径/锚点有效，rg无结果（exit1为本项PASS）。STOP：默认外部工具受阻、任意新case skip、旧九项变化、pack边界扩大、A最新main影响受测依赖。不能以重跑更小套件替代；恢复只重验受影响范围，再跑已固定全门禁。

## 文档链接检查与最终完成定义

作者送审与T6均从根执行下列脚本。仅校验本地链接路径存在；锚点另外逐项核对实际标题，不把脚本输出当语义审核。

```bash
python3 - <<'PY'
import re
from pathlib import Path
files = [Path('README.md'), Path('deploy/README.md'), Path('docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md'), Path('docs/40-readiness/CURRENT-READINESS.md')]
runbook = Path('docs/30-designs/RUNBOOK-A6-WORKER-REUSE.md')
if runbook.exists():
    files.append(runbook)
errors = []
for file in files:
    for target in re.findall(r'\]\(([^)]+)\)', file.read_text()):
        target = target.split('#', 1)[0]
        if not target or '://' in target or target.startswith('mailto:'):
            continue
        path = file.parent / target
        if not path.exists():
            errors.append(str(file) + ': ' + target)
if errors:
    raise SystemExit('\n'.join(errors))
print('local document paths PASS')
PY
```

完成须同时具备：生产base/transport已交付；T0..T6通过并逐步提交；五项真实子进程验收、逐轮四项与九项Temporal证据；当前HEAD明确Codex审查与必需CI；MASTER确认合入顺序后普通merge；回读merge、checkout快进、仅清理已合入本任务分支。缺任何项不宣告交付完成。作者阶段只提交可审核草稿内容与SHA，不把计划/源码核对写成已验收。

## 作者送审自审

此前T0→T6及Schema定向修订已获MASTER审核；MASTER已审核新增受控SDK输入契约与扩充T2为Executable；本地制作固定738文件bundle并完成原六探针、16项SDK/数据用例及5项真实transport，21/21无skip。已核输入、产物、每步最多10文件、默认无输入仍原工具及六探针；T0 的独立checkout与实施授权、最终merge的A安全点与MASTER放行是分开的明确前置 STOP，不是假定已经成立。T0/T1实际验证见已核实前置状态；新生产与端到端测试仍待逐步执行，不存在提前验收PASS声明。若实施发现固定官方API、fixture wire协议或直接依赖与本文不一致，按本规则回作者修订和重审，不由执行者选择替代。

## T2 STOP定向修订

最后通过步骤T1，提交`f45c6c8`。实测官方SDK before hook中原计划的GetSandbox返回schema为undefined，五测试均hookFailed、未执行transport行为断言。已从完整SHA校验官方归档的`proto/openshell.proto`核实：`rpc GetSandbox(GetSandboxRequest) returns (SandboxResponse)`；对应raw导出准确名称为`SandboxResponseSchema`。MASTER已定向批准该名称修订，测试同名已更正；未改生产安全原语/SDK版本/decoder，未跳过测试。之后两次完整T2分别在install、generate阶段hookFailed，均0行为PASS；未提交T2、未进入T3。

本轮私有诊断已结束：原npm ci exit0，但本机锁定optional包`@bufbuild/buf-darwin-arm64@1.71.0`被npm移除；原npm run gen exit1/signal=null，Buf wrapper寻找不存在的fallback binary产生ENOENT；build未执行。明确直接原因是缺可执行平台包，具体下载失败原因未由日志证实。官方tarball单次HEAD实际peer确认为既有本地代理、HTTP200，但不替代原安装/生成或行为验收。没有追加安装/hook重跑，原工具/来源/TLS/预算不改。MASTER随后批准仅本轮既存私有目录定向补齐；一次GET完整36698209bytes、官方lock SHA512及响应长度通过、实际peer为既有本地代理。首次本地三成员白名单漏列两个官方辅助bin而STOP，未提取；MASTER定向批准准确五成员后，核三bin均arm64 Mach-O和包meta，通过后仅提取精确平台包路径。原gen exit0/7687ms、build exit0/1985ms；无新GET/安装/脚本/版本变更。源码44文件逐字节等于官方完整归档，构建/runtime清单697文件3826263bytes（含dist52文件），manifest SHA256为ea5b35268fe278d330f6578893be2c84c155de7262c66cf1a843bb2718fb6d2e；runtime为protobuf2.12.1、Connect/Connect-node2.1.2。上述仅诊断制品与静态导出核对，无T2行为PASS；尚未批准受控输入wrapper，原prepareSdk不改。

## T2 实际通过记录

2026-11-20，获审扩充T2在本地controlled-local来源下完整运行SDK/数据16项、transport5项，最终21/21、fail0/skip0，实际duration1855.8885ms；原probeSdk六项真实执行，输入738文件/13058270bytes按固定清单校验后隔离加载，输入与诊断制品保留。首次真实持有RPC场景暴露静默destroy的RST_NO_ERROR不结束官方客户端等待响应头；改为原生HTTP2 NGHTTP2_CANCEL后完整重验通过，没有换SDK/codec/断言。先前挂起本测试进程树已仅定向停止，所属一个SDK隔离树已删除；最终正常测试的owned树清理通过。Worker与Orchestrator typecheck、四文件focused ESLint/Prettier及diff检查通过；四新源均不足1000物理行。首次错误schema/hook失败、npm平台包缺失、过窄allowlist STOP事实保留，不计入行为PASS。默认无输入路径仍原prepareSdk，当前新增wrapper默认网络完整运行与CI受控SDK正向均未在本地证明；CI按设计真实default build，待交付检查。T2不证明A6-05长期复用，T3..T6未完成。

## T3 实际通过记录

2026-11-20，本条所属T3提交完成正式base与单测。完整base9项+transport5项14/14，fail0/skip0，duration3081.650584ms，采用已核受控SDK来源及原六probe。真实官方handle正常/撤权后显式dispose再fiber只close一次；recover无SDK/模型、Task无投影不发prompt；factory仅provider/model且拒单例/多字段；局部初始化失败、两handle/根fiber/模型三错后续清理全部执行。新增正常真实AgentLoop轮completed、model stream1、history handle null/close1、SDK session归零。此前故障注入误用ctx.plugin动态别名已改实际registry.plugin；正常轮最初因SDK cwd lookup需stat而fixture拒绝返回review，MASTER批准只读根stat后重验原成功断言通过。两情况不算此前PASS，生产base无SDK/权限降级。单测的helper/mTLS外部系统/模型皆非真实部署证据，A6-05仍待T4..T6长期验收。

## T4 实际通过记录

2026-11-20，本条所属T4提交实现独立fixture/observer/SDK验收。以7649f3019ac207f22d9bbe564e9e600de1e29aac为前置提交，本地受控SDK来源（原六probe实际执行）完成fixture两项2/2、fail0/skip0，duration1716.181125ms。官方SandboxClient通过生产SingleHostExecution SDK ingress、真实双向TLS与同SDK protobuf上游，GetSandbox及interactive helper resolve取得真实输出和exit0；跨目标SDK返回grpc7、persistence HTTP403，上游调用数不增，私有内存完整execution_sessions/history四表行及脱敏snapshot不变（完整行比较不写入断言输出）。父端观察实际HTTP2 session/stream关闭，而非Worker自报。

独立撤权用例在interactive输入未closeInput/cancel时观察到上游held stream；controller.takeover因沙盒退出未证实而拒绝，记录UNKNOWN/stopConfirmed=false。实际既有RPC结束、官方done拒绝、后续write拒绝、上游held消失；新连接旧token返回grpc16且不触达上游，邻Session新token正向成功。SDK transport主动关闭后父端quiescent断言全部连接/stream归零、原生Worker子进程为空，断言先于fixture finally清理。

Orchestrator typecheck、三源focused ESLint/Prettier、public-files格式与git diff检查通过；三个新源分别低于1000行。fixture仅本地合成helper/沙盒运行契约，不是真实沙盒进程或磁盘；不证明沙盒已停止、不证明真实外部模型、长期跨Session同PID/四项隔离/Worker失败补位或默认网络SDK构建已恢复。A6-05仍待T5/T6。

## T5a 实际通过记录

2026-11-20，本条所属提交按MASTER批准b18e78ef39e4260528b9ffa0aeb4e96273bf6a76交付fixture只读persistence/operation HTTP观察器，不改生产handler。独立fixture两case最终2/2、fail0/skip0、duration1627.842458ms；真实跨Session persistence POST403/无效operations POST403分别恰1条对应面/原grant SHA摘要/path记录，完整私有SQL原行及脱敏snapshot不变，SDK/撤权原断言保持。首次误将operations空对象预期400，实际正式入口403；修正为精确403后完整重验，不计首次失败为PASS。Orchestrator typecheck、两源ESLint/Prettier与diff通过，新fixture639行、fixture.test289行。该小步不计T5完整网络负测已通过；剩余IPC及迟到请求检查仍须在原T5完整五case重验。

## T5b 实际通过记录

2026-11-20，按MASTER批准工作区blob872eac208b78158941a41daa04a6ace275f18259修订，反事实只作来源诊断：临时跳过旧emit仍有4条当前摘要HTTP200（baseline后30–38ms），SDK/operation/模型不增；结合RemoteSession.enqueue200ms定时flush的stage/append/reconcile/flush四RPC源码说明，不能用原活动窗口将本轮合法刷盘算旧事件触发。原两观测源已逐字节恢复hash，反事实不提交、不计T5验收。

本条所属提交仅fixture/fixture.test/RUNBOOK：只读附加response finish status/finishedAt；完整fixture两case2/2、fail0skip0、duration1688.531875ms，精确403及finishedAt≥start断言通过，原所有SDK/mTLS/SQL/撤权断言保留。Orchestrator typecheck、两源Lint/Prettier、RUNBOOK格式、diff通过。T5将旧事件窗口移至新base构造前，仍须最小phase后完整五case；T5尚未PASS。
