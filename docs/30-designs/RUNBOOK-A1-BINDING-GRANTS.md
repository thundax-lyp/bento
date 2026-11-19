# RUNBOOK：A1-03 旧执行授权拒绝

## 状态、工作边界与执行者契约

- 建立/修订日期：2026-11-19；状态：作者草稿，待 MASTER 审核，未提交，**尚非 Executable**。
- 唯一 checkout：`/Volumes/storage/workspace/bento-b`；起点 `main=origin/main=b08cd93c8667ca524450289733e2992e3b7bbfe2`。当前只有本文未跟踪；未建任务分支、未实施业务。
- MASTER 已裁决缩为 A1-03，批准作者在仓库外做纯本地官方 SDK 工具准备；该准备已通过下述探针。T1–T6 仍需同版本 `Executable`、单独计划提交核对及显式 `$bento-runbook-worker RUNBOOK-A1-BINDING-GRANTS.md` 后才能执行。
- 执行分支固定 `codex/a1-revoked-grants`。MASTER 对同一草稿 SHA 评为 Executable 后，才按其指令创建该分支并仅提交本文；回读分支、计划 commit/blob、完整文件清单和干净状态，由 MASTER 核对后再等显式 worker 调用。当前不得提前创建分支。
- 执行者仅能按固定顺序修改列出的文件、运行命令、核对断言或 STOP；不得选择新产品范围、放宽断言、替换 SDK、跳过网络失败或扩大共享生产修改。
- 每步 PASS 后删除该步说明，将依赖改为对应可回读产物并单独提交。最后一步同提交迁移 Readiness 并删除本文。失败保留当前 STEP，不提交半成品。
- PASS 指对应版本的全部规定断言通过；skip、静默缺 SDK、只启动端口、单独 Gate.require 不构成通过。STOP 报告最后 PASS/SHA、精确 symbol、命令、脱敏结果及所需决定，不回滚用户文件。

## 目标、Scope 与 Non-goals

唯一目标是 [A1-03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-03-bad-case-旧执行授权)：先以生产 controller 生成的当次 grant 完成合法 HTTP/HTTP2/Provider 调用，再真实撤权；旧 capability 的新请求、同连接新 stream、重连和持有 interactive 后续 stdin 均不得继续执行，旧官方 Provider 不能追加历史；通过独立只读 SQL 和同路径 reopen 读回撤销。

测试范围固定为本地单宿主 SingleHostExecution 的 persistence HTTP、operation HTTP 和 SDK HTTP2 三 RPC。mTLS upstream 为独立受控服务器，不是外部 OpenShell Server；SDK wire 与生产 decoder 真实，模型和 sandbox 观察是 fixture。该本地证据不声明真实外部部署、真实模型或实际 Docker 进程已停止。Happy Path 是本项负例的前置控制，不等于 A1-01 的账号到完整部署绑定链。

不修改生产源码、原 A2 五场景或时序、不修改依赖清单/lock、workflow、根 package.files。禁止 A 的远端 Docker/OpenShell/IdP/S3/模型、其代理及其他 checkout 写操作。禁止 service.ts retryReason/advanceTaskRetry、旧 service retry suite、业务 history checkpoint/restore。需要进入共享生产源码时必须先 STOP 给 MASTER 排序。

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
3. `apps/orchestrator/openshell/binding-grants/fixture.ts`：`createGrantFixture(sdk:PreparedSdk):Promise<GrantFixture>`。GrantFixture 返回 controller、binding、grant、sdkUrl/operationUrl（reopen 后返回新端口的只读 getter）、connect():ClientHttp2Session、request(client,method,hold?:boolean):Promise<RpcResult>、openInteractive(client):Promise<HeldRpc>、revoke():Promise<void>、beginRevoke():{revoked:Promise<void>,settled:Promise<void>}、snapshot():AuthoritySnapshot、history():HistorySnapshot、reopen():Promise<void>、dispose():Promise<void>；RpcResult={status:string,upstreamCalls:number}；HeldRpc={sendStdin():void,status:Promise<string>,closed:Promise<void>,upstreamClosed:Promise<void>}。签名使用来自生产/Node 的真实类型；snapshot投影采用上文明确字段；history固定四表；计数为独立upstream总收到请求/完整stdin帧数，两项暴露 `counts():{requests:number,stdin:number}`。
4. `apps/orchestrator/openshell/binding-grants.test.ts`：固定 suite，后文每场景独立 test，禁止 skip。通过 suite before/after 准备/处置一次 SDK；每 case 独立 fixture/controller/grant。before hook timeout600000ms，每业务 test timeout60000ms，concurrency=false。
5. `apps/orchestrator/openshell/binding-grants/check-package.mjs`：根路径由 import.meta.url 获取，实际 npm pack dry-run 白名单正负断言。不得改旧 temporal-retry/check-package.mjs。

