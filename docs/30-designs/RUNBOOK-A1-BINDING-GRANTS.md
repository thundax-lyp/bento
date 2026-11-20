# RUNBOOK：A1-03 旧执行授权拒绝

## 状态、工作边界与执行者契约

- 建立日期：2026-11-19；本轮修订：2026-11-20。状态：T3 作者修订待 MASTER 对新 SHA 复审，尚未获本轮实施授权。T1/T2 已按规则提交并删步，T3 未通过，保留现场。
- 唯一 checkout：`/Volumes/storage/workspace/bento-b`；起点 `main=origin/main=b08cd93c8667ca524450289733e2992e3b7bbfe2`。当前分支 codex/a1-revoked-grants，HEAD/最后 PASS 为046ff51b69ded8edb499ec42e8d76f4eb16d5bb4；T3 两处源未提交，本文本轮修订也未提交。
- MASTER 已裁决缩为 A1-03，批准作者在仓库外做纯本地官方 SDK 工具准备；该准备已通过下述探针。T1–T6 仍需同版本 `Executable`、单独计划提交核对及显式 `$bento-runbook-worker RUNBOOK-A1-BINDING-GRANTS.md` 后才能执行。
- 执行分支固定 `codex/a1-revoked-grants`。MASTER 对同一草稿 SHA 评为 Executable 后，才按其指令创建该分支并仅提交本文；回读分支、计划 commit/blob、完整文件清单和干净状态，由 MASTER 核对后再等显式 worker 调用。当前不得提前创建分支。
- 执行者仅能按固定顺序修改列出的文件、运行命令、核对断言或 STOP；不得选择新产品范围、放宽断言、替换 SDK、跳过网络失败或扩大共享生产修改。
- 每步 PASS 后删除该步说明，将依赖改为对应可回读产物并单独提交。最后一步同提交迁移 Readiness 并删除本文。失败保留当前 STEP，不提交半成品。
- PASS 指对应版本的全部规定断言通过；skip、静默缺 SDK、只启动端口、单独 Gate.require 不构成通过。STOP 报告最后 PASS/SHA、精确 symbol、命令、脱敏结果及所需决定，不回滚用户文件。

## 目标、Scope 与 Non-goals

唯一目标是 [A1-03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-03-bad-case-旧执行授权)：先以生产 controller 生成的当次 grant 完成合法 HTTP/HTTP2/Provider 调用，再真实撤权；旧 capability 的新请求、同连接新 stream、重连和持有 interactive 后续 stdin 均不得继续执行，旧官方 Provider 不能追加历史；通过独立只读 SQL 和同路径 reopen 读回撤销。

测试范围固定为本地单宿主 SingleHostExecution 的 persistence HTTP、operation HTTP 和 SDK HTTP2 三 RPC。mTLS upstream 为独立受控服务器，不是外部 OpenShell Server；SDK wire 与生产 decoder 真实，模型和 sandbox 观察是 fixture。该本地证据不声明真实外部部署、真实模型或实际 Docker 进程已停止。Happy Path 是本项负例的前置控制，不等于 A1-01 的账号到完整部署绑定链。

不修改生产源码、原 A2 五场景或时序、不修改依赖清单/lock、workflow、根 package.files。禁止 A 的远端 Docker/OpenShell/IdP/S3/模型、其代理及其他 checkout 写操作。禁止 service.ts retryReason/advanceTaskRetry、旧 service retry suite、业务 history checkpoint/restore。需要进入共享生产源码时必须先 STOP 给 MASTER 排序。

### 2026-11-20 作者诊断事实与复审门禁

在昨日失败源字节未改变的前提下，今天仅运行一个 N GetSandbox 观测例，原 this/args/返回值保持；未增加重试或修改停止布尔。合法 RPC 完成后，初始 observeStop 为false/false/true/true；第一次 confirm 为true/false/true/true，第二次（原有唯一重调）仍为true/false/true/true，四项顺序依次 stopped/channelsClosed/credentialsRevoked/writesRevoked。原 upstream server session 先 close，第二次 confirm 仍channelsClosed=false；原 ingress→upstream client session close及原WorkerGate.channel Promise fulfilled发生在第二次失败之后。真实未满足项是channelsClosed；不能用一次setImmediate或上游先close保证内部channel已清理。

诊断结果私有摘要 SHA256=`34ccc2f09b3444ce27830dbaef3cd5fed0268c10801cc8b61a44ba62ca70dd00`。仅保留脱敏布尔、事件顺序与相对时间；这不是A1-03验收通过。只用一轮实际观测，未运行第二轮。工具/fixture已清理。此次作者批次涉及sdk-ingress/worker-gate/management/authority/single-host/fixture/sdk与仓库外observer，不扩大机械T3预算。

