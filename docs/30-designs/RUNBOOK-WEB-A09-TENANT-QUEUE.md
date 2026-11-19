# WEB-A09：租户队列与上传隔离

## 状态与执行者契约

- 状态：Draft，待 MASTER 审核；2026-11-19。当前只允许调查、起草和修订，不允许实施、建分支或提交。
- checkout：`/Volumes/storage/workspace/bento-b`；起草基线 `abfc8506d57ccbc6fdbdcad2cedbc5f81b04269d`，main 与 origin/main 一致。
- 待审核通过后分支：`codex/web-a09-tenant-queue`。MASTER 确认 Executable 后单独提交本文件，再收到显式 `$bento-runbook-worker RUNBOOK-WEB-A09-TENANT-QUEUE.md` 才实施。
- 每步 PASS 后删除该步说明、更新剩余前置事实并提交该步产物和 RUNBOOK；最后一步迁移证据并删除本文件。不得 amend/rebase/squash，不推送 main。
- 每步列出的文件包括专门核对文件和本 RUNBOOK，最多 10 个。指定入口不存在、契约冲突、必需断言失败、需改范围外生产逻辑时 STOP，保留现场；报告最后 PASS/提交、命令、脱敏输出和所需决定，交作者修订。不得降低断言或以 skip 代替 PASS。
- 全流程授权继承 MASTER：一个 PR、Ready、显式 `$bento-codex-comment-fix`、当前 HEAD 必需 CI 和明确 Codex 结论后普通 merge、同步及清理本任务分支/fixture。此授权不覆盖当前起草阶段的实施。

## 目标、当前断点与正式依据

只关闭 [WEB-06-05 / WEB-A09](../10-requirements/WEB-REQUIREMENTS.md)：三个独立已认证账号的同部署真实 HTTP 请求，A 排队满明确拒绝且无半写，B/C 仍受理；100 MB 物理 multipart 上传在途不占执行槽；空间额度不足与任务队列满在 API 和页面可区分。

追踪链：

| 正式依据                                                              | 契约与设计                                                                                                                   | 生产入口                                                                                                                          | 新验收与长期证据                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| WEB-06-05、WEB-A09；Business Rules 排队上限由部署配置、空间与队列独立 | [Web Interface](../20-interfaces/WEB-INTERFACE.md) Task 生命周期、Error Mapping；[Web Design](WEB-DESIGN.md) Task 与上传规格 | `Store.enqueueTaskRun` → `enqueueRun` → `hasQueueCapacity`；`handleTasks`；`httpBackend`；`taskEntryServer`；`TaskDetailsContent` | `web-queue-isolation.spec.ts` 三账号场景；Readiness WEB-06-05 |
| WEB-A09 上传阶段不占执行槽、区分额度                                  | 同接口“我的空间”、设计“上传规格”，上传/查询/预览/下载独立于 Run 队列                                                         | `mySpace` 上传事务；`transferFile`；`serveExecution` 的 slots/work；`Store.dispatchSnapshot/start`                                | 同 spec 上传阶段场景；Readiness 专项证据                      |

正式语义：需求用“排队上限”，不把已运行 Run 当作排队项；接口另规定 preparing/workspace_restored/history_restored/blocked 重试预留占一份队列容量，queued/closed receipt 自身不占。当前 `hasQueueCapacity` 按 owner 统计 queued Run 加上述重试预留；运行/恢复/取消中的 Run 消耗执行槽而不计入 queued 数。已被预留派发但仍 queued 的 Run 仍计排队容量，同时在 dispatchSnapshot 占执行槽。此任务保留这些语义，不制造新 retry 或恢复场景。

当前证据：Readiness 仅有 `6e3515f` 双槽/公平/429，缺三账号真实队列对照。现有 `upstreamError(429)` 已给固定中文队列提示，`mySpace` 给 `409 space_quota` 和空间文案，页面透传 ApiError；没有已证实的生产缺陷。本计划只增加验收及 CI，不改生产代码。发现缺陷须 STOP 由作者固定最小修复后复审。

已有适用证据可复用：`task-submission.test.ts` 对满额重试预留、原子性和 reopen 有 13 项；Go `TestTemporalFairDispatchThroughExecutionEntry` 构造测试可执行文件，经 BENTO_TEST_FAIR_BINARY 启用现有 TS 双槽测试，不能因普通 TS suite skip 推断其未测。新 fixture 为单槽非 Temporal，邻接双槽回归不等于真实外部生产池化。

