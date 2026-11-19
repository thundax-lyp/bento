# A2 Crash Recovery RUNBOOK

## 状态与执行者契约

- 状态：执行中；2026-11-19。T2/T3已通过，下步T4。最后 PASS T1 `97bd22a53c57bde931f0a7b39e2341a25a0cfda2`。获审类型桥接与事务采证修订均已落地；T1/T2通过事实见下文。
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

新符号签名（均为测试接口）：OfficialAgent=AgentHandle['agent']；WorkerAgent=Parameters<Awaited<ReturnType<DshWorkerBootstrap>>['flush']>[0]。已知官方request/header.reason为字符串、生产Event窄shape为对象，边界直接断言的规则由下述T2类型桥接约束固定；实施后须保留该边界事实，不能随删步骤丢失。

```ts
// runtime.ts，类型复用各官方包，不在生产导出。
createOfficialRuntime(options: {
    workspaceRoot: string;
    sessionId: SessionId;
    beforeStream: (options: GenerateOptions) => void;
}): Promise<{
    ctx: Context;
    agentOptions: { provider: string; model: string };
    agents: AgentRegistry;
    initialize(): Promise<void>;
    persistence(): SessionPersistence;
    flush(agent: OfficialAgent | WorkerAgent): Promise<void>;
    userMessage(prompt: string): ReturnType<typeof createUserMessage>;
    dispose(options?: { revoked?: boolean }): Promise<void>;
}>;
```

`initialize` 安装官方服务（AgentRegistry、SessionStore、SessionProjectionRegistry、LlmRuntime、SystemPrompt、ToolRuntime、AgentLoop、checkpointPolicy 顺序不变）并注册 a2-local 模型。RemoteSession 由调用者先安装，禁止 initialize 再安装。runtime agents 使用 ctx.agents 的官方实例（getter，initialize 前不读取）；仅包装该实例 create/resume 以跟踪官方返回的 handle，不另写 Agent factory；所有已获取 AgentHandle 的唯一显式处置者为共享runtime.dispose，固定细则见下节；原fixture与子进程不得再直接handle.dispose或root dispose。恢复句柄仍由生产 RemoteSession 自行处置。新 bootstrap recover 时直接使用该装配。seed/produce/continue 仅沿用原 fixture 的官方 create/resume→followup→whenIdle→flush 正常轮，不走 execute 模式或新增 provider。flush 用 ctx.sessions.get(options.sessionId) 取官方 Session，assert 存在且与 agent.session 为同一对象，再 assert ctx.sessions.flush 返回 true；shared.flush接受OfficialAgent与WorkerAgent union，核对真实Session对象；生产bootstrap经下述T2包装映射回真实Agent再调用shared.flush，不改生产类型、不用any。

### Agent 与 Context 的唯一处置所有权

`createOfficialRuntime` 仅构造 Context、返回对象，不安装插件；调用者得到该对象后才安装RemoteSession、调用initialize。共享runtime保存 `Set<AgentHandle>`（create/resume成功后立即登记，失败未返回的handle不虚构）、`unregisterAdapter?:()=>void`、`disposal?:Promise<void>`。initialize本身不调用dispose；失败统一由取得runtime对象的调用者进入finally/catch处置。共享runtime是唯一显式调用handle.dispose、unregisterAdapter、ctx.fiber.dispose的地方；fixture只负责代理/控制器/目录，子进程只负责进程资源。禁止在fixture保留一套handle/root处置后再调用共享dispose。

`dispose(options?:{revoked?:boolean})` 首次调用立即缓存整个清理Promise；后续调用返回同一个Promise（包括同一个拒绝），不重试任何handle、RemoteSession或root，后续参数不得改变首次模式。一次调用内部顺序固定，逐动作try/catch累计错误，后续动作一律继续：