最小修订只移除本项多余的“完整takeover成功/READY”前置：SDK/O/I采用无独立停止证明的stopped=false，精确期待生产fail-closed UNKNOWN错误且只调用一次；拒绝状态码、真实controller入口、官方wire、无upstream新增/历史与operation保护、独立SQL/reopen全保留。不能把UNKNOWN标READY或借本项关闭A3。新SHA由MASTER复审后才修改两处T3源并重验；当前不实施、不提交半步。

### A1-02 暂缓的正式裁决

A1-02、A1-01/04/05 和父 A1 状态均不动。B1/B2 留为后续独立任务的缺项：

- Project/Run 输入忽略额外键，不凭这一事实直接判定漏洞，也不为凑 A1-02 改成全未知键 400。内部 service token 加 `x-bento-owner-id` 是受信业务 API 代传 owner 的边界，不当作 worker 可任意声明 tenant 的攻击接口。
- 官方 SDK workspaceScope.workspace 是 Gateway namespace，不能当 Volume；SDK 无 Bento tenant、业务 Session 或 Volume 选择字段。A1-02 后续需明确真实可提交绑定入口及独立挂载证据，不能新增合成 volume 字段，也不能以 scope 拒绝替代卷伪造。

## 真相源、现状与调用链

正式依据：[架构](../00-governance/ARCHITECTURE.md)、[应用边界需求](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-身份与绑定)、[执行链设计](./APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计)、[Readiness](../40-readiness/CURRENT-READINESS.md)。A1-03 当前部分实现，缺真实撤权后执行入口证据；原 A2-02 只能证明历史方法拒绝，不能替代 SDK 执行拒绝。

1. 合法 fixture 绑定经 `SingleHostExecution.bind`→`Authority.bind`；`SingleHostExecution.admit(session,generation,run,leaseMs)`→`Authority.admit` 返回随机 token；不直接写 SQL 种授权。
2. worker Bearer→`SingleHostExecution.grant`→`Authority.authorize`（hash/RUNNING/expires）→`WorkerGate.require`；Session/Run/generation 从权威账本解析，不信 caller 自报。
3. SDK `SingleHostExecution.sdkIngress`→`createSdkIngress`→`WorkerGate.channel`→`schemaDecoder`→`forward`，真实 gRPC framing 后经独立 mTLS upstream。三方法是 GetSandbox、ExecSandbox、ExecSandboxInteractive；后续 stdin 每帧重验。
4. operation HTTP `/operations`→真实 grant→Authority.reserveOperation；撤权后不得新增 operation。
5. `RemoteSession.rpc`→HTTP `/rpc`→`persistenceIngress`→SessionHistory.dispatch→SQLite；官方 Provider append 首先 stage，拒绝应如实标为 stage 403，不冒充后端 append 分支执行。
6. `takeover`→`beginDrain`（DRAINING/capability=NULL）→PersistenceFence.revoke→gate.revokeChannels→history.releaseReaders→可信 stop/observe/CAS。fixture 的 stop barrier 用于观察撤权后请求，不用于证明真实子进程停止。
7. HTTP/HTTP2/controller 关闭后以原数据库路径 reopen，旧 token 仍拒；不得重新 bind 空库伪造恢复。

## 精确数据、错误与所有权

`apps/worker/protocol.ts:Binding` 必填 tenant/project/session/sandbox/volume:string；`Grant` 必填 token/session/run:string、generation:number。fixture 的合法 Binding 仅种子资源标识，controller 负责授权；SDK workspace 固定 `default`。每例使用随机 Session/Run 和独立目录，不产生跨例凭据。

`Authority.execution_sessions`：session 主键；tenant/project/sandbox/volume/state 非空 TEXT、sandbox 唯一；generation 非空 INTEGER；run/capability/expires 可 NULL。admit 从 READY 到 RUNNING，capability 存随机 token 的 SHA-256；旧 grant 明文只在内存。beginDrain 将 capability 清 NULL，绑定五字段不变；takeover 完成新代 READY 时 run/expires 同生产契约，不自行清理。

独立观察器仅使用另建 `DatabaseSync(path,{readOnly:true})`，SELECT 后 finally close。投影保留五字段、generation/state/run/expires、`capability IS NULL AS revoked`，不输出 hash。历史 snapshots 固定读取 sessions、events（ORDER BY id,seq）、batch_receipts（ORDER BY id,epoch,batch）、batch_intents（ORDER BY id），只在内存 deepEqual，公开只记计数/摘要。

