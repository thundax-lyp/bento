# Task 提交可靠性闭环

状态：Executable / 已获 MASTER 显式开工；2026-11-19。T0 已验证，T1 客户端请求键测试 4/4 PASS。

工作边界：WORKER B，checkout `/Volumes/storage/workspace/bento-b`。调查基线 `231567dcf83e2d1a000db68f03dcb655a3d57cac`，当前 main 干净。获 Executable 后任务分支固定 `codex/task-submission-reliability`；只有 MASTER 单独发出 `$bento-runbook-worker RUNBOOK-TASK-SUBMISSION-RELIABILITY.md` 才开工。

## 执行者契约

依 T0→T1→T2→T3→T4→T5 执行，不提前实施后续步骤。每步 PASS 后删除该步、改写后续前置为可核对事实，并单独提交；最后一步同步长期证据并删除 RUNBOOK。每步最多 10 文件，包含 RUNBOOK 和专门核对文件。通用规则见 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md)、[Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。

MASTER 已传达全流程分支、提交、push、PR、Ready、显式评论处理、当前 HEAD 门禁通过后普通 merge、同步和清理授权；当前阶段仅调查和未提交草稿送审。不得把送审视为开工。

STOP 保留现场，不回滚用户改动；报告最后 PASS/提交、文件及符号、复现命令、脱敏实际结果和需要的决定。范围内测试错误可原步修复，产品/共享入口/基线变化交作者修订并复审。不得放宽断言、跳过用例或伪造受理。

## 目标、正式依据与当前断点

三项共用正常页面→请求键→个人 API→Orchestrator SQLite→原回执→UI 重投链，合并交付但分别验收。

| 场景      | 正式依据                                                                                                                                                                         | 当前断点                                                                                              | 本次验收                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WEB-05-04 | [需求](../10-requirements/WEB-REQUIREMENTS.md#web-05-04-bad-case-提交响应丢失)、[Task 生命周期](../20-interfaces/WEB-INTERFACE.md)、[设计](WEB-DESIGN.md) Task 冻结及重复 create | [Readiness](../40-readiness/CURRENT-READINESS.md) 缺实际丢回执对照                                    | blank 和 snapshot 均从页面创建；上游 202 后丢回包；原键重投返回同 Task，输入及环境版本不变、provisionTask 仅一次；随后发送 Run，worker execute 一次                    |
| WEB-06-03 | [需求](../10-requirements/WEB-REQUIREMENTS.md#web-06-03-bad-case-提交响应丢失)、接口 POST /tasks/{taskId}/runs、设计 Task Run                                                    | 缺同提交超时重投；TaskDetailsContent 的 onError refresh 会读出活跃 Run 并禁 canSend，没有独立重投入口 | 页面发送→上游 202 后 abort→原正文同键重投→200 同 Run；Run/user_message/execute 都恰一；同库重开重放仍同 ID                                                             |
| WEB-06-04 | [需求](../10-requirements/WEB-REQUIREMENTS.md#web-06-04-bad-case-同任务已有活跃-run)、接口 task_busy、设计 Task 写门禁                                                           | 五状态与 pending retry 各态缺逐项证据                                                                 | queued/running/recovering/needs_review/cancelling 及 preparing/workspace_restored/history_restored/blocked retry 预留均拒新键要求，原记录不变且不新增 Run/user_message |

代码事实：

- `apps/workspace/web/src/api.ts::taskMutation` 已按账号、kind、scope、正文 JSON SHA-256 存 sessionStorage 键。成功及明确 4xx 删除，网络/5xx 保留；createTask 排序 fileIds，createTaskRun trim prompt。不修改此通用策略。
- `apps/workspace/api/server.ts::taskEntryServer` blank 转 FrozenTaskInput；snapshot 经 `space-execution.ts::createTask/enrollTask/freezeTask/reconcileTask` 持久 pin/frozen intent。生产 freeze 与 receipt 逻辑不能被 fixture 替代。
- `apps/workspace/api/protocol.ts::createTaskInput`、Task 路由解析与 DTO；`execution-service-http.ts::taskForward` 原键与 prompt 转发。
- `apps/orchestrator/execution-service/http.ts::executionHttp` 的 Task 路由调用 `Store.createTask/enqueueTaskRun`，首写 202/replay 200，wake 不代表第二次执行。
- `store.ts::createTask` 的 receipt、项目、Task、refs 同一 Store.write；`enqueueTaskRun` 先查同键后写门禁，同键异 prompt 报 conflict；新增 Run 和 user_message 同事务。
- 准确门禁符号是 `taskWriteGuard/projectHasPendingRun/pendingTaskRetry`，不是初始线索中的 requireTaskWritable/enqueueTask/acceptTask。
- 已运行基线定向测试：`node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='Task input, Run, and source deletion share a durable transaction boundary' apps/orchestrator/execution-service/service.test.ts`：1/1 PASS。证明 Store 基础行为，不证明浏览器或真实 Worker。旧测试仍保留，不修改 A 独占 suite。
- `web/e2e/task.spec.ts` 的 lostReceipt 是 mock，不作为生产受理证据。#63 terminal-results fixture 仅作为组织方法参考，既有 terminal-results 文件不修改。

## Scope、Non-goals 和资源

只补三项提交可靠性、最小页面重投入口及其测试/证据。生产服务端保持只读；新测试若揭示服务端缺陷，STOP 送作者固定修正方案，不临场加文件。

禁止修改 `service.ts::retryReason`、恢复控制流、`service.test.ts`、OpenShell、Session checkpoint、安全重试 mutation/确认按钮、取消实现和结果展示。不得改 `api.ts::taskMutation`；需改时报 MASTER。A 页面只读；MASTER 已同意 B 修改 TaskDetailsContent sending/onError/canSend 周边。

不实现恢复、结案、队列公平、租户满额新能力、外部身份、S3、模型、Temporal、Docker 或 OpenShell 验收。不承诺跨设备/关浏览器离线草稿恢复。sessionStorage 测试只证明同 tab reload 后原正文仍找同键；页面临时未知提交正文只在本次组件生命周期保留，刷新可按账号找回已受理记录。

ENVIRONMENTS.md 调查时不存在；本任务不连接外部受控服务，无需配置秘密。API 端口 4343、Vite 4344，execution 使用系统分配回环端口；任一固定端口已占用 STOP，不复用/杀旧进程。临时目录由 mkdtemp 创建，finally 只清理本 fixture 自有资源。

## 数据、接口、顺序和不变量

- 公开创建 required `{name:string,source:{kind:'blank'}|{kind:'space_snapshot',spaceId:string,fileIds:string[]}}`；K 为 Idempotency-Key。name trim，snapshot fileIds 排序。私人 FrozenTaskInput required `{id:string|null,name:string,sourceSpaceId:string|null,inputFiles:{path:string,text:string}[],inputManifest:{fileId:string,path:string,bytes:number,sha256:string}[],inputDigest:string}`。blank id/source 为 null 且两个数组空；snapshot id 是 space intent UUID。inputDigest 为规范文本快照 JSON SHA-256。所有值均来自生产 mapper/freeze；fixture 只提供已保存源字节。
- Store Task 创建 hash 为 `{name,sourceSpaceId,inputManifest:按fileId排序,inputDigest}` 的 JSON SHA-256；`task_creation_receipts(owner,key,taskId,hash)` 主键 owner/key。taskId 首写由可信端分配，environmentVersion 来自 host，不由浏览器指定；重投不换版本。receipt 与 Task 同生命周期；同部署重开继续读。不同正文同键 409 idempotency_conflict，不新建记录。
- Run 请求 required `{prompt:string}`，公开 parser/客户端 trim，原键透传。Store 按 taskId/key 查既有 Run，prompt 或 retryOf 不符即 409 idempotency_conflict；同键同正文先返回原 Run，不受 busy 新写门禁影响。新的 Run ID/时间/sequence 由 Store 创建，user event ID 为 `${runId}:user`、kind=user_message、text=prompt、check=null；只 append 一次。
- 活跃 Run 集为 queued/running/recovering/cancelling/needs_review；pending retry 为 preparing/workspace_restored/history_restored/blocked。新键在这些状态回 409 task_busy，不生成 Run、event 或派发。queued/closed retry receipt 自身不持预留，前者由其新 Run 状态持门禁；此任务不改变恢复状态转换。
- DTO 沿用接口的 TaskDTO、RunDTO、TaskEventDTO；不增加公开字段、事件或数据库结构。POST 首受理 202，重投 200；公开错误 `{error:{code,message}}`。无新 outbox/Archive/版本契约。
- UI 新增 `pendingSubmission: string|null`（初始 null，组件内拥有）保存未知回执的已 trim 正文。sending 改为 `mutationFn:(submittedPrompt:string)=>createTaskRun(account,id,submittedPrompt)`。正常 onSubmit 传 prompt.trim()。onError(error,submittedPrompt) 对 ApiError 400–499 清 null；其他错误保存 submittedPrompt，然后执行现有 refresh。onSuccess 清 null、清 prompt、refresh、导航原返回 Run。
- pendingSubmission 非 null 时普通 canSend 为 false，不允许编辑或正常发送；另显文案「提交结果未确认，请重试原提交。」与 type=button「重试提交」。该按钮只在 online、任务读取未报错、无其他 mutation pending 时可点，固定调用 sending.mutate(pendingSubmission)，不采用当前输入框内容、不看 last.canContinue 放行新要求。网络/5xx 后继续保留；成功或确定 4xx 清除。不修改 retry/cancel mutation。活跃原 Run 正常入口展示「任务已有执行，请等待完成或取消。」并禁发送；取消按钮仍沿用现有条件。

## 有效 LOC 与文件映射

以下为基线已存在且交付必须核对的范围；按非空且非纯注释行计算，同一行只计一次。不计文档、新测试估值或生成物。

| 路径                                         | 行段 / 核对符号                                      | 有效 LOC | 需求映射              |
| -------------------------------------------- | ---------------------------------------------------- | -------: | --------------------- |
| apps/workspace/web/src/api.ts                | 337–406 taskMutation/createTask/createTaskRun        |       69 | 05-04/06-03 请求键    |
| apps/workspace/web/src/pages.tsx             | 1127–1250、1365–1400 TaskDetailsContent              |      160 | 06-03 重投、06-04 UI  |
| apps/workspace/api/server.ts                 | 325–410 taskEntryServer Task 接线                    |       86 | 全链                  |
| apps/workspace/api/protocol.ts               | 509–530、550–660 createTaskInput/Task route parser   |      133 | 正文与键              |
| apps/workspace/api/execution-service-http.ts | 70–105、145–240 taskForward/公开错误                 |      130 | 回执/冲突             |
| apps/workspace/api/space-execution.ts        | 409–652 enrollTask/freezeTask/advanceTask/createTask |      238 | 05-04 冻结            |
| apps/orchestrator/execution-service/http.ts  | 130–196、320–347 Task routes                         |       94 | 202/200               |
| apps/orchestrator/execution-service/store.ts | 736–940 createTask/taskWriteGuard/enqueueTaskRun     |      199 | 持久化与 busy         |
| 合计                                         | 8 个代码文件                                         |     1109 | 达到 500 LOC / 5 文件 |

允许新增且不计入上述门槛：`apps/workspace/web/src/task-submission.test.ts`、`apps/orchestrator/execution-service/task-submission.test.ts`、`apps/workspace/web/acceptance/task-submission-fixture.ts`、`apps/workspace/web/acceptance/web-task-submission.spec.ts`、`apps/workspace/web/playwright.task-submission.config.ts`。

## 机械步骤

### T2：持久回执和各态新写门禁

前置状态：src/task-submission.test.ts 已提交，Vitest 4/4 PASS；网络/5xx 原键、模块重载、成功/4xx 清除、账号/正文/Task 隔离和 snapshot 排序已核对。
允许修改：新 `apps/orchestrator/execution-service/task-submission.test.ts`、`apps/orchestrator/package.json` test 脚本、RUNBOOK。专门核对 store.ts、http.ts、types.ts，共 6 文件。
禁止修改：Store/HTTP/service 生产代码与 service.test.ts。

执行：

1. node:test 独立文件使用临时真实 SQLite Store。创建 blank/snapshot，importResult ready，enqueueTaskRun；close/reopen 同库，再 createTask 同键、enqueueTaskRun 同键，核对 replay=true、ID/冻结字段不变、Run/event 恰一。异正文同键均冲突，冲突前后 tasks/runs/events/creation receipts 行数不变；异 owner 不读原记录。
2. 为五个 Run 状态各建独立 Task，Store.status 注入目标状态（仅状态门禁 fixture，不宣称状态转换已验），close/reopen 后提交新键新正文，均 409 task_busy；保留原状态、prompt、Run/event 全字段及计数。原键同正文仍能 replay。
3. retry fixture 禁止直接 INSERT：每个状态单独建 Store(path,16)、owner=`retry-owner`，blank input={id:null,name:'Retry task',sourceSpaceId:null,inputFiles:[],inputManifest:[],inputDigest:SHA256('[]')}；version='sha256:'+'a'.repeat(64)。调用 createTask(owner,randomUUID(),input,version).task.id、importResult(taskId,'ready')、enqueueTaskRun(owner,taskId,randomUUID(),'Original').run；status(source.id,'failed','Synthetic failure')、recordStopProof(source.id,'{}')。这份 '{}' 是沿用旧 settled retry Store 单测的合成 stop receipt，只证明账本门禁，不证明真实停止或恢复。evidence 固定 `{oldGeneration:1,newGeneration:2,workspaceSha256:input.inputDigest,historySha256:input.inputDigest}`，`acceptTaskRetry(owner,taskId,source.id,randomUUID(),evidence).attempt` 构造同 Task/source 的合法 Store receipt。签名为 acceptTaskRetry(owner:string,taskId:string,sourceRunId:string,key:string,evidence:{oldGeneration:number,newGeneration:number,workspaceSha256:string,historySha256:string})；advanceTaskRetry(id:string,expected:'preparing'|'workspace_restored'|'history_restored',phase:'workspace_restored'|'history_restored'|'blocked'):boolean。
    - preparing：accept 后不推进；workspace_restored：advance(id,'preparing','workspace_restored')；history_restored：依次前一步及 advance(id,'workspace_restored','history_restored')；blocked：advance(id,'preparing','blocked')。每次 advance 必须 true。close/reopen 后新键 enqueue 精确抛 `{status:409,code:'task_busy'}`，Run/event/attempt 全字段与计数不变。
    - queued 正对照：推进至 history_restored，调用 finalizeTaskRetry(attempt.id,'history_restored')，返回 Run ID 必等于 attempt.newRunId、status=queued；新键 enqueue 必为 task_busy，无新记录。再 status(next.id,'succeeded','Synthetic success')，新键 enqueue 必成功 replay=false，恰新增一个 Run 和一个 user_message，证明 queued receipt 不独立持锁。不宣称该 synthetic success 有真实结果。
    - closed 对照：新独立 fixture 的 preparing→blocked，closeBlockedTaskRetry(attempt.id,2,'a'.repeat(64)) 必非 null，回读 phase=closed、Task.closedReason=unconfirmed；close/reopen 后新键 enqueue 唯一预期为 `{status:409,code:'task_not_ready'}`，不是 task_busy；Run/event/attempt 不增。这里只调用既有 Store 结束 receipt 来验证门禁，不测试可信结案服务或其证据充分性。

4. package.json test 显式加入 `execution-service/task-submission.test.ts`，确保 pnpm check 和 CI 真正运行新测试，不改已有匹配路径。

验证：

```bash
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/execution-service/task-submission.test.ts
pnpm --filter @bento/orchestrator typecheck
```

PASS：每个状态/预留单独命名子用例通过，重开回执不增行，所有拒绝无半提交；类型检查退出 0。STOP：任何行为不符或 schema 不匹配，交作者修订。finally 关闭 Store 并删除本测试临时目录；不清理别的目录。

### T3：实际 HTTP 与浏览器丢回执验收入口

前置状态：T2 持久回执与门禁测试已提交且 PASS。
允许修改：新 fixture、新 spec、新 config、RUNBOOK。专门核对 terminal-results-fixture.ts、space.ts、space-storage.ts、space-execution.ts、api/server.ts、web/src/space.tsx，共 10 文件。
禁止修改：所有既有 fixture/验收、生产服务、页面；本步先复现页面缺口。

执行：

1. 新 fixture 返回签名固定如下，不新增产品路由：

```ts
export async function startTaskSubmissionFixture(): Promise<{
    seedSource(): Promise<{
        spaceId: string;
        fileId: string;
        path: 'input.txt';
        name: 'Submission source';
    }>;
    setSourceText(text: string): void;
    releaseRun(taskId: string): void;
    observe(taskId: string): Promise<{
        prepare: number;
        execute: number;
        runs: number;
        userMessages: number;
        creationReceipts: number;
        sourceReads: number;
    }>;
    reopen(): Promise<void>;
    close(): Promise<void>;
}>;
```

接线顺序固定：mkdtemp(tmpdir()/bento-submission-*)→localHost(join(state,'volume'))→包装 host→serveExecution({state,host,token:bearer,retryMs:20,workerTimeoutMs:15000})→`let backend=httpBackend(execution.url,bearer,5000)`→`let space=mySpace(join(state,'space.sqlite'),storage,(owner,op)=>backend(owner,op))`→`let api=await taskEntryServer({port:4343,origin:'http://127.0.0.1:4344',auth:sessionAuth(mockAccounts(accounts),false,false),backend:(owner,op)=>backend(owner,op),space})`。accounts=demoAccounts()，demo=accounts.find(a=>a.account==='demo')!，owner 仅来自 demo.ownerId；bearer='fixture-submission-'+randomUUID()。不得使用 mockBackend。

storage=`spaceStorage('http://127.0.0.1:1','fixture','us-east-1')`，仅 read(key,size) 使用本地对象字节：assert key===spaceObjectKey(fileId)（即 'space/'+fileId）、size===5，sourceReads++，返回 Buffer.from(currentSource)，初始 currentSource=Buffer.from('base\n')。setSourceText(text) 仅把 currentSource 更新为 UTF-8 Buffer，测试传入同长 'next\n'。其他 storage 方法 create/signPart/parts/complete/empty/abort/size/remove/preview/download 全部覆写为抛 Unexpected storage operation（方法列表已逐项核对 space-storage.ts）。此处替代 S3 对象读取本身；mySpace 传给生产 spaceExecution 的 storage.read、生产 freezeTask 的 key/大小/UTF-8/checksum/manifest/digest 和持久 receipt 路径完整保留，不模拟 freeze 或返回 Task。

seedSource() 只能调用一次，重复调用返回首次 IDs；spaceId/fileId=randomUUID()，在 mySpace 初始化 schema 后以独立 DatabaseSync(join(state,'space.sqlite')) 事务写入：`INSERT INTO space_projects(id,owner,name) VALUES (?,?,?)` 参数 [spaceId,demo.ownerId,'Submission source']；`INSERT INTO space_uploads(id,project,owner,path,size,manifest,state,storageId,expires,signedUntil,cleanup) VALUES (?,?,?,?,?,?,?,?,?,?,?)` 参数 [fileId,spaceId,demo.ownerId,'input.txt',5,JSON.stringify([SHA256(Buffer.from('base\n')).digest('base64')]),'saved',null,0,0,null]。COMMIT 后关闭连接，返回上面 source 对象。失败 ROLLBACK 并关闭；只 seed 已保存上传前置，不写 space_tasks、pins、Task、Run。对象 key 一律由生产 spaceObjectKey(fileId) 计算。冻结 manifest hex SHA 来自生产 freezeTask，inputDigest 为生产文本快照 SHA，不从 fixture 灌入。

正常 snapshot 入口：注册登录后 seedSource，page.goto('/space/'+spaceId)，page.getByRole('checkbox',{name:'input.txt'}).check()，page.getByRole('button',{name:'从所选文件新建任务',exact:true}).click()；Task 名称沿用源项目名 'Submission source'，不添加虚构任务名称输入。POST /api/tasks body 必是该 name 和唯一 fileId 的 space_snapshot。丢回包后仍在该页面，选择未丢失，再点原按钮。blank 入口 page.goto('/')、getByLabel('任务名称').fill(name)、getByRole('button',{name:'创建空白任务',exact:true}).click()。

2. host.provisionTask 包装生产 localHost 实际调用，按 task project ID 计数；host.worker 对 execute 按 project ID 计数后调用 base.worker。为 prompt=`hold-submission` 使用按 project ID 管理的可释放 Promise，在释放前保留 running；releaseRun(taskId) 只 resolve 对应 gate，close 先释放所有自有 gate 再停自有服务。setSourceText 只更新 storage.read 的 fixture 字节。observe 新开只读 DatabaseSync(join(state,"business.sqlite"),{readOnly:true})，用 `SELECT COUNT(*) AS n FROM runs WHERE projectId=?`、`SELECT COUNT(*) AS n FROM task_events WHERE taskId=? AND json_extract(body,'$.kind')='user_message'`、`SELECT COUNT(*) AS n FROM task_creation_receipts WHERE taskId=?` 绑定 taskId 计数并 finally close；sourceReads 来自 read 包装，host 计数来自包装调用，不从 HTTP 状态推断。reopen 先断言所有已计数 Run 终态，依序 await api.close()/execution.close()（api.close 内部负责 await space.close，禁止二次 close space），按上述顺序以原 state、accounts、bearer、storage 重建 execution/backend/space/api，保留计数和 source IDs/字节；禁止重开 running 来触发恢复。
3. spec 每个 test.beforeEach 启动新 fixture，test.afterEach finally close，注册各自 demo 合成账号；testDir acceptance、testMatch web-task-submission.spec.ts、workers=1、retries=0、timeout=120000、Chromium、trace/video/screenshot off；Vite 4344 strictPort，API_TARGET=4343，reuseExistingServer=false。端口冲突直接失败。
4. spec 登录从注册/登录正常入口；blank 和 snapshot 创建分别 page.route 对匹配 POST 执行 route.fetch()，断言真实上游 202、保存 body/key/Task，随后 route.abort('failed')。页面保留原表单后点击同创建按钮重投，route.fetch 捕获 200 后 route.fulfill({response})。核对同 ID/输入/environment、prepare=1/receipt=1；snapshot 通过 setSourceText 在受理后把 fixture 源字节改为 `next\n`，重投 inputDigest 不变、storage.read 不再调用。随后页面发送 noop 并核对 execute=1。
5. Run 丢包用同样 fetch→202→abort。先允许 noop 结束，页面原正文重投得到同 Run。另用 hold-submission 保持 running；断言 pending entry“重试提交”可见并重投（此处当前生产缺陷应复现）。第二登录页/旧页面发送不同新键要求，实际 HTTP 409 task_busy；UI 禁发送并显示等待/取消。原键异正文 409 idempotency_conflict。每次前后 observe 核对不新增 prepare、execute、Run、user_message。
6. 增加服务同库重开后原 Task/Run key 原正文 replay 200 测试；原 ID/输入/environment 和计数不变。reload 检查未知请求键仍在 sessionStorage；不声明组件 pendingSubmission 跨刷新存在。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web exec playwright test -c playwright.task-submission.config.ts --grep 'create receipt|completed Run receipt|reopen receipt'
pnpm --filter @bento/web exec playwright test -c playwright.task-submission.config.ts --grep 'active Run receipt'
```

PASS：前三个命名组退出 0；active Run receipt 组只包含一个测试，退出 1，且唯一失败必须是 getByRole(button,{name:"重试提交",exact:true}) 的 toBeVisible 找不到元素；其前置上游 202、abort、原 Run running 与 host/数据库计数断言须先 PASS。任何其他失败均 STOP。保留该精确红灯输出，作为 T3 回归复现产物；不是整体验收通过。该 acceptance/config 仅由专用 -c 手动运行，不接入默认 playwright.config.ts 或 CI；不得加 test.fail/expectedFailure/skip。T3 可单独提交该唯一红灯，T4 必须紧随，最终专用套件必须全绿。STOP：任何其他失败、上游未实际受理、假 fulfill 受理、缺计数/清理失败；不尝试外部服务。

### T4：未知回执原正文重投入口

前置状态：T3 三组 PASS、active Run 缺按钮精确失败已提交；MASTER 已协调页面范围。
允许修改：pages.tsx、web-task-submission.spec.ts、task-submission.test.ts、RUNBOOK。专门核对 api.ts，共 5 文件。
禁止修改：retry/cancel mutation、安全重试/结果段、api.ts、其他生产代码。

执行：严格落实前述 UI 数据与顺序：pendingSubmission、sending string 变量、onError 4xx 清除、未知保存、onSuccess 清除；正常发送禁 active，未知按钮固定原正文同键。同步修改 completed Run receipt 用例：T3 的 noop 已结束后原发送按钮重投，在 T4 改为点击新增“重试提交”；pendingSubmission 在未知回执后无论原 Run 活跃或已完成都保留，普通 canSend=false，成功或明确 4xx 才清除。该用例仍须真实上游受理后 abort、同键原正文 200 同 Run，host execute/Run/user_message 计数断言保持不变。补浏览器定向断言：未知后普通输入禁用；attempt 重投 200 清入口且导航原 Run；重投遇 409 清入口并保留正常 busy 门禁；5xx 继续保留原正文；点击期间重复操作禁用。4xx/5xx 的 UI 清除测试可在这一专门分支注入错误响应，但不能充当真实受理/幂等证据。实际受理用例仍由 T3 上游 fetch→abort 保证。成功后数据库 user_message=1，重复重投也仍为 1。

验证：

```bash
pnpm --filter @bento/web exec vitest run src/task-submission.test.ts
pnpm --filter @bento/web exec playwright test -c playwright.task-submission.config.ts
pnpm --filter @bento/web typecheck
```

PASS：全部真实受理、UI 错误分支与原正文同键断言通过，无 expectedFailure/skip；旧 Run 未变、新键被拒。STOP：需改通用键或相邻 retry 语义则交 MASTER，不扩范围。

### T5：完整门禁、正式证据和收口

前置状态：T4 已提交，所有 dedicated 验收 PASS。
允许修改：Readiness、WEB-DESIGN、public-files.json、本 RUNBOOK（最后删除）。专门核对 WEB-REQUIREMENTS、WEB-INTERFACE、package.json、README、deploy/README、ARCHITECTURE，共 10 文件。
禁止修改：需求/接口语义、非本任务 Readiness 行、运行配置及架构边界。

执行：

1. 在完整检查前先向 public-files.json.files 精确登记上述五个新增代码路径，每条只出现一次；该白名单负责允许 Git 跟踪，不等于 npm 发布范围。不得增加根 package.json.files。然后运行下列固定完整集合；首次任何失败 STOP，按原范围修复再复验，不缩减检查。原 task.spec mock 只作 shared 页面回归，尤其 A 的 retry UI。
2. WEB-DESIGN 只补未知回执临时入口的实现职责和清除规则；无新接口/依赖/发布入口，不需改 README/部署/架构。public-files.json 只登记上述五路径，npm pack 检查确认根 package.json.files 未扩展，web 测试/fixture 不进入 npm 包。
3. Readiness 逐行更新 WEB-05-04、06-03、06-04，记录日期、实际代码提交基线、命令、逐项计数和明确 synthetic identity/Worker/storage、真实 HTTP/SQLite/Chromium 范围。外部模型/OpenShell/真实身份/S3 未验，不冒称生产验收。三项全部适用断言通过才已实现。父项仅在所有必需子项完成时更新，否则保持部分实现。
4. 删除 RUNBOOK，rg 检查不存在仅指向该文件的残留引用；本步单独提交。随后按 worker skill 完成单一 PR、当前 HEAD CI/Codex 门禁、普通 merge 和同步清理；远端实时策略必须回读。共享文档合前纳入新 main，仅复验受影响边界。

验证：

```bash
pnpm check
pnpm --filter @bento/web exec playwright test e2e/task.spec.ts
pnpm --filter @bento/web exec playwright test -c playwright.task-submission.config.ts
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/execution-service/task-submission.test.ts
npm pack --dry-run --json
git diff --check
rg -n 'RUNBOOK-TASK-SUBMISSION-RELIABILITY' docs README.md .agents
```

PASS：前六条退出 0；最后 rg 在删除并清残留后无匹配（退出 1）；无 skipped 丢包/活跃态子用例，逐场景证据可回读。文档 Markdown 相对链接以本文件送审时的 Python 链接检查同法核对；删除后只核对本步改动的文档链接。STOP：基线合流影响共享入口、门禁不通过或证据不足，不标完成/不合并。失败不回滚既有业务状态，fixture finally 清理自己的临时资源。

## 完成定义与验证矩阵

| 边界           | 必需断言/证据                                                                    |
| -------------- | -------------------------------------------------------------------------------- |
| 正常入口       | blank/snapshot 页面创建、页面发送各真实 202；可回读原 Task/Run                   |
| 响应丢失       | route.fetch 真受理后 abort；第二次同 key/body 为 200 同记录                      |
| 冻结           | snapshot digest/manifest/环境不变，prepare=1；源读不重复                         |
| 执行次数       | 每 Task 指定 Run execute=1；Run/user_message/creation receipt 唯一               |
| 冲突           | 同键异正文 409，前后计数与原记录不变                                             |
| 活跃门禁       | 五 Run 态、四 retry 预留态逐项拒新键，无半提交；原键重放允许                     |
| 持久化         | Store 及无活跃执行的服务同库重开找回原 receipt；sessionStorage reload 保留未知键 |
| 授权           | 不同账号不复用客户端键，不读原 Task/Run                                          |
| UI             | 原正文重试；新要求禁用；网络/5xx 保留、成功/4xx 清临时入口；等待/取消可见        |
| 相邻边界       | task.spec 全部通过，retry/cancel/结果行为不改                                    |
| Not Applicable | 外部执行、恢复/结案实施、迁移、双写、新 outbox/Archive：本任务均无新行为         |

草稿验收不等于产品已完成。实际验证事实只迁移至 Readiness/稳定设计；临时 RUNBOOK 必须最终删除。