fixture 行为唯一固定：两库同目录；binding={tenant:'a103-tenant',project:randomUUID(),session:randomUUID(),sandbox:'a103-sandbox',volume:randomUUID()}；controller.bind观察仅为本地fixture合法种子，admit(session,1,randomUUID(),300000)。SDK upstream 使用独立 openssl 生成的一日CA/签名server与client证书、server requestCert/rejectUnauthorized=true；仅127.0.0.1随机端口。client证书只给ingress，测试worker只得loopbackURL/token。upstream用官方decoder识别合法frame并计数，正常GetSandbox返回空合法gRPC消息/0 trailer，正常Exec与interactive返回官方exit(0)/0 trailer；hold interactive仅记录start/合法stdin，固定不发送response headers、data或trailers，不结束；撤权后观察stream/session close并断言下游header7。operation listener必须直接采用controller.operationIngress()，sdk listener直接采用controller.sdkIngress(options)，均listen(0,'127.0.0.1')，不得自写鉴权HTTP/手造grantFor替代生产入口。

TLS 生成固定为独立 CA、server、client 三对 RSA2048 密钥：CA 用 openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=a103-ca -addext basicConstraints=critical,CA:TRUE；server/client 分别用 req -new -newkey rsa:2048 -nodes -subj /CN=a103-server 与 /CN=a103-client；再用 x509 -req -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 签发。server.ext 固定 basicConstraints=CA:FALSE、subjectAltName=IP:127.0.0.1、extendedKeyUsage=serverAuth；client.ext 固定 basicConstraints=CA:FALSE、extendedKeyUsage=clientAuth。文件名固定 ca/server/client 的 .key/.csr/.crt 和两 .ext；全部在 fixture 0700目录，写入文件 mode0600，每次 openssl timeout30000ms。HTTP2 server 显式 ca=ca.crt、cert=server.crt、key=server.key、requestCert=true、rejectUnauthorized=true；ingress credentials 使用 ca.crt/client.crt/client.key。正常连接必须 server-side socket.authorized=true，否则 STOP。HTTP与HTTP2请求/close各timeout5000ms、case内barrier等待timeout10000ms，超时不重试请求。

`beginRevoke()` 在同一调用内记录deadline=performance.now()+10000，启动 `controller.takeover(binding.session,1)`；revoked在fixture sandbox.stop被调用时resolve，此时独立SQL必须revoked=true。stop先标记fixture running=false，再等待本例所有已记录SDK上游transport.close，全部完成才返回；无持有transport时立即返回。I在await revoked后同步尝试旧流stdin，随后等待header7及两侧close。所有barrier沿用该剩余总deadline，不能每次重置10秒。

settled封装唯一有界算法：首次takeover成功直接resolve；首次抛错时仅当 `error instanceof Error && error.message==='old execution unconfirmed'` 才进入一次恢复检查。检查必须在原deadline内确认全部已记录SDK transport已close，独立inspect为同Session/generation1/stateUNKNOWN且capabilityNULL，再await一次setImmediate让gate.channel.finally完成；随后仅重调一次 `controller.takeover(binding.session,1)`。最多两次takeover调用；第二次任意错误原样reject，不再循环。首次其他错误、SQL不符、剩余时间不足、任何close超时都立即reject并触发STOP。不得在仍活跃transport时重调，不重发stop命令，不吞非指定错误，不修改SQL或operations.UNKNOWN。