新 SDK 请求使用已撤销 token 时，真实 `SingleHostExecution.grant`→`Authority.authorize` 同步抛 execution denied，命中 `createSdkIngress` 外层 catch，因此固定断言 HTTP2 初始 response headers 的 `grpc-status='16'`（不是7，也不以reset或无响应通过）。这适用于同session新stream、全新连接及reopen后的请求；不得手造 grantFor 跳过生产authorize。测试同时捕获trailers用于诊断，但本路径必须由header16通过。

I 的持有通道已在撤权前通过 grant/channel；fixture hold upstream 固定不发送任何 response headers/data/trailers，因此生产 revoke→deny(7) 在下游尚未发头时固定返回 response header `grpc-status='7'`，再关闭stream和upstream transport。I只接受header7及两侧实际close，单纯reset/close不能替代7。若未来选择已发头的另一持有路径，它会reset/close，须另立获审计划；不纳入本轮，也不以“7或reset”放宽断言。operation HTTP为403；persistence为HTTP403/`{ok:false,error:{name:'GrantDenied'}}`；官方RemoteSession映射SessionOwnershipLostError。

本轮不新增业务 DTO、事件、receipt、outbox、事务结构或持久字段；不更改重放/UNKNOWN 语义。正在执行的 SDK 未完成 stream 可能留 operations.UNKNOWN，不能将其清为成功以让 takeover 通过；本项只验证撤权及拒绝，不验 A3 槽位释放。

## 官方 SDK 前置证据（已完成工具探针）

来源固定：插件 `thundax-lyp/dsh-plugin-openshell@f35e85532368f175b38ac9885c5c4db6985ad34d` 的 `scripts/prepare-official-sdk.mjs`；已按该 SHA 取回字节，文件 SHA-256=`0a2664e147f976b6a4a75423da54a2d32245922638605c64ae2f8bd689eb156b`。它固定 NVIDIA/OpenShell revision `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47`，不是跟随 main/tag。

本轮真实准备位于仓库外权限 0700 的 `/tmp/bento-b-a103-sdk.2UHE9g`（macOS canonical `/private/tmp/...`），只用于本轮作者探针，**未来执行不得依赖其存在或硬编码此路径**。通过正常 HTTPS 从 `https://codeload.github.com/NVIDIA/OpenShell/tar.gz/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47` 下载，归档实测 SHA-256=`ef434dd44746c5ee14a24e8dc4f09654134ee362f5a09fb08d31eb27c81b02ad`；只提取 sdk/typescript、proto、buf.yaml、LICENSE。

官方 `sdk/typescript/package-lock.json` SHA-256=`256dbfb9d87fe8a89a3e8a8fe9c60fc70bab4446bd1f6fa066a8a77a670ca38a`；`buf.gen.yaml` SHA-256=`6fd9a0b948f988cd73c6bf19d48ff8292369d3aaeea0ec8e6fc0053c3c387595`。官方 package 是 `@nvidia/openshell-sdk@0.0.0`，版本身份靠 source revision/archive，不靠 npm 版本号。gen 使用官方锁内本地 Buf/protoc-gen-es，Google APIs module 固定 `c17df5b2beca46928cc87d5656bd5343`，不改生成配置。

正常执行顺序：npm ci --ignore-scripts --no-audit --no-fund --cache TASKDIR/npm-cache --fetch-timeout=20000 --fetch-retries=1；npm run gen（BUF_CACHE_DIR=TASKDIR/buf-cache）；npm run build。上述 TASKDIR 是本段算法名，不是执行器可复制的占位命令；T1 固定工具会生成目录并传参。

实测 Node22.23.2/npm10.9.8：下载37205ms、提取73ms、ci99009ms、gen11548ms、build1500ms。`dist/raw.js` SHA-256=`a9e978d239c9138bdb66e4abfb711e2fc7e6774f33d8a62c6e993527fbd38156`。未来不以 generated 字节 hash 跨平台作唯一 gate，而以固定 archive/lock/config、实际构建及 schema 探针核对来源。

真实探针命令（已运行退出0）：

```bash
node --import /Volumes/storage/workspace/bento-b/register-paths.mjs --experimental-strip-types /tmp/bento-b-a103-sdk.2UHE9g/probe.mjs
```

探针动态导入实际 raw.js 与其安装树 `@bufbuild/protobuf`，调用官方 create/toBinary，再调用生产 `schemaDecoder(raw)` / `schemaExecEventDecoder(raw)`。已确认 WorkspaceSelectorSchema、GetSandboxRequestSchema、ExecSandboxRequestSchema、ExecSandboxInputSchema、ExecSandboxEventSchema 全部实际导出。固定选择 `{selection:{case:'workspace',value:'default'}}`：