1. 对Set按获取顺序快照，**调用前从Set删除**，每个handle显式调用dispose恰一次。正常模式直接await；revoked模式须assert捕获handle数恰1，随后保持原fixture的 `await assert.rejects(handle.dispose(), SessionOwnershipLostError)`，不能通过预先吞异常把此断言变绿。
2. 仅revoked模式取得ctx.sessionPersistence，保留既有 `assert('dispose' in persistence && typeof persistence.dispose === 'function')`，再保持原第二个 `assert.rejects(persistence.dispose(), predicate)`：predicate断言AggregateError、message严格为 `Session persistence close failed`、errors.length严格为1、唯一子项为SessionOwnershipLostError，返回true。此动作只调用一次；不能循环writer或单独再次close来改变聚合数量。正常模式不提前手动persistence.dispose。
3. 若已注册模型则调用unregisterAdapter一次，并在调用前清空保存值；未注册时跳过。
4. 无论前面是否失败，调用ctx.fiber.dispose一次。RemoteSession原有ctx.effect仍由Cordis执行；不改其所有权、不注销effect、不额外再调用显式persistence.dispose。框架自身的服务卸载与原fixture原顺序相同，不允许添加handle.dispose重试。
5. 无错误返回；1个错误原样throw；多个错误按动作顺序 `throw new AggregateError(errors,'A2 runtime cleanup failed')`。两个预期assert.rejects通过不计错误；断言失败必须计入，不能标为已撤权并放过。

原fixture.close(revoked)仍缓存其closing Promise，但cleanup动作唯一替换为：`shared.dispose({revoked})` → closeHttpServer(proxy) →原transportFailures断言；全部尽力执行并沿用原fixture cleanup聚合规则。删除fixture原直接agent.dispose、显式persistence.dispose、unregisterAdapter、ctx.fiber.dispose动作，两个预定拒绝断言的原判定逻辑完整迁到共享dispose，五个test断言不改。正常close、expectRevokedDispose、reopen及最终fixture.dispose重复进入close均复用原缓存，不重复调用共享dispose的内部动作。

部分初始化失败：fixture取得shared后任何步骤失败，调用上述普通close(false)，把初始失败与cleanup失败一起聚合；尚无handle/adapter时对应动作跳过，root仍处置。recover bootstrap只返回T2类型桥接生成的包装及既有DshWorkerBootstrap结构，不提前initialize；安装RemoteSession、initialize失败都处于runDshWorker现有try/finally中，finally调用shared.dispose()。seed/produce/continue在取得shared后统一try/finally共享dispose，正常close命令和外层finally通过同一缓存幂等；SIGKILL故障场景不能运行这段finally，也不由父进程模拟执行它。

子进程统一 `spawn(process.execPath, ['--import', absoluteRegisterPaths, absoluteCrashChild, role], {cwd:repositoryRoot, stdio:['pipe','pipe','pipe','ipc']})`。role 仅 `host`/`worker`；stdin 每行 JSON 命令，stdout 仅 writeSync(1,JSON.stringify(frame)+'\n')，stderr 捕获限64KiB且只报告脱敏错误。IPC 不传旧批次给恢复 worker。子进程在自身正常disconnect前置intentionalDisconnect=true；事件循环可响应时，仅非预期disconnect令子进程以错误退出；卡在Atomics.wait的host由父进程清理SIGKILL，不依赖disconnect回调。每条业务控制等待10秒；单用例node:test timeout=60000，主体独立deadline=40000，到期进入下节至多15000ms清理并失败，禁止只依靠test runner超时。框架不使用 shell/固定PID/固定端口。

Host init 字段 `{authorityPath,historyPath,binding,fresh:boolean}`，首次fresh=true才bind，重启fresh=false读取原库、不bind覆盖。Host 控制命令均含 required `command:string`，响应含相同 `command` 与 `ok:true`，失败响应 `ok:false,error:string` 并令场景失败；init完成响应 `ready` 含 `persistenceUrl:string`。Host 命令 `admit` 输入 `{generation,run}`，lease=120000；每代只admit一次，seed/produce复用generation1的同一grant，recover/continue复用generation2同一grant，绝不在RUNNING再次admit；`takeover` 输入旧 generation；`arm` 输入 `point:'before-commit'|'after-commit'|'after-stage'|'after-append'`，只允许一次且须已有一轮 completed。`snapshot` 由父进程自己只读 SQL，host 不提供写库捷径。

Worker 控制命令同样含 `command`，init后响应ready；`prepare` 获取官方create/resume并先flush seed suffix、响应prepared；`turn` followup固定文本 `a2-crash-input` 并等idle/flush，完成响应completed；`close`正常处置并退出0。recover收到init后直接执行runDshWorker，返回recovered并退出0。Worker init 字段仅 `{request:WorkerRequest,workspaceRoot,action:'seed'|'produce'|'recover'|'continue'}`。seed/produce/continue 调用共享官方 runtime 的 create/resume、followup、whenIdle、flush；seed 和 continue 完整正常轮。recover **只能** `runDshWorker(request, bootstrap)`，mode=recover；不得自己调用 reconcile、open 或 dispatch。recover stdout 可报告结果及观察到的 RPC trace，不能收父进程传来的目标批次。beforeStream 核对正常轮输入已持久提交。produce必须先prepare并收到prepared，父进程此时读取preparedBaseline，才arm并发送turn；host收到arm时也用独立readOnly连接读取并保存preparedBaseline。preparedBaseline仅代表准备完成点，不能假定随后目标事务前没有合法官方批次。目标payload必须同时含request/header及user/message，否则不能命中barrier；frame必须记录匹配次数=1。