## Scope、Non-goals 与不变量

新增独立 queue fixture、物理 multipart fixture、Chromium spec/config、专用命令和 CI 接线；迁移实际结果到 Readiness。独立存储 fixture 借鉴既有实现，但不修改 submission/space-integrity fixtures。

禁止修改 `service.ts`、`service.test.ts`、Store 调度算法、retryReason/advanceTaskRetry、OpenShell/checkpoint、taskMutation/retry/cancel 页面逻辑；不使用 Docker、真实 IdP/S3/模型或 A12 外部环境；不操作 A 的资源。端口固定 4363 API、4364 Vite；内部执行 HTTP 与物理对象 HTTP 绑定回环随机端口。不终止已有服务，硬冲突 STOP 报告。

不标记 A6-04 完成，不改 A 负责的 Readiness 行；WEB-06 其他必需子项未实现时父行保持部分实现。无数据库迁移、新运行协议、依赖、角色、生产配置或根 npm files 扩大。

不变量：owner 来自真实 sessionAuth cookie；不伪造 X-owner 绕过 Web API；Task/Run 只能经正常 HTTP 创建，不 SQL seed；业务数据库观察连接只读。文件存储真实落盘，签名能力与账号身份种子合成；host 执行由受控 gate 与 production localHost 完成。worker 活跃数来源于实际 worker 调用进入/退出，同时核对 SQLite，不能只检查 HTTP 429。

## 文件范围与有效 LOC

以下是交付或验收必须核对的既有代码，基线行段去重，排除空行和纯注释，不计新增估算。计数合计 **877 LOC / 9 个代码文件**；同一行仅计一次。

| 文件                                             | 必核对符号及基线行段                                                                                                                  | 有效 LOC |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------: |
| `apps/orchestrator/execution-service/store.ts`   | enqueueTaskRun 899–941；hasQueueCapacity 1862–1872；enqueueRun 1937–2012；dispatchSnapshot/reserveDispatch 2184–2250；start 2284–2297 |      206 |
| `apps/orchestrator/execution-service/service.ts` | Options/serveExecution 47–88；work 调度入口 1480–1530                                                                                 |       84 |
| `apps/orchestrator/execution-service/http.ts`    | handleTasks 的 Run 接收/读回 310–355                                                                                                  |       46 |
| `apps/workspace/api/execution-service-http.ts`   | route/upstreamError 1–79；forwardTask 134–220                                                                                         |      163 |
| `apps/workspace/api/server.ts`                   | taskEntryServer 168–205；Task 转发和错误出口 395–454                                                                                  |       98 |
| `apps/workspace/api/space.ts`                    | 上传冲突、额度预占、写入 514–590                                                                                                      |       77 |
| `apps/workspace/web/src/pages.tsx`               | TaskDetailsContent sending 1171–1192；可发送条件 1240–1265；错误展示 1359–1365                                                        |       55 |
| `apps/workspace/web/src/space-api.ts`            | transferFile 195–275                                                                                                                  |       79 |
| `apps/orchestrator/temporal_fair_entry_test.go`  | TestTemporalFairDispatchThroughExecutionEntry 16–103                                                                                  |       69 |

新代码唯一允许路径：

1. `apps/workspace/web/acceptance/queue-storage-fixture.ts`
2. `apps/workspace/web/acceptance/queue-isolation-fixture.ts`
3. `apps/workspace/web/acceptance/web-queue-isolation.spec.ts`
4. `apps/workspace/web/playwright.web-queue-isolation.config.ts`

既有修改白名单：`apps/workspace/web/package.json`、`.github/workflows/checks.yml`、`public-files.json`、`docs/40-readiness/CURRENT-READINESS.md` 和本 RUNBOOK。不新增其他文件或依赖。

## 数据、调用链及精确测试接口

