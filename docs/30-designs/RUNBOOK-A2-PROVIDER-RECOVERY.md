# A2 官方 Provider 持久化生命周期与恢复

## 状态与工作边界

- 状态：MASTER 已审核 Executable 并显式启动 worker；T1、T2、T3、T4 已 PASS。
- 建立日期：2026-11-19。作者 checkout：`bento-b`；基线 `104be8f5139c1100e3e5949bf3478f66f175e274`，`main=origin/main`。
- 本轮只新增本地验收 fixture/test、锁定其官方依赖、同步相关设计和 Readiness。生产代码只读。计划执行分支固定为 `codex/a2-provider-recovery`，顺序固定为：MASTER 审核为 Executable→MASTER 单独派发建立该分支并只提交本 RUNBOOK→回读计划 commit 与文件 SHA256→MASTER 显式调用 `$bento-runbook-worker` 开工。建分支和仅提交计划属于开工前独立阶段，不属于 T1；获审计划提交为 `4278b4fee05fef0d71c1e9a2d12881abe4fb9ecf`，当前已处于该分支。
- MASTER 主 checkout 不属于 WORKER；A checkout、旧 Docker/OpenShell、远端环境、IdP、S3、外部模型均禁止写入。A 独占 `service.ts` 的 retryReason/advanceTaskRetry、既有 service retry suite、外部 checkpoint 验收窗口。

## 执行者契约