04 的 barrier 仅在host子进程启动时包装公开`DatabaseSync.prototype.exec`并保留原函数。通过`PRAGMA database_list`的main项核对 **`realpathSync(row.file) === realpathSync(config.historyPath)`**，只允许同一实际history文件；其他实际文件不注入。row.file为空、main缺失/重复、historyPath不存在、realpathSync失败均STOP，不降级到词法路径、basename或宽匹配。新readOnly证据连接也须指向同一canonical history文件，不改PRAGMA或连接锁设置。

arm后遇COMMIT，在该事务连接自身视图查询`batch_intents JOIN batch_receipts USING(id,epoch,batch)`，只在目标Session matching receipt、intent.payload同时含request/header及user/message时命中append。stage的COMMIT没有matching receipt，不命中。命中后先取得transactionView（当前事务自身未提交SQL视图），再**在调用原COMMIT之前**新建独立`DatabaseSync(config.historyPath,{readOnly:true})`，按固定四表SQL读priorCommitted并finally.close；before/after都只用此处捕获的同一priorCommitted。不能用transactionView或COMMIT之后读数冒充priorCommitted。独立读连接阻塞、不可读、读取结果不一致均STOP，不能改锁/超时/生产事务逻辑。

barrier frame固定为 `{command:'barrier',point,hits:1,preparedBaseline,priorCommitted,transactionView,target:{batch,digest,epoch,first,count}}`；三份snapshot结构均为既有PersistedSnapshot，target取matching持久receipt，并核验其batch/epoch与intent一致、digest=sha256(intent.payload)、count=JSON.parse(payload).length、first=priorCommitted.sessions[0].next。host arm快照须与父preparedBaseline逐字段deepEqual。frame不能只带模糊state。before在原COMMIT前writeSync该frame再Atomics.wait无限阻塞；after必须先调用原COMMIT再writeSync同一份已捕获frame、Atomics.wait。父收到frame后只kill登记host的SIGKILL，等exit和close，随后kill旧caller并等exit和close，才重开/读取。任何目标命中第二次均失败；不throw/close模拟故障，不复制任何事务写SQL。

05 host使用ingress前方回环透明代理。只对已arm point对应的method（after-stage对应stage、after-append对应append）、且请求events同时含request/header及user/message的唯一目标请求采证。**转发该目标请求前**用独立readOnly连接读取priorCommitted、finally.close，并保留完整原请求字符串中的batch/events（仅host/父断言，不给新Worker）。随后body/authorization字节原样转发，等上游HTTP200并读完response，再独立readOnly连接读取transactionView、finally.close。05的transactionView明确为上游RPC提交后的已提交视图，不声称未提交视图；不得用preparedBaseline替代目标请求前的priorCommitted。

05需验证target的batch与请求query.batch一致、payload与JSON.stringify(query.events)字节相同、digest=sha256(payload)，epoch由真实intent确定；after-stage未有receipt，first由priorCommitted.next、count由query.events.length固定；after-append必须将真实原receipt逐字段绑定到同一batch/digest/first/count/epoch且JSON响应value与receipt（去id）deepEqual。完整SQL断言见下节，任一不符不发barrier、不吞错误。frame同04，hits恰1。验证后才暂扣下游response并发barrier，父SIGKILL旧caller且等exit/close，host保持存活。父发drop-ack命令，host destroy下游/释放gate并await handler回执后，才正常close/reopen双库、正式takeover/admit。代理不注入/重放/补写请求、不执行reconcile；原caller不运行dispose/finally。

恢复Worker经真实ingress trace核验`stat→open(write)→reconcile(无batch/events)→close→官方resume`，服务端自行发现持久intent。新Worker只拿合法Session/grant/config；preparedBaseline/priorCommitted/transactionView/target及旧请求仅在host/父内存作证据，绝不写入新Worker参数、环境、文件或bootstrap。

### 目标基线与四表的精确断言