生产结构均不变。Task 由 POST `/api/tasks` 输入 `{name:string,source:{kind:"blank"}}`，Idempotency-Key 为客户端 randomUUID；202 `{task}`，同键重放200。Task ID/Run ID由 Orchestrator 生成。准备到 ready 后 POST `/api/tasks/{taskId}/runs` 输入 `{prompt:string}` 加新 key，202 `{run}`；满额429 `{error:{code:"tenant_queue_full",message:"当前账号的任务队列已满。等一个排队任务开始后再提交。"}}`。外层 key 由浏览器 api.ts 管理，测试捕获实际请求以便重放，不替换生产键生成。Run 归原 Task，user_message 与 Run 同事务；拒绝不新增 Run、task_events、retry_attempts、task_creation_receipts 或 worker 进入。已有 Task 不因发送失败被删。owner、时间、generation 和事件序号均由既有服务生成，不由测试伪造。

上传：POST `/api/space/projects` `{id:UUID,name:string}`；POST `/api/space/projects/{id}/uploads` `{id:UUID,path:string,size:integer,checksums:string[]}`；GET upload；POST part `{number:integer}`；浏览器真实 PUT signed URL；POST complete `{}`。100_000_000字节六块（partSize=16_777_216），checksums 为各块 SHA256/Base64。上传元数据由 mySpace 的 space.sqlite 原子预占，saved/reserved 不能改变业务执行表；对象由 fixture 持有，落在独立临时目录。超额409 `{error:{code:"space_quota",message:"账号空间不足，已保存和上传预占合计最多 200 MB。"}}`，拒绝不新增上传记录、不签名、不 PUT。页面预检既有文案为“账号可用额度不足。”，不要求绕过预检触发页面 API 报错。

新增测试接口（字段全部 required；无可选配置、无生产导出）：

```ts
// queue-storage-fixture.ts
export async function startQueueStorageFixture(
    directory: string,
    origin: string,
): Promise<{
    storage: ReturnType<typeof spaceStorage>;
    waitHeldPart(): Promise<{ key: string; number: number; bytes: number }>;
    releaseParts(): void;
    observe(): {
        inFlight: number;
        createdUploads: number;
        signedParts: number;
        partsWritten: number;
        objectsWritten: number;
        bytesWritten: number;
    };
    close(): Promise<void>;
}>;
// queue-isolation-fixture.ts
export async function startQueueIsolationFixture(): Promise<{
    accounts: readonly { account: string; invite: string; ownerId: string }[];
    storage: Awaited<ReturnType<typeof startQueueStorageFixture>>;
    releaseRun(runId: string): void;
    releaseAll(): void;
    observe(): Promise<{
        activeWorkers: number;
        peakWorkers: number;
        enteredRuns: string[];
        occupied: { owner: string; status: string }[];
        queued: { id: string; owner: string }[];
        owners: Record<
            string,
            {
                tasks: number;
                runs: number;
                events: number;
                creationReceipts: number;
                retryAttempts: number;
                queued: number;
            }
        >;
    }>;
    close(): Promise<void>;
}>;
```

storage 采用 production `spaceStorage` 返回对象的方法形状，以新独立 HTTP server 覆盖 create/signPart/parts/complete/empty/abort/size/read/remove/download/preview，真实读写临时文件。签名 token 由 randomUUID 分配，Map 绑定 key/upload/part/size/checksum/expiry，固定最长600秒；校验 Origin/CORS、Content-Length、checksum header 和实际摘要，非法403。完整读取第一个大文件 part1 的真实 PUT 字节后、写文件/回包前持有 gate，记录 inFlight；其他块正常落盘，waitHeldPart 只在该位置 resolve。releaseParts 幂等并放行之后所有块；parts 回读磁盘摘要，complete 按编号核对并合并，size/read/download 回实际字节。无故障注入、泛化配置或秘密。create 返回 uploadId string；signPart 返回真实 HTTP PUT URL；parts 返回 `{PartNumber:number,ETag:string,Size:number,ChecksumSHA256:string}[]`（unknown upload 返回 null）；complete 输入的完成清单逐项核对 PartNumber/ETag/ChecksumSHA256 后按序合并并清理 multipart；size 返回实际字节数或 null；read 核对期望 size 后返回 Buffer；empty 写零字节文件；abort 清理指定 multipart；remove 删除指定对象；download/preview 返回绑定对象和300秒有效 token 的真实 GET URL。GET 回实际对象字节或404；PUT OPTIONS 的 CORS 仅允许固定 origin、PUT/GET/OPTIONS 与 content-length/x-amz-checksum-sha256/content-type，返回允许浏览器实际传输的响应，不拦截浏览器请求。close 放行 gate、关闭 server/连接并等待 handlers；目录统一由上层移除。

