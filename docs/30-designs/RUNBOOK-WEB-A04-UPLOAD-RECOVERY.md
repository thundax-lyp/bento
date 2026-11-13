# RUNBOOK · WEB-A04 Multipart 上传恢复

状态为待独立审查草案，建立于 2026-11-13。起草基线为 `38831d1def116abdfa42792676b9835d2fcc100f`，工作目录为派工指定的 `bento-a`。审核和 MASTER 开工指令到达后使用 `codex/web-a04-upload-recovery`。当前阶段只起草。起始提交时此路径受设计目录忽略规则约束，获审后以 `git add -f -- docs/30-designs/RUNBOOK-WEB-A04-UPLOAD-RECOVERY.md` 单独暂存，校对暂存 blob 与审核版本一致。

## 执行契约与目标

适用 RUNBOOK。验收跨越认证后的 HTTP、S3 multipart 可观测状态、SQLite 持久状态、重开与两种竞态，必须分步建立证据。当前删除 fixture 覆盖项目门禁与对象删除回执恢复，未通过 multipart 的 HTTP 开始、授权、完成及取消路径验收 WEB-A04。

按 T0 至 T7 顺序执行。T0 由维护者核定。每个 T1–T6 仅在指定命令和全部断言通过后删去该步骤、提交测试和 RUNBOOK 的变化。保留后续步骤依赖所需的公共 fixture 和已通过事实。T7 迁移证据并删除手册。每个步骤仅提交本步产物。任何计划外行为、缺失入口、超时、跳过用例或断言不符均 STOP，保留工作树与最后通过的提交，报告步骤、路径、符号、复现命令、脱敏结果及所需决定。先修正明确的 fixture 错误。若复现证实产品契约偏差，交作者指定最小修复的文件、符号、行为和回归断言，再由独立审核者复审。当前草稿没有已证实且可授权执行的产品修复。

完成链路为 owner 同源请求 → Workspace HTTP → SQLite 预占 → fixture 分块 → 合并与 HEAD → 原 ID 的文件投影和额度，或清理确认后释放。证据覆盖服务实例关闭并使用同一个数据库重建。范围限本地单 Workspace API 实例、SQLite、受控 S3 adapter fixture。4 GB／10 GB 上限、前端取消增强、真实浏览器断网、真实 S3 与 CORS、Go 入口／认证构建、远端环境、多实例互斥、强杀进程和新生命周期均在范围外。

## 依据、结构与调用链

- [WEB-02、WEB-03、WEB-A04](../10-requirements/WEB-REQUIREMENTS.md) → [我的空间 HTTP 契约](../20-interfaces/WEB-INTERFACE.md) → [上传与续传及验收](./WEB-DESIGN.md) → T1–T6 → T7 [Readiness](../40-readiness/CURRENT-READINESS.md) 的 WEB-02、WEB-03。
- [平台架构](../00-governance/ARCHITECTURE.md)规定个人端 API 拥有文件归属、上传状态和额度。 `apps/workspace/api/server.ts` 的 `taskEntryServer` 从业务会话取 `ownerId` 后调用 `apps/workspace/api/space.ts` 的 `mySpace().route`。`apps/workspace/api/space-files.test.ts` 中的 `project deletion crosses both HTTP boundaries` 提供端口、会话和 HTTP 测试接线。
- 客户端提供 UUID v4 项目 ID 与上传 ID、相对路径、整数大小、按序 Base64 SHA-256 清单。上传 ID 同时作为重试键和保存文件 ID，重试需同项目、路径、大小及清单。分块授权输入 `{number: number}`，输出 `{url: string, checksum: string}`。完成与取消 POST 体为 `{}`。
- `space.ts` 的 `reserve` 用 `BEGIN IMMEDIATE` 查占用并插入，失败回滚。`space_uploads` 由 API 持有。必填文本字段为 `id, project, owner, path, manifest, state`，`manifest` 为 JSON 数组编码。必填整数为 `size, expires, signedUntil`，时间为 Unix 毫秒。服务端设 `expires=Date.now()+86400000`，`signedUntil` 默认 0，分块授权返回前更新为当前时间加 605000 毫秒。 `storageId` 为 S3 提供的可空文本，`cleanup` 为可空文本 `cancelled | expired | failed`。两者初始为 NULL。 `view` 投影为 `{id, project, path, size, state, expires}`，上传 GET 另返回 `parts: number[]`。项目详情的文件由 `apps/workspace/api/space-execution.ts` 的 `detail` 投影为 `{id, path, size}`。
- `space.ts` 的 `prepare` 清理同键孤儿、创建 multipart 并保存 `storageId`。`parts` 筛选正确的编号、尺寸、摘要和非空 ETag，再排序。`finish` 先落盘 `completing`，先 HEAD，再 ListParts，必要时再次 HEAD；分块不足且无对象时回到 `uploading`，否则按序合并并核对 HEAD 后置 `saved`。未知的存储异常经 `taskEntryServer` 映射为 `500 server_error`，保留已落盘状态供同 ID 重试或后台核对。
- `space.ts` 的 `locked` 按上传 ID 互斥，竞争者立即得到 `409 space_conflict`。取消可将 `preparing/uploading` 推进到 `cleaning`，`saved/completing` 拒绝取消。 `clean` 持久化清理原因，等授权窗口结束，再 abort、查对象并删除残留。 `apps/workspace/api/space-storage.ts` 的 `spaceStorage` 对 abort 以 ListParts 缺失确认，对 remove 以 HEAD 缺失确认。 `sweep` 每 30000 毫秒重新读取 SQLite，推进核对及清理。
- `preparing/uploading/completing/cleaning` 计预占，只有 `saved` 在本任务路径下计已保存并出现在项目文件列表、可获取下载地址。 `cancelled/failed` 为清理终态，均为零预占。 `spaceImpact` 和 `deleteProject` 分别在预检查和提交时对未清理上传执行 `upload_pending` 门禁。无 schema、事件、版本、outbox 或执行归档变更。

