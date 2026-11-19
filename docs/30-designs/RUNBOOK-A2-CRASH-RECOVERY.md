# A2 Crash Recovery RUNBOOK

## 状态与执行者契约

- 状态：Draft / 待 MASTER 审核；2026-11-19。当前阶段仅作者调查与未提交草稿，不授权实施。
- checkout：B；基线 `6c59560e95da641719e2ab9343cc23986abd4163`。执行分支唯一为 `codex/a2-crash-recovery`，作者阶段不得创建。顺序固定：MASTER 对本文件精确 SHA256 给出 Executable → MASTER 派建该分支且仅提交获审 RUNBOOK → 回读分支、基线、提交 SHA、单文件清单与文件 SHA256，交 MASTER 核对 → MASTER 显式 `$bento-runbook-worker RUNBOOK-A2-CRASH-RECOVERY.md` 启动后才能 T1。审核通过或计划提交本身不等于实施启动。
- 遵循 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)、[Document Rules](../00-governance/DOCUMENT-RULES.md)、[Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。每步 PASS 后删该步、保留事实与剩余步骤，独立 commit；最后迁移长期证据并删除本文件。不得 squash/rebase。
- 每步预算包含本文件及专门读取文件，不超过 10 个。只允许下文指定路径；需要生产修复、依赖改版、断言降级或超过预算则 STOP，交作者修订重审。不得由执行者选择替代方案。
- STOP 保留现场，回报最后 PASS/commit、准确 symbol、复现命令、脱敏输出与所需决定。失败不得写已实现。回滚仅关闭本任务有句柄的子进程/服务器、删除本任务 mkdtemp 目录；不得丢弃用户修改。

## 目标、断点及正式依据

交付同一条持久会话链的两个剩余场景：[A2-04 与 A2-05](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a2-持久会话)。合并理由：均依赖官方 Provider 的 durable intent、真实 ingress/SQLite、代次接管及新 Worker 恢复，共用进程夹具，分别验收。

[Architecture](../00-governance/ARCHITECTURE.md) 的 Session 日志/执行权边界及 [设计的三组交接不变量、A2 Provider 接线](./APPLICATION-BOUNDARIES-DESIGN.md) 约束：未提交先对账；已提交不重复；旧代拒写；控制面先撤权、确认停止与绑定，再放行新代。[Readiness](../40-readiness/CURRENT-READINESS.md#a2-官方-provider-本地验收) 当前 A2-01/02/03 已实现，04/05 待核验，父 A2 部分实现。

已核对实现：

1. `apps/worker/dsh-worker.ts:runDshWorker` 安装 RemoteSession，stat 后若 prior 存在，先 `reconcileSessionPersistence`，再官方 agents.resume；recover 模式 flush 后返回 recovered。
2. `apps/worker/remote-session.ts:RemoteSession.finishReconciliation` open(write)→无 batch 参数 reconcile→close；失败缓存仅存在当前 runtime。`Handle.settle` stage→append→校验 receipt→reconcile。
3. `apps/orchestrator/openshell/session-history.ts:dispatch/transaction/request/commit` 每个 RPC 独立 BEGIN IMMEDIATE/COMMIT。stage 写 intent；append 在同一事务写 events、receipt、next/revision；reconcile 自主从 intent 取 payload，可提交未提交批次，或复用 intent.epoch 的旧 receipt，再删 intent。
4. `apps/orchestrator/openshell/single-host.ts:takeover/admit/persistenceIngress` 经 WorkerGate 执行正式请求。`PersistenceFence.revoke/grant` 清旧 handle、改 owner/epoch，不删除 intent；generation2 的 reconcile 仍可找 epoch1 receipt。
5. 既有 `provider-lifecycle/fixture.ts` 只在测试进程中装配官方服务；现有五项不能证明真实强杀或 runDshWorker 自主恢复。

终点：四个新的独立数据库场景（04 before/after commit；05 after-stage/after-append）通过；每场景先完成正常轮，再故障，再同库重开与合法新代恢复，最后新代正常轮通过。04 与05 各写独立证据，不用一个结果替代另一项。

## Scope、Non-goals 与真实性

允许测试夹具抽取复用、子进程强杀、只读 SQL 证据、官方 DSH runDshWorker 测试 bootstrap、精确白名单登记及 A2 相关设计/Readiness 更新。无生产行为变更预案；发现正常入口缺口即送最小生产修复计划重审。

禁止修改：`apps/orchestrator/execution-service/service.ts`、service retry suite、业务 history checkpoint/restore 算法、OpenShell/workspace-checkpoint、A12 外部窗口、根 files 正向范围、runtime dependencies/lock、CI workflow。禁止远端 IdP/S3/OpenShell/模型、旧 Docker、其他 checkout。仅 localhost 随机端口、本任务临时 SQLite 与持有 ChildProcess 对象的 PID。

真实：独立 OS 进程、SIGKILL、SQLite FULL/WAL、生产事务与 ingress/WorkerGate/RemoteSession、官方 AgentRegistry/AgentLoop/SessionStore/checkpoint、runDshWorker 恢复入口。合成：binding/Run、模型响应、sandbox stop/start/running、bootstrap 配置。不得由此宣称外部模型/OpenShell、独立停止观察、生产 bootstrap、多节点及完整故障接管通过。没有外部副作用/outbox/Archive 新契约；本轮不新增 DTO、运行时公开 endpoint 或迁移。

## 精确数据、接口和不变量

以下结构只描述既有协议，本轮不改其所有权或语义：

| 结构           | 精确字段、来源和生命周期                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WorkerRequest  | required `mode:'execute'\|'recover'`, `binding:{tenant,project,session,sandbox,volume:string}`, `grant:{token,session,run:string,generation:number}`, `persistenceUrl,operationUrl:string`；optional `prompt,publicEventsUrl,gateway:string`。控制面生成 binding/grant；恢复输入无 batch/events/receipt/旧 handle。execute 需要 prompt/gateway/provider；recover 不调外部 provider。 |
| sessions       | `id,header,owner:string; inherited,epoch,next,revision,materialized:number; handle:string\|null; created_by:string\|null`。header 为官方 materializeCreateHeader 的 JSON；next/revision 初值0，materialized SQL 默认1、create 写0。create 产生 key，revoke 清 key；grant 改 epoch/owner。                                                                                            |
| batch_intents  | `id:string` PK(Session)，`epoch:number,batch:string,payload:string` 均 required/non-null；stage 产生，batch 由 RemoteSession randomUUID，payload 为 materializeAppendBatch 后完整事件数组 JSON，epoch 来自 grant；reconcile 删除；接管不删除。                                                                                                                                       |
| events         | required `id:string,seq:number,event:string(JSON)`，PK(id,seq)；序号由官方 Session 产生，assertContiguous 核验，事务写入。不得自己制造事件/修改 seq。                                                                                                                                                                                                                                |
| batch_receipts | required `id:string,epoch:number,batch:string,digest:string,first:number,count:number`，PK(id,epoch,batch)。digest=sha256(payload)，first=提交前 next，count=events.length；原 receipt 不改不删。公开 receipt 不含 id，其余字段同 SQL。                                                                                                                                              |
| Provider RPC   | `/rpc` JSON `{method,id?,key?,batch?,events?,...}` + Bearer grant。new Worker 自主请求 `reconcile` 不含 batch/events；返回 null 或 `{outcome:'committed'\|'already-committed',receipt}`。新的 append 仍 stage→append→reconcile；不手动重放 RPC。                                                                                                                                     |
| 错误           | 授权失效 ingress HTTP403→SessionOwnershipLostError；占用 writer→SessionAlreadyOwnedError；未结 intent close/flush→IntentConflict（RPC400）；digest 冲突→BatchConflict。新测试不改变映射，也不吞这些错误。                                                                                                                                                                            |

事件种类、内容、时间及 ID 均来自官方 Session/AgentLoop，不另加领域事件。正常轮需 request/header、user/message、assistant/message 和 completed turn/end，官方 checkpoint 必须在模型 dispatch 前提交输入。恢复后的官方 end-seed 是合法新 suffix，不得与原 prefix 混淆。测试比较原历史精确前缀、事件单份连续、每个事件唯一 receipt 覆盖、digest/first/count 与 SQL 一致。

旧已提交 receipt 必须逐字段 deepEqual；stage-only 情况杀前没有目标 receipt，恢复后才有新 generation receipt，禁止称为复用“原 receipt”。after-append 情况恢复结果必须 already-committed，receipt epoch 保留1，next/revision 不因这次 reconcile 再增加。恢复后的官方 resume/flush 新 suffix 可增加独立批次，分开计数。

## 文件与规模

下列为基线必要核对的既有代码，按精确行范围去重，排除空行和整行注释（含块注释）；不计文档、生成物、新增估计。总 **8 文件、1875 有效 LOC**，满足500/5门槛。

| 文件                                                        | 行范围 / 必要 symbol                                        | 有效 LOC |
| ----------------------------------------------------------- | ----------------------------------------------------------- | -------: |
| `apps/worker/dsh-worker.ts`                                 | 1–158，runDshWorker/Runtime/completedTurn                   |      149 |
| `apps/worker/remote-session.ts`                             | 1–399，RemoteSession/Handle/reconcileSessionPersistence     |      366 |
| `apps/orchestrator/openshell/session-history.ts`            | 438–743，dispatch/transaction/request/events/receipt/commit |      295 |
| `apps/orchestrator/openshell/single-host.ts`                | 145–260，admit/takeover/reconcile/persistenceIngress        |      110 |
| `apps/orchestrator/openshell/persistence-fence.ts`          | 1–76，revoke/grant                                          |       66 |
| `apps/orchestrator/openshell/worker-gate.ts`                | 1–73，require/channel/revokeChannels                        |       61 |
| `apps/orchestrator/openshell/provider-lifecycle/fixture.ts` | 1–518，createProviderFixture/LocalTurnAdapter/runtime       |      510 |
| `apps/orchestrator/openshell/provider-lifecycle.test.ts`    | 1–322，全部五项及verifyStored                               |      318 |

仅允许新增以下四个文件（名字固定），修改现有 fixture、public-files.json、设计和 Readiness；既有 test 只读，不改断言。生产上述六文件只读。

- `apps/orchestrator/openshell/provider-lifecycle/runtime.ts`：导出共享官方装配 `createOfficialRuntime`；抽取现有 Context、插件顺序、LocalTurnAdapter、agents/flush/dispose 行为，不复制第二套实现。
- `apps/orchestrator/openshell/provider-lifecycle/crash-child.ts`：仅测试子进程入口，host/worker 两种角色及 SQLite barrier。
- `apps/orchestrator/openshell/provider-lifecycle/crash-fixture.ts`：父进程编排、只读证据、kill/wait/cleanup；不执行持久化 RPC。
- `apps/orchestrator/openshell/provider-crash.test.ts`：四项独立故障场景；进入既有 openshell/*.test.ts，因此不改 package/CI 命令。

## 固定进程协议与 barrier

新符号签名（均为测试接口）：

```ts
// runtime.ts，类型复用各官方包，不在生产导出。
createOfficialRuntime(options: {
    workspaceRoot: string;
    sessionId: SessionId;
    beforeStream: (options: GenerateOptions) => void;
}): Promise<{
    ctx: Context;
    agentOptions: AgentOptions;
    agents: AgentRegistry;
    initialize(): Promise<void>;
    persistence(): SessionPersistence;
    flush(agent: Parameters<Awaited<ReturnType<DshWorkerBootstrap>>['flush']>[0]): Promise<void>;
    userMessage(prompt: string): ReturnType<typeof createUserMessage>;
    dispose(options?: { revoked?: boolean }): Promise<void>;
}>;
```

`initialize` 安装官方服务（AgentRegistry、SessionStore、SessionProjectionRegistry、LlmRuntime、SystemPrompt、ToolRuntime、AgentLoop、checkpointPolicy 顺序不变）并注册 a2-local 模型。RemoteSession 由调用者先安装，禁止 initialize 再安装。runtime agents 使用 ctx.agents 的官方实例（getter，initialize 前不读取）；仅包装该实例 create/resume 以跟踪官方返回的 handle，不另写 Agent factory；所有已获取 AgentHandle 的唯一显式处置者为共享runtime.dispose，固定细则见下节；原fixture与子进程不得再直接handle.dispose或root dispose。恢复句柄仍由生产 RemoteSession 自行处置。新 bootstrap recover 时直接使用该装配。seed/produce/continue 仅沿用原 fixture 的官方 create/resume→followup→whenIdle→flush 正常轮，不走 execute 模式或新增 provider。flush 用 ctx.sessions.get(options.sessionId) 取官方 Session，assert 存在且与 agent.session 为同一对象，再 assert ctx.sessions.flush 返回 true；由此满足既有 DshWorkerBootstrap 的结构类型，不放宽生产类型、不用 any。

### Agent 与 Context 的唯一处置所有权

`createOfficialRuntime` 仅构造 Context、返回对象，不安装插件；调用者得到该对象后才安装RemoteSession、调用initialize。共享runtime保存 `Set<AgentHandle>`（create/resume成功后立即登记，失败未返回的handle不虚构）、`unregisterAdapter?:()=>void`、`disposal?:Promise<void>`。initialize本身不调用dispose；失败统一由取得runtime对象的调用者进入finally/catch处置。共享runtime是唯一显式调用handle.dispose、unregisterAdapter、ctx.fiber.dispose的地方；fixture只负责代理/控制器/目录，子进程只负责进程资源。禁止在fixture保留一套handle/root处置后再调用共享dispose。

`dispose(options?:{revoked?:boolean})` 首次调用立即缓存整个清理Promise；后续调用返回同一个Promise（包括同一个拒绝），不重试任何handle、RemoteSession或root，后续参数不得改变首次模式。一次调用内部顺序固定，逐动作try/catch累计错误，后续动作一律继续：

1. 对Set按获取顺序快照，**调用前从Set删除**，每个handle显式调用dispose恰一次。正常模式直接await；revoked模式须assert捕获handle数恰1，随后保持原fixture的 `await assert.rejects(handle.dispose(), SessionOwnershipLostError)`，不能通过预先吞异常把此断言变绿。
2. 仅revoked模式取得ctx.sessionPersistence，保留既有 `assert('dispose' in persistence && typeof persistence.dispose === 'function')`，再保持原第二个 `assert.rejects(persistence.dispose(), predicate)`：predicate断言AggregateError、message严格为 `Session persistence close failed`、errors.length严格为1、唯一子项为SessionOwnershipLostError，返回true。此动作只调用一次；不能循环writer或单独再次close来改变聚合数量。正常模式不提前手动persistence.dispose。
3. 若已注册模型则调用unregisterAdapter一次，并在调用前清空保存值；未注册时跳过。
4. 无论前面是否失败，调用ctx.fiber.dispose一次。RemoteSession原有ctx.effect仍由Cordis执行；不改其所有权、不注销effect、不额外再调用显式persistence.dispose。框架自身的服务卸载与原fixture原顺序相同，不允许添加handle.dispose重试。
5. 无错误返回；1个错误原样throw；多个错误按动作顺序 `throw new AggregateError(errors,'A2 runtime cleanup failed')`。两个预期assert.rejects通过不计错误；断言失败必须计入，不能标为已撤权并放过。

原fixture.close(revoked)仍缓存其closing Promise，但cleanup动作唯一替换为：`shared.dispose({revoked})` → closeHttpServer(proxy) →原transportFailures断言；全部尽力执行并沿用原fixture cleanup聚合规则。删除fixture原直接agent.dispose、显式persistence.dispose、unregisterAdapter、ctx.fiber.dispose动作，两个预定拒绝断言的原判定逻辑完整迁到共享dispose，五个test断言不改。正常close、expectRevokedDispose、reopen及最终fixture.dispose重复进入close均复用原缓存，不重复调用共享dispose的内部动作。

部分初始化失败：fixture取得shared后任何步骤失败，调用上述普通close(false)，把初始失败与cleanup失败一起聚合；尚无handle/adapter时对应动作跳过，root仍处置。recover bootstrap只返回shared对象及既有DshWorkerBootstrap结构，不提前initialize；安装RemoteSession、initialize失败都处于runDshWorker现有try/finally中，finally调用shared.dispose()。seed/produce/continue在取得shared后统一try/finally共享dispose，正常close命令和外层finally通过同一缓存幂等；SIGKILL故障场景不能运行这段finally，也不由父进程模拟执行它。

子进程统一 `spawn(process.execPath, ['--import', absoluteRegisterPaths, absoluteCrashChild, role], {cwd:repositoryRoot, stdio:['pipe','pipe','pipe','ipc']})`。role 仅 `host`/`worker`；stdin 每行 JSON 命令，stdout 仅 writeSync(1,JSON.stringify(frame)+'\n')，stderr 捕获限64KiB且只报告脱敏错误。IPC 不传旧批次给恢复 worker。子进程在自身正常disconnect前置intentionalDisconnect=true；事件循环可响应时，仅非预期disconnect令子进程以错误退出；卡在Atomics.wait的host由父进程清理SIGKILL，不依赖disconnect回调。每条业务控制等待10秒；单用例node:test timeout=60000，主体独立deadline=40000，到期进入下节至多15000ms清理并失败，禁止只依靠test runner超时。框架不使用 shell/固定PID/固定端口。

Host init 字段 `{authorityPath,historyPath,binding,fresh:boolean}`，首次fresh=true才bind，重启fresh=false读取原库、不bind覆盖。Host 控制命令均含 required `command:string`，响应含相同 `command` 与 `ok:true`，失败响应 `ok:false,error:string` 并令场景失败；init完成响应 `ready` 含 `persistenceUrl:string`。Host 命令 `admit` 输入 `{generation,run}`，lease=120000；每代只admit一次，seed/produce复用generation1的同一grant，recover/continue复用generation2同一grant，绝不在RUNNING再次admit；`takeover` 输入旧 generation；`arm` 输入 `point:'before-commit'|'after-commit'|'after-stage'|'after-append'`，只允许一次且须已有一轮 completed。`snapshot` 由父进程自己只读 SQL，host 不提供写库捷径。

Worker 控制命令同样含 `command`，init后响应ready；`prepare` 获取官方create/resume并先flush seed suffix、响应prepared；`turn` followup固定文本 `a2-crash-input` 并等idle/flush，完成响应completed；`close`正常处置并退出0。recover收到init后直接执行runDshWorker，返回recovered并退出0。Worker init 字段仅 `{request:WorkerRequest,workspaceRoot,action:'seed'|'produce'|'recover'|'continue'}`。seed/produce/continue 调用共享官方 runtime 的 create/resume、followup、whenIdle、flush；seed 和 continue 完整正常轮。recover **只能** `runDshWorker(request, bootstrap)`，mode=recover；不得自己调用 reconcile、open 或 dispatch。recover stdout 可报告结果及观察到的 RPC trace，不能收父进程传来的目标批次。beforeStream 核对正常轮输入已持久提交。produce必须先prepare并收到prepared，父进程此时读取baseline，才arm并发送turn；避免resume suffix混入故障baseline。目标payload必须同时含request/header及user/message，否则不能命中barrier；frame必须记录匹配次数=1。

04 的 barrier 仅在 host 子进程启动时包装公开 `DatabaseSync.prototype.exec`，保留原函数，通过 `PRAGMA database_list` 精确限定 historyPath。arm 后遇 `COMMIT`，在该连接的未提交视图查询 `batch_intents JOIN batch_receipts USING(id,epoch,batch)`，只有存在目标 Session 的 matching receipt 且其intent.payload同时含request/header及user/message才命中 append；stage 的 COMMIT 无 matching receipt，不命中。捕获该 receipt、intent、完整 events/next/revision 为 barrier 证据，测试只读不改库。before-commit 在调用原 exec('COMMIT') 前 writeSync barrier 并 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)` 无限阻塞；after-commit 必须先执行原 COMMIT 再同样阻塞。父进程收到 barrier 后 kill('SIGKILL')，等待 exit signalCode=SIGKILL，之后才重开数据库。不得用 throw/close 模拟崩溃，不复制 transaction/commit SQL 写逻辑。包装不能进入生产模块、不能改变其他 exec 的返回和异常。

05 host 使用 ingress 前方回环透明代理，只在目标 stage/append 已返回上游200、intent.payload同时含request/header及user/message且只读 SQL确认 intent（及 after-append receipt）后暂扣下游 response，以 stdout 发 barrier。请求字节/authorization 原样转发；不得注入/重放请求。父进程 SIGKILL worker 并等退出后，父进程向host发送下节drop-ack命令，host destroy该下游响应、等待handler settle并回执后，才正常close/reopen和takeover。代理只阻断网络回复，不完成对账。原 caller 不运行 dispose/finally。恢复 Worker 走真实 ingress，trace 核验 `stat→open(write)→reconcile(无batch/events)→close→官方resume`，reconcile 返回来自服务端的原批次。目标 batch 仅作为只读断言保存在父进程/host，不写入新 worker 参数/环境/磁盘文件。

### 进程退出、挂起请求与清理的固定顺序

仅crash-child.ts/crash-fixture.ts实现以下测试协议，不增加生产endpoint。所有spawn必须在返回ChildProcess对象后、发送任何init前登记 `error/exit/close` 监听和状态 `{spawned:boolean,exit?:{code:number|null,signal:NodeJS.Signals|null},closed:boolean}`，立即保存exitPromise与closePromise；创建失败的error原样记为失败，不能等待一个永远不会发生的exit。stdout/stderr从spawn起持续消费，禁止管道填满。每个控制命令一次只允许一个在途，监听stdout时拒绝未知/重复回执。

Host额外命令与回执固定：

- `{command:'drop-ack'}`：仅05 barrier已命中且caller已退出后发送；host销毁唯一被扣留response，解除handler内的gate，await该handler的finally，清掉扣留状态；回 `{command:'drop-ack',ok:true,pending:0}`。若无唯一扣留response/handler则失败，不做reconcile。handler finally从inFlight Set删除；上游fetch完成后须已读完body。正常销毁下游由此命令负责，不能作为意外transport error计入；其他fetch/handler错误仍失败。
- `{command:'close'}`：停止接受新控制命令；先关闭proxy listener、销毁全部downstream connections，释放所有扣留gate并destroy response；对inFlight fetch各自AbortController.abort，await全部handler以Promise.allSettled结清，预期close导致的AbortError单独核验，不吞其他错误；proxy关闭后再关闭ingress listener与全部connections并await回调；所有HTTP处理结束后调用controller.close（history/fence/authority/gate按原实现）。包装exec时仅此处恢复保存的原exec。每个清理动作即使前项失败仍执行。成功writeSync回 `{command:'close',ok:true,pending:0}`，随后stdin.destroy、已连接时process.disconnect，设置exitCode=0；失败先writeSync `{command:'close',ok:false,error:'A2 host cleanup failed'}`，disconnect/destroy仍执行，exitCode=1。父进程必须同时核对回执和exit(code0,signal=null)，仅回执不算关闭。
- reopen不是在旧host里重造controller：先close命令成功并等待该ChildProcess exit和close，之后spawn新host，使用完全相同双库路径与binding、fresh=false，等待ready后再takeover/admit。04被强杀host不发close命令；必须先确认其SIGKILL exit与close，然后直接同路径spawn。05固定drop-ack回执→close回执及退出→新host ready。禁止bind覆盖恢复库。

Worker `{command:'close'}`：只在非故障正常轮完成后发送，await共享dispose()；成功回 `{command:'close',ok:true}`，stdin.destroy、process.disconnect、exitCode=0；失败回ok:false并exitCode=1。recover由runDshWorker的finally完成共享dispose，成功先回 `{command:'recover',ok:true,result:'recovered'}` 再相同断开/退出；任何主体或处置错误均失败，不伪造recovered。正常关闭worker必须核对相应回执和exit0/无signal。04/05指定的故障对象不发close，不先end stdin、不disconnect、不发SIGTERM，直接SIGKILL。

父进程统一 `killAndWait(child: ChildProcess, requireSigkill: boolean): Promise<void>`：

1. 只接受本fixture登记的对象；不用裸PID、进程组或pkill。监听从spawn开始已登记，检查已记录exit或exitCode/signalCode。已退出不再kill，但requireSigkill=true仍必须断言已记录signal严格为SIGKILL（提前退出0也失败）；清理模式false对已退出幂等。spawn错误无PID不kill，保留error，spawned=false记为从未存在OS进程的终态；只等待其close，不等待不会发生的exit。
2. 仍活跃时调用child.kill('SIGKILL')恰一次；同步throw、error事件、返回false且回读仍未退出都计清理失败；返回false但已有exit仍需按记录核对。继续await已登记exitPromise，最多5000ms，requireSigkill时断言signal=SIGKILL且code=null；不能把kill返回true当退出证据。
3. 退出后child.stdin.destroy；仍connected时尝试child.disconnect（先检查connected、记录其错误），继续消费stdout/stderr至closePromise（最多2000ms），再destroy读流并移除本fixture事件监听/清空定时器。已退出但close没到也失败，不能无限等待。SIGKILL不是normal关闭成功，只在指定crash对象或失败清理时使用。

`CrashFixture.dispose()`首次立即缓存一个Promise，后续返回同一个结果，不重复kill/close/rm。`runCrashCase`用try/catch记录主体失败，finally总调用dispose；同时注册test.after调用同一dispose作runner保险。主体deadline/控制超时一旦触发，置closing=true，清掉所有控制等待定时器并reject仍在途的命令，禁止再发业务命令。失败清理**直接**按以下顺序，不等旧RPC/Atomics gate自行结束：

1. 对仍活跃worker全部killAndWait(false)，并行启动，Promise.allSettled收集全部错误；已退出对象完成流/IPC收尾。指定crash对象的requireSigkill=true断言仍由主体保存，不因清理false覆盖结果。
2. 对仍活跃host killAndWait(false)，包括Atomics.wait中的host；不向阻塞host发close、不等待fetch超时。退出由OS关闭SQLite/网络；子进程死后父进程无需也不能替它执行controller.close。父进程继续关闭自己的stdin/IPC/流；没有父进程HTTP server或fetch。
3. 正常成功路径则在进入dispose前依次正常close所有worker→host（每个关闭回执及退出总等待上限3000ms）。任一normal关闭失败记录为失败并立即进入上述强杀清理，不把强杀改写成正常close通过。close超时不丢弃child对象。
4. 仅全部成功spawn的登记child均已确认exit且close（spawn失败项须已close）、父只读DatabaseSync已finally.close，才rm本任务folder并assert existsSync=false。否则保留folder，报告未退出对象角色与最小错误；禁止rm掩盖存活进程。每个snapshot无论SQL断言结果如何均finally关闭只读DB。
5. 清理共用deadline=15000ms，kill等待与流关闭均取剩余deadline和上述上限的较小值；超时记录错误，仍向尚未发kill的活跃登记对象发一次SIGKILL并完成可执行的流收尾，不再启动业务。kill失败或到deadline仍无exit必须STOP并报告，不能标PASS、跳过或重新跑用例。父进程在正常返回前必须全部退出/close，否则用例失败。
6. 所有动作尽力执行，错误按主体→worker→host→流/IPC→目录顺序收集；0项成功，1项原样throw，多项 `AggregateError(errors,'A2 crash case and cleanup failed')`。清理失败本身是用例失败，不用console.warn替代。无实现外的兜底进程扫描或跨任务删除。

父编排新符号固定：`createCrashFixture(): Promise<CrashFixture>`、`runCrashCase(point: CrashPoint): Promise<void>`；`type CrashPoint = 'before-commit'|'after-commit'|'after-stage'|'after-append'`。`CrashFixture` required `folder,historyPath,authorityPath:string; session:SessionId; snapshot():PersistedSnapshot; dispose():Promise<void>`，内部保留host/worker ChildProcess对象集合；`PersistedSnapshot` 结构为 `{sessions:Row[],events:Row[],receipts:Row[],intents:Row[]}`，`Row=Record<string,SQLOutputValue>`；沿用原fixture四表只读SQL，不复制SQL写逻辑。`runCrashCase` 严格执行T2/T3对应单一路径，测试函数只传point；不能通过point选择不同生产实现。host side保存trace `{method:string,request:string,status:number,response:string}`；只将reconcile的观察结果向父进程报告，父进程不向恢复Worker发送trace。host trace含临时grant，仅内存用于断言，失败报告须删authorization/token/key，不写Git或聊天。所有命令输入以一次JSON.parse解析并拒绝未知command/action/point，错误失败不继续。

## T0：基线及正常链前置（作者已完成）

预算：10文件：本文件、AGENTS、worker Skill、RUNBOOK/DOCUMENT/COMMIT/PR Rules、Architecture、既有 provider test/fixture。正式需求及生产调查记录于上文，由作者另行完成，不混作执行步骤。

事实：B main=origin/main=基线，起草前 git status --short 空。ENVIRONMENTS.md 不存在，本任务无本地秘密依赖。Node v22.23.2 原生 SQLite 与官方包可加载；DatabaseSync.prototype.exec 的属性描述 writable=true/configurable=true（仅只读核对描述符，未实施barrier）。2026-11-19 执行：

```bash
node --import ./register-paths.mjs --test apps/orchestrator/openshell/provider-lifecycle.test.ts
```

PASS：5 tests、5 pass、0 fail、0 skip，包括正常 checkpoint/reopen、三种旧代独立拒绝、丢ACK原回执。没有执行强杀或修改代码，04/05 仍未验。作者阶段只写本草稿；未建分支、commit/push/PR。

## 机械步骤

所有命令工作目录为仓库根。每步验证失败必须 STOP，禁止删除失败用例/减少断言/替换已定入口。各步均禁止改上文 Non-goals。

T1 已通过（2026-11-19）：共享runtime与原fixture唯一处置接线完成；原provider-lifecycle 5/5、0skip，Orchestrator typecheck、指定三文件prettier通过；五个原test文件无改动。实现提交由包含本记录的Git提交回读。

### T2：事务提交边界真实强杀

前置状态：包含上述T1事实的提交已核对且原五项通过。
允许修改：crash-child.ts、crash-fixture.ts、provider-crash.test.ts、public-files.json、本文件。
专门读取：runtime.ts、session-history.ts、single-host.ts、persistence-fence.ts、worker-gate.ts。预算10文件。

执行：实现上述 host/worker命令、SQLite包装barrier、只读SQL父编排与清理；新增两个固定测试名 `A2-04 before-commit SIGKILL is atomic`、`A2-04 after-commit SIGKILL is atomic`。每项独立mkdtemp/host/worker：先seed正常轮并正常退出；新produce官方resume、flush seed suffix并响应prepared，此时保存完整baseline，再arm并发送turn发新输入，在目标append barrier强杀host，杀旧worker并等退出。before SQL必须恰为原events/receipts/next/revision，目标intent完整仍在；after必须恰为整批新增、receipt单份、next增count/revision增1，intent仍在。两者不能出现半批。

重启host原双库→takeover(session,1)→READY generation2→admit新run→recover新worker。父进程只传合法request，正式runDshWorker自主恢复；before得到committed，新receipt epoch2；after得到already-committed，原receipt epoch1精确不变。只读SQL与官方Provider read历史一致，intent为空；新continue Worker用同一合法generation2/run grant经官方resume完成正常轮，历史前缀及目标receipt保持。正常轮结束后handle为空。每个子进程必须等待退出，所有server与临时目录清理断言成功。

验证：

```bash
node --import ./register-paths.mjs --test apps/orchestrator/openshell/provider-crash.test.ts
node --import ./register-paths.mjs --test apps/orchestrator/openshell/provider-lifecycle.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：新2/2、原5/5，无skip；每项真实signal=SIGKILL、精确barrier命中一次、重开SQL/Provider/receipt/新代正常轮全断言通过。STOP：barrier没命中、SQLite包装不受原生实现允许、resume无法处理合法恢复历史、需生产修复，报告失败位置交作者；不能改用mock/throw。提交 `Test(openshell): 验证持久事务提交边界强杀恢复`，删T2并核对提交。

### T3：调用方退出后新 Worker 自主发现

前置状态：T2提交且两项实际强杀通过。
允许修改：crash-child.ts、crash-fixture.ts、provider-crash.test.ts、本文件。
专门读取：runtime.ts、apps/worker/dsh-worker.ts、apps/worker/remote-session.ts、apps/worker/protocol.ts、session-history.ts。预算9文件。

执行：补代理barrier；新增 `A2-05 caller SIGKILL after-stage is discovered`、`A2-05 caller SIGKILL after-append preserves original receipt`。每项独立双库与进程，先seed正常轮退出；produce官方caller先prepare并flush seed suffix，prepared后父进程读baseline再arm并发turn；caller在stage/append实际提交且下游ACK暂扣时发barrier，父进程只kill caller SIGKILL并等待，host保留。after-stage为完整intent且无目标events/receipt，after-append有完整批次与原receipt且intent未删除。destroy下游后host按drop-ack/close回执与退出协议正常关闭重开双库（不是代替caller强杀），合法takeover/admit新代；新Worker只经runDshWorker恢复，无旧进程、batch/event/receipt输入。trace逐项断言恢复入口顺序及reconcile无batch/events，返回committed/already-committed与服务端目标一致。与T2相同SQL/Provider/digest/seq不变量，再新代正常轮。

验证：

```bash
node --import ./register-paths.mjs --test apps/orchestrator/openshell/provider-crash.test.ts
node --import ./register-paths.mjs --test apps/orchestrator/openshell/provider-lifecycle.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：四个新case4/4、原5/5，无skip；新Worker参数精确无恢复批次提示；stage-only新receipt与append原receipt分别核对；旧caller确实退出且未dispose。STOP：任何手工reconcile、人工复制payload、旧caller重试、fixture代替runDshWorker，保留失败现场，不算通过。提交 `Test(openshell): 验证新 Worker 自主对账崩溃批次`，删T3并核对提交。

### T4：完整验证及长期证据收口

前置状态：T3提交，四项独立证据完整；与MASTER核对最新主线及A合入顺序。主线变化只普通merge；共享边界冲突或证据语义变化先交作者核对，不覆盖A记录。
允许修改：APPLICATION-BOUNDARIES-DESIGN.md 的A2接线、CURRENT-READINESS.md 的A2条目与A2证据、本文件（删除）。
专门读取：正式APPLICATION-BOUNDARIES-REQUIREMENTS.md、package.json、apps/orchestrator/package.json、.github/workflows/checks.yml、public-files.json、provider-crash.test.ts、crash-fixture.ts。预算10文件。

执行：

1. 运行固定完整验证。既有check真实发现四个新case；原5项保持。不改workflow/命令以绕过检查。运行环境已有安装树，不删除node_modules规避打包。
2. `npm pack`实际列表无node_modules路径、每个路径在公开白名单（npm自动README/package元数据按既有范围核对），四个新增测试路径齐备；不改变根files范围。
3. 设计说明新Worker从正式prior入口自主读取intent与测试强杀边界。Readiness按04两种事务边界、05两种caller边界分别记录日期、代码SHA、命令、测试数、barrier、真实/fixture、原receipt与新receipt区别，保留A2-01/02/03及A7证据。
4. 只有04与05各自全部通过才改已实现。核对正式A2所有五项适用子项全部有相符证据才能父A2派生已实现；外部故障接管仍显式Not Covered，不把父状态扩大为发布/完整接管就绪。任何正式语义覆盖疑问交MASTER裁定，不自行缩窄需求。
5. 无部署/产品启动改变，README/架构/部署清单核对结论为无需改；不复制局部fixture为生产操作手册。长期证据齐全后删除本RUNBOOK，rg确认无残留引用。

验证：

```bash
pnpm check
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const allowed = new Set(JSON.parse(readFileSync('public-files.json', 'utf8')).files);
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const paths = pack.files.map(item => item.path);
for (const path of paths) {
    assert(!path.split('/').includes('node_modules'), path);
    assert(allowed.has(path), path);
}
for (const path of [
    'apps/orchestrator/openshell/provider-lifecycle/runtime.ts',
    'apps/orchestrator/openshell/provider-lifecycle/crash-child.ts',
    'apps/orchestrator/openshell/provider-lifecycle/crash-fixture.ts',
    'apps/orchestrator/openshell/provider-crash.test.ts',
]) assert(paths.includes(path), path);
for (const path of [
    'docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md',
    'docs/40-readiness/CURRENT-READINESS.md',
]) {
    for (const match of readFileSync(path, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (/^(https?:|#)/.test(link)) continue;
        assert(existsSync(resolve(dirname(path), link.split('#')[0])), link);
    }
}
console.log('pack allowlist/new paths/no node_modules and relative links PASS');
JS
pnpm exec prettier --check docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md docs/40-readiness/CURRENT-READINESS.md
rg -n 'RUNBOOK-A2-CRASH-RECOVERY' docs .agents README.md public-files.json
git diff --check
```

链接核对：用本地Node扫描本步两个正式文档中Markdown相对链接，去fragment后resolve并assert existsSync；远程链接不请求；不得把新代码路径误作必须已有的Markdown链接。rg无匹配退出1为PASS，其余命令退出0；pack JSON列表按上文断言逐项核对。pnpm check 中原有可选Temporal skip单列，不计A2证据，四个新case不得skip。

PASS：完整check、pack、链接、格式/diff通过；Readiness证据与当前代码版本一致且无未闭scope；RUNBOOK删除。STOP：任一必需case失败/缺失/skip、打包越界或无官方恢复证据；不得提前删除手册或标已实现。提交 `Test(openshell): 收口 A2 崩溃恢复验收证据`，核对SHA/文件/手册删除。

## 验证矩阵与交付

| 需求                                  | focused入口/断言                                                                                    | full/证据                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A2-01/02/03 前置回归                  | 原provider-lifecycle.test.ts 5/5，全部保留                                                          | T0/T1/T2/T3及pnpm check                  |
| A2-04 before                          | 原生COMMIT前host SIGKILL，目标events/receipt全无、intent完整；同库正式恢复整批一次                  | 新provider-crash.test.ts，T2与T4逐项证据 |
| A2-04 after                           | 原生COMMIT后host SIGKILL，目标events/receipt全有；reconcile不重复revision，原receipt不变            | 同上                                     |
| A2-05 stage                           | caller实际SIGKILL；新runDshWorker无批次提示自主提交intent                                           | T3与T4逐项证据                           |
| A2-05 append                          | caller实际SIGKILL；新runDshWorker无提示自主发现原receipt且完全复用                                  | 同上                                     |
| 共用保护                              | 每项正常seed→故障→双库重开→合法takeover/admit→新代正常轮，SQL与Provider历史逐项核对、digest/seq一致 | 四项不得共享DB或失败后重试               |
| 越权/冲突/原子非法输入                | 无新协议变化，复用既有完整openshell suite及三旧代回归；不新增重复测试                               | pnpm check                               |
| 外部生命周期/真实模型/独立停止/多节点 | Not Applicable 本地持久批次测试；不得据此闭合其他需求                                               | Readiness Not Covered 保留               |

后续一个PR按worker Skill交付：push→Draft→Ready→当前HEAD必需CI与明确Codex结论→显式comment-fix处理feedback→普通merge→回读→仅本任务分支/进程/fixture清理。此段不提前授权作者执行；现阶段止于草稿送审。获MASTER审核后先独立提交计划并核对，随后等待显式worker启动。临时RUNBOOK不登记进公开白名单，最终删除前不得进入发布PR。