`revoke()` 仅执行 `await beginRevoke().settled`。创建settled即安装拒绝观察器避免unhandled rejection，但保留其原始拒绝向test传播；若takeover在stop前失败，revoked也以同一错误reject。10秒deadline触发时拒绝fixture本地barrier，destroy精确记录transport、在额外且仅用于清理的5000ms内等待takeover Promise settle并聚合清理错误；清理也超时则STOP并保留精确资源报告，不再启动任何恢复调用；不遗留无人等待的后台takeover。`reopen()` 关闭clients/listeners/controller，以原两库路径重建controller、sdkIngress和operationIngress，旧grant不变，绝不bind/admit。

正常/失败 dispose 统一聚合：停止测试发送→destroy所有记录的ClientHttp2Session及streams→close/closeAllConnections HTTP、close HTTP2 servers且destroy其已记录sessions→controller.close→关闭只读SQL句柄→删目录。每关闭Promise限定5000ms；failures使用AggregateError保留原错误。不得未等待close即删证书或DB。

SDK子进程使用spawn且保留精确ChildProcess句柄，detached进程组仅本任务使用；超时kill该group并await close，禁止pkill/按名字杀进程。download125000、tar30000、npmci240000、gen120000、build120000ms；总prepare600000ms。日志仅任务临时0600文件，公开只阶段/退出码/耗时；dispose删除SDK/归档/cache/log，失败保留脱敏阶段错误，不泄漏代理地址。网络失败STOP，禁止换来源、关TLS、mock schema或skip。Linux/macOS两平台使用正常curl/tar/openssl/npm；缺命令T0 STOP。

## Operation HTTP 精确前后控制

fixture仅启动真实 `controller.operationIngress()` 返回的HTTP server，不传allow或acceptTaskEvents，不增加代理鉴权逻辑。O例在fixture创建时生成 `operationPrefix='a103:'+randomUUID()`，三个id分别为prefix+':before'、prefix+':after'、prefix+':reopen'；均长度≤256，input固定字符串 `'a103-operation-input-v1'`。每次实际fetch(new URL('/operations',operationUrl),{method:'POST',headers:{authorization:'Bearer '+grant.token,'content-type':'application/json'},body:JSON.stringify({id,input:'a103-operation-input-v1'}),signal:AbortSignal.timeout(5000)})，消费或cancel响应body。

只读SQL观察器 `operations()` 运行 `SELECT session,generation,id,digest,state FROM operations WHERE session=? ORDER BY id`，参数为binding.session；每次新建readOnly连接并finally close。O不执行SDK RPC，避免无关SDK operation污染：第一次合法POST之前投影为空；before请求201后恰有一行(session=binding.session,generation=1,id=prefix+':before',digest=SHA256('a103-operation-input-v1'),state='UNKNOWN')，该行是合法持久预留，不清理为成功。记录此projection为O基线；await revoke完成后再确认相同projection与SQL撤权，然后after请求必须403且projection与基线deepEqual。reopen原库后再次先确认原projection及revoked，再发reopen请求403，随后projection仍deepEqual；明确断言after/reopen两个id都不存在。其他H中的operation成功控制使用同样body形状、独立随机prefix与真实入口，不能调用reserveOperation替代HTTP。

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

P固定复用 `createProviderFixture` 及其公开 runtime API，禁止改旧fixture/runtime：start(1)→create→turn（内置等待200ms auto-flush及inflight quiescence）→保存writer与合法events→controller.takeover→snapshot baseline→writer.append(events.slice(0,1))拒绝→trace stage403/四表不变→expectRevokedDispose→fixture.reopen→独立SQL capability NULL与generation2→fixture.dispose。不手工造官方handle、mock append或过滤事件。SDK与Provider是两组明确标注的本地子链，不拼成A5同轮真实部署证据。

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