| probe             | 真实编码输入                                                    | 生产解码结果                           | bytes |
| ----------------- | --------------------------------------------------------------- | -------------------------------------- | ----: |
| GetSandbox        | name=a103-sandbox + workspaceScope                              | sandbox=a103-sandbox/workspace=default |    25 |
| ExecSandbox       | sandbox/command=['true']/workspaceScope                         | 同上                                   |    31 |
| Interactive start | payload.start(sandbox/command=['cat']/workspaceScope/tty=false) | 同上且 tty=false                       |    32 |
| Interactive stdin | payload.stdin Uint8Array([65])                                  | 'stdin'                                |     3 |
| Event exit 0      | payload.exit.exitCode=0                                         | kind=exit/code=0                       |     2 |
| Event exit 17     | payload.exit.exitCode=17                                        | kind=exit/code=17                      |     4 |

这些是工具 probe，未调用任何业务授权/撤权入口，不是 A1-03 通过证据。未使用 JSON mock decoder 或原 sdk-ingress.test.ts 的 codecFixture。

## 新增文件、接口与职责

仅允许新增以下文件，全部 `.ts` 导入显式扩展名；跨两级父目录用 `@/`。root 从 import.meta.url 推导，不能依赖 process.cwd。

1. `apps/orchestrator/openshell/binding-grants/sdk.ts`：唯一 SDK 准备器，`prepareSdk():Promise<PreparedSdk>`；`PreparedSdk={raw:string,encode(method:SdkMethod,input:'start'|'stdin',sandbox:string):Uint8Array,exit(code:number):Uint8Array,decode:SdkIngressOptions['decode'],decodeExecEvent:NonNullable<SdkIngressOptions['decodeExecEvent']>,dispose():Promise<void>}`；SdkMethod 为上述三字面量。start 的 sandbox 由 encode 第三参数传入，workspace 固定 default；stdin 固定 Uint8Array([65])。prepareSdk 每次 mkdtemp(tmpdir/bento-a103-sdk-)并chmod0700，只在该目录下载/解包/安装/生成，成功返回 dispose，失败先清理再抛；禁止通过环境变量传入任意 raw.js 或以 dist 存在跳过来源校验。官方包作为动态导入的工具依赖，不加入仓库 package/lock。
2. `apps/orchestrator/openshell/binding-grants/sdk-probe.ts`：`probeSdk(sdk:PreparedSdk):void` 完成上述6断言和schema导出检查；直接 CLI 时 prepare→probe→finally dispose。导入模块不启动下载，CLI 判定比较 process.argv[1]与fileURLToPath(import.meta.url)。
3. `apps/orchestrator/openshell/binding-grants/fixture.ts`：`createGrantFixture(sdk:PreparedSdk):Promise<GrantFixture>`。GrantFixture 返回 controller、binding、grant、sdkUrl/operationUrl（reopen 后返回新端口的只读 getter）、connect():ClientHttp2Session、request(client,method,hold?:boolean):Promise<RpcResult>、openInteractive(client):Promise<HeldRpc>、revoke():Promise<Revocation>、beginRevoke():{revoked:Promise<void>,settled:Promise<Revocation>}、snapshot():AuthoritySnapshot、fence():{hasHistory:boolean,revoked:boolean}、history():HistorySnapshot、reopen():Promise<void>、dispose():Promise<void>；RpcResult={status:string,upstreamCalls:number}；HeldRpc={sendStdin():void,status:Promise<string>,closed:Promise<void>,upstreamClosed:Promise<void>}。签名使用来自生产/Node 的真实类型；snapshot投影采用上文明确字段；history固定四表；计数为独立upstream总收到请求/完整stdin帧数，两项暴露 `counts():{requests:number,stdin:number}`。
4. `apps/orchestrator/openshell/binding-grants.test.ts`：固定 suite，后文每场景独立 test，禁止 skip。通过 suite before/after 准备/处置一次 SDK；每 case 独立 fixture/controller/grant。before hook timeout600000ms，每业务 test timeout60000ms，concurrency=false。
5. `apps/orchestrator/openshell/binding-grants/check-package.mjs`：根路径由 import.meta.url 获取，实际 npm pack dry-run 白名单正负断言。不得改旧 temporal-retry/check-package.mjs。

