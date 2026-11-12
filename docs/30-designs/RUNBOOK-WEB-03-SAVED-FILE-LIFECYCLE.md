# RUNBOOK · WEB-03 已保存单文件生命周期

状态 `Executable`，执行中。2026-11-12 建立于 bento-a 的 `main` / `origin/main`，基线 `b33c8e722a26126556d01794a82756f9b11b42fc`。范围为 [WEB-03 与 WEB-A05](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期) 中的单文件预览、删除、对象清理和额度回收。仅做已保存 UTF-8 文件预览，保留下载、执行快照和历史 Run/diff。项目整体删除、文件树改版、二进制预览及上传协议排除。

现有 `apps/workspace/api/space.ts` 的 `mySpace.route` 只提供已保存文件下载。 `apps/workspace/api/space-execution.ts` 的 `spaceExecution.start` 绑定不可变输入清单。Go 入口 `apps/workspace/api/go/main.go` 将 `/api/` 转发给 task-entry，`projects.go` 的直接提交路由在此基线未注册。task-entry 的 Run 提交最终由 `apps/orchestrator/execution-service/http.ts` 调用 `Store.addRun`。空间 API 先查询 Run 再写删除状态仍会留下竞态。Run 入队门禁归 [Orchestrator](../00-governance/ARCHITECTURE.md#应用与编排的目标职责)，对象与额度归空间 API。遵循 [Web 接口](../20-interfaces/WEB-INTERFACE.md#项目详情及目标扩展)、[单文件删除设计](WEB-DESIGN.md#单文件删除--目标) 和 [Readiness](../40-readiness/CURRENT-READINESS.md)。

## 执行前检查（T0，作者或维护者负责）

本节在机械步骤之外，不计步骤和文件数。核对干净基线与获授权的执行分支、Node 22、锁定 pnpm、依赖和 Chromium headless shell。检查 4319/4320 空闲，测试对象源另用随机回环端口。以 `git status --short --branch`、`git rev-parse main origin/main` 及 `git diff --check` 核对起点。本地 fixture 不读真实配置，也不依赖主 checkout 的部署改动。维护者已在独立任务分支核对执行条件。

WEB-03 单文件生命周期与 WEB-07 取消 Run 各在独立分支编写和验证。并行实施时，本计划的预览 T1–T2 可先行。已核对两个分支共同基线 b33c8e7，用户确认 WEB-03 先合入、WEB-07 后合入。WEB-07 在包含 WEB-03 的最新 main 上聚焦复验交叠的 Run 入队、取消状态和单文件删除门禁。

## 执行与提交

从仓库根执行 T1–T7。文件数包含专门核对和 RUNBOOK，不含工具间接读入的依赖或 fixture 自动生成的 SQLite sidecar。每步 PASS 后移除已完成步骤，将后续前置改为可检查的已提交产物或验证事实，保留后续编号，按步将产物、必要的公开清单条目和 RUNBOOK 清理一起本地提交。T7 同次提交删除本文。STOP 时保留现场、未完成步骤和持久状态，报告最后 PASS 的提交、触发点、复现命令及脱敏结果。Fixture 退出后只清理其自建临时资源。无事件、outbox、旧部署迁移或新清理框架。

## 机械步骤

### T4：接通空间 API 与私有门禁

前置状态：HEAD 已包含 Store 的持久门禁及 executionHttp 私有路由。Orchestrator typecheck 和 file deletion hold fences Run admission 已通过。

允许修改：`apps/workspace/api/protocol.ts`、`apps/workspace/api/execution-service-http.ts`、`apps/workspace/api/mock.ts`、新增 `apps/workspace/api/file-delete-hold.test.ts`、`public-files.json` 及本文。共 6 个文件。

禁止修改：公开删除路由、生产部署与现有任务错误映射。

执行：

1. 向 `Backend` 的 Operation 加 `{kind:'acquireFileDeleteHold'|'releaseFileDeleteHold'; projectId:string; operationId:string}`，Result 的 JSON 分支增加 T3 状态对象。 `publicJson` 只接受 held/denied/released 字符串枚举并投影为 `{state}`。 `httpBackend` 复用现有 bearer、owner 和超时，按 T3 编码路径及无请求体的 POST/DELETE，仅接受 200。4xx/5xx/超时沿用当前映射，不能作为 denied 回执。
2. 在 `mockBackend` 每项目存 operationId 到状态的 Map，复用 owner/项目检查。acquire 写前检查 importing 和现有非终态 Run，按原键重放；release 写 released；在 createRun 的原提交键回读后、创建前拒绝 held 项目。现有 mock 项目注销删除项目时一并丢弃 Map。
3. 新 Node fixture 用本地 HTTP 断言方法、路径、owner 与枚举校验，拒绝未知状态。另用 `mockBackend` fixture 验证 held 阻止新 Run、release 后同 op 仍 released，登记测试文件到公开清单。

验证：

```bash
pnpm --filter @bento/workspace-api typecheck
node --experimental-strip-types --test apps/workspace/api/file-delete-hold.test.ts
```

PASS：两条退出 0，真实传输适配器和 mock 都保持相同门禁结果形状。

STOP：需把私有门禁暴露给浏览器，或错误被误译为 denied。

### T5：持久接受删除并完成对象清理

前置状态：T4 已提交。 `spaceStorage.size/remove` 能识别不存在，并在 remove 后核对不存在。

允许修改：`apps/workspace/api/space.ts`、`apps/workspace/api/space-execution.ts`、`apps/workspace/api/server.ts`、`apps/workspace/api/space-files.test.ts`、`apps/workspace/web/src/space-api.ts`、`apps/workspace/web/src/space.tsx` 及本文。另核对 `apps/workspace/api/space-storage.ts` 与 `apps/workspace/api/protocol.ts`，创建和删除临时 fixture `space.sqlite`。共 10 个文件。

禁止修改：存储实现、上传清理、项目删除、执行源快照和 Run/diff。

执行：

1. `spaceExecution` 新增 `deletionProject(owner:string,spaceId:string,fileId:string): string|null`。查本空间当前 owner 绑定，仅检查不可变 `inputs[].fileId`。目标被 validating/importing 初始化引用时抛出 `409 project_importing`，无引用或没有 execution project ID 返回 null，其他有引用返回该 projectId。将 `view` 改为按同 owner/project/file 的 `state='saved'` 计算 `inputs[].available`，保留其余字段和历史。
2. `mySpace` 新建 `space_file_deletions(fileId TEXT PRIMARY KEY REFERENCES space_uploads(id) ON DELETE CASCADE, operationId TEXT NOT NULL, executionProjectId TEXT, phase TEXT NOT NULL CHECK(phase IN ('checking','deleting','releasing'))) STRICT`。同 owner 的上传记录保留为终态 `deleted` 墓碑，文件 ID 即公开重试键。对新 `DELETE /api/space/files/{fileId}`，先按 owner 与 UUID 查文件。缺失或非 saved/deleting/deleted 用原 404，deleted 直接 204，deleting 直接 202。初次 saved 在同步段检查初始化引用并写原意图，opId 用 `node:crypto` 的 `randomUUID()`。有执行引用时写 checking 后才调用 T4 acquire。无引用时同一 SQLite 事务写 deleting 意图及上传 deleting 状态，无 await，因而与现有同步初始化选择互斥。
3. 在每文件现有锁内使用 `checkFileDeletion(row: Upload): Promise<'held'|'denied'>`。checking 用原 opId 取得门禁。denied 删除意图且保留 saved，本次显式 DELETE 返回 `409 project_busy`；后台则只保留 saved。held 用同一 SQLite 事务把上传和意图改为 deleting。远端异常或非预期 released 保留 checking，显式请求回 `503 file_delete_unconfirmed` 并提示重试，后台复用原键。checking 期间文件仍 saved，只有已有执行绑定会进入 checking，现有规则拒绝启动新的初始化。显式请求只调用 check，受理返回 202。并发若锁占用，重读上传，deleting/deleted 返回 202/204，否则回 503，禁止新建操作。
4. 复用 `mySpace.sweep` 的定时器和每文件锁扫描删除意图，调用 `advanceFileDeletion(row: Upload): Promise<void>`。checking 先调用 check，denied 即结束，held 继续清理。deleting 先 `storage.size`；非 null 时调用已有 `storage.remove`，该函数确认 HEAD 不存在才返回。已确认缺失后记录 releasing；此时可释放远端 Run 门禁。调用原 opId release（无绑定则跳过），只接受 released，最后在事务内标 deleted 并删除本地意图。任何清理或释放错误保留阶段；重试 HEAD 或 release，绝不恢复 saved。 `statesWithSpace` 加 deleting，GET 空间的 `saved` 汇总含 deleting，deleted 不计额度且不进入空间列表。确认缺失并收到释放回执后一次回收。deleting 不可用于初始化、预览或下载，保留原占用路径。预览和下载在异步签名返回前重查 saved，避免已受理删除后发出新地址。账号注销沿用已有每文件锁和对象删除，外键级联删除本地意图。后续同名上传使用新 ID。已删除 ID 的状态查询仅向原 owner 返回墓碑，且原注册 ID 不可复活。
5. `taskEntryServer` 的同源 Origin 校验扩至空间文件 DELETE，复用 POST 的 400。映射 `{deleteStatus:202}` 为 `202 {state:'deleting'}`，`{deleteStatus:204}` 为无正文 204。浏览器列表 Upload 类型只增加 deleting，状态显示「正在删除」。planUpload 把 deleting 与 saved/cleaning 同样视为占用，禁止续传。复用原 GET upload 状态，新增 `getUpload(id:string): Promise<Omit<Upload,'state'> & {state:Upload['state']|'deleted'}>`。仅在本地缓存 ID 存在、无计划续传 ID 且不在空间列表时查询该 ID。只有确认 deleted 才丢弃缓存并生成新 ID，404 或查询失败仍用原 ID，以免改变未知注册回执的恢复行为。上传请求形状和 transferFile 不改。本步只让读侧识别新状态，删除按钮留给 T6。
6. 扩充 `space-files.test.ts`，用 T1 临时 DB 和可切换的门禁/存储 fixture。断言跨账号与不存在相同；初始化引用拒绝；denied 保持 saved；acquire 丢回执后仍用同 opId；202 起预览下载均 404 且已用额度保留。用 `node:test` mock timers 推进现有 30 秒 sweep，等待 fixture 的本轮异步调用完成。注入一次 remove 回执丢失且对象已不存在，关闭重开同 DB 后再推进 sweep，断言只按原对象继续、release 回执失败可重试、最终同 owner 重复 204，额度只释放一次，记录消失而来源清单标不可用。验收只以合成资源执行，不变动旧上传清理。

验证：

```bash
pnpm --filter @bento/workspace-api typecheck
pnpm --filter @bento/web typecheck
node --experimental-strip-types --test apps/workspace/api/space-files.test.ts
```

PASS：三条退出 0，拒绝、未知结果、重启恢复、停止签发、额度和重复删除断言成立。

STOP：不能确认远端结果或对象不存在时保持持久阶段，禁止释放额度或改回 saved。fixture 任一断言失败即停止本步。

### T6：单文件删除确认与反馈

前置状态：T5 的删除端点、清理恢复和只读状态已验证并提交。

允许修改：`apps/workspace/web/src/space-api.ts`、`apps/workspace/web/src/space.tsx`、`apps/workspace/web/e2e/space-preview.spec.ts` 及本文。另核对 `apps/workspace/web/playwright.config.ts`。共 5 个文件。

禁止修改：项目级删除、任务历史、原下载、上传及取消。

执行：

1. 新增 `deleteSpaceFile(id:string): Promise<'deleting'|'deleted'>`，复用 `request` 同源 DELETE，15 秒超时，202 映射 deleting，204 映射 deleted。其他响应走现有失败提示。 `spaceQuery` 仅在当前数据含 deleting 时每 2 秒回读。
2. 在 `CloudProject` 的 saved 行加「删除文件」，先显示原路径和影响「将删除这个原文件，清理完成后释放额度。已有任务与补丁仍可查看」。确认前保留下载，取消确认零请求。确认只发一次同 ID DELETE，关闭同文件预览并刷新空间和项目，202 依服务端状态显示清理中，204 移除该行，额度只由 GET 更新。409 显示服务器原因，503/网络超时提示「暂未确认删除结果，请刷新后重试」，不自动发起 DELETE；再次确认沿用同 fileId。正在删除行仅展示状态。
3. 在现有 Chromium fixture 追加单文件删除用例。验证取消确认零写入、409 保留下载、随后确认得到 202 时下载消失且额度未变、后台状态推进后同一行消失并释放正确字节。已有预览用例仍通过。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test:e2e space-preview.spec.ts
```

PASS：两条退出 0，现有预览和删除交互 fixture 全部通过。

STOP：出现提前扣减、取消也发请求、跳过确认或误删历史的行为。

### T7：同步接口、设计和验证证据

前置状态：T1–T6 的源码和 fixture 已提交，所有列明的聚焦命令通过。用已提交步骤的验证输出确认，不重复读取代码或运行测试。

允许修改：`docs/20-interfaces/WEB-INTERFACE.md`、`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`、`apps/workspace/api/README.md`，最后删除本文。共 5 个文件。

禁止修改：需求、部署配置、项目整体删除口径。

执行：将文本预览及单文件删除标为已实现，记录 302/413、DELETE 202/204、404 等价、409/503、私有入队门禁及删除额度确认点。Web 设计保留项目删除为目标。API README 写明私有桶需允许本 Web origin 的 CORS GET，沿用既有 PUT 配置。Readiness 的 WEB-03 保留「部分实现」，记录实际基线、Node/Chromium fixture、覆盖范围，注明真实 S3/CORS、真实多账号和项目整体删除未验收。沿用原有文档链接。

验证：

```bash
pnpm exec prettier --check docs/20-interfaces/WEB-INTERFACE.md docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md apps/workspace/api/README.md
git diff --check
if rg -n -F 'RUNBOOK-WEB-03-SAVED-FILE-LIFECYCLE' docs/20-interfaces/WEB-INTERFACE.md docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md apps/workspace/api/README.md; then
    exit 1
else
    test "$?" -eq 1
fi
```

PASS：格式和空白检查通过，rg 退出 1 表示无引用。随后 `rm docs/30-designs/RUNBOOK-WEB-03-SAVED-FILE-LIFECYCLE.md`，用 `test ! -e docs/30-designs/RUNBOOK-WEB-03-SAVED-FILE-LIFECYCLE.md` 核对，并与四份文档同次提交。

STOP：证据缺项、范围不符、引用存在或扫描失败，保留本文。

作者自检按 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md) 和 [文档规则](../00-governance/DOCUMENT-RULES.md) 核对基线、源码、公开文件登记、步骤及验收边界。交付阶段仅验证文档。