## T0：作者前置与 MASTER 放行

前置状态：仅作者阶段，SDK工具probe已PASS，业务未实施。
允许修改：本文。专门核对：本文、AGENTS、RUNBOOK-RULES、command-host、SDK官方package-lock/buf.gen/raw、原provider fixture，共8文件。
禁止修改：任何生产/测试/依赖/CI。

执行：核对上述工具证据；MASTER只读审核同一草稿。审批前不建分支。获同SHA Executable后才按MASTER指令新建codex/a1-revoked-grants，仅提交本文；回读commit SHA、计划blob与获审字节一致、提交文件仅本文、分支及基线和干净状态，由MASTER核对，再等显式worker调用。

验证（仓库根）：

```bash
git status --short
git rev-parse HEAD origin/main
pnpm exec prettier --check docs/30-designs/RUNBOOK-A1-BINDING-GRANTS.md
git diff --check
```

PASS：只有本文未跟踪，基线相同，链接/格式通过；官方探针6项已实测，MASTER对同SHA评Executable并核对计划提交。当前尚缺最后审核/提交/worker调用。
STOP：来源/基线/共享窗口变化或审核未通过；不能把本工具探针当业务PASS。

## T3：旧 capability 的新 stream 与重连

前置状态：binding-grants.test.ts 的 H 合法当次授权控制已执行1例PASS/skip0（2026-11-19，真实官方SDK、mTLS upstream三RPC、operation201及独立SQL），typecheck/lint通过。
允许修改：本文、binding-grants.test.ts、fixture.ts。专门读取authority.ts、single-host.ts、sdk-ingress.ts、persistence-fence.ts、sdk.ts，共8文件。
禁止修改：production/UNKNOWN对账/停止生命周期。

执行：新增3方法×2连接方式的6独立 `A1-03 N METHOD` / `A1-03 R METHOD` tests，每例先成功再takeover，再发送合法官方wire旧token请求。每例新请求header grpc16、upstream不增、SQL capabilityNULL/五字段不变；关闭重开原两库后同旧token再次header16。O独立test严格使用Operation HTTP精确前后控制章节的三个id/body、真实controller.operationIngress和只读projection；before201，撤权后after403，原库reopen后reopen403，两个拒绝后projection与唯一UNKNOWN预留基线deepEqual。snapshot比较以撤权完成后的状态为baseline，避免错误要求generation不变。

验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='A1-03 (N |R |O )' apps/orchestrator/openshell/binding-grants.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：7目标tests全部通过；6+6次SDK拒绝独立观察，O前后/reopen均拒；SQL与upstream证据不缺。
STOP：任一方法遗漏、upstream新增、SQL撤销未生效、原路径reopen不成立；不改Gate或放宽status。

## T4：持有 interactive 通道撤权

前置状态：T3通过，真实旧grant拒绝可回读。
允许修改：本文、fixture.ts、binding-grants.test.ts。专门读取sdk-ingress.ts、worker-gate.ts、single-host.ts，共6文件。
禁止修改：A3真实进程停止、READY保护或其他执行入口。

执行：增加唯一 `A1-03 I held interactive rejects post-revoke stdin`；先成功结束一条interactive控制，再打开hold流，start/stdin完整解析计数后baseline；takeover触发stop barrier时独立SQL已NULL，尝试旧流stdin，等待下游header7及两侧实际关闭，无新增stdin；完成takeover后同client新stream与重连都header16；重开原库仍header16。hold请求可留下UNKNOWN operation，不篡改其state。

验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='A1-03 I ' apps/orchestrator/openshell/binding-grants.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：目标1例通过，成功前置/独立撤销/持有流header7/两侧关闭/无post-revoke帧/后续拒绝及cleanup全部有断言。
STOP：只观察100ms timer或只本地write错误、停流未观测、真实takeover无法对账；不伪造停止证据。

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