所有snapshot只含同一Session的sessions/events/receipts/intents，SELECT顺序沿用既有fixture；每个SQL Row用`{...row}`保留全部列和值、统一普通对象原型后采证（node:sqlite原行是null-prototype，跨JSON frame后原型变化不能当值差异）；不得删列、改值、重排events。session恰1，字段集合严格为`id,header,inherited,epoch,owner,handle,next,revision,materialized,created_by`。以下“等于”均指原值逐字段deepEqual，不能只比较长度、选取宽泛对象或忽略额外写入。

1. priorCommitted.events以preparedBaseline.events为精确前缀。对preparedBaseline中每个receipt，priorCommitted按(id,epoch,batch)找到且整行deepEqual；priorCommitted中新增receipt不允许复用旧键。两时点events序号都从0连续到next-1，每个event由唯一receipt覆盖，每个receipt的first/count范围完整、digest按真实SQL event JSON重算相同。新增事件后缀必须恰由新增receipt覆盖，不存在无receipt的新增event或无event的新增receipt。
2. 对preparedBaseline→priorCommitted每个新增receipt，host已记录的真实HTTP append200 trace必须恰有一项同batch、请求events与对应SQL events逐项相同、response receipt与SQL行去id逐字段相同；这些是确实已经先提交的官方批次，不能把它们归入待强杀目标或在失败时忽略。目标batch在priorCommitted无receipt、无目标seq事件。目标payload的首seq严格为priorCommitted.next。preparedBaseline.receipts与新增receipt的并集按既定排序恰等于priorCommitted.receipts，不接受额外行。
3. preparedBaseline→priorCommitted.sessions保持`id/header/inherited/epoch/owner/handle/materialized/created_by`逐字段不变；next增加值恰为先提交事件后缀长度，revision增加值恰为先提交新增receipt数。04以及05 after-append的priorCommitted.intents恰为一个target intent `{id:session,epoch:target.epoch,batch:target.batch,payload:目标原JSON}`；05 after-stage的priorCommitted.intents为空。preparedBaseline.intents须为空。不得删除合法先提交批次以回到preparedBaseline。
4. 04 transactionView.events严格为priorCommitted.events加目标payload原事件，transactionView.receipts为priorCommitted.receipts加唯一target receipt并按epoch/batch排序；sessions恰等于`{...priorSession,next:priorNext+target.count,revision:priorRevision+1,materialized:1}`，其他八字段不变（此时prior.materialized已为1，也单独断言）；intents与priorCommitted完整相同。target receipt的first=priorNext/count/digest/epoch/batch逐项核对。transactionView仅用于目标事务待提交的事实，不能当恢复后SQL。
5. **04 before**：SIGKILL退出后独立SQL的events/receipts/sessions/intents均严格deepEqual priorCommitted全部四表；目标events/receipt全无，完整target intent仍在。**04 after**：SIGKILL退出后四表均严格deepEqual transactionView（已按第4条验证恰整批），不能只检查包含目标event；seq不重不漏，目标receipt恰1。两种情况的preparedBaseline/priorCommitted/transactionView均单独保留作断言。
6. **05 after-stage**：transactionView的events/receipts/sessions严格等于转发前priorCommitted；仅intents由空变成唯一完整target intent。caller SIGKILL后再次独立snapshot四表严格等于transactionView。不存在目标events/receipt；不能把新receipt称为复用原receipt。
7. **05 after-append**：priorCommitted已包含该target intent，transactionView恰为priorCommitted加目标整批event及唯一receipt，sessions仅next+count/revision+1（materialized保持1）、其他八字段不变，intents逐字段不变；caller SIGKILL后的四表严格等于transactionView。SQL原receipt与真实HTTP append200响应完整一致，之后reconcile必须复用它。
8. 恢复前的控制面takeover/admit仅按生产Fence改owner/epoch/handle，恢复断言分清这个合法变化；历史与已提交receipt仍逐字段不变。正式reconcile的HTTP trace绑定target.batch/digest/范围；before或stage-only回committed且新receipt epoch2，after或append回already-committed且原receipt epoch1不变。reconcile RPC自身的已提交SQL：旧receipt路径events/next/revision不增；新提交路径恰增加target整批与一份receipt、next+count/revision+1；两者只删除target intent。用proxy对该reconcile前后独立SQL snapshot精确比较，后续官方resume可另增合法end-seed/interrupted suffix，不能用resume后的revision增加掩盖reconcile重复写入。最后仍要求原历史前缀、SQL/Provider一致与新代正常轮通过。

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

## T2 类型桥接约束（已审定bc7efc9，保持不变）

