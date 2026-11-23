# A1-02 伪造资源绑定验收

## 状态与执行者契约

- 状态：Draft / 待 MASTER 审核，尚非 Executable；2026-11-23。
- checkout：`bento-b`；main 基线 `2b82c7332b73361c87eee3d0c088bcc4fca61b0e`；调查开始工作树干净，origin/main 相同。
- 计划分支：`codex/resource-binding-forgery`。未经 MASTER Executable 及 `$bento-runbook-worker` 派发，不建分支、不提交、不实施。
- 继承全流程授权：逐步 commit/push、一个 PR、Ready、显式 `$bento-codex-comment-fix`、当前 HEAD 门禁后普通 merge、同步清理。B 先合入，A 在安全点同步；合并前仍回读 MASTER 顺序。
- 每步 PASS 后删除本步文本，提交本步产物及 RUNBOOK。失败 STOP，保留现场和脱敏证据，向 MASTER 回报最后 PASS、SHA、命令、实际结果及所需修订。不修改旧测试断言、不降低门禁、不回滚他人文件。
- 执行 cwd 均为仓库根。每步最多10文件，包含本稿和专核文件。生产行为失败时 STOP 交作者定位，本稿不授权临场修改生产契约。

## 目标、起点与依据

正式 [A1-02](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a1-02-bad-case-伪造资源绑定) 要求 tenant、Session、卷各伪造值分别拒绝、真实绑定不变、无跨租户数据。当前 [Readiness](../40-readiness/CURRENT-READINESS.md) 为待核验；本轮交付独立生产入口验收和持久证据，全部必需用例通过后改为已实现。A1 父项按其他子项仍保持部分实现。

