# WEB-A07 输入快照验证 RUNBOOK

状态为待独立审核。起草日期为 2026-11-13（Asia/Shanghai）。工作区为 `/Volumes/storage/workspace/bento-a`，调查基线为 `5c8ffb99b2065851ee4d262e21ccc396ad089186`。MASTER 审核通过并指定分支、审核提交及开工指令后，WORKER 从 T1 执行。RUNBOOK 草稿被仓库公开白名单模式忽略，审核通过后的临时提交按 MASTER 指令仅对本 RUNBOOK 使用显式暂存，最终 PR 差异中须已删除。B 的 A6 默认先合入，A 在 T1 提交后按 T2 同步并复验。若 B 尚未执行且 MASTER 明确调整顺序，则使用 MASTER 指定的当前 main 提交作为同步基线。

## 目标与范围

使用现有真实模式的个人端 HTTP 和私有执行 HTTP，在本地证明两条链路。第一条在原 Run 保持排队期间新增空间文件，原 Run 仍从初始化快照执行。第二条由同账号在另一空间项目初始化不同快照，得到不同执行项目、Session 和 Run，只读取自己的输入。两条链路均经过现有服务授权、SQLite、执行侧 Workspace 和实际补丁交付。验证其他账号与资源关系不符均返回 `404 not_found`。