fixture 行为唯一固定：两库同目录；binding={tenant:'a103-tenant',project:randomUUID(),session:randomUUID(),sandbox:'a103-sandbox',volume:randomUUID()}；controller.bind观察仅为本地fixture合法种子，admit(session,1,randomUUID(),300000)。SDK upstream 使用独立 openssl 生成的一日CA/签名server与client证书、server requestCert/rejectUnauthorized=true；仅127.0.0.1随机端口。client证书只给ingress，测试worker只得loopbackURL/token。upstream用官方decoder识别合法frame并计数，正常GetSandbox返回空合法gRPC消息/0 trailer，正常Exec与interactive返回官方exit(0)/0 trailer；hold interactive仅记录start/合法stdin，固定不发送response headers、data或trailers，不结束；撤权后观察stream/session close并断言下游header7。operation listener必须直接采用controller.operationIngress()，sdk listener直接采用controller.sdkIngress(options)，均listen(0,'127.0.0.1')，不得自写鉴权HTTP/手造grantFor替代生产入口。

TLS 生成固定为独立 CA、server、client 三对 RSA2048 密钥：CA 用 openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=a103-ca -addext basicConstraints=critical,CA:TRUE；server/client 分别用 req -new -newkey rsa:2048 -nodes -subj /CN=a103-server 与 /CN=a103-client；再用 x509 -req -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 签发。server.ext 固定 basicConstraints=CA:FALSE、subjectAltName=IP:127.0.0.1、extendedKeyUsage=serverAuth；client.ext 固定 basicConstraints=CA:FALSE、extendedKeyUsage=clientAuth。文件名固定 ca/server/client 的 .key/.csr/.crt 和两 .ext；全部在 fixture 0700目录，写入文件 mode0600，每次 openssl timeout30000ms。HTTP2 server 显式 ca=ca.crt、cert=server.crt、key=server.key、requestCert=true、rejectUnauthorized=true；ingress credentials 使用 ca.crt/client.crt/client.key。正常连接必须 server-side socket.authorized=true，否则 STOP。HTTP与HTTP2请求/close各timeout5000ms、case内barrier等待timeout10000ms，超时不重试请求。

### 撤权完成与停止未证实：唯一 fixture 语义

本项不要求 A3 的停止证明与 READY；SDK/O/I fixture 固定验证已撤权但停止未证实的安全 UNKNOWN，不再强制完整接管成功。P 原官方独立 fixture 维持原契约，不受此修订影响。

`Revocation` 唯一返回结构为 `{state:'UNKNOWN',generation:1,revoked:true,stopConfirmed:false,error:'old execution unconfirmed'}`，所有字段 required。它表示独立 SQL 和精确预期错误已证实的结果，不将 takeover 失败伪装成成功。新 grant 不签发，原 Run 保留，五字段绑定不变。

SDK fixture 的 sandbox.stop 只记一次受信 stop 调用并 resolve revoked barrier，不设置 running=false，也不提供停止证明；sandbox.stopped 固定返回 false。sandbox.start 固定抛 `A1-03 cannot start without stop proof`（生产正常应永不调用），内部 start 调用计数必须0。bind 的初始 running/installed 观察仅为合法种子，不混作撤权后的停止证据。

`beginRevoke()` 同步建立共享总 deadline=performance.now()+10000，且只启动 **一次** 原样 `controller.takeover(binding.session,1)`；没有重调、setImmediate 或轮询。revoked 在 sandbox.stop 被调用时 resolve，此时另建 readOnly SQL 验证 capabilityNULL、generation1、stateUNKNOWN、五字段不变，fence().revoked=true。若 takeover 在 stop 前拒绝，revoked 以该原错误 reject；Promise 创建时装拒绝观察器，原失败仍传给测试。

settled 在同一剩余 deadline 内用 assert.rejects 精确断言原 takeover 为 Error 且 message===`old execution unconfirmed`；意外 resolve、其他错误或超时均 STOP。随后等待 SDK ingress 每一已记录 ServerHttp2Stream 的真实 close Promise 和每一 upstream ServerHttp2Session 的真实 close Promise，均在该剩余 deadline 内完成。仅添加公开事件观察器，不包装/替换 grantFor、WorkerGate、Authority、原 transport 或其返回值；不销毁工作端同 HTTP2 session，N 仍须在该连接上创建新 stream。两端 close 不等于内部 gate Promise 已 settle；本项不据此推进 READY。

结束前再读独立 SQL：Session stateUNKNOWN/generation1/revoked1、原run/五字段绑定不变，stop调用恰1/start调用0、历史与 operation 未被人工修补，然后返回上述 Revocation。`revoke()` 仅 return await beginRevoke().settled。I 在 await revoked 后同步尝试旧 stdin，再等待 status7 与两侧 close/settled；不等待停止成功或重调控制器。