queue fixture：新 mkdtemp；demoAccounts 三身份（demo/guest/registration-demo）→mockAccounts→sessionAuth，invite 均 demo-invite；这是合成受邀账号但走真实注册、密码验证、cookie。localHost 为基底，唯一覆盖 worker：execute 时按 grant.run 注册 gate 并增加活跃计数，释放后调用 base.worker 原请求（测试 prompt 固定 noop）；finally 减计数；其他 mode 原样委托。不覆盖 provisionTask/recovery。serveExecution 固定 tenantQueueLimit=2、单槽默认 workerSlots、retryMs=20、workerTimeoutMs=120000；httpBackend→mySpace→taskEntryServer。清理唯一所有者与截止时间固定如下，成功、异常及部分启动均使用同一个幂等 close Promise。不得杀进程、删除未知目录。

1. 初始化状态持有 storage/execution/space/api 各自“已返回资源”引用，以及 `spaceOwner: "fixture" | "api"`。storage 工厂在自身启动失败时关闭自身已建 HTTP listener；serveExecution 在自身启动失败时已有内部 close，未返回对象不由 fixture 再关闭。mySpace 返回后暂由 fixture 持有。
2. **调用 taskEntryServer 之前**将 spaceOwner 从 fixture 转为 api：该函数成功返回后由 `api.close()` 关闭 mySpace；该函数启动抛错时，其内部 catch 同样执行 close 并关闭 mySpace，fixture 不再直接关闭。只有尚未调用 taskEntryServer、space 已成功创建的部分启动失败，才由 fixture 直接 `space.close()`。这覆盖“没有 api 返回值但已交给 API 启动”的失败分支，避免重复关闭。
3. close 首先设置永久 `releasedAll=true`，释放当前所有 worker gate，并调用 storage.releaseParts；之后新进入的 worker/PUT 检查永久标志直接放行，不能重新建立阻塞 gate。若 execution 已建立，通过只读账本轮询全部受理 Run 为 succeeded/failed/cancelled 且 activeWorkers=0、occupied=0、queued=0，硬截止30秒。正常验收仍另断言全部 succeeded，清理允许失败终态只用于释放资源，不能替代测试通过。
4. drain 成功后按顺序：api 已返回则仅 await api.close()；api 未调用且 space 存在则仅 await space.close()；api 启动失败已内部清理则两者均不再调用。随后 await execution.close()、storage.close()。每个关闭步骤硬截止10秒，使用可取消计时器并在完成后清除；不吞掉异常或把 timeout resolve 为成功。此前 drain 失败也继续尝试同序关闭已拥有资源，聚合全部错误。storage.close 放行全部 gate、停止接收、关闭连接并等 handler 完成后才算完成。
5. 只有所有已创建资源都确认关闭后才 rm 自有临时目录，并 assert stat 返回 ENOENT；仍有 drain/close 错误则清理完成后依然抛 AggregateError，让测试失败。任一关闭超时/未确认时保留自有目录，不删除仍可能访问的文件，抛错并 STOP 报告资源名/截止阶段及目录位置，不宣布清理完成。spec 的 afterEach 必须 await close 并传播其失败；不能只打印错误。

observe 使用 business.sqlite 的只读事务：runs→projects.owner，tasks.owner，task_events→tasks，task_creation_receipts.owner，retry_attempts→tasks；queued 精确 status='queued'；occupied 使用与 Store.dispatchSnapshot 相同查询（running/recovering/cancelling 或 queued 且存在 run_dispatches）。worker计数来自实际调用 Map，enteredRuns 保留进入历史；无凭据输出。所有等待使用 expect.poll 或有截止时间 Promise，默认10秒，上传完成30秒；不用裸 sleep 推断状态。

Not Applicable：不新增业务 DTO/schema/event/outbox/archive/restart 机制；已有 reopen 与 retry 容量原子性由固定邻接回归覆盖。无真实外部服务验证，此任务正式 WEB-A09 未指定真实模型/OpenShell（WEB-A08/A10另有该要求）；报告须写明替代边界。

## T0：基线、正式口径与资源门禁（作者完成，执行前复核）

前置状态：起草阶段，无实施授权。允许修改：仅本 RUNBOOK。专门核对：Go fair test、service.test.ts 中 two-slot case、task-submission.test.ts、两个 package.json（根与orchestrator）；合计6文件。禁止修改任何代码或配置。