## 固定 fixture 和断言

全部追加到 `apps/workspace/api/space-files.test.ts`。复用该文件已有依赖与会话接线。新增 `withUploadRecoveryFixture(t: TestContext, run: (fixture: UploadRecoveryFixture) => Promise<void>): Promise<void>`，`TestContext` 由 `node:test` 类型导入。该类型仅供本文件使用。每个用例创建独立 `mkdtemp` 目录及 `space.sqlite`，创建一个 owner 和一个 mock account，沿用 `sessionAuth(mockAccounts([owner]), false)` 与 `startSession` cookie。用 `mockBackend()` 和 `mySpace` 构建 `taskEntryServer`，监听端口 0。配置 `origin = 'http://127.0.0.1:1'` 只用于 Origin 请求头，fetch 使用返回的真实监听地址。无第二监听器，无 4319/4320 占用。每次 HTTP 调用使用 5 秒超时和 `redirect: 'manual'`。除测试明确取消的请求，所有请求均读完响应。始终先释放 barrier、等待在途请求、关闭当前服务，再删本测试临时目录。重开使用同一 auth、SQLite 路径及同一 fixture 存储状态，先关闭旧服务。用例超时设为 20000 毫秒。

用 HTTP 创建项目 `Fixture`。每例仅创建一个上传 `nested/fixture.bin`，大小 16777219 字节。分块为 `Buffer.alloc(16777216, 1)` 和 `Buffer.alloc(3, 2)`，用 `createHash('sha256').update(bytes).digest('base64')` 构造清单。项目和上传 ID 用 `randomUUID()` 各生成一次。每个分块通过真实 `POST /api/space/uploads/{id}/part` 获得 fixture URL；测试将该 URL、字节及返回摘要传给本地 `putPart(url: string, bytes: Buffer, checksum: string): void`，校验签名对应的 key、storageId、分块编号、长度及重算摘要，然后写入 fixture 分块状态。ETag 固定为双引号包裹的 `part-1`、`part-2`。fixture 不经网络上传正文。