`fence()` 另建 readOnly 连接，固定 SQL `SELECT epoch,owner,handle FROM sessions WHERE id=?`，最多一行。无历史行时返回 `{hasHistory:false,revoked:true}`，这与生产 PersistenceFence.isRevoked 的无历史契约一致，只声明无历史可写；不声称观察到了历史行撤销。存在历史行时 revoked 只在 epoch=grant.generation、owner='bento:revoked' 且 handle IS NULL 时 true。P 独立官方链必须真实有历史行，并在其现有 takeover 后另建 SQL 确认这三个撤销字段，明确补齐真实历史栅栏证据。

10秒 deadline 触发或非预期错误时仅清理本任务资源，精确 destroy 已记录 transports，在另5秒清理期限内等待原 takeover settle并聚合错误；不启动第二次 takeover，不修改 UNKNOWN、不伪造 STOPPED/READY。`reopen()` 关闭clients/listeners/controller，以原两库路径重建controller、sdkIngress和operationIngress；旧grant不变，绝不bind/admit/takeover，SQL仍generation1/UNKNOWN/revoked1，旧token仍header16/O403。

正常/失败 dispose 统一聚合：停止测试发送→destroy所有记录的ClientHttp2Session及streams→close/closeAllConnections HTTP、close HTTP2 servers且destroy其已记录sessions→controller.close→关闭只读SQL句柄→删目录。每关闭Promise限定5000ms；failures使用AggregateError保留原错误。不得未等待close即删证书或DB。

SDK子进程使用spawn且保留精确ChildProcess句柄，detached进程组仅本任务使用；超时kill该group并await close，禁止pkill/按名字杀进程。download125000、tar30000、npmci240000、gen120000、build120000ms；总prepare600000ms。日志仅任务临时0600文件，公开只阶段/退出码/耗时；dispose删除SDK/归档/cache/log，失败保留脱敏阶段错误，不泄漏代理地址。网络失败STOP，禁止换来源、关TLS、mock schema或skip。Linux/macOS两平台使用正常curl/tar/openssl/npm；缺命令T0 STOP。

## Operation HTTP 精确前后控制

fixture仅启动真实 `controller.operationIngress()` 返回的HTTP server，不传allow或acceptTaskEvents，不增加代理鉴权逻辑。O例在fixture创建时生成 `operationPrefix='a103:'+randomUUID()`，三个id分别为prefix+':before'、prefix+':after'、prefix+':reopen'；均长度≤256，input固定字符串 `'a103-operation-input-v1'`。每次实际fetch(new URL('/operations',operationUrl),{method:'POST',headers:{authorization:'Bearer '+grant.token,'content-type':'application/json'},body:JSON.stringify({id,input:'a103-operation-input-v1'}),signal:AbortSignal.timeout(5000)})，消费或cancel响应body。

只读SQL观察器 `operations()` 运行 `SELECT session,generation,id,digest,state FROM operations WHERE session=? ORDER BY id`，参数为binding.session；每次新建readOnly连接并finally close。O不执行SDK RPC，避免无关SDK operation污染：第一次合法POST之前投影为空；before请求201后恰有一行(session=binding.session,generation=1,id=prefix+':before',digest=SHA256('a103-operation-input-v1'),state='UNKNOWN')，该行是合法持久预留，不清理为成功。记录此projection为O基线；await revoke精确得到UNKNOWN/generation1/stopConfirmed=false结果后再确认相同projection与SQL撤权，然后after请求必须403且projection与基线deepEqual。reopen原库后再次先确认原projection及revoked，再发reopen请求403，随后projection仍deepEqual；明确断言after/reopen两个id都不存在。其他H中的operation成功控制使用同样body形状、独立随机prefix与真实入口，不能调用reserveOperation替代HTTP。

## 不变量与验证矩阵

| 编号 | 先有合法控制                                                                   | 撤权后真实攻击及断言                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H    | 三SDK方法0、operation201；SQL RUNNING/有capability                             | 该前置本身不改变Readiness                                                                                                                                         |
| N    | 每方法独立合法RPC、原HTTP2session存活                                          | revoke后同session新stream，三个方法各header status16，upstream requests不增                                                                                       |
| R    | 每方法独立合法RPC后关闭原client                                                | revoke后新HTTP2连接，三个方法各header status16，upstream不增                                                                                                      |
| I    | interactive start+一帧stdin，upstream各计数确认；另有成功已完成interactive控制 | 调用takeover进入stop barrier（已NULL/fenced）后尝试旧stream stdin；下游header7、closed与upstreamClosed均确认；stdin计数不增；然后同client新stream与重连均header16 |
| O    | 真实operation POST第一次201                                                    | revoke后不同id再次POST403，operations行数/内容不增                                                                                                                |
| P    | 既有官方fixture start/create/turn产生checkpoint及receipt                       | 同controller takeover后旧writer.append独立抛OwnershipLost，trace仅stage403；四表与撤销基线相同，不当作SDK拒绝证据                                                 |
| D    | 每SDK例SQL先有真实tokenhash但仅投影hasCapability                               | 撤销后独立只读SQL revoked=true、binding不变；reopen原库旧capability三方法仍header16/operations403                                                                 |