依据为 [WEB-04、WEB-05 与 WEB-A07](../10-requirements/WEB-REQUIREMENTS.md)、[WEB 接口的执行输入与错误语义](../20-interfaces/WEB-INTERFACE.md#执行输入与任务--web-04--web-06)、[Web 设计的执行环境与任务交互](./WEB-DESIGN.md#执行环境与任务交互)及 [Readiness 的 WEB-04 / WEB-05](../40-readiness/CURRENT-READINESS.md)。

### 当前断点和范围限制

- `apps/workspace/api/space-execution.ts` 的 `spaceExecution.start` 在初始化时固定清单，`validate` 验证内容并暂存文本，`reconcile` 导入原执行项目。该项目 ready 后，`space_execution.snapshot` 已清除。来源清单仍可读。
- `one_space_execution` 每个空间项目最多一条有效绑定。绑定后选择新输入返回 `409 execution_already_bound`。现有 Run 提交只有 `{prompt}`，`Store.enqueueRun` 保存执行项目与 Session 的关系，`serveExecution.driveRun` 在执行前从绑定 Workspace 取本轮基线。因此同一空间项目重新选择输入并创建第二个任务，依赖正式设计所说的新任务级关联及 HTTP 字段。实现还须定义任务关联、持久化提交与重试、项目和文件清理引用。该产品路径待正式契约。
- 现有实现可验证的是初始化输入在排队期间抵抗空间文件变更，以及两个既有独立项目之间的 Workspace 绑定。保留 WEB-04/05 的部分实现状态。平台镜像和策略版本固定、OpenShell 内命令与文件操作、真实平台密钥端到端验证、同空间项目两任务隔离及恢复期间的空间输入变更均超出本次验收。现有恢复、重放、删除与发布流程无行为变更。

## 契约和不变量

| 边界      | 固定数据与所有权                                                                                                                                                                                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空间 API  | Cookie 确定账号 owner。项目和文件使用 UUID v4。初始化请求为 `{fileIds: string[]}`，头部必须有唯一的 `Idempotency-Key`。服务持久化清单，项为必需的 `fileId: string, path: string, size: number, manifest: string`。公开项为 `{fileId,path,size,available:boolean}`。ready 返回 `projectId: string`，本例无 `issues`。                    |
| 私有导入  | `spaceExecution.reconcile` 使用 `space-init-` 加 `JSON.stringify([spaceId,key])` 的 SHA-256 hex 作为导入键。输入为 `{name:string,files:{path:string,text:string}[]}`。空间 API 以服务 Bearer 和 `X-Bento-Owner-Id` 调用，执行服务持有实际绑定。                                                                                         |
| Run       | `POST /api/projects/{projectId}/runs` 请求 `{prompt:string}` 与唯一 `Idempotency-Key`，首次 202。同项目同键同 prompt 回 200 与原 Run ID。服务生成 Run ID 和时间。公开 Run 包含必需的 `id,projectId,sessionId,status,createdAt,updatedAt`，以及可选的 `summary`，详情还返回 `prompt`。                                                   |
| Workspace | `apps/orchestrator/execution-service/store.ts` 的 `projectBinding` 产生必需的 `{tenant,project,session,sandbox,volume}`，均为 string。`serveExecution.importProject` 将导入文本落到绑定 Workspace 并比对回读。`driveRun` 读取同一绑定的前置基线，`Store.start` 持久化基线并推进 queued → running。完成后执行服务捕获并发布同一份 diff。 |

生产调用链为 `taskEntryServer` → `mySpace` / `spaceExecution` → `httpBackend` → `executionHttp` → `Store` / `serveExecution` → `localHost`（仅测试）→ 原 Run 详情与 diff。当前 Workspace 是可写执行态，前置基线按 Run 采集。此次只增加回归测试和证据。持久化格式、事件、回滚、重启、回执与恢复契约沿用现有实现。

## 执行者契约

每一步仅执行列出的操作。PASS 要求退出码 0、规定用例均执行且断言通过。任何前置状态、指定入口、契约或验证不符即 STOP，向 MASTER 报告最后 PASS 步骤与 SHA、失败位置、复现命令、脱敏输出及继续所需决定。失败现场留在本 checkout，测试清理自己的监听器和临时目录。不得放宽断言或改生产逻辑来通过测试。仅使用随机本地端口、测试临时目录、进程内对象存储替身和假凭据。禁止使用 B 的 Docker、共享状态或部署环境，保留旧分支。

### T0：确认基线与既有双 HTTP 入口

前置状态为指定 checkout 和调查基线。允许修改仅本 RUNBOOK 草稿。专门核对 `apps/workspace/api/space-files.test.ts` 中两个既有用例。禁止开分支、暂存或提交。审核提交若基于新的主线，由 MASTER 确认并复核受影响入口后复验本步。

执行并验证：

```bash
git rev-parse HEAD
git status --short --branch
node --import ./register-paths.mjs --test --test-name-pattern='project deletion crosses both HTTP boundaries|direct text import enforces the snapshot limits' apps/workspace/api/space-files.test.ts
git diff --check
```

PASS 为基线和改动归属符合派工、2 个指定用例通过，0 失败、0 跳过。起草时在原基线用 Node.js 22.23.2 已通过。STOP 为基线或文件归属不符，或任一用例未执行或失败。

### T1：锁定现有输入冻结与归属

前置状态为 MASTER 已指定执行分支和审核提交并明确开工，T0 证据适用。允许修改 `apps/workspace/api/space-files.test.ts` 和本 RUNBOOK。专门核对 `apps/workspace/api/space-execution.ts`、`apps/orchestrator/execution-service/local.ts`、`apps/orchestrator/execution-service/service.ts` 与 `apps/orchestrator/execution-service/store.ts`，合计 6 文件。禁止改生产入口、已有用例、运行配置和持久化。

执行：

1. 在 `project deletion crosses both HTTP boundaries` 之后新增测试 `WEB-A07 focused frozen project inputs through both HTTP boundaries`，超时 20 秒。沿用该既有用例的 HTTP fixture 配置、两个登录 Cookie、`setInterval` mock、`waitFor` 的 5 秒上限与 20 ms 轮询、内存对象 Map、SQLite 临时文件及清理方式。测试使用独立目录前缀 `bento-input-snapshot-`，fixture token 为 `fixture-only-input-snapshot-token`。在 storage 替身额外定义 `empty(key)` 为把空 Buffer 写入 Map。为第一个与第二个项目分别创建 owner A 的真实空间项目，另建 owner B 的空间项目。项目创建均通过 POST /api/space/projects，提交各自 UUID 和固定名称 Fixture，断言 200。每个项目各有一个 fixture 已保存的 `README.md`，用既有测试的 SQL 与 SHA-256 base64 manifest 写入方式，文本依次为 `alpha\n`、`beta\n` 和 `foreign\n`。使用独立的 UUID。HTTP 初始化与后续链路消费这些 fixture 文件。
2. 创建 `const host = localHost(join(dir, 'volume'))`，保存原 `snapshot` 并包裹。在第一个项目 ready 后将其执行项目 ID 设为唯一拦截目标。首次匹配目标的 `host.snapshot(binding)` 先清除拦截目标，再通知已进入闸门，并等待释放后调用原 snapshot。用两个 `Promise.withResolvers<void>()` 分别作进入与释放信号。等待进入时用现有 `waitFor` 读取由进入 Promise 置真的标志。另包裹 `host.worker`，只在 `mode === 'execute'` 时记录 `binding`、`grant.run`、`grant.session` 和原 snapshot 返回的文件数组，然后原样调用原 worker。禁止记录 grant token。使用该 host 启动真实执行服务。
3. 首次初始化前，用 B 的 Cookie 对 A 的空间项目初始化，并用 A 的 Cookie 对第一个空间项目选择第二项目的文件和 B 的文件。三次均期望 `404 not_found`，随后 A 的空间详情仍为 `uninitialized`。三个拒绝请求和合法请求使用不同键。
4. A 用键 `initialize-alpha` 初始化第一个项目，断言 202，轮询 ready 并保存执行项目 ID。每次初始化轮询的读取回调先调用 `t.mock.timers.tick(2000)`，再 GET 对应空间项目详情。通用 `waitFor` 不推进 mock `setInterval`。断言清单精确为原 file ID、`README.md`、`Buffer.byteLength('alpha\n')`、`available:true`。设置拦截目标，A 用键 `run-alpha` 提交 `{prompt:'first change'}`，断言 202，等待闸门进入。GET 原详情断言 200、queued、项目 ID、Run ID 与 Session ID 等于提交响应，`prompt` 等于提交值。
5. 闸门保持期间，在第一个空间项目通过 `POST /api/space/projects/{spaceId}/uploads` 以新 UUID 提交 `{id,path:'extra.txt',size:0,checksums:[]}`，断言 200 和 `uploading`。再 `POST /api/space/uploads/{id}/complete`，断言 200 和 `saved`。读取空间详情，文件列表含原文件与新文件，初始化清单和执行项目 ID 与步骤 4 完全相同。用新键 `initialize-alpha-changed` 选择原文件和新文件，断言 `409 execution_already_bound`。同键重试原 Run，断言 200 且 ID 相同，列表只含一个 Run，详情仍 queued。B 读取原 Run 详情、diff 及尝试向 A 的执行项目提交 Run 均为 `404 not_found`。
6. 释放闸门，轮询第一个 Run 到 succeeded。初始化第二个项目（`initialize-beta`），同样断言 202，按第 4 项在每次读取前推进 mock 定时器，断言 ready 及精确清单，文本大小对应 `beta\n`。提交 `{prompt:'second change'}`，键为 `run-beta`，断言 202，轮询 succeeded。两次捕获的 worker 输入按顺序严格等于 `[{path:'README.md',text:'alpha\n'}]` 和 `[{path:'README.md',text:'beta\n'}]`。两个 `binding.tenant` 都是 A，`binding.project` 与对应执行项目相等，`binding.session`、`grant.session` 与对应公开 Session 相等，`grant.run` 与对应公开 Run 相等。两次项目、Session、Run、sandbox、volume 各自不同。两份 diff 都 200，第一个包含上下文 ` alpha` 与新增行 `+first change`，第二个包含 ` beta` 与 `+second change`。第二份没有 `first change`，第二个完成后重读第一份 diff 字节一致。A 在第二个项目路径下读取第一个 Run，断言 `404 not_found`。
7. 在 `finally` 首先释放闸门，再关闭 Web（未成功启动时关闭 space）、执行服务，最后删除本测试目录。使用嵌套 finally 保证前一关闭失败时仍做后一清理。

验证：

```bash
node --import ./register-paths.mjs --test --test-name-pattern='WEB-A07 focused frozen project inputs through both HTTP boundaries' apps/workspace/api/space-files.test.ts
pnpm --filter @bento/workspace-api check
pnpm exec eslint apps/workspace/api/space-files.test.ts
pnpm exec prettier --check apps/workspace/api/space-files.test.ts
pnpm exec prettier --check --ignore-path /dev/null docs/30-designs/RUNBOOK-WEB-A07-INPUT-SNAPSHOT.md
git diff --check
```

PASS 为指定用例 1 项通过，0 失败、0 跳过，API check 全部通过，lint、格式和 diff 检查通过。删除 T1 说明，保留用例名称和 T2 前置事实，按 WORKER 规则提交测试与 RUNBOOK。STOP 为任一断言失败、超时、用例未执行或需越出当前测试边界。

### T2：同步复验与证据收口

前置状态为指定用例已通过并提交，且 MASTER 已给出明确的 main 提交 SHA。默认要求 B 的 A6 已合入，该 SHA 包含其合并提交。若 B 尚未执行且 MASTER 明确调整顺序，则以 MASTER 指定的当前 main SHA 为准。其余情况等待 MASTER 确定基线。允许修改 `docs/40-readiness/CURRENT-READINESS.md` 和删除本 RUNBOOK。专门核对 `apps/workspace/api/space-files.test.ts`、`docs/10-requirements/WEB-REQUIREMENTS.md`、`docs/20-interfaces/WEB-INTERFACE.md` 和 `docs/30-designs/WEB-DESIGN.md`，合计 6 文件。禁止改 B 的证据、部署文件与其他需求状态。

执行：

1. 在 T1 提交后的干净工作区同步 MASTER 指定的 main 提交。先更新 `origin/main`，确认指定 SHA 为其祖先，默认顺序还须确认 B 的 A6 合并 SHA 为指定 SHA 的祖先。将指定 SHA 合并到当前任务分支并核对它为当前 HEAD 的祖先。同步后核对 Readiness 的交叠、本次正式依据及验证入口。若基线关系不符、出现合并冲突或正式口径与入口变化影响本方案，STOP 并交回 MASTER。复验使用同步后的 HEAD，提交前若 `origin/main` 再变化，先请 MASTER 确认同步基线，再重复本步骤及下方验证。
2. 先运行下方的两个测试命令和 ESLint。向 Readiness 的 WEB-04 说明追加实际日期（Asia/Shanghai）、当前代码 SHA、Node.js 版本、指定用例名称和实际结果。注明回环 TS 双 HTTP、临时 SQLite、本地 fixture Workspace、模拟对象存储。记录排队时新增空间文件后原 Run 输入保持、另一空间项目的 Run 读取自身快照、跨账号及错配路径 404。保留部分实现，并注明同空间项目多任务、新平台环境版本、真实 OpenShell、密钥及恢复场景未覆盖。
3. 删除本 RUNBOOK，执行下方的 Prettier、diff 与引用检查。若发现其他跟踪文件引用本 RUNBOOK，STOP 交由作者核实范围。核对 diff 仅包含证据和 RUNBOOK 删除，按 WORKER 规则提交。

验证：

```bash
node --import ./register-paths.mjs --test --test-name-pattern='WEB-A07 focused frozen project inputs through both HTTP boundaries|project deletion crosses both HTTP boundaries|direct text import enforces the snapshot limits' apps/workspace/api/space-files.test.ts
pnpm --filter @bento/workspace-api check
pnpm exec eslint apps/workspace/api/space-files.test.ts
pnpm exec prettier --check apps/workspace/api/space-files.test.ts docs/40-readiness/CURRENT-READINESS.md
git diff --check
git grep -n -F 'RUNBOOK-WEB-A07-INPUT-SNAPSHOT.md' -- ':!docs/30-designs/RUNBOOK-WEB-A07-INPUT-SNAPSHOT.md'
```

PASS 为同步后 3 个指定用例全部通过，0 失败、0 跳过，API check、lint、格式和 diff 检查通过，最后一条 grep 退出码 1 且无输出。Readiness 有可复现证据，RUNBOOK 在最终提交中删除。STOP 为同步冲突触及范围外文件、基线事实变化、验证失败或有残留引用。完整验证限定为既有 API 测试、相关 focused 用例、lint 与文档检查。此任务只增加测试与 Readiness 证据，无前端、部署或外部运行变更。