本节属于T2同一原子验收，不建立允许类型失败通过的小步。原T1已通过事实保留，T2须同时交付签名修复、child接线与两项真实强杀通过；不能把未通过的crash文件删掉或排除typecheck。作者阶段仅修订本文件。runtime.ts纳入T2允许修改，原有文件预算仍10，见T2清单。

**STOP证据与唯一方案**：当前typecheck TS2322（crash-child bootstrap的官方AgentOptions optional provider/model）、TS2345（官方SessionEvent[]与生产弱data不兼容）。官方session types.d.ts的RequestHeaderReason及SessionEventMap request/header明确 `reason:'initial'|'resume'|'change'|'series'`，turn/end为`reason:TurnEndReason`，tool/result可有`error:{name:string,code:string,reason?:string}`。因此“验证所有event.data.reason均是对象，再every收窄”的完整结构守卫对正常request/header必失败。不能声称原数组实际满足该窄类型全部属性。唯一替代在snapshot边界做**直接局部断言**（非unknown/any、非整体runtime断言），仅在验证生产completedTurn实际消费的turn/end.reason.kind和tool/result.error.code后返回原数组；保留已知request/header.reason字符串。该静态适配边界必须显式记录，生产Event或读取逻辑有变化即STOP重审。它不证明所有SDK字段符合生产窄类型，不对存储/SDK对象做改变。

类型及唯一新导出固定如下（真正类型从相应既有入口导出/推导，不复制生产Event声明）：

```ts
type WorkerRuntime = Awaited<ReturnType<DshWorkerBootstrap>>;
type WorkerAgent = Parameters<WorkerRuntime['flush']>[0];
type WorkerEvents = ReturnType<WorkerAgent['session']['snapshotEvents']>;
type OfficialAgent = AgentHandle['agent'];
type SharedRuntime = Awaited<ReturnType<typeof createOfficialRuntime>>;
export function createWorkerBootstrapRuntime(
    shared: SharedRuntime,
): WorkerRuntime;
function assertWorkerConsumedFields(events: readonly SessionEvent[]): void;
```

执行：

1. runtime.ts的固定agentOptions去掉宽的官方AgentOptions注解，使用 `{provider:'a2-local',model:'fixture'} satisfies AgentOptions`，推导required provider/model；不修改值。shared.flush签名改为OfficialAgent或WorkerAgent union，保留真实SessionStore.get、存在与identity断言及ctx.sessions.flush(true)。不动原dispose、原五断言、官方插件顺序。
2. `assertWorkerConsumedFields`对原数组逐项核验 `typeof event.type==='string'`。只在event.type==='turn/end'时assert typeof event.data.reason==='object'、reason!==null、typeof reason.kind==='string'；只在type==='tool/result'且event.data.error!==undefined时assert error!==null、typeof error==='object'、typeof error.code==='string'。其他type不把同名reason字符串当作错误，不过滤或更改事件；失败用assert抛错，绝不跳过事件。这不是声称完整WorkerEvent shape的类型谓词。
3. `createWorkerBootstrapRuntime`显式返回ctx、agentOptions、workspaceRoot、persistence/initialize/userMessage/dispose委托，不能spread shared（会提前读取agents getter）。内部`WeakMap<WorkerAgent,OfficialAgent>`。agents.create/resume分别await真实shared.agents对应方法，取得官方handle（shared仍唯一拥有处置权），只向生产入口返回`{agent:wrapper}`。wrapper方法为：`followup(message:Parameters<OfficialAgent['followup']>[0]){real.followup(message)}`、`whenIdle(){return real.whenIdle()}`；session为只读视图，仅有snapshotEvents方法，实际调用`real.session.snapshotEvents()`得到events，先assertWorkerConsumedFields，再 **`return events as WorkerEvents`**。此唯一断言只出现在该return，不经unknown/any中转；不复制数组、不map/filter、不删字段、不改seq，不向真实Session赋新方法。生产目标的followup为方法参数，利用方法参数双向兼容，不能把unknown强转为UserMessage。创建后把wrapper→real登记WeakMap。
4. 包装Runtime.flush(agent)先WeakMap.get并assert存在，核对shared.ctx.sessions.get(real.session.id)与real.session同一对象，再await shared.flush(real)。不能把wrapper.session传给shared.flush并放宽identity断言；真实Session与Provider/官方Store不被wrapper替换。dispose只委托shared.dispose()，不能取得/自行dispose原handle。包装只在测试runtime导出，生产无变更。
5. child只在T2接线阶段导入createWorkerBootstrapRuntime；bootstrap不得提前initialize。T2完整typecheck必须退出0，包含保留的全部crash文件。新桥接函数的返回直接约束WorkerRuntime，原guard/局部断言编译不过即STOP，不使用整体类型断言绕过。原五回归与两项强杀均须通过后，同T2提交runtime.ts修复；不增加未经故障验收即提交全部新夹具的中间步骤。