执行：核对 checkout、干净 main、HEAD/origin/main；检查 ENVIRONMENTS.md 存在性；无该文件且仅用回环合成fixture，不依赖秘密。核对端口，运行下列既有门禁。

```bash
git status --short --branch
git rev-parse HEAD origin/main
node -e "const n=require('node:net'); (async()=>{for(const port of [4363,4364]) await new Promise((ok,fail)=>{const s=n.createServer();s.once('error',fail);s.listen(port,'127.0.0.1',()=>s.close(ok))})})().catch(e=>{console.error(e.code);process.exitCode=1})"
(cd apps/orchestrator && go test -run '^TestTemporalFairDispatchThroughExecutionEntry$' -count=1 -v .)
(cd apps/orchestrator && node --import ../../register-paths.mjs --experimental-strip-types --test execution-service/task-submission.test.ts)
```

作者实测：main/origin/main 均 abfc850；工作树干净；ENVIRONMENTS.md不存在；4363/4364无监听；Go fair test PASS（实际执行3.702s）；submission 13 PASS / 0 skip。送审前回环 bind 检查4363/4364均PASS。

PASS：基线一致；端口可绑定；Go 指定测试实际 PASS；13项均通过且无 skip。执行启动前基线受 A 合入影响时由 MASTER 复审受影响步骤，不擅自换基线。STOP：任一不满足、未知改动、硬端口冲突、正式契约冲突。无外部副作用，无回滚。T0 不产生 commit。

## 已通过的执行前置事实

T1 已完成：两个独立fixture已落地；web typecheck、两个fixture eslint、计划空状态启动/close smoke和关闭后4363/4364 bind检查均PASS。观察3个distinct账号/owner与0 Task/Run/worker/队列；close内确认目录ENOENT。没有生产代码变更。对应提交为包含本记录的 `Test(task-entry): 建立租户队列独立验收宿主`，从该提交进入T2。

## T2：三账号队列和上传在途完整验收

前置状态：上述T1能力提交可回读且fixture可启动关闭。允许修改：新spec、新config、本 RUNBOOK；专门核对两个新fixture、pages.tsx、space-api.ts、web/src/space.tsx（合计8文件）。禁止页面retry/cancel变更与生产修复。

执行：新 config 唯一内容为以下配置（导入 `defineConfig, devices` 自 `@playwright/test`）：

```ts
export default defineConfig({
    testDir: './acceptance',
    testMatch: '**/web-queue-isolation.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 120000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        baseURL: 'http://127.0.0.1:4364',
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
    webServer: {
        command: 'pnpm dev --host 127.0.0.1 --port 4364 --strictPort',
        url: 'http://127.0.0.1:4364',
        env: { BENTO_API_TARGET: 'http://127.0.0.1:4363' },
        reuseExistingServer: false,
    },
});
```

spec 只设一个完整有序测试 `WEB-A09: three authenticated tenants isolate queue capacity from physical multipart uploads`，beforeEach 启动 fixture，afterEach 始终 await close 并传播异常。创建三个 browser.newContext/page，依次为 A=demo、B=guest、C=registration-demo 注册登录；每个账号严格执行：`password=randomUUID()` 仅存在测试内存（36字符，符合15–128字符且不同于邀请码）；goto('/login') → 点击 link“使用邀请码注册” → 定位包含 heading“受邀注册”的 form → 依次填 label“账号”=该 account、“邀请码”=demo-invite、“新密码”=password → 点击该 form 中 exact button“注册” → 等 URL `/login(?:\?|$)` → 填 label“账号”与 exact label“密码”=同一 password → 点击 exact button“登录” → 等 label“任务名称”可见。三次顺序完成，不并行触发密码哈希限流；不打印密码/邀请码/hash/cookie。注册所用 fixture account/owner 映射只从 accounts 返回值取，不重新分配身份。不得 route mock 业务响应。请求上下文复用各自 cookie；API mutation 的 Origin 字面为 `http://127.0.0.1:4364`。

T2 STOP/作者修订依据：2026-11-19 Chromium实际返回 `Cannot set buffer larger than 50Mb, please write it to a file and pass its path instead.`；原Buffer直接选择100MB不可执行。仅将选件方式改为先写真实100MB临时文件后传路径，保持六分块、字节数、HTTP/worker/SQLite/额度与下载摘要全部断言，待MASTER复审后继续。