从 `spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1')` 取得同型 adapter。覆盖 `create/signPart/parts/complete/size/abort/remove/download`，`empty/read/preview` 直接抛出意外调用。记录每次调用及参数。仅允许对象键 `spaceObjectKey(uploadId)`，创建返回 `fixture-multipart`。fixture 存储仅持有一个活动 multipart、其分块和一个可空对象长度。 `parts` 用逆序返回 `{PartNumber, Size, ETag, ChecksumSHA256}`，multipart 已结束时返回 null。 `complete` 校验合并清单按 1、2 排列且 ETag 与摘要匹配，消耗 multipart 并写对象长度，禁止第二次对象写入。 `size` 返回对象长度或 null。 `abort` 清除 multipart 并确认缺失，允许 `prepare` 期间无 storageId 的初始调用。 `remove` 清除对象并确认缺失。下载签名为固定 `https://fixture.invalid/download`，仅允许对象存在。各场景覆盖的注入点由对应步骤固定。

HTTP 工具返回 status、解析后的 JSON 和 Location。创建上传断言 `200 uploading`、原 ID 和 `expires`；所有观察点用 API 读取上传、空间额度和项目文件列表。增加只读 SQLite 查询按 ID 读取 `state, storageId, signedUntil, cleanup` 并计行数，断言始终一行，核对阶段状态、持久原因和签名窗口；不得写 SQLite。以下断言用语在各步骤含义固定：

- 「隐藏」要求项目 `files: []`，下载 `404 not_found` 且无 Location；断言阶段对应的额度。
- 「已保存一次」要求同一原 ID、`saved`、`saved=16777219/reserved=0`、唯一文件 `{id,path,size}`、下载 `302` 和 fixture Location、同键对象存在且长度匹配、multipart 不存在、写入次数为 1。
- 「清理结束」要求无对象和 multipart、隐藏、`saved=0/reserved=0`。SQLite 状态须等于该步骤的指定终态。
- 「门禁」要求删除预检查 `200`、`uploadCount=1,fileCount=0,blockers=['upload_pending']`，随后的同源项目 DELETE 为 `409 upload_pending`。需要检查门禁消失时，断言预检查 `uploadCount=0, blockers=[]`，不发起成功的项目 DELETE。
- 只在 T2、T4、T6 启用 `t.mock.timers` 的 `Date`、`setInterval`，初始毫秒为 `1800000000000`，在启动 API 之前启用。 `tick(30000)` 后用 `setImmediate` 让无门控的 fixture I/O 完成。跨过签名窗口时将 Date 设为 SQLite `signedUntil+1`。T2 随后 tick，T6 由重试 cancel 驱动清理。计时器重置由测试框架负责。
- barrier 用 `new Promise<void>(resolve => { ... })` 各建 entered、release 并保存各自的 resolve，fixture 到指定调用点先 resolve entered 再等 release。用测试超时和 HTTP 超时约束。竞争请求在 entered 后发出，并在 release 之前检查其响应。清理路径始终 resolve release 并等待请求结束。取消竞态中的 abort 计数从创建之后开始，排除初始化时清理同键孤儿的调用。

## 机械步骤

### T0 · 核定开工边界

前置状态：MASTER 已确认独立审核为 Executable、草案版本和开工窗口，并提交独立的 RUNBOOK 起始提交。同步最新主线后如 #28 已先合入，检查依赖 diff 并由 MASTER 对新基线确认复验与必要复审。

允许修改：0 个文件。专门核对 10 个文件，含本 RUNBOOK、`apps/workspace/api/{server.ts,space.ts,space-storage.ts,space-execution.ts,space-files.test.ts,auth.ts,package.json,tsconfig.json}` 和 `.github/workflows/checks.yml`。禁止修改认证/API 启动文件及其他 checkout。

执行：

1. 对照审核版本和主线，核对分支唯一前置提交是审核过的 RUNBOOK，确认工作树干净，远端是 `thundax-lyp/bento`。#28 如先满足门禁由 MASTER 先合入；开工前以实际远端回读决定。主线变化时由 MASTER 先同步并复验本节，不在旧基线上启动。
2. 核对测试仍使用 `port: 0`、`taskEntryServer`、`mySpace`、`sessionAuth` 与现有项目门禁。使用已安装的仓库工具链，无需读取或传输远端配置。

验证：

```bash
git status --short --branch
git remote get-url origin
git rev-parse HEAD HEAD^ origin/main
git ls-remote origin refs/heads/main
git diff-tree --no-commit-id --name-only -r HEAD
node --version
pnpm --version
node --test apps/workspace/api/space-files.test.ts
```