修订审核STOP：桥接本身产生类型错误、需要unknown/any中转、直接断言因类型毫无重叠不能编译、需要改生产Event/丢事件或原五项变化时，报告精确证据，不选择替代方案。此局部断言为MASTER已确认的唯一替代；guard-only方案不适用的证据已列明，不新增整体cast。

作者现场事实（2026-11-19，未提交T2）：bc7efc9类型桥接获审修复后，Orchestrator typecheck退出0；两项实际case均因host barrier timeout失败，未有强杀边界通过记录。脱敏trace证明目标前存在已提交inbox/turn-start批次；隔离临时DB探针得到PRAGMA路径词法相等false、realpath相等true，探针目录已清理。本次RUNBOOK修订不等于实现已修复；待审核后再执行下列T2。

T2 已通过（2026-11-19）：获审77b6a098的严格realpath身份、prepared/priorCommitted/transactionView和四表精确断言已落地。两项COMMIT边界真实SIGKILL 2/2、0skip；同库正式runDshWorker自主reconcile、原receipt/新receipt分别核验、SQL/Provider与generation2正常轮全部通过；全部ChildProcess exit/close及目录删除通过。Orchestrator typecheck、原Provider五项5/5、四代码文件ESLint、diff检查通过。局部snapshot类型断言仅在获审边界，未修改生产与原五test。提交由包含本记录的Git提交回读。

T3 已通过（2026-11-19）：after-stage/after-append真实caller SIGKILL独立场景通过；新Worker只拿合法request及workspaceRoot，经生产runDshWorker无batch/events参数reconcile发现原intent。stage-only生成epoch2新receipt；append已提交复用epoch1原receipt；单RPC前后四表与合法resume后缀分开核对。新四case4/4、原五Provider5/5均无skip，Orchestrator typecheck、三代码ESLint、diff检查通过；每个场景双库重开、新代正常轮、全部进程exit/close和目录删除均通过。提交由包含本记录的Git提交回读。

### T4：完整验证及长期证据收口

前置状态：包含上述T3事实的提交已核对，四项独立证据完整；与MASTER核对最新主线及A合入顺序。主线变化只普通merge；共享边界冲突或证据语义变化先交作者核对，不覆盖A记录。
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

| 需求                                  | focused入口/断言                                                                                                  | full/证据                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A2-01/02/03 前置回归                  | 原provider-lifecycle.test.ts 5/5，全部保留                                                                        | T0/T1/T2/T3及pnpm check                  |
| A2-04 before                          | 原生COMMIT前host SIGKILL，四表严格priorCommitted、目标events/receipt全无、intent完整；同库正式恢复整批一次        | 新provider-crash.test.ts，T2与T4逐项证据 |
| A2-04 after                           | 原生COMMIT后host SIGKILL，四表严格transactionView=priorCommitted+目标整批；reconcile不重复revision，原receipt不变 | 同上                                     |
| A2-05 stage                           | caller实际SIGKILL；新runDshWorker无批次提示自主提交intent                                                         | T3与T4逐项证据                           |
| A2-05 append                          | caller实际SIGKILL；新runDshWorker无提示自主发现原receipt且完全复用                                                | 同上                                     |
| 共用保护                              | 每项正常seed→故障→双库重开→合法takeover/admit→新代正常轮，SQL与Provider历史逐项核对、digest/seq一致               | 四项不得共享DB或失败后重试               |
| 越权/冲突/原子非法输入                | 无新协议变化，复用既有完整openshell suite及三旧代回归；不新增重复测试                                             | pnpm check                               |
| 外部生命周期/真实模型/独立停止/多节点 | Not Applicable 本地持久批次测试；不得据此闭合其他需求                                                             | Readiness Not Covered 保留               |

后续一个PR按worker Skill交付：push→Draft→Ready→当前HEAD必需CI与明确Codex结论→显式comment-fix处理feedback→普通merge→回读→仅本任务分支/进程/fixture清理。此段不提前授权作者执行；现阶段止于草稿送审。获MASTER审核后先独立提交计划并核对，随后等待显式worker启动。临时RUNBOOK不登记进公开白名单，最终删除前不得进入发布PR。