1. 只按 T0→T1→T2→T3→T4→T5 顺序推进。T0 是作者已完成的独立前置核对，不与实施合并。MASTER 未确认 T0 或基线变化影响受测入口时 STOP 送回作者复核。
2. 每步只读其列出的专门核对文件，只修改允许文件；预算包含本 RUNBOOK。工具自动加载的依赖不是要求执行者阅读的材料，不新增专门读取范围。
3. 每步全部断言及命令退出 0 才 PASS；PASS 后删该步、将后续依赖换成实际可核验事实，与该步产物一起提交，回读 SHA 和文件清单。不得提前删未完成步骤。
4. 任何未固定的接口、断言、依赖、生产修复或系统错误都是 STOP，回报最后成功 STEP/SHA、符号、最小复现命令和脱敏实际输出，不改断言绕过。保留现场，不回滚无关文件。
5. 单个 RUNBOOK 对应一个 PR；交付遵守 [Worker Skill](../../.agents/skills/bento-runbook-worker/SKILL.md)、[Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。已进入获审实施阶段，只允许本计划内的逐步提交和交付。

## 目标、依据与当前断点

[正式需求](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a2-持久会话)是行为依据；[设计](./APPLICATION-BOUNDARIES-DESIGN.md#三组交接不变量)规定会话↔worker 的 owner/generation、序号、批次回执、旧代拒绝和不重复写；[架构](../00-governance/ARCHITECTURE.md#架构决策)规定执行权与日志所有权分别撤销。接口由当前主题设计及锁定官方 SessionPersistence 公共 API 共同描述，本任务不新增业务接口，不用当前代码发明需求。

| 场景             | 正式行为→生产责任→验收                                                                                                                                                                        | 当前缺口                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A2-01 Happy Path | provider/checkpoint 持久化历史、批次 ID、回执、审计→RemoteSession、SingleHostExecution.persistenceIngress、SessionHistory→官方 create/turn/checkpoint/close、双库重开、官方 resume、新代 turn | Readiness 仅三库停服还原；没有当前入口的官方 DSH checkpoint 联合证据 |
| A2-02            | 旧代 append/flush/close 独立拒绝，Session/批次不变→WorkerGate.require、PersistenceFence.revoke、RemoteSession.Handle→三份独立活 handle 在各自独立环境撤权后首次操作                           | 现有旧代写入证据不足以分别证明三方法；lost 缓存不能重复计数          |
| A2-03            | 提交后 ACK 丢失，重投复用批次和原回执→Handle.settle、SessionHistory.request/commit→真实转发后丢一次下游响应、同批次重投、同库重开回读                                                         | 现有两代回执不等于丢 ACK 重投                                        |

三项共用官方 Session/AgentLoop→生产 RemoteSession→实际 HTTP ingress→实际 SQLite、同一批次协议和恢复链，合并交付。A2-04 事务强杀、A2-05 新 Worker 自主发现未对账批次不在 Scope，父 A2 必须仍为部分实现。

## Scope 与 Non-goals

- Scope：锁定测试用官方包；一个独立 fixture 和一个固定入口 test，先成功链，再三项独立拒绝，再丢 ACK；通过后只更新 A2-01/02/03 与父派生、长期设计中相关 A2 证据。
- Non-goals：正式 worker bootstrap 上线、真实外部模型/OpenShell、故障接管的独立停止证明、自动发现未对账批次、事务强杀、多节点、工具副作用恢复、业务 retry、迁移/双写、外部部署。
- Not Applicable：本地随机回环端口、临时 SQLite，无 IdP/S3/远端连接或秘密；根 `ENVIRONMENTS.md` 实查不存在，本轮不依赖该文件，不索取环境凭据。不新增 DTO、业务事件、投影、Archive/outbox、迁移和发布/启动命令；检查 README/架构/部署现有入口无需变化，因为仅增加 devDependency 和既有 test glob 内的验收。

## 官方依据、依赖和真实边界

作者已正常通过 pnpm 在仓库外独立临时目录安装官方包，无 TLS 绕过、无旧 node_modules 复制。官方 npm 包均 `0.2.1-rc.4`，不是把 DSH 整体版本 `2.0.0-rc.4` 填入拆分包版本。锁定内容以 npm 包及 lockfile integrity 为准，不依赖可变 tag。

官方来源：各包 `package.json.repository` 指向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。作者核对 `dsh-agent-loop/lib/index.js` 的 `createStoredSession`、`appendUnstoredSuffix`、`createAgent`、`resumeWith`、`prepare` teardown；`dsh-session` 的 `SessionStore.flush`；`dsh-session-checkpoint-policy/lib/index.js` 的 `apply/afterCheckpoint`。AgentLoop 的 public `ctx.agents.create/resume` 是本任务唯一获取持久写句柄的入口，不能裸 `SessionStore.prepare→enter` 代替。

T1 在 `apps/orchestrator/package.json` 的 devDependencies 新增且固定下列九包 `0.2.1-rc.4`：

- `@deepseek-ai/dsh-agent`：AgentRegistry。
- `@deepseek-ai/dsh-agent-loop`：真实 AgentLoop/factory。
- `@deepseek-ai/dsh-session`：SessionStore、Session 类型与标识。
- `@deepseek-ai/dsh-session-projection`：AgentLoop 的 inbox/turn-boundary 投影依赖。
- `@deepseek-ai/dsh-llm`：真实 LlmRuntime、LlmAdapter、createUserMessage。
- `@deepseek-ai/dsh-system-prompt`：AgentLoop prompt 依赖。
- `@deepseek-ai/dsh-tools`：AgentLoop/checkpoint policy 的 tools 依赖；本轮不注册工具。
- `@deepseek-ai/dsh-scope`：上述公共 API 的固定 peer，显式固定防止漂移。
- `@deepseek-ai/dsh-session-checkpoint-policy`：官方 pre-step/model/tool durability checkpoint。

既有 runtime dependency `@deepseek-ai/dsh-session-persistence=0.2.1-rc.4` 和 devDependency `@deepseek-ai/cordis=4.0.5` 保持原声明；worker 的依赖不变。新包只被 Orchestrator 测试 fixture 使用，不进入生产 worker 装配。

真实：官方 AgentRegistry/AgentLoop/SessionStore/checkpoint policy、生产 RemoteSession、SingleHostExecution、HTTP、SQLite、同库 reopen、持久 receipt。合成：可信 binding/Run ID、本地模型适配器和 sandbox stop/start/running 观察。不能据此宣称真实模型、OpenShell、独立停机、外部故障接管或自主发现已验。

## 精确结构与所有权

| 数据          | 字段、来源、生命周期                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Binding       | `{tenant,project,session,sandbox,volume}: string` 全 required；fixture 为每 case 产生独立 UUID Session/Run，固定无秘密 tenant/project/sandbox/volume 标签；生产 controller.bind 后拥有绑定，不接受模型指定                                                                           |
| WorkerGrant   | `{token:string,session:string,run:string,generation:number}` 全 required；controller.admit 生成 token；代次 1，takeover 后 2；leaseMs 固定 60_000；不输出 token                                                                                                                      |
| SessionHeader | 官方 create 生成 `id/version/createdAt/isSeeded`，可含 meta.cwd；fixture 只传 sessionId 与绝对 tmp cwd，不手工 header、seq、time 或种子                                                                                                                                              |
| RPC           | POST `/rpc`，Bearer grant.token；JSON `{method:string,id?:SessionId,...fields}`；create 加 header/options，open 加 access，handle 调用加 key；key 来自生产 create/open 回包，只保存在进程内                                                                                          |
| HandleData    | `{id,header,access:'write'\|'read',inheritedEventCount,key:string}` 全 required；真实 handle 由 RemoteSession.adopt 构造；fixture 只捕获同一个返回对象，不替换输出或行为                                                                                                             |
| Batch         | 生产 Handle 自动生成 `{id:UUID,digest:sha256(JSON.stringify(materializedEvents)),events,buffered:number,extra:string}`；fixture 不生成/修改 batch 或 seq，不重写 buffer/pending                                                                                                      |
| Stage/Append  | 请求 fields `{batch:string,events:readonly Event[],key:string}`；stage 持久 intent，append 在事务内写 events/receipt/next/revision；顺序固定 stage→append→reconcile，显式 checkpoint 之后 flush；close 先 drain 再 close                                                             |
| Receipt       | 持久 `{epoch:number,batch:string,digest:string,first:number,count:number}` 全 required；canonical owner SessionHistory，主键 `(id,epoch,batch)`；RemoteSession 检查 batch/digest/first/count；重投必须原值                                                                           |
| Read          | 官方 handle.read 返回 `{events:SessionEvent[],eventState:'detached'}`；snapshotEvents 与 SQL events 逐项 deepEqual，seq 必须 0..n-1；恢复可追加官方 session/end-seed，不要求总长度不变                                                                                               |
| Persistence   | sessions(id,header,inherited,epoch,owner,handle,next,revision,materialized,created_by)，events(id,seq,event)，batch_receipts(id,epoch,batch,digest,first,count)，batch_intents(id,epoch,batch,payload)；精确列以生产 schema 为准；测试只 SELECT，不 UPDATE/INSERT/DELETE             |
| Audit         | 此轮回读每个 receipt 的 Session/epoch/batch/digest/first/count、authority inspect 的 Session/Run/generation/state，并记录脱敏 RPC method/status 顺序；不声称新增独立持久审计系统。history_checkpoints/history_restores 属业务 retry 前缀恢复，不拿它们冒充官方 durability checkpoint |
| Checkpoint    | 官方 policy 的 agent/pre-step 与 llm/stream→ctx.sessions.flush(session)→生产 session/flush listener→Handle.flush→真实 stage/append/reconcile/flush；turn 完成后再 await ctx.sessions.flush，结果必须 true                                                                            |

内部 payload 只来自官方 Session/AgentLoop。固定模型适配器 `class LocalTurnAdapter extends LlmAdapter` 的 `stream(options:GenerateOptions):AsyncIterable<StreamChunk>` 检查 options.signal 未中止，按序 yield block-start(index=0,blockType='text')、text-delta(index=0,text='a2-local-response')、block-end(index=0,block={type:'text',text:'a2-local-response'})、finish(reason={kind:'stop'})。userMessage 固定 `createUserMessage({source:{kind:'user'},content:[{type:'text',text:'a2-local-input'}]})`，模型路由固定 provider='a2-local',model='fixture'；无 tools，无外部 HTTP 模型。

## 唯一 fixture 接口与调用顺序

新增 `apps/orchestrator/openshell/provider-lifecycle/fixture.ts`，只导出：

```ts
export async function createProviderFixture(): Promise<ProviderFixture>;
```

`ProviderFixture` 精确职责：`controller:SingleHostExecution`、`session:SessionId`、`historyPath:string`、`authorityPath:string`；`start(generation:1|2):Promise<Runtime>` 为该代 admit 一个 UUID Run 并建立 runtime；`reopen():Promise<void>` 只在全部 runtime 正常关闭后关闭并重建 controller 和生产 ingress；`snapshot():PersistedSnapshot` 用独立 read-only DatabaseSync SELECT 返回指定 Session 的 sessions/events/receipts/intents；`dispose():Promise<void>` 清理本 fixture 所有资源。

`Runtime`：`ctx:Context`、`agentHandle:AgentHandle|undefined`、`writer:SessionHandle|undefined`、`trace:RpcTrace[]`；`create():Promise<AgentHandle>`、`resume():Promise<AgentHandle>`、`turn():Promise<readonly SessionEvent[]>`、`checkpoint():Promise<void>`、`close():Promise<void>`、`expectRevokedDispose():Promise<void>`、`dropNextAppendAck():void`、`waitForDroppedAck():Promise<void>`。

`PersistedSnapshot` 字段固定 `sessions: Record<string,SQLOutputValue>[]`、`events`、`receipts`、`intents` 同型。SQL 精确为 sessions `WHERE id=?`，events `WHERE id=? ORDER BY seq`，batch_receipts `WHERE id=? ORDER BY epoch,batch`，batch_intents `WHERE id=?`。read-only DB 在每次 snapshot 后 finally close，不持有事务。

`RpcTrace` 固定 `{method:string,status:number,request:string,response:string,dropped:boolean,before:PersistedSnapshot,after:PersistedSnapshot}`，存储于内存，禁止 console 输出完整对象（含 key/凭据/历史）；仅断言和输出 case 名称。fixture 代理从每 runtime 随机回环端口将原 POST body、Authorization 转发到 controller.persistenceIngress 的独立随机回环端口；不自行解析授权、不调用 history.dispatch 代替生产 ingress，不改请求/上游响应正文。仅对 `/rpc` POST 接受转发，其他请求 404。

以下是必须使用的官方公共 import、参数和调用片段，不是 pseudocode；全部写在唯一 `fixture.ts`，不创建其他 bootstrap/type 文件。`ProviderFixture`、`Runtime`、`PersistedSnapshot`、`RpcTrace`、`LocalTurnAdapter` 和下文 `closeHttpServer` 均为此文件私有定义，只导出 createProviderFixture。类型按上文逐字段声明为 `type`，`agentHandle`、`writer` 必须显式含 undefined 并初始化 undefined；不引入 optional 替代字段。Session ID 唯一用 `SessionId(randomUUID())`，不使用类型强转伪造品牌。

```ts
import { Context } from '@deepseek-ai/cordis';
import {
    AgentRegistry,
    type AgentHandle,
    type AgentOptions,
} from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
    LlmRuntime,
    LlmAdapter,
    createUserMessage,
    type GenerateOptions,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import {
    SessionStore,
    SessionId,
    type SessionEvent,
} from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Server } from 'node:http';
import { remoteSessionPersistence } from '@/apps/worker/remote-session.ts';
import { SingleHostExecution } from '../single-host.ts';

const agentOptions: AgentOptions = { provider: 'a2-local', model: 'fixture' };
```

官方类均使用以上 named export；checkpoint policy 没有 default export，必须 namespace import。LocalTurnAdapter 的唯一 constructor 为 `constructor(beforeStream: (options: GenerateOptions) => void)`，在类中保存此回调；stream 开始先 `options.signal?.throwIfAborted()`，再 `this.beforeStream(options)`，再按前节固定四个 chunk yield。beforeStream 唯一实现为前节 SQL request prefix/receipt/intents 断言，不注入其他模型策略。

start 在本 fixture 的生产 ingress 已 listening 后创建代理、await listening，得到 `proxyUrl`（真实 `http://127.0.0.1:<随机端口>`）；调用 `const grant = controller.admit(session, generation, randomUUID(), 60_000)`，随后唯一装配为：

```ts
const ctx = new Context();
await ctx.plugin(remoteSessionPersistence, {
    url: proxyUrl,
    token: grant.token,
});
await ctx.plugin(AgentRegistry);
await ctx.plugin(SessionStore);
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(LlmRuntime);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(AgentLoop);
await ctx.plugin(checkpointPolicy);
const unregisterAdapter = ctx.llm.registerAdapter(
    ['a2-local'],
    new LocalTurnAdapter(beforeStream),
);
```

这九次 plugin 调用均 await；除 remoteSessionPersistence 的精确 `{url,token}` 外，其余调用全部不传 options，使用官方默认 Config（AgentLoop 默认 agents=[]、maxParallelToolCalls=10）。`unregisterAdapter` 是官方返回的零参数 disposer，在 runtime cleanup 中调用一次。不得调用 apply 函数或 new Service 替代 ctx.plugin。仅为捕获真实 writer，包装 persistence.create/open：调用并 await 原方法，以原 this/原参数执行，保存并原样返回真实 write handle；read handle 不覆盖 writer。不得 subclass/替换真实 Provider、mock fetch、模拟事件或重写输出。

create/resume 分别唯一调用 ctx.agents.create({sessionId,meta:{cwd:fixture tmpdir},agentOptions}) / ctx.agents.resume({resumeSessionId,agentOptions})。turn 为 followup→whenIdle→checkpoint，断言最新 turn/end.reason.kind='completed'、恰好新增一个 user/message 和 assistant/message。

checkpoint 必须 await ctx.sessions.flush(agent.session)，结果 true。代理在每次转发前 snapshot 为 before，收到上游完整响应后 snapshot 为 after，再回包；适配器开始 yield 前，断言此前本轮 request/header、user/message 已出现在 SQL events，receipt 覆盖对应 seq，且 intents 空，证明官方 policy 在模型 dispatch 前已完成真实 checkpoint。

正常 close 固定顺序：await agentHandle.dispose()→unregisterAdapter()→await ctx.fiber.dispose()→await closeHttpServer(proxy)。官方先 drain/close 写句柄，不能先 root dispose 活 Agent。reopen 固定 await closeHttpServer(旧 ingress)→controller.close()→同 paths new SingleHostExecution→新 ingress.listen(0,'127.0.0.1') 并 await listening；不依赖 test timeout 触发清理。

HTTP server 唯一关闭 helper（同一 fixture.ts 内的精确代码）：

```ts
function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    return closed;
}
```

即先同步调用 server.close 停止接受连接，立即同步 closeAllConnections 关闭已有连接，再 await callback promise；禁止先 await close 再 closeAllConnections。未成功 listen 的局部 server 无监听资源，直接 resolve。所有资源 disposer 在 runtime/fixture 内各自 memoize 一个 Promise，重复 finally 调用返回同一 Promise，不二次 close；已发生的清理失败不能变为成功。

正常 close、expectRevokedDispose、create/start 部分失败及顶层 fixture.dispose 的 finally 均使用以下错误传播规则：为依赖顺序中的每个独立 cleanup 操作分别 try/await/catch，失败加入 `unknown[]`，继续尝试剩余 cleanup；全部尝试后，1 个错误原样 throw，多个错误 throw `new AggregateError(failures, 'A2 fixture cleanup failed')`，零错误 resolve。不使用空 catch。runtime cleanup 始终尝试 agent 处置、adapter disposer、root dispose、proxy close；撤权路径将 agent 处置换成前节规定的 assert.rejects，然后在 adapter disposer 前插入真实 persistence.dispose 的 assert.rejects。fixture.dispose 顺序固定为逐个 runtime cleanup→closeHttpServer(ingress)→controller.close→rm(本 fixture tmpdir,{recursive:true,force:true})，每项即使前项失败也执行。case 主体错误与 cleanup 错误同时存在时以 AggregateError 收集二者，不让 finally 覆盖主体失败。代理 fetch 固定携带 AbortSignal.timeout(10_000)，不得无限挂起；不将 timeout 当成功清理。sandbox 为 closure 的 running boolean，stop=false/start=true，stopped/running 只读该 boolean；这是合成控制面，不是真实停止证据。

丢 ACK：dropNextAppendAck 只武装下一次 method='append'。代理完整 await 上游 HTTP 200、JSON ok=true/receipt，snapshot 确认 receipt 和对应 events 已持久提交后，设置 trace.dropped=true，并只 destroy 本次下游 response；上游及其他请求不销毁。waitForDroppedAck 在该点 resolve。不得在 stage、提交前断流，或自造 response/receipt。

## 不变量与错误语义

- 先跑 Happy Path，再保护场景；每 case 新 fixture/独立 DB/独立 UUID，无共享进程全局 mock、固定端口或外部资源。
- HTTP 403 由生产 RemoteSession.rpc 映射为官方 SessionOwnershipLostError；history 自身错误为 HTTP 400 JSON error.name。只能断言观察到的层，不把 403 写成 backend 400。
- 旧代三 case 各自新建活 handle、完成 turn/checkpoint、代理计数清零后 takeover(1)；takeover 是合成 sandbox 观察。撤权后不得先读/flush/close 该 handle，防止预先触发 lost。
- append case 首次调用 `writer.append(agent.session.snapshotEvents().slice(0,1))`；这是官方已有事件，未手调 seq，仅用于撤权后权限测试。生产首先发 stage，预期该 stage 403、append 请求 0 次；这证明 append 公共操作在授权入口拒绝，不声称 backend append 分支被执行。flush case 空 buffer 的 writer.flush 首次 HTTP flush403；close case 空 buffer writer.close 首次 HTTP close403。三个 case 独立 SessionOwnershipLostError，三次真实 HTTP 拒绝。
- 各旧代请求前后 deepEqual SQL sessions/events/receipts/intents；epoch/owner 的 takeover 变化在“请求前”已完成，禁止与撤权前比较造成假失败。controller.inspect 同样不变。
- lost 的 writer 在处置时不能静默吞错：官方 AgentHandle.dispose 的单一 close 失败原样抛 SessionOwnershipLostError；通过结构检查获得 `ctx.sessionPersistence` 的真实 `dispose():Promise<void>` 方法（不是替换方法）并直接调用，RemoteSession.dispose 抛 AggregateError('Session persistence close failed')，errors 恰一个 SessionOwnershipLostError。expectRevokedDispose 依次用 assert.rejects 验证 AgentHandle.dispose 和真实 persistence.dispose 的上述错误，再 await ctx.fiber.dispose，预期 resolve。作者实测确认此顺序；其他 reject 一律失败，禁止 catch-all 忽略。服务器/DB/tmp 清理仍在 finally 独立执行，清理失败使测试失败。
- ACK case 不触发 generation 变更。原 writer 保留 pending，首次网络 TypeError 被官方 AgentLoop 的 checkpoint fail-closed 路径消费并形成 error turn；随后显式 writer.flush 复用同一 batch/events，stage→append 获原 receipt→reconcile→flush；不能直接 rpc 重发、重新生成事件或自行改 seq。
- 200ms write-behind timer 可能先提交；ACK case 在 Agent create 完成后武装，followup→whenIdle 后等待 waitForDroppedAck，再 checkpoint。失败发生在官方 policy 的 pre-step/model barrier 时 turn 可能被关闭，不把该轮宣称 completed；验收只核对实际被丢响应的官方批次。不得为了获得失败而 mock timers 或追求一定在显式 checkpoint 抛错：以 trace.dropped 和后续 writer.flush 重投作为确定边界，见 T4。

## 规模核算（基线去重）

以下是验收必须核对的既有生产代码，不代表新增量；排除空行、纯注释。新 fixture/test 约 350/240 有效 LOC 仅为估计，不计入门槛。整项已核实 5 代码文件、939 有效 LOC，无重复行。

| 文件                                               | 符号/行范围                                                                       | 有效 LOC |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | -------: |
| apps/worker/remote-session.ts                      | RemoteSession / Handle / plugin / reconcileSessionPersistence；1–399              |      366 |
| apps/orchestrator/openshell/session-history.ts     | dispatch/transaction/request/events/receipt/commit；441–742                       |      292 |
| apps/orchestrator/openshell/single-host.ts         | constructor/bind 29–66；admit/takeover/reconcile/grant/persistenceIngress 139–275 |      162 |
| apps/orchestrator/openshell/worker-gate.ts         | WorkerGate require/channel/revokeChannels/close；1–73                             |       61 |
| apps/orchestrator/openshell/persistence-ingress.ts | createPersistenceIngress；1–60                                                    |       58 |

## T0：作者前置证据（独立门禁）

专门核对：本 RUNBOOK、AGENTS、worker Skill、RUNBOOK/DOCUMENT/COMMIT/PR Rules、ARCHITECTURE 共 8；正式需求/设计、代码和官方 SDK 调查分批完成，本节不是把全部调查打包为一个实施 STEP。

已核实：工作区初始干净、main/origin/main 同基线；ENVIRONMENTS 缺失但无环境依赖。现有 focused：

```bash
node --import ./register-paths.mjs --test apps/orchestrator/openshell/remote-session.test.ts apps/orchestrator/openshell/persistence-ingress.test.ts
pnpm check:orchestrator
```

实际结果：focused 5/5；Orchestrator typecheck、Node 104 tests（102 pass、2 既有 skip）、Go test/vet 通过。未执行 pnpm check，不能宣称全仓已绿。

作者仓库外探针正常安装十个基础官方包，再安装 checkpoint-policy，均成功；真实 create/turn/checkpoint/close→controller takeover(合成 sandbox)→两库重开→官方 resume→新代 turn/checkpoint/close 成功。第一次历史 11 events，resume 12（官方 end-seed），第二轮 21；前 11 个原样一致，最新 turn completed。探针不是固定 CI 证据，另做作者探针确认 stale flush/AgentHandle.dispose 各抛 SessionOwnershipLostError；显式真实 persistence.dispose 抛唯一 OwnershipLost 子错误的 AggregateError，随后 root dispose resolve。丢 ACK 探针真实转发首个 append200 后 destroy 下游，官方 turn 以 error 结束，writer.flush 重投的两次同 batch 请求和完整 receipt 字节一致。以上仍未形成五 case 固定 CI/SQL 全断言，不能据此更新 Readiness。

PASS：MASTER 独立审核本草稿为 Executable，且确认上述基线/T0 适用。STOP：尚未审核，或新增生产修改需求、依赖安装失败、正式依据冲突。不得把本节作者预验当成执行放行。

## 机械步骤

### T5：固定回归、迁移证据并删除计划

前置状态：T2正常恢复1/1、T3三项stale3/3、T4丢ACK1/1及各自typecheck已通过并逐步提交。丢ACK在真实append200+SQL事件/回执确认后触发；同批次请求/回执字节相同、重投不加revision、事件/receipt单份、reopen及新代正常轮均已断言。五个case准备进入固定全集。
允许修改：APPLICATION-BOUNDARIES-DESIGN.md、CURRENT-READINESS.md、本 RUNBOOK（删除）。
专门核对：以上 3 + APPLICATION-BOUNDARIES-REQUIREMENTS.md、provider-lifecycle.test.ts、fixture.ts、apps/orchestrator/package.json、public-files.json、.github/workflows/checks.yml、根 package.json，共 10。
禁止修改：其他 Readiness 行/其他设计结论、父 A2 标已实现、根 files、远端设置。

执行：运行下列固定全集，确认默认入口实际出现全部5个 case，新增 suite 无 skip；检查公开文件精确许可及 pack（仅检查，不发包）。将当前受测 commit/日期、官方包版本、五项结果、HTTP/SQLite/真实与合成边界、清理结果迁移到 Readiness 新章节“ A2 官方 Provider 本地验收”；A2-01/02/03 全部必需断言通过才各标已实现。父 A2 仍部分，04/05保留原状态和未覆盖。设计新增“A2 Provider 验收接线”，记录官方 acquisition/checkpoint→production ingress、版本固定和测试入口，不重复业务需求。删除本 RUNBOOK 和仅指向它的残留引用。

```bash
node --import ./register-paths.mjs --test apps/orchestrator/openshell/provider-lifecycle.test.ts
pnpm check
npm pack --dry-run --json
node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; for (const file of ["docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md","docs/40-readiness/CURRENT-READINESS.md"]) { for (const match of fs.readFileSync(file,"utf8").matchAll(/\]\(([^)]+)\)/g)) { const target=match[1].split("#")[0]; if (!target || /^[a-z]+:/i.test(target)) continue; if (!fs.existsSync(path.resolve(path.dirname(file),target))) throw new Error(file+": missing "+target); } }'
rg -n 'RUNBOOK-A2-PROVIDER-RECOVERY' docs .agents README.md public-files.json
git diff --check
```

PASS：独立 suite 5/5，默认 check 包含5项且全部通过，既有 skipped 逐项说明且不增加；pack 无秘密/临时目录/越界；rg 在删除后退出1表示无残留（其他错误 STOP）；diff check 0；证据可追溯当前代码，长期文件相对链接均存在。文档链接检查使用上述固定 inline Node 命令，忽略 anchors 与 https，失败 STOP。最终删除 RUNBOOK 与长期证据一并提交并回读。无外部资源需回滚。

STOP：任何 scope 必需断言缺失/失败、出现新增 skip、无法公开 whitelist/pack、与 A 合并后证据失效；保持三项部分实现，送回作者，不删除计划。PR 交付后若 main 前进，普通 merge 同步并复验受影响的五项、check 和 Readiness；禁止覆盖其他证据。

## 完成定义与未覆盖

五个固定 case + 默认 pnpm check + typecheck/lint/format/pack/文档链接与 diff 检查通过；三项各自可回读证据齐全；设计/Readiness 迁移完成、RUNBOOK 删除并提交。后续一个 PR 的当前 HEAD 必须通过实际必需 CI、取得明确 Codex 审查结论、处理反馈，按授权普通 merge 后同步/仅清理本任务分支与 fixture。当前作者阶段没有这些交付结果。

A2-04/05、真实模型/OpenShell、外部停机/故障接管、多节点、生产 bootstrap 与自动发现均未覆盖；不能因 A2-01/02/03 本地通过更改这些状态。