按 [架构](../00-governance/ARCHITECTURE.md#架构决策)，资源绑定来自受信服务端，Worker 只有当次 capability。对应 [设计](./APPLICATION-BOUNDARIES-DESIGN.md#三组交接不变量) 的会话/Workspace 绑定与执行准入。不新增公开 API、用户字段或状态。接口沿 [Web 接口](../20-interfaces/WEB-INTERFACE.md) 及当前 Worker 私有协议；不把控制面管理方法宣称为公开用户 API。

当前生产事实：

- `Authority.checkPurge` 在 READY、无 capability 前提下逐字段比较 tenant/project/sandbox/volume，并检查其他 Session 引用。`SingleHostExecution.purge` 先 checkPurge，成功后才调用真实资源 remove callback、删除历史和权威行。因此 READY 场景可证明拒绝来自绑定比较，而非 RUNNING 状态门禁或 schema。
- `Authority.authorize` 只从 token 摘要定位权威绑定；`WorkerGate.require` 比较 grant 的 session/run/generation。tenant/volume 不是 Worker 可重写字段，不为测试发明生产参数。
- `SingleHostExecution.persistenceIngress` → `createPersistenceIngress` → `SessionHistory.dispatch`：HTTP Bearer 决定 grant，query.id/header.id 必须匹配 Session，错误403 GrantDenied。
- `SingleHostExecution.sdkIngress` → `createSdkIngress`：官方 protobuf 目标 sandbox 和可信 workspace 必须匹配；错误 gRPC7，转发及 operation reservation 在检查之后。卷由可信 sandbox 绑定决定，SDK 不接受任意 volume。

## Scope、禁止范围与完整链

三项核心独立结果固定为：READY A 绑定仅 tenant 改为 B；仅 session 改为现存 B Session；仅 volume 改为 B Volume。每次调用真实 SingleHostExecution.purge，必须拒绝且 remove callback 从未进入，A/B 权威、历史、文件逐字一致。随后正确 C 绑定可真实删除 C 卷和持久行，A/B 不变，排除“全部禁止”的假通过。

再将 A/B 正式 admit：A token 对 B 历史 stat/open/read/create 全部拒绝；官方 SDK 三种方法用 A token 定位 B sandbox 均拒绝；合法 A/B 各自请求通过，仅访问自己的数据。关闭并同库重开后重复拒绝及合法控制，核对持久绑定不变。

Non-goals：A1-03 撤权、A3 停止/接管、A6 审批/预算/排空、多节点、真实模型/外部 OpenShell/OS 隔离。网关为独立本机真实 mTLS/HTTP2 fixture，卷为真实本机私有文件目录；不声称已证明远端挂载或恶意宿主隔离。不访问 A 的任何远端资源。

禁止修改 service.ts、types.ts、store.ts、retry/checkpoint、command-host.ts、WEB-DESIGN、A 的 task-retry-sdk.test.ts。生产 openshell 文件本轮仅专核，不计划修改；必要变更必须先向 MASTER 报精确 symbol/影响并修订计划。

## 数据与唯一新增路径

新增路径均在 `apps/orchestrator/tests/openshell/`：

1. `binding-forgery/state.ts`：`snapshot(paths, volumes)` 使用独立 readOnly DatabaseSync 返回 `{authority:{execution_sessions,operations,management_stops,management_starts},history:{sessions,events,batch_receipts,batch_intents,history_checkpoints,history_restores},files:{volume:string,bytes:string,sha256:string}[]}`；各表稳定主键排序，BLOB 转 hex；文件固定为各卷 `canary.txt`。不读 WAL 原始字节，不写 SQL，不返回 capability/token 或凭据。权威 capability 只返回摘要列的 SHA256 与非空标记，不记录原摘要。
2. `binding-forgery/fixture.ts`：`createBindingFixture(): Promise<BindingFixture>`；拥有随机临时根、两个 SQLite、三个独立卷、SingleHostExecution。暴露 `bindings`（A/B/C 完整 Binding）、`paths`、`volumes`、`controller`、`admit():void`、`rpc(actor:'A'|'B', body:unknown):Promise<{status:number,body:unknown}>`、`snapshot()`、`reopen():Promise<void>`、`dispose():Promise<void>`；`grant(actor)` 仅供网络 helper，不输出 token。`remove(binding)` 只允许 fixture 内预登记的完整绑定，记录调用后真实 rm 对应卷；默认不删除其他资源。
3. `binding-forgery/gateway.ts`：`createBindingGateway(fixture,sdk:PreparedSdk)`；自有 CA/server/client 临时证书、真实 mTLS HTTP2 upstream、生产 sdkIngress。`request(actor,method,target)` 返回 grpcStatus/headers/body；`calls()` 返回 `{sandbox,method}[]`；`close()` 等全部 client/server/stream 关闭。不修改复用的 sdk.ts/sdk-probe.ts。
4. `binding-forgery-control.test.ts`：READY 绑定三项负测、合法删除及独立持久回读。
5. `binding-forgery-persistence.test.ts`：两租户真实 HTTP 历史伪造、合法隔离及同库重开。
6. `binding-forgery-sdk.test.ts`：固定官方 SDK 三方法跨 sandbox 拒绝、合法控制、同库重开。
7. `binding-forgery/check-package.mjs`：显式公开与 pack 边界检查。

Binding 精确为 `{tenant,project,session,sandbox,volume}`，均 required string；A/B/C 每字段互异，session/project/volume 用 randomUUID，tenant/sandbox 用固定测试前缀加 UUID。路径由本次 mkdtemp 生成且不公开。grant 为 `{token,session,run,generation}`；run 为新 UUID、generation=1、leaseMs=300000。只有 `admit()` 从 READY 调用生产 admit 生成，测试不能改 SQL 或手工签 token。先 READY 核验，后 admit，不用过期 lease 或 RUNNING 门禁冒充绑定拒绝。

历史必须经生产 HTTP create/append/close 种下 A/B 不同内容，不可空表假证明。create header 为 `{id:session,version:4,createdAt:1700000000000,isSeeded:false}`；事件固定为 `[{type:"turn/start",seq:0,time:t,data:{turn:1}},{type:"turn/end",seq:1,time:t+1,data:{turn:1,reason:{kind:"completed"}}}]`，A 的 t=1700000000001，B 的 t=1700000000101。header.createdAt沿用上述值。经官方 materializeAppendBatch 后，用生产 create 响应 key 按 `{method:"stage",id:session,key,batch,events}` → 同字段 method append → `{method:"reconcile",id:session,key,batch}` → `{method:"flush",id:session,key}` → `{method:"close",id:session,key}` 顺序 HTTP 调用，batch为randomUUID。append响应receipt必须匹配batch、first=0、count=2，digest为SHA256(JSON.stringify(materializedEvents))。合法open请求 `{method:"open",id:session,access:"read"}`，以响应key执行 `{method:"read",id:session,key,offset:0,length:2}`，最终close；不得手写SQL种历史。合法 read 的 value.events 必须深比较对应 actor 的完整 expectedEvents（如下），并且不等于另一 actor 的 expectedEvents。文件 canary 仅供独立文件快照及网关读取观察，不写入历史；历史隔离以完整事件值及两组不同 time 证明。拒绝响应不得含 B 的完整事件数组、文件 canary 或任何凭据。

```ts
const expectedEvents = {
    A: [
        { type: 'turn/start', seq: 0, time: 1700000000001, data: { turn: 1 } },
        {
            type: 'turn/end',
            seq: 1,
            time: 1700000000002,
            data: { turn: 1, reason: { kind: 'completed' } },
        },
    ],
    B: [
        { type: 'turn/start', seq: 0, time: 1700000000101, data: { turn: 1 } },
        {
            type: 'turn/end',
            seq: 1,
            time: 1700000000102,
            data: { turn: 1, reason: { kind: 'completed' } },
        },
    ],
};
```

种入值必须为 materializeAppendBatch(expectedEvents[actor])，回读后 assert.deepEqual(value.events, expectedEvents[actor])；A/B 两套完整值分别比较，重开前后同样比较。

## 规模核算

计数基线为上述 HEAD，按必须专核的既有生产/SDK 代码范围计；无重复范围，去空行与纯注释，共 **716 LOC / 7 个代码文件**。不计新文件预测、Markdown 或生成物。

| 文件                                                      | 行范围 / symbol                                                       | LOC |
| --------------------------------------------------------- | --------------------------------------------------------------------- | --- |
| `apps/orchestrator/src/openshell/authority.ts`            | 67–108 checkPurge/purge；171–184 authorize                            | 54  |
| `apps/orchestrator/src/openshell/worker-gate.ts`          | 29–57 require/channel                                                 | 26  |
| `apps/orchestrator/src/openshell/persistence-ingress.ts`  | 8–60 createPersistenceIngress                                         | 53  |
| `apps/orchestrator/src/openshell/sdk-ingress.ts`          | 60–115 createSdkIngress；232–455 forward                              | 249 |
| `apps/orchestrator/src/openshell/single-host.ts`          | 48–64 bind/inspect/purge；237–287 grant/persistenceIngress/sdkIngress | 63  |
| `apps/orchestrator/src/openshell/session-history.ts`      | 441–590 dispatch/transaction/request                                  | 144 |
| `apps/orchestrator/tests/openshell/binding-grants/sdk.ts` | 20–50 decoder来源/PreparedSdk/缓存身份                                | 27  |

## T0：作者完成基线与契约确认

前置：MASTER 审核与共享顺序。允许修改：本稿。专核：上表7文件、remote-session.test.ts（合计本稿9文件）。禁止修改：所有生产文件。

执行：核 HEAD、clean、三类 READY 伪造确实触发字段比较；核历史 append 精确 wire；读受控 `/Volumes/storage/workspace/bento/ENVIRONMENTS.md` SDK章节，使用默认共享缓存但不回显私密配置。核 node/pnpm/openssl 和已安装依赖。

验证：`git status --short`；`git rev-parse HEAD origin/main`；`node --version`；`pnpm --version`；`openssl version`；`node --import ./register-paths.mjs --test apps/orchestrator/tests/openshell/management.test.ts apps/orchestrator/tests/openshell/persistence-ingress.test.ts`。

PASS：基线匹配、无归属不明改动、命令0且无skip；wire与本文一致。STOP：任何冲突、来源缺失、依赖失败。作者已核 wire 与 remote-session.test.ts、SessionHistory.request 一致；2026-11-23 Node v22.23.2、pnpm12.15.0、OpenSSL3.5.9，以上baseline测试4/4 PASS、fail0skip0。HEAD仍为起始基线；当前唯一改动为本未跟踪草稿。T0技术前置已通过，Executable与分支/开工仍待MASTER。

## T4：以官方 SDK 和真实 mTLS 验证目标沙盒拒绝

前置：control+persistence 两suite已提交，9/9 PASS、fail0skip0；5项Session攻击真实HTTP403，A/B非空事件完整回读、同库reopen与快照不变。允许修改：gateway.ts、sdk.test.ts、fixture.ts、本稿；专核 sdk-ingress.ts、binding-grants/sdk.ts、sdk-probe.ts（sdk.test.ts 唯一路径为 binding-forgery-sdk.test.ts）。

执行：before prepareSdk并probeSdk，after dispose；gateway只接受本fixture的两个sandbox，官方schema decode请求，再按sandbox映射自己卷读取canary，GetSandbox回官方空response、Exec两种回frame(sdk.exit(0))；upstream calls及实际文件读取另行记录。CA/server/client仅在本次临时目录，serverAuth/clientAuth与IP SAN沿既有fixture；不修改它。合法A/B三方法各成功0且正确目标。A token+B sandbox三方法各独立test返回7，calls和snapshot不增，无B canary泄漏；同库重开后重建ingress且复验。

验证：`node --import ./register-paths.mjs --test --test-concurrency=1 --test-timeout=900000 apps/orchestrator/tests/openshell/binding-forgery-sdk.test.ts`。

PASS：官方prepare/probe成功，不降mock；三项负测和合法控制全部执行无skip；upstream真实mTLS认证通过且攻击零到达；合法请求实际读取自己文件。STOP：SDK/网络/证书失败或目标检查失效，不放宽TLS/断言。清理仅本fixture网络/证书及SDK本次构建目录。

## T5：固定公开边界与完整验证

前置：T4已提交。允许修改：check-package.mjs、public-files.json、apps/orchestrator/package.json、本稿；专核根package.json、binding-grants/check-package.mjs、.github/workflows/checks.yml（共7文件）。

执行：public-files精确登记7个新代码文件；根files不变。test默认openshell/*.test.ts已收三个新suite；check:core:fast末尾加 `node tests/openshell/binding-forgery/check-package.mjs`。新检查器用现有pack检查同等正负断言，确认7文件各入包一次且无node_modules/SQLite/私钥/证书/日志/临时目录。CI当前Orchestrator路径覆盖自动执行，无CI改动；若实际未覆盖STOP向MASTER报。

验证：`node apps/orchestrator/tests/openshell/binding-forgery/check-package.mjs`；`pnpm check`；`git diff --check`。

PASS：完整check0；三个新suite全部实际执行无skip，既有两个可选Temporal skip不得计入A1证据；pack符合固定边界。STOP：任何失败、用例缺失或发布泄漏；不得扩大根files。

## T6：迁移证据并删除 RUNBOOK

前置：T5提交和完整验证证据对应当前代码。允许修改：APPLICATION-BOUNDARIES-DESIGN.md、CURRENT-READINESS.md、本稿（完整路径见前面链接）；专核正式需求、public-files.json（共5文件）。

执行：设计记录绑定伪造入口/信任范围与真实HTTP/mTLS/SQLite/文件fixture边界；Readiness A1-02改已实现，逐项列tenant/session/volume、合法控制、持久回读/重启、SDK与HTTP拒绝和零转发，记录日期/代码基线/实际命令/通过数量/未覆盖。A1父项仍部分，A6原状态不变。删本稿，不保留completed/archive副本。

验证：`pnpm exec prettier --check docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md docs/40-readiness/CURRENT-READINESS.md`；`git diff --check`；`rg -n 'RUNBOOK-A1-02-BINDING-FORGERY' docs`（预期无结果退出1）；再从仓库根执行以下固定命令，检查两份长期文档内所有行内Markdown链接的本地路径；先去除 `#fragment`（本步骤只检查文件存在，不校验锚点标题），忽略纯锚点及带URI scheme的外部链接，URL解码后按文档所在目录解析。路径不存在则退出1：

```bash
node --input-type=module <<'JS'
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const documents = [
    'docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md',
    'docs/40-readiness/CURRENT-READINESS.md',
];
let checked = 0;
for (const document of documents) {
    const source = readFileSync(document, 'utf8');
    for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const destination = resolve(dirname(document), decodeURIComponent(target));
        if (!existsSync(destination)) {
            console.error(document + ': missing link target: ' + target);
            process.exit(1);
        }
        checked++;
    }
}
console.log('Local Markdown link targets PASS: ' + checked);
JS
```

PASS：证据完整、无悬空链接和本稿引用，本稿删除与证据同commit。STOP：任何必需结果缺失，保持A1-02原状态。最后按worker skill创建同一个PR、Ready、显式comment-fix、当前HEAD CI与Codex及MASTER顺序全部满足后普通merge，再快进清理任务分支；不新增无关交付门禁。