I的post-revoke stdin允许本地write在已关闭stream上抛错，但仍必须另行断言下游header7、两侧实际close及upstream未收帧，不以本地异常或reset单独通过。撤权前计数必须等完整frame被upstream解析后再取baseline，防止把预先排队stdin算在撤权后。入口断流不声明正在运行的子进程已停止；保留A3缺口。

P固定复用 `createProviderFixture` 及其公开 runtime API，禁止改旧fixture/runtime：start(1)→create→turn（内置等待200ms auto-flush及inflight quiescence）→保存writer与合法events→controller.takeover→snapshot baseline→writer.append(events.slice(0,1))拒绝→trace stage403/四表不变→expectRevokedDispose→fixture.reopen→独立SQL capability NULL与generation2；另读历史行epoch1/owner='bento:revoked'/handleNULL→fixture.dispose。不手工造官方handle、mock append或过滤事件。SDK与Provider是两组明确标注的本地子链，不拼成A5同轮真实部署证据。

## 必要代码规模（仅 A1-03）

基线 b08cd93，非空非纯注释，范围逐行去重；只计本次授权/撤销/真实入口需要核对的既有代码，不计文档、generated或不再相关的Store/业务HTTP。

| 路径                                                | 行范围                  | 有效LOC |
| --------------------------------------------------- | ----------------------- | ------: |
| apps/orchestrator/openshell/authority.ts            | 137–195                 |      53 |
| apps/orchestrator/openshell/worker-gate.ts          | 1–73                    |      61 |
| apps/orchestrator/openshell/single-host.ts          | 143–285                 |     136 |
| apps/orchestrator/openshell/persistence-ingress.ts  | 1–60                    |      58 |
| apps/orchestrator/openshell/sdk-ingress.ts          | 1–427                   |     412 |
| apps/orchestrator/openshell/persistence-fence.ts    | 1–76                    |      66 |
| apps/orchestrator/execution-service/command-host.ts | 16–124                  |     105 |
| apps/worker/remote-session.ts                       | 1–110                   |     105 |
| 合计                                                | 8不同代码文件，不含新增 |     996 |

## T0：已核验前置与本轮修订放行

原计划b4c3e0fc6345efab59d9fa2bea130c57fc23ee00已独立审核/仅计划提交/显式worker启动，T1/T2已有PASS提交。本轮不重建分支。恢复已核对HANDOFF、HEAD046ff51及两处源字节；诊断事实见上节。

本轮只允许改本文并送新SHA。MASTER对同一修订明确Executable后，才沿现有分支恢复T3，先落实唯一UNKNOWN语义；不先删除T3，不混入未通过源的计划提交。基线或正式范围有影响变化先回MASTER复审。

## T4：持有 interactive 通道撤权

前置状态：N3/R3/O共7例于2026-11-20 focused全部PASS、skip0；仅一次takeover精确拒绝并保持UNKNOWN/gen1；新流/重连/原库reopen均header16、O403且SQL/历史无新增；typecheck/lint通过。
允许修改：本文、fixture.ts、binding-grants.test.ts。专门读取sdk-ingress.ts、worker-gate.ts、single-host.ts，共6文件。
禁止修改：A3真实进程停止、READY保护或其他执行入口。

执行：增加唯一 `A1-03 I held interactive rejects post-revoke stdin`；先成功结束一条interactive控制，再打开hold流，start/stdin完整解析计数后baseline；takeover触发stop barrier时独立SQL已NULL，尝试旧流stdin，等待下游header7及两侧实际关闭，无新增stdin；原takeover精确拒绝且撤权闭流观测完成后，同client新stream与重连都header16；重开原库仍header16。hold请求可留下UNKNOWN operation，不篡改其state。

验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='A1-03 I ' apps/orchestrator/openshell/binding-grants.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：目标1例通过，成功前置/独立撤销/持有流header7/两侧关闭/无post-revoke帧/后续拒绝及cleanup全部有断言。
STOP：只观察100ms timer或只本地write错误、停流未观测、原takeover未得到精确预期错误、错误映射或双侧close观测不符；不伪造停止证据。