PASS：工作树干净、分支正确，HEAD 文件列表只有 RUNBOOK，父提交与最新审核基线、本地跟踪与远端 SHA 一致。Node 22、仓库指定 pnpm，现有 4 项用例全通过。STOP：任何不匹配或未得到 MASTER 开工指令，记录命令输出和基线，留在 T0。T0 无提交。

### T1 · 缺块及无效分块后补传

前置状态：T0 PASS。允许修改 2 个文件，本 RUNBOOK、`apps/workspace/api/space-files.test.ts`。禁止修改生产、依赖、CI 和启动文件。

执行：

1. 实现固定 fixture。新增测试 `WEB-A04 missing multipart parts recover`，只传第 2 块，断言上传 GET 为 `uploading` 且 `parts=[2]`、预占等于声明大小、隐藏。
2. 试完成，断言 `409 space_conflict`、SQLite 回到 `uploading`、没有合并调用，仍隐藏和预占。只为第 1 块签名并写入，令存储回读的第 1 块 Size 少 1，断言仍只返回 `[2]`，完成仍拒绝且不调用合并。恢复第 1 块的正确 Size，GET 返回 `[1,2]`。再完成，断言 `200` 且已保存一次。

验证：

```bash
node --test --test-name-pattern='WEB-A04 missing multipart parts recover' apps/workspace/api/space-files.test.ts
pnpm --filter @bento/workspace-api typecheck
git diff --check
```

PASS：实际执行指定的 1 项且断言全部成立。STOP：任何偏差按执行契约报告，保留未提交用例；只清理本测试目录。提交 `Test(task-entry): 验证缺块及无效分块补传`。

### T2 · 对象大小不符与清理额度

前置状态：T1 PASS。允许修改 2 个文件，本 RUNBOOK、`apps/workspace/api/space-files.test.ts`。禁止修改生产、签名时限与项目门禁。

执行：

1. 新增 `WEB-A04 wrong object size stays hidden`，正确上传两块，令 fixture Complete 写入 16777218 字节。断言完成 `409 space_conflict`，SQLite `cleaning/failed`（state/cleanup），只调用一次合并。验证隐藏、预占与门禁。
2. 在签名窗口内 tick 一次，断言未调用清理 abort 或 remove，预占仍在。跨过窗口再 tick，断言清理结束为 `failed`、remove 一次、门禁消失。取消回读 `200 failed`，额度保持，重复完成 `409 space_conflict`。

验证：

```bash
node --test --test-name-pattern='WEB-A04 wrong object size stays hidden' apps/workspace/api/space-files.test.ts
git diff --check
```

PASS：实际执行 1 项且全部通过。STOP：状态、调用次数或额度偏差按执行契约报告。提交 `Test(task-entry): 验证大小不符的清理与额度`。

### T3 · 完成回执丢失后同 ID 重试

前置状态：T2 PASS。允许修改 2 个文件，本 RUNBOOK、`apps/workspace/api/space-files.test.ts`。禁止修改生产或 HTTP 错误契约。

执行：

1. 新增 `WEB-A04 lost storage completion receipt replays`。传齐后令 fixture Complete 写入正确大小、消耗 multipart，再抛出固定 fixture 异常。断言 HTTP `500 server_error`、SQLite 和 GET 仍为 `completing`、隐藏、保持全额预占，且门禁仍在。
2. 保存调用日志当前位置。用同 ID 再完成两次，均为 `200`，两份 Upload 响应完全相同，已保存一次。从记录位置起，恢复第一次完成仅 HEAD，第二次无存储操作。下载签名的观察请求在调用日志断言后发送。
3. 在同一个测试内顺序调用两次 `withUploadRecoveryFixture`，第 1、2 项使用第一份 fixture，本项使用第二份独立的 SQLite、API 实例和存储状态。第二份传齐后，令 fixture Complete 写入正确对象并消耗 multipart，随后在正常返回前卡 barrier。使用带独立 AbortController 的 fetch 发起完成请求。等待 entered，确认 SQLite 为 `completing`，取消客户端请求并断言 AbortError，再 release。fixture Complete 正常返回。仅轮询上传 GET，每 20 毫秒一次，最多 5 秒，直到 `200 saved`，并断言 `parts=[]`、SQLite 为 `saved`。
4. 记录第二份 fixture 的调用日志位置，用同一上传 ID 重试 POST complete，断言 `200` 且 Upload 等于上一步 GET 去掉 parts 后的结果。日志位置之后不得新增 HEAD 或 Complete 调用。执行「已保存一次」断言，核对唯一对象、唯一文件及 `saved=16777219/reserved=0`。