固定顺序与必须断言：

1. 六个空白Task A0/A1/A2/A3/B0/C0 均从页面创建并等ready；账户列表互不可见，B/C GET A Task为404。此时Task/creationReceipts各为A4/B1/C1，Runs/events/retryAttempts为0，worker/occupied均0。
2. A空间页面新建项目并选择真实100_000_000字节文件，测试先 mkdtemp 创建自有选择目录，将 big Buffer 的100_000_000字节写入 big.bin，再 setInputFiles(绝对文件路径)，不伪造元数据；该选择目录在spec finally关闭contexts后rm并assert ENOENT（失败也清理），fixture存储目录所有权不变；点击正常上传，等待storage.waitHeldPart。断言part1字节16_777_216、inFlight≥1、上传状态非saved、reserved100_000_000、saved0；业务表计数和occupied0/worker0与上传前一致。实际partsWritten可含其他并行块，不把“未回包”视为没有上传。
3. 在同一A会话HTTP开始第二个100_000_000字节上传（同大小摘要列表，独立路径/id），只预占不PUT。reserved恰200_000_000；再开始独立1字节上传返回409 space_quota及固定文案，上传总数与reserved不增，存储调用不增，执行观察不变。A第二page刷新空间，选择1字节显示“账号可用额度不足。”，不触发上传POST；原上传page保持在途。
4. 仍持有上传gate：A0页面发送noop，等实际worker进入且Store running，activeWorkers=occupied.length=1；A1/A2分别发送得到202且queued，A排队数2、总Run3，证明running未占排队名额。保存A1实际Idempotency-Key/body/receipt。捕获A3实际key/body；A3发送收到429 tenant_queue_full及固定队列文案；页面提示可见且与空间提示不等。比较拒绝前后同一owner业务表、enteredRuns完全不变，无Run/event/retryAttempt/receipt半写，A3 Task仍可读。任务要求文本保留、按钮恢复可操作。
5. A满额时B0/C0各自页面发送，均202且各queued1，A queued仍2；未执行B/C并非拒收。各列表与SQLite owner一致，三个会话看到自己的Run且读别人的Run为404；worker仍只有A0，peak1。使用A1原key/body经A会话HTTP重放，返回200相同Run，所有计数不增。上传仍inFlight，reserved不变；此前每次上传观察不能让worker计数单独增长。
6. 释放A0；等A1实际进入running（先提交先运行，B/C为后提交），A排队降1，固定用A3先前被拒绝的原key/body经A HTTP重试得到202，A排队恢复2，再刷新A3页面看到原Run；不要点击发送生成第二条Run。新Run只1个user_message与1次执行；之后原key重放200，异prompt同key409 idempotency_conflict无新增。所有请求均在原owner会话下。
7. 执行worker gate保持不动，记录执行snapshot，releaseParts等待第一文件saved，下载100MB核对SHA256；完成前后执行snapshot逐字段相同（enteredRuns/active/occupied/queued/owners），saved100_000_000、reserved100_000_000（第二上传）。取消第二上传经API等待清理后reserved0，执行snapshot仍相同。原失败1字节上传ID可重新开始并完成，saved100_000_001，不产生Task/Run，显示额度恢复。上传调用本身不能改变执行槽。
8. releaseAll，全部已受理Run最终succeeded；每Run entered恰一次，activeWorkers/occupied/queued均0、peak1、A3无额外Run、retryAttempts全0。console只输出脱敏owner别名A/B/C、阶段计数、HTTP状态/错误码及文件字节/摘要；不输出cookie/token/原始认证数据。关闭所有context，afterEach关闭fixture。失败也执行finally清理。

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web exec playwright test --config playwright.web-queue-isolation.config.ts
```

PASS：指定测试1 passed /0 skipped；上述阶段独立expect断言均成立，端口与临时文件清理。STOP：任何必要断言缺失、超时或失败；不得只保留429、缩小文件、合并身份或mock响应。恢复：保留代码，fixture清理后从完整场景重跑。提交 `Test(task-entry): 验证三账号队列和上传槽位隔离`。

## T3：专用验收纳入CI与公开边界

前置状态：T2完整场景通过。允许修改：web/package.json、checks.yml、public-files.json、本RUNBOOK；专门核对新config/spec/两个fixture（合计8文件）。禁止根package.json files与依赖/锁文件变化。

执行：web scripts新增 `test:queue-isolation` = `playwright test --config playwright.web-queue-isolation.config.ts`。现有 Web Chromium E2E job 在 test:space-integrity 后新增独立 run `pnpm --filter @bento/web test:queue-isolation`；沿用已有受影响路径选择和Chromium安装，不改job名/保护规则。public-files.json精确登记4个新文件（两个fixture、spec、config）；本临时RUNBOOK不属于产品公开文件，不登记，最终无RUNBOOK公开条目。不得添加目录通配。

```bash
pnpm --filter @bento/web test:queue-isolation
pnpm format:check
npm pack --dry-run --json > /tmp/bento-b-web-a09-pack.json
git diff --check
```

PASS：场景完整通过；格式/diff退出0；新文件均在公开精确白名单，npm files不变且包清单无fixture/临时状态/凭据。STOP：workflow遗漏、未触发检查被算成功、打包扩大或未知产物。测试副作用按fixture finally清理；不删除用户临时文件。提交 `CI(ci): 纳入租户队列独立验收`。

## T4：完整验证、证据迁移与RUNBOOK删除

前置状态：T3提交；前面代码版本可回读；MASTER确认与A的合入顺序。允许修改：Readiness、本RUNBOOK、public-files.json（仅清除本RUNBOOK条目）；专门核对spec、checks.yml（合计5文件）。禁止修改其他Readiness场景、A6-04或A负责行。

```bash
pnpm check
pnpm --filter @bento/web test:queue-isolation
(cd apps/orchestrator && go test -run '^TestTemporalFairDispatchThroughExecutionEntry$' -count=1 -v .)
npm pack --dry-run --json > /tmp/bento-b-web-a09-pack.json
git diff --check
```

执行：记录每条实际结果及HEAD；pnpm check含Go全套与普通TS suite，不用其中skip否定专门fair测试，也不能将skip当新增通过。Readiness仅WEB-06-05改已实现，追加“WEB-A09 租户队列与上传隔离验证”证据：日期、实现提交/测试提交、单槽本地生产HTTP/SQLite/auth/物理multipart+受控host、三独立账号各状态、A拒绝原子性、B/C受理、100MB在途0槽与执行期间不增槽、额度两类提示、成功下载摘要、既有双槽Go邻接PASS。Not Covered明确真实IdP/S3/模型/OpenShell、生产双槽池化、A6-04其他资源限制；父WEB-06仍部分实现。

按以下方式检查Markdown相对文件链接（锚点另人工核对正式标题），然后迁移完成删除RUNBOOK并清除其仅引用，git diff --check。证据不能仅留临时文件。提交 `Docs(task-entry): 收口租户队列与上传隔离证据`。

```bash
python3 - <<'PY'
import re
from pathlib import Path
p=Path('docs/30-designs/RUNBOOK-WEB-A09-TENANT-QUEUE.md')
for href in re.findall(r'\]\(([^)]+)\)',p.read_text()):
    target=href.split('#')[0]
    if target and '://' not in target:
        assert (p.parent/target).exists(),href
print('RUNBOOK relative file links PASS')
PY
```

PASS：所有固定验证退出0且必需场景实际执行；Readiness证据可独立复现；RUNBOOK已删除。STOP：任何未过门禁、受影响的新主线尚未复验、scope子项未覆盖；保留本步，不标完成，不扩大修复。

## PR交付与收尾

按[PR规则](../00-governance/PR-RULES.md)与[Bento Worker](../../.agents/skills/bento-runbook-worker/SKILL.md)交付一个PR；描述使用模板、只写可审阅行为/实际验证和限制。显式调用 `$bento-codex-comment-fix` 处理本PR意见，当前HEAD明确Codex结论及所有实时必需CI通过后普通merge。目标main有A变更时普通merge最新main，复验受影响边界与queue场景，保留A证据，禁止历史改写。合并回读后快进main、确认tip已纳入、清理本任务分支与fixture，向MASTER回报PR/merge SHA/同步基线/CI/Codex/Readiness与剩余限制。任一门禁缺失保持待审，不能以CI绿色代替Codex或执行验收。