## T5：旧官方 Provider 独立拒绝与固定打包门禁

前置状态：T4通过，不改既有A2时序。
允许修改：本文、binding-grants.test.ts、check-package.mjs、Orchestrator package.json、public-files.json。专门读取provider-lifecycle/fixture.ts、runtime.ts、旧temporal-retry/check-package.mjs、根package.json，共9文件。
禁止修改：原A2 tests/fixture/runtime、根files、public patterns、workflow。

执行：按P固定调用新增 `A1-03 P old provider cannot append after controller revocation`，不另造Provider；追加readOnly SQL/reopen撤销读回。suite仍由既有openshell/*.test.ts自动纳入。新增check-package并精确登记其源；Orchestrator check只在原命令尾追加 `&& node openshell/binding-grants/check-package.mjs`，保留Temporal9项与原pack检查。

check-package固定：assert根package.files与旧check-package同approved数组完全相同、patterns原3项相同；5个新增源各在public files一次、实际npm pack files一次；npm pack --dry-run --json在真实已安装依赖树运行，timeout120000/maxBuffer8MiB。逐文件拒绝node_modules、.pem/.key/.crt/.sqlite及wal/shm/.db/.log/.tgz/.tar.gz、debug-workspace、bento-a103-sdk-*目录；输出仅计数与正负断言PASS。不得修改/遮蔽安装树使打包检查变绿。

验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='A1-03 P ' apps/orchestrator/openshell/binding-grants.test.ts
node apps/orchestrator/openshell/binding-grants/check-package.mjs
pnpm --filter @bento/orchestrator typecheck
```

PASS：P目标1例、stage403/OwnershipLost/four-table不变及reopen独立NULL通过；真实包正负检查通过、typecheck0。
STOP：自动flush竞态、关闭异步错误、pack依赖/私钥泄漏、公共白名单扩大；保留STEP，不改原五断言。

## T6：完整验证、证据迁移与删除

前置状态：H1、N3、R3、O1、I1、P1共10独立业务tests已实现；SDK工具6探针不是业务tests。
允许修改：本文、Readiness、APPLICATION-BOUNDARIES-DESIGN.md。专门读取binding-grants.test.ts、sdk.ts、fixture.ts、check-package.mjs、Orchestrator package.json、public-files.json，共9文件。
禁止修改：A1父及01/02/04/05状态、A的验收证据与生产源码。

执行：运行以下完整集合；test总数必须10、全通过、skip0。Readiness仅A1-03补日期、HEAD/SDK revision、loopback/mTLS受控upstream/真实HTTP+HTTP2+双库/官方Provider、各独立断言及Not Covered。全部正式适用条件有证据才能标已实现；若MASTER认为本地证据缺真实部署必需项，保留部分实现并STOP送审，不能自行缩验。父A1部分不变、其他子项不变。设计新增A1-03本地验收接线，注明fixture与真实边界；不把mock sandbox停止说成真实停止。最后删除本文及仅指向本文的引用。

验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/openshell/binding-grants.test.ts
pnpm check
node apps/orchestrator/openshell/binding-grants/check-package.mjs
git diff --check
```

PASS：10业务tests全过无skip；pnpm check全过，包含正常官方Temporal CLI获取及9项真实retry硬门禁；pack正负通过；Readiness证据适用本HEAD，所有未覆盖项明确；本文最终删除。
STOP：任一缺失/skip/网络/CI相关失败或不能独立完成A1-03；不手工跳过Temporal、不硬编码旧archive。按实际错误修复本范围或回MASTER，保留原证据。

## 失败恢复、交付与删除约束

ENVIRONMENTS.md不存在；固定loopback fixture无秘密配置依赖，不索取远端值。正常系统代理仅单命令继承，不输出地址，不改TLS/global。SDK工具临时目录必须在检查结束后删除；本轮作者探针目录已在送审前删除且确认无残留子进程，未来重新准备，不把本地缓存当仓库依赖。

业务fixture失败仅清本任务临时资源，保留断言失败与清理错误；不得重置用户DB/删其他分支。新test在固定CI入口运行，依赖不可用明确失败，不能silent skip。影响基线变化由MASTER复审；按最新main普通merge后复验受影响边界，不覆盖A的在途candidate。

获审实施后的完整交付沿一个Draft PR→本地验证/范围通过转Ready→同HEAD所有适用CI与明确Codex审查→显式$bento-codex-comment-fix处理→普通merge→回读/同步/仅任务分支fixture清理；不squash/rebase，不改保护规则。当前阶段只提交草稿给MASTER审核，不运行上述业务步骤。