验证：

```bash
node --test --test-name-pattern='WEB-A04 lost storage completion receipt replays' apps/workspace/api/space-files.test.ts
git diff --check
```

PASS：实际执行 1 项，存储完成回执丢失与成功 HTTP 回执丢失两份独立 fixture 的断言均通过。STOP：重发合并、重复记账、半成品可见、回读超时或其他偏差按执行契约报告。提交 `Test(task-entry): 验证上传完成回执丢失后的重试`。

### T4 · 重开并回读原上传

前置状态：T3 PASS。允许修改 2 个文件，本 RUNBOOK、`apps/workspace/api/space-files.test.ts`。禁止修改生产、恢复周期或 SQLite 写入。

执行：

1. 新增 `WEB-A04 pending completion survives reopen`。传齐后在 Complete 写入正确对象并消耗 multipart 后卡 barrier。用带独立 AbortController 的 fetch 发完成请求。等待 entered 后取消客户端请求并断言 AbortError，再 release。fixture Complete 抛同 T3 异常，关闭服务时等待处理结束。保持 fixture 存储和 SQLite 目录，关闭后以只读 SQLite 断言仍为 `completing`。
2. 同 SQLite 文件重开 API，不先调用 complete。GET 仍为 `completing`，隐藏且仍全额预占。tick 30000 推进后台对账。GET 为 `saved`、`parts=[]`。再次 POST complete 回读相同 Upload（GET 去掉 parts），已保存一次。核对重开后到保存仅一次 HEAD、没有 ListParts 或再次合并。

验证：

```bash
node --test --test-name-pattern='WEB-A04 pending completion survives reopen' apps/workspace/api/space-files.test.ts
git diff --check
```

PASS：实际执行 1 项且全部通过。STOP：丢失持久状态、超时、恢复重复副作用或其他偏差按执行契约报告。提交 `Test(task-entry): 验证重开后的原上传对账`。

### T5 · 完成先进入临界区

前置状态：T4 PASS。允许修改 2 个文件，本 RUNBOOK、`apps/workspace/api/space-files.test.ts`。禁止修改锁、错误契约与生产接线。

执行：

1. 新增 `WEB-A04 complete wins over cancel`。传齐后令 Complete 在副作用前卡 barrier。进入后断言 `completing`、隐藏、全额预占和门禁。并发 cancel 返回 `409 space_conflict`，到此无对象、无清理调用。
2. release 并等待完成 `200`，断言已保存一次、无清理调用、门禁消失。再次 cancel 返回 `409 space_conflict`，保持已保存一次。

验证：

```bash
node --test --test-name-pattern='WEB-A04 complete wins over cancel' apps/workspace/api/space-files.test.ts
git diff --check
```

PASS：实际执行 1 项且全部通过。STOP：竞争请求等到 release 才响应、出现清理或任何偏差时按执行契约报告。提交 `Test(task-entry): 验证完成先取得上传锁`。

### T6 · 取消先取得清理权

前置状态：T5 PASS。允许修改 2 个文件，本 RUNBOOK、`apps/workspace/api/space-files.test.ts`。禁止修改锁、清理流程和项目门禁。

执行：

1. 新增 `WEB-A04 cancel wins over complete`。传齐后在窗口内 cancel，断言 `200 cleaning`、SQLite `cleaning/cancelled`、全额预占、隐藏和门禁，未调用清理 abort。跨过窗口后发起第二次 cancel，令这次请求的 abort 在实际清除前卡 barrier。等待 entered，再发 complete，须在 release 前返回 `409 space_conflict`，仍隐藏、预占，且没有合并。
2. release 并等待第二次 cancel 返回 `200 cancelled`，验证清理结束为 `cancelled`、仅一次清理 abort、零对象写入及门禁消失。再次 complete 返回 `409 space_conflict`，再次 cancel 返回 `200 cancelled`，重复检查零额度及无存储副作用。

验证：

