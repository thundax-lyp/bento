# RUNBOOK · WEB-A03 空间额度边界

状态：2026-11-13 草稿，待 MASTER 独立审查。起点：`thundax-lyp/bento` 的 `main`，`20714e6ea58b08c003bfb685a29b239fcb40dab7`（已合入 #31 和 #32，逐文件进度的 Readiness 证据已在基线中）。未来任务分支：`codex/web-a03-quota-boundaries`。当前只准调查和起草；收到审查通过及 MASTER 开工指令后才进入 T0。该路径受 `.gitignore` 约束，审查通过并获开工指令后才在任务分支用 `git add -f -- docs/30-designs/RUNBOOK-WEB-A03-QUOTA-BOUNDARIES.md` 单独暂存，并用 `git rev-parse :docs/30-designs/RUNBOOK-WEB-A03-QUOTA-BOUNDARIES.md` 核对审核 blob；草稿阶段不暂存。按顺序执行，每步命令退出 0 且逐项断言成立才 PASS；否则 STOP，报告最后 PASS、当前 HEAD、文件与 symbol、命令、脱敏实际值和所需决定。保留现场；不得放宽断言或修改产品来让测试通过。

## 目标、断点与范围

[WEB-02、WEB-03、WEB-A03](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期) → [空间 HTTP 契约](../20-interfaces/WEB-INTERFACE.md#现有接口) → [空间设计](WEB-DESIGN.md#状态与额度) → `apps/workspace/api/server.ts::taskEntryServer` → `apps/workspace/api/space.ts::mySpace` → `apps/workspace/api/space-files.test.ts` → `pnpm check` → [Readiness](../40-readiness/CURRENT-READINESS.md)。[WEB-A03 验收表](../10-requirements/WEB-REQUIREMENTS.md#验收标准)。WEB-02 的 4 GB 为 4,000,000,000 字节，WEB-03 的 10 GB 为 10,000,000,000 字节。

#31 的 `openUploadRecoveryFixture` 用约 16 MiB 的实际 Buffer 验证 WEB-A04 的补传和对账；它固定一个账号和对象。Readiness 已记录上传恢复及删除证据，尚无经 HTTP 的 4/4/2 GB 额度上限证据。任务跨 HTTP、SQLite 写事务、存储生命周期与共享 Readiness，不能用单点断言安全关闭。本次只补五个验收测试和证据。真实大文件传输、真实 S3/CORS、浏览器断网、进程重启/强杀、多实例写入、执行门禁及项目/账号级清理均不在本轮；现有恢复与执行门禁回归保持原样。无新依赖、事件、版本、request hash、迁移、持久化格式或 API 变更。

## 固定契约与观测

- 请求用同源 Origin 和 `sessionAuth(mockAccounts(...), false)` 签发的 Cookie；owner 从服务端 session 取。项目由 `POST /api/space/projects {id,name}` 创建，返回 `200 {id}`。项目、上传 ID 均用每例新 `randomUUID()`；同一请求重放复用原 ID 和整个 JSON；无 `Idempotency-Key`。只变更 path 的同 ID 请求返回 `409 space_conflict`，不新增记录。
- 以下 `start(P,X)` 指向 `POST /api/space/projects/${P}/uploads`，body 必须为 `{id,path,size,checksums}`（必填，分别为 string、string、整数 number、string[]）。`part(X,n)` 为 `POST /api/space/uploads/${id}/part {number:n}`，返回 `200 {url,checksum}`；`complete(X)` / `cancel(X)` 是相同前缀下 `POST /complete` / `POST /cancel`，body `{}`。上传响应为 `200 {id,project,path,size,state,expires}`（只有 size、expires 为 number）；查询 `GET /api/space/uploads/${id}` 额外返回 `parts:number[]`。文件 ID 等于上传 ID。删除用 `DELETE /api/space/files/${id}`（无 body），响应 `202 {state:"deleting"}` 或 `204` 无 body。下载用 `GET /api/space/files/${id}/download`（不跟随 302）。错误断言仅 HTTP status 和 JSON `error.code`。
- `mySpace.reserve` 在 `BEGIN IMMEDIATE` 内查归属、同 ID、路径和同账号有效用量，插入 `preparing` 或回滚。超单文件限制为 `413 file_limit`；合计超限为 `409 space_quota`；越权为 `404 not_found`。`prepare` 调用 `abort(key,undefined)` 清理可能的孤儿，再 `create(key)` 并写入 `uploading`。`finish` 用 `parts` 检查摘要、长度和 ETag 后合并，HEAD 同大小才写 `saved`；重放已保存的完成不再调存储。
- 账本 `space_uploads`：`id/project/owner/path/manifest/state` 为非空 TEXT（manifest 是请求 checksums 的 JSON 字符串）；`size/expires/signedUntil` 为非空 INTEGER，`signedUntil` 初始 0；`storageId/cleanup` 可空 TEXT。到期为 reserve 的 Date.now() + 86,400,000；签名后 `signedUntil` 为 Date.now() + 605,000（600 秒及 5 秒余量）。`clean` 写 `cleaning` 与 `cleanup=cancelled|expired`，等签名失效才 abort 并检查/清理对象，然后写该终态。每 30,000 ms 的 `sweep` 推进清理。单文件删除写 `deleting` 与 `space_file_deletions(fileId,operationId,executionProjectId,phase)`；此处未初始化执行项目，`executionProjectId=null`、`phase=deleting`，成功清理后 `deleted` 并移除 intent，保留同 owner 墓碑。
- `GET /api/space`：核对 `200`、`quota=10000000000,fileLimit=4000000000,partSize=16777216` 及本步明确的 `saved,reserved`。以独立只读 SQLite 查询逐 ID 核对 owner/project/path/size/manifest/state 和行数；同时按 owner 读全部记录，以 `saved,deleting` 计已保存，以 `preparing,uploading,completing,cleaning` 计预占，其余为零，两项分别等于 HTTP，且总和不超额度。拒绝的新 ID 必须无行、无存储调用；同 ID 重放不得额外占用或重复 create/complete。账号和数据库均从空状态开始。

## Fixture 固定方案（T1 实现）

只改 `apps/workspace/api/space-files.test.ts`。从 #31 的 `openUploadRecoveryFixture` 提取公共 `openSpaceHttpFixture(storage: ReturnType<typeof spaceStorage>, prefix: string)`，复用其 `taskEntryServer / mySpace / reopen / close / dispose`、临时库和 fetch 逻辑。返回 `{dbPath, request, renewSession, reopen, close, dispose}`；`request(path, method='GET', input?, signal?, actor:'a'|'b'='a')` 保持原响应形状，使用各自 Cookie；`renewSession(actor:'a'|'b'):void` 用同一 auth 的 startSession 更新该 actor 的 Cookie（初始化也调用此函数）；账号 B 为 `{ownerId:'owner-b',account:'b',inviteSha256:''}`。沿用 Origin `http://127.0.0.1:1` 作为同源校验字符串及假 SDK endpoint，实际 HTTP 用 `port:0` 和返回的 `web.origin`；不监听 1，不使用 4319/4320。保留 A04 的 Buffer、字节摘要验证、fault hooks、调用日志及测试名；不把 A04 改成元数据测试。共用现有 `assertUploadError`、`recoveryBarrier` 与 `recoveryClock`；增加 `advanceTo(now:number)` 调用 mock Date 的 setTime，保留旧 clock API。每例单独 fixture，非并行测试，timeout 20 秒；网络请求限 5 秒，屏障等待沿用 5 秒限制。关闭 server 及 SQLite 后在 finally 删除 mkdtemp；故障屏障须先在 finally release 并等待在途请求，避免关服挂起。

新增 `openQuotaFixture()`，基于公共 HTTP fixture，prefix `bento-upload-quota-`。固定两账号各一个项目（name 为 `Quota A`、`Quota B`）。声明 `type QuotaInput = {id:string;path:string;size:number;checksums:string[]}`；`quotaInput(path:string,size:number):QuotaInput` 对每个 1-based 分块 n 以 `createHash('sha256').update('quota-fixture:'+n).digest('base64')` 生成摘要。大小用常量字节，块数 4 GB 为 239、2 GB 为 120、1 B 为 1。Fixture 预先按对象键登记各测试声明（含预期被拒绝者）；登记不算存储副作用，不生成对象或分块。键为 `spaceObjectKey(id)`，multipart ID 为 `'fixture-'+id`。用一个按 key 索引的 Map 跟踪 active、parts、size(number|null) 和写次数；另有逐 key 调用日志。未登记的 key 或未预期的方法 fail；不发网络请求。覆写 `spaceStorage` 的 create、signPart、parts、complete、size、abort、remove、download；empty/read/preview fail。

- create 要求 inactive，置 active；signPart 必须匹配该 key、multipart ID、n、`min(16777216,size-(n-1)*16777216)`、声明摘要，返回 `https://fixture.invalid/${key}?partNumber=${n}`。仅对实际收到 200 的签名，用 `acceptQuotaPart(input:QuotaInput,n:number,url:string,checksum:string):void` 匹配签名后登记 `{PartNumber:n,Size:签名长度,ETag:'"part-'+n+'"',ChecksumSHA256:checksum}`；不分配大 Buffer。parts 在 active 时返回分块，否则 null。complete 核对所有编号按升序及 ETag/摘要，累加分块 Size 作为对象大小，清空分块并置 inactive，写次数加一。download 仅对已存在对象返回 `recoveryDownload`。
- abort 支持 `(key:string,upload?:string)=>Promise<void>`，remove 支持 `(key:string)=>Promise<void>` 前置 hook（初始 undefined）。记录调用后、改存储前 await 对应 hook，传原参数。abort 在有 ID 时核对 ID，再清分块、置 inactive；remove 将大小置 null。记录成功确认的 `abort-confirmed`、`remove-confirmed`；终态断言直接读取 fixture 的 inactive、parts.size=0、size=null，不能仅依据调用次数。生产 adapter 的 abort 会验证 ListParts、remove 会做 HEAD；这里模拟的是确认回执。
- 以 `recoveryClock(t)` 在建 fixture 前启用 Date/setInterval。阻塞存储时，用屏障 `waitForEntry`，只读取 HTTP 用量和 SQLite/fixture；放行后等待请求结束或推进 sweep。扫尾终态未到时，最多用 5 秒的真实 `delay(10)` 轮询只读 SQLite（以真实 monotonic `performance.now()` 为截止）；不使用被 mock 的 Date 做超时。不得 UPDATE SQLite、直接调内部 reserve/clean/sweep，或靠网络真实时间等待过期。

## 调查记录

初稿基线为 `b55171a`，Node v22.23.2、pnpm 12.15.0，聚焦 14/14 和 `pnpm check` 均通过。修订时，本地 HEAD、跟踪分支和远端 main 均为 `20714e6`。#32 未修改 Workspace API 及其测试文件，既有聚焦结果仍适用于相同测试版本；`pnpm check` 的初稿结果仅对应初稿基线。当前只形成一份草稿；T0 的审核版本、任务分支和提交门禁尚未执行。

## 执行步骤

### T0：核定开工边界

前置状态：MASTER 已交回同一版本独立审核通过；任务分支已从指定基线创建，唯一提交差异为本 RUNBOOK，工作树干净。
允许修改：0。专门核对本 RUNBOOK、`apps/workspace/api/{server.ts,space.ts,space-storage.ts,space-files.test.ts,file-delete-hold.test.ts,auth.ts}`、`docs/40-readiness/CURRENT-READINESS.md`、`package.json`、`.github/workflows/checks.yml`，共 10 个。
禁止修改：所有文件及其他 checkout。

执行：核对分支、远端、唯一 RUNBOOK 提交、Node 22、pnpm 12.15.0 和已安装锁定依赖。工作目录为派工绑定的 checkout 根。若目标分支已变化，交回 MASTER 核对新基线并复审受影响步骤。

验证：

```bash
git status --short --branch
git remote get-url origin
git rev-parse HEAD^ origin/main
git log -1 --format=%H
git ls-remote origin refs/heads/main
git diff --name-only 20714e6ea58b08c003bfb685a29b239fcb40dab7 HEAD
node -v
pnpm -v
git merge-base --is-ancestor 20714e6ea58b08c003bfb685a29b239fcb40dab7 HEAD
node --test apps/workspace/api/space-files.test.ts apps/workspace/api/file-delete-hold.test.ts
pnpm check
```

PASS：工作树干净，分支和基线如上，仅 RUNBOOK 差异，聚焦 14/14，统一检查全过。STOP：任一不符；缺工具或依赖报告实际失败，不自动安装或改锁文件。

### T1：精确上限、请求重放与账号隔离

前置状态：T0 PASS。允许修改：`apps/workspace/api/space-files.test.ts`（加本 RUNBOOK 共核对 2 个）。禁止修改：生产代码、锁文件、A04 的输入及断言。

执行：

1. 按上文提取 fixture 并新增唯一测试 `WEB-A03 exact limits and owner isolation`。A 按顺序准备 `a.bin:4000000000,b.bin:4000000000,c.bin:2000000000`；在空账号先尝试 `oversize.bin:4000000001`，断言 413。每个 start 为 200 uploading；逐文件、逐块通过 HTTP part 并登记元数据，再 complete。核对上传 DTO 与 SQLite，额度按以下 (saved,reserved) 逐项推进：`(0,4000000000) → (4000000000,0) → (4000000000,4000000000) → (8000000000,0) → (8000000000,2000000000) → (10000000000,0)`。检查各已保存文件出现在项目详情、对象大小准确、各仅一写。
2. 在 a 首次 start 后立即重放相同请求并比较整个 DTO，且变更 path 为 `different.bin` 重放得到 409 space_conflict。在满额后再重放 a 的原 start 与 complete，均返回同一 saved DTO，不触发存储调用。A 的 `one.bin:1` 新 ID 返回 409 space_quota，A 用量不变。
3. B 在 A 满额时自己的 `b-owner.bin:1` start 成功，B 用量 `(0,1)`，列表只有自己的项目和记录；A 仍为 `(10000000000,0)` 且无 B 的记录。B 对 A project 用新的 `foreign.bin:1` start、在 B 项目重放 A 的 a 原 start、GET A 的 a 上传、POST a 的 part(1)/complete/cancel、GET a 下载、DELETE a 文件，逐项均为 404 not_found，不改变两边账本或触发任何存储调用。

验证：

```bash
node --test --test-name-pattern='WEB-A03 exact|WEB-A04' apps/workspace/api/space-files.test.ts
pnpm --filter @bento/workspace-api typecheck
```

PASS：7 项实际执行并通过，及上述账本/存储断言。单步提交 `Test(task-entry): 验证空间精确额度和账号隔离`。STOP：任何差异；不修改 HTTP/存储行为。

### T2：并发预占

前置状态：T1 PASS。允许修改：`apps/workspace/api/space-files.test.ts`（含 RUNBOOK 共 2 个）。禁止修改：T1、A04 断言和生产代码。

执行：新增 `WEB-A03 concurrent reserves cannot oversubscribe`。A 用 `seed.bin:4000000000` start+part+complete 得 `(4000000000,0)`，再以 `pending.bin:2000000000` start 不签名得 `(4000000000,2000000000)`。创建 `race-a.bin`、`race-b.bin` 各 4 GB。对这两个 key 的首次 prepare abort 用同一个 `recoveryBarrier` 暂停（其他 key 不暂停）。同时发出两条 HTTP start，不先 await 单条；等屏障进入，再用 `Promise.race` 等其中第一条响应，必须是败者 409 space_quota，胜者此时仍卡在存储，SQLite state=preparing 且用量 `(4000000000,6000000000)`。败者无行无调用。finally 放行并用 `Promise.allSettled` 收尾；正常路径断言最终响应集合恰为一条 200 uploading、一条 409 space_quota（不指定获胜 ID），只有胜者 create 一次、用量不变。相同胜者请求重放得到同一 DTO；败者原请求重放仍 409。

验证：

```bash
node --test --test-name-pattern='WEB-A03 concurrent' apps/workspace/api/space-files.test.ts
```

PASS：1 项实际执行并通过。单步提交 `Test(task-entry): 验证并发上传原子预占`。STOP：先返回成功、两胜两败、超时、拒绝仍有行或上述断言失败；放行屏障并收尾，保留失败证据。

### T3：取消后复用额度

前置状态：T2 PASS。允许修改：`apps/workspace/api/space-files.test.ts`（含 RUNBOOK 共 2 个）。禁止修改：已验场景和生产代码。

执行：新增 `WEB-A03 cancelled quota releases after storage confirmation`。A 对 `fill1.bin:4000000000,fill2.bin:4000000000,fill3.bin:2000000000` 逐个 start，不完成；只给 fill3 的 part 1 签名并登记。用量 `(0,10000000000)`。cancel(fill3) 两次均返回 cleaning；查上传 GET 为 cleaning、parts=[]，SQLite cleanup=cancelled，fixture 仍 active 且有一块，无带 ID 的 abort。固定重试请求 `one.bin:1` 此时返回 409。安装只拦 fill3 的带 ID abort 的屏障，将 clock advanceTo(fill3.signedUntil+1) 后 sweep；屏障内仍 cleaning、满额、对象分块仍在，原 one 请求仍 409。放行并等 SQLite cancelled：确认 abort 一次、无分块/对象，GET 为 cancelled、parts=[]，用量 `(0,8000000000)`。cancel 重放同 DTO；原 one 原样 start 得 200 uploading 和 `(0,8000000001)`，再重放 DTO 相等且额度不增加。

验证：

```bash
node --test --test-name-pattern='WEB-A03 cancelled' apps/workspace/api/space-files.test.ts
```

PASS：1 项实际执行并通过。单步提交 `Test(task-entry): 验证取消清理后复用额度`。STOP：终态早于确认、存储未清、提前放行或其他断言失败。

### T4：过期后复用额度

前置状态：T3 PASS。允许修改：`apps/workspace/api/space-files.test.ts`（含 RUNBOOK 共 2 个）。禁止修改：已验场景和生产代码。

执行：新增 `WEB-A03 expired quota releases after storage confirmation`。在初始时刻先 start `expired.bin:2000000000`；advanceTo(该记录 expires-60000) 后先 `renewSession('a')`（账号会话自身也是 24 小时），再 start `fill1.bin:4000000000,fill2.bin:4000000000`，并给 expired 的 part 1 签名、登记。用量 `(0,10000000000)`。advanceTo(expired.expires) 并 sweep，GET 与 SQLite 为 cleaning（cleanup=expired），parts=[]；无带 ID abort，fixture 仍 active 且有一块，one.bin:1 start 409。part(expired,1) 返回 409 space_conflict；再以同一 expired start 请求读取 cleaning DTO。随后按 T3 的带 ID abort 屏障步骤用 expired 替代 fill3，保持两条 4 GB 上传未过期；屏障内 one 请求仍 409，终态改为 expired，确认存储和计数同 T3。重放 expired 的原 start 得相同 expired DTO 且无新存储调用；one 原请求及重放均返回同一 uploading DTO，用量 `(0,8000000001)`。

验证：

```bash
node --test --test-name-pattern='WEB-A03 expired' apps/workspace/api/space-files.test.ts
```

PASS：1 项实际执行并通过。单步提交 `Test(task-entry): 验证过期清理后复用额度`。STOP：过期时间、状态、签名/额度门禁或确认断言不符。

### T5：删除后复用额度

前置状态：T4 PASS。允许修改：`apps/workspace/api/space-files.test.ts`（含 RUNBOOK 共 2 个）。禁止修改：已验场景、执行门禁和生产代码。

执行：新增 `WEB-A03 deleted quota releases after storage confirmation`。A start、签名、登记并完成 `delete.bin:2000000000`，再 start `fill1.bin:4000000000,fill2.bin:4000000000`；用量 `(2000000000,8000000000)`。安装仅阻塞 delete 的 remove 前置屏障。DELETE 两次均为 202 deleting，确认 SQLite 仍计入 saved，有一条 deletion intent，下载 404，项目详情不列文件，one.bin:1 start 409。sweep 进入 remove 屏障后重复检查同一用量、intent、fixture 对象大小仍 2 GB，one 原请求仍 409。放行后等 SQLite deleted，intent 无行、无残留分块/对象、仅一次 remove-confirmed；GET space 不列该 ID，DELETE 两次均 204 且不再次调用存储，用量 `(0,8000000000)`。用原 one 请求 start 并重放，均返回同一 uploading DTO，用量 `(0,8000000001)`。

验证：

```bash
node --test --test-name-pattern='WEB-A03 deleted' apps/workspace/api/space-files.test.ts
```

PASS：1 项实际执行并通过。单步提交 `Test(task-entry): 验证删除清理后复用额度`。STOP：删除可见性、intent、存储或额度断言失败，保留临界状态证据。

### T6：同步、完整验证与收口

前置状态：T5 PASS，工作树干净。逐文件上传进度已通过 #32 合入 T0 基线 `20714e6`。
允许修改：`docs/40-readiness/CURRENT-READINESS.md` 和删除本 RUNBOOK。核对这两份文档与聚焦命令涉及的 `apps/workspace/api/space-files.test.ts`、`apps/workspace/api/file-delete-hold.test.ts`，共 4 个文件。
禁止修改：测试与生产代码、他人分支。

执行：

1. 运行 `git fetch origin main` 并记录 `git rev-parse origin/main` 的 SHA。用 `git merge-base --is-ancestor 20714e6ea58b08c003bfb685a29b239fcb40dab7 origin/main` 确认 #32 已包含在当前目标分支。若 origin/main 已是 HEAD 的祖先，直接验证。否则执行 `git merge origin/main`，验证同步后的 HEAD。同步冲突或新增基线变动影响固定断言与测试计数时 STOP，交回 MASTER 复核。需要退出冲突状态时执行 `git merge --abort`。
2. 运行前两条验证命令。同一合入基线和同一测试版本已有对应通过记录时复用该记录；新增提交影响对应验证输入时，重跑该命令。保留 #32 的 WEB-02 进度证据，在 Readiness 的 WEB-02/03 记录 WEB-A03 实测日期、初始/同步基线、T5 SHA、命令与结果，以及动态端口 HTTP、SQLite 和合成 adapter 对象的覆盖范围。将“4 GB 边界/额度上限”缺口收窄到真实 4 GB 文件传输与真实 S3/CORS，保留其他缺口。
3. 删除本 RUNBOOK 并运行余下检查。确认本步 diff 只有 Readiness 和 RUNBOOK 两个文件。

验证：

```bash
node --test apps/workspace/api/space-files.test.ts apps/workspace/api/file-delete-hold.test.ts
pnpm check
git diff --check
pnpm exec prettier --check docs/40-readiness/CURRENT-READINESS.md
(
    rc=0
    rg -n 'RUNBOOK-WEB-A03-QUOTA-BOUNDARIES' docs .agents README.md || rc=$?
    test "$rc" -eq 1
)
```

迁移前运行或复用前两条命令的结果。删除后运行其余命令。残留检查只接受 rg 退出 1，退出 0 或大于 1 均 STOP。PASS：聚焦 19 项（基线 14 + 本轮 5，若主线新增同文件测试须先复审本计数）、`pnpm check` 与 diff 全过，无残留链接；提交 `Docs(task-entry): 记录 WEB-A03 本地额度验收`，仅迁移证据并删除 RUNBOOK。本地验收使用上述聚焦用例和仓库统一检查。PR 按远端必需检查验收。STOP：任一失败则不宣告通过或交付 PR；若已删除 RUNBOOK，仅恢复本步骤删除的文件至 T5 版本，保留测试和原始失败证据。后续按 MASTER 授权，一个 PR、Ready、显式调用审查修复 skill、门禁后普通 merge、同步并清理已合入分支。