```bash
node --test --test-name-pattern='WEB-A04 cancel wins over complete' apps/workspace/api/space-files.test.ts
git diff --check
```

PASS：实际执行 1 项且全部通过。STOP：释放早于存储确认、竞争触发合并、超时或其他偏差按执行契约报告。提交 `Test(task-entry): 验证取消先取得上传清理权`。

### T7 · 完整验证与收口

前置状态：T1–T6 均有 PASS 记录和对应提交。允许修改本 RUNBOOK（删除）和 `docs/40-readiness/CURRENT-READINESS.md`，专门核对 `apps/workspace/api/{space-files.test.ts,file-delete-hold.test.ts}`、`public-files.json`、`package.json`，合计 6 个文件。禁止更新稳定需求、接口、部署或 CI；若证实契约修复需更新稳定文档，按执行契约 STOP 并复审对应步骤。

执行：

1. 运行 focused 完整套件，须含原有 8 项和新增 6 项。核对没有跳过、取消或失败。核对 `public-files.json` 已列入测试文件与 Readiness。核对 npm pack 含两份交付文件且无 RUNBOOK 和临时 fixture 目录。
2. 更新 Readiness 的 WEB-02、WEB-03 行，记录实际日期、T0 基线、T6 commit、SQLite + fixture、命令、结果、已覆盖的六类场景与保留的未覆盖项。保留 WEB-A05／A10 原有证据。 `pnpm check` 通过后方可把结果记为通过。记录写入后删除 RUNBOOK，查残留引用，复核 diff。
3. 提交 `Docs(task-entry): 记录 WEB-A04 本地上传恢复验收`。后续按 [PR 门禁](../00-governance/PR-RULES.md)和 [Worker 交付规则](../../.agents/skills/bento-runbook-worker/SKILL.md)核对已授权操作与实际 HEAD。一个 PR，普通 merge，须通过当前 HEAD 的必需检查、Codex review 及有效反馈收口，再同步并清理已合入分支。若 #28 先合入或期间主线变化，按 MASTER 的顺序同步并重跑完整验证。

验证：

```bash
node --test apps/workspace/api/space-files.test.ts apps/workspace/api/file-delete-hold.test.ts
pnpm check
node --input-type=module -e "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; const {files}=JSON.parse(readFileSync('public-files.json')); for (const path of ['apps/workspace/api/space-files.test.ts','docs/40-readiness/CURRENT-READINESS.md']) assert(files.includes(path));"
npm pack --dry-run --json | node -e "const assert=require('node:assert/strict'); const paths=JSON.parse(require('node:fs').readFileSync(0,'utf8'))[0].files.map(({path})=>path); for (const path of ['apps/workspace/api/space-files.test.ts','docs/40-readiness/CURRENT-READINESS.md']) assert(paths.includes(path)); assert(!paths.some(path=>path.includes('RUNBOOK-WEB-A04-UPLOAD-RECOVERY')||path.includes('bento-upload-recovery-')));"
git diff --check
if rg -n --hidden -g '!.git' 'RUNBOOK-WEB-A04-UPLOAD-RECOVERY' .; then exit 1; else test "$?" -eq 1; fi
```

PASS：14 项完整运行，`pnpm check` 成功，公开和 npm 范围断言通过，无残留引用，最终提交包含证据迁移和 RUNBOOK 删除。STOP：任一门禁失败保留本步，报告可复现证据。若 Readiness 已编辑，保持验证状态与实际一致。部署镜像和 Chromium 属于远端必需检查，按实际 PR HEAD 回读。真实外部运行不适用本地验收，依据为本次限定的 HTTP、SQLite 与 S3 adapter fixture。

## 起草证据

起草前工作树干净，本地 HEAD、origin/main 和 GitHub main 均为 `38831d1def116abdfa42792676b9835d2fcc100f`。Node v22.23.2、pnpm 12.15.0。现有 `node --test apps/workspace/api/space-files.test.ts apps/workspace/api/file-delete-hold.test.ts` 8 项通过。起草期间 GitHub #28 为 OPEN。该 PR 与本任务共享 Readiness、CI 和打包检查边界，并修改 API 的 package 与 tsconfig。#28 的文件清单未包含本任务测试文件、space 状态机和 adapter。新增用例与 T0 开工门禁待执行。
