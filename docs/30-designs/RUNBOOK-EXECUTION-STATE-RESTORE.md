# 单节点执行宿主停服备份还原演练

状态为待 MASTER 审核，建立于 2026-11-13（Asia/Shanghai）。工作区为 `/Volumes/storage/workspace/bento-b`，调查基线为 `99246d59655979f73942e60571796198c3f1b64b`。审核通过并明确派发前，仅允许在当前工作区起草本文。T0 由作者或维护者确认，WORKER 自首个剩余实施步骤执行。每步最多涉及 10 个文件，含本文和该步专门核对的文件。命令均从仓库根目录执行。

## 目标与依据

[应用与编排边界需求的 A7、A2、A3](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)要求单节点备份还原、持久历史及回执一致、旧代请求拒绝。[执行链实施设计](APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计)确认单宿主交付包含 A7，并将代次、会话历史和批次回执归入执行链。[架构](../00-governance/ARCHITECTURE.md)规定 Workspace Volume 与沙盒生命周期独立。此演练固定在一条已完成 Run 的静止边界，通过还原后的下一条 Run 读回旧历史并继续写入。

[#35 的演练说明](../../deploy/README.md#单节点业务执行账本备份还原演练)只复制 `business.sqlite`，还原后验证终态业务读取和同键重放，要求零宿主调用。[Readiness 的 A7 行](../40-readiness/CURRENT-READINESS.md)明确留下授权账本和历史缺口。本次保留原测试，新测试覆盖同一项目在还原后重新派发。项目、Run、Session 和 Volume 的关联来自业务库，下一代从授权库读取，写入 owner/epoch 由历史库 CAS。三库必须从同一无写者窗口采集。该窗口仅证明停服静止状态的一致性，逐库备份期间源实例持续关闭。

## 所有权与调用链

- `apps/orchestrator/execution-service/service.ts` 的 `serveExecution` 创建三个库及控制器锁，`close` 等待调度工作结束并关闭入口、宿主控制器及存储。测试通过 `service.test.ts` 的 `start` 启动同一个生产服务函数，以回环 HTTP 创建项目、提交 Run，以动态 worker RPC 读写历史。
- `apps/orchestrator/execution-service/store.ts` 的 `Store.binding` 和 `projectBinding` 将 `projects.owner/id/sessionId/sandbox/volume`（均为非空文本）映射为 `Binding.tenant/project/session/sandbox/volume`。业务库 `runs.id/projectId/sessionId/key/prompt/status` 为非空文本，`receipt` 为整数，初值 0，收到完成回执后为 1。HTTP caller 提供 prompt 和幂等键，项目/Run/Session ID 由服务生成。详情 GET 使用 `Store.run`，在 `runView` 上添加 prompt。提交 POST 的同键重放使用 `Store.enqueueRun` 返回的 `runView`。
- `serveExecution` 内的 `worker → settle → fence` 经 `apps/orchestrator/openshell/single-host.ts` 的 `SingleHostExecution.admit/takeover/persistenceIngress` 调度 worker、推进代次、授权 `POST /rpc`。授权库 `execution_sessions` 持有五个绑定文本字段、整数 generation、文本 state，以及可空的文本 run/capability 和整数 expires。终态 Run 对应下一代 `READY`，三个可空字段均为 NULL。新派发返回服务签发的 `WorkerRequest.grant`，其中 token/session/run 是字符串，generation 是整数。旧 token 在还原实例的当前入口须返回 HTTP 403。
- `apps/orchestrator/openshell/persistence-fence.ts` 的 `PersistenceFence.revoke/grant` 先将已撤代标记为 `owner='bento:revoked', handle=NULL`，新代获准后才把历史 epoch 推到新代、owner 置为新 Run。因而在静止边界，授权 generation 恰比历史 epoch 大 1。
- `apps/orchestrator/openshell/session-history.ts` 的 `SessionHistory.dispatch/request/commit` 在事务内处理历史。版本 4 header 由 worker 提交，包含非空文本 `id`、整数 `version/createdAt` 和布尔 `isSeeded`。历史 `sessions` 的 `id/header/owner` 为文本，`epoch/next/revision/inherited/materialized` 为整数，`handle/created_by` 可空文本。空白历史的 `next/revision` 初值 0，本测试 inherited 为 0。事件表 `events(id,seq,event)` 保存文本 ID、整数序号及 JSON 文本。 `batch_intents(id,epoch,batch,payload)` 保存 Session ID、整数代次、批次 UUID 和 JSON 文本。 `batch_receipts(id,epoch,batch,digest,first,count)` 保存非空 Session ID、整数代次、批次 UUID、SHA-256 十六进制文本、整数起始序号与数量。 `stage` 先存 intent，`append` 同事务提交事件、回执和游标，`reconcile` 返还已提交回执并删除 intent。跨代回执以旧 epoch 留在数据库，新代用当前 grant 读历史。测试在旧代内验证同批次回执，恢复后以只读 SQL 核验旧回执，RPC 核验历史和新代写入。
- `apps/orchestrator/execution-service/local.ts` 的 `localHost.snapshot` 从 `<fixture-root>/<project>/volume` 读基线。为了跑后续 Run，测试需将同一合成 `README.md` 文件放到还原侧同绑定路径并校验字节。两侧采用独立 fixture 根目录，绑定的 sandbox/volume 是账本中的引用。运行标志由 fixture 的正常 stop/start 管理。外部 Workspace 卷及其恢复流程另有生命周期。

范围包括三库停服快照、合成卷文件、历史读回、旧代拒绝、新代历史写入、终态和回执一致性。范围之外包括真实 DSH provider/checkpoint 和模型、故障注入及未结批次恢复、真实 OpenShell/Workspace、Temporal、MySQL、Keycloak、S3、共享栈、在线备份、多节点、生产部署恢复、回滚及 RPO/RTO。全部 SQL 查询使用只读连接。所有种子数据经现有入口创建。遇到失败保留断言输出和本步工作文件，禁止手工补写、放宽断言或修改业务语义。

## 执行步骤

### T0：确认起点和审核门禁

前置状态为上述基线和已安装锁定依赖。允许修改本文。专门核对 `apps/orchestrator/execution-service/service.test.ts`、`deploy/README.md`、`docs/40-readiness/CURRENT-READINESS.md`。禁止打开任务分支、提交或改业务代码，直至 MASTER 批准。

```bash
git rev-parse HEAD
git status --short
git status --short --ignored -- docs/30-designs/RUNBOOK-EXECUTION-STATE-RESTORE.md
node --input-type=module -e 'import { backup } from "node:sqlite"; if (!process.version.startsWith("v22.") || typeof backup !== "function") process.exit(1); console.log(process.version)'
test "$(pnpm -v)" = 12.15.0
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores the completed Run business ledger from an isolated backup$' apps/orchestrator/execution-service/service.test.ts
```

PASS 为基线吻合，普通状态为空，指定草案在本阶段显示为 `!!`（仓库忽略规则覆盖临时设计文件），Node 和 pnpm 前置通过，#35 测试为 1 pass、0 fail、0 skip，MASTER 审核批准后才开始 T1。调查已在 Node 22.23.2、pnpm 12.15.0 下得到上述 #35 测试结果。STOP 为基线或断言不符、出现额外改动或审核未批准。保留现场，回报实测 SHA、文件清单或失败输出。

### T2：同步 A 的主线结果并收口证据

前置状态为分支已提交测试 `restores stopped execution state and continues fenced session history`，其定向测试、Orchestrator 类型检查、格式及差异检查通过，且 MASTER 已确认 A 的 WEB-A02 合并进入 main 并同步至 B 的任务分支。允许修改本文、`deploy/README.md`、`docs/40-readiness/CURRENT-READINESS.md`。专门核对测试文件、`README.md`、`public-files.json`。禁止覆盖 A 的条目或迁移本文到长期目录。

1. 先执行定向双测，确认 2 pass、0 fail、0 skip，记录实际日期、新增三库演练测试的提交 SHA、Node 版本和覆盖边界。核对这两项测试都由现有 Orchestrator 测试套件执行。

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores (the completed Run business ledger from an isolated backup|stopped execution state and continues fenced session history)$' apps/orchestrator/execution-service/service.test.ts
```

2. 在部署手册的 #35 演练之后增加「单节点执行宿主停服备份还原演练」，使用上面的固定双测命令。记录前置条件、三库与 fixture 文件边界、可观察 PASS、临时目录清理和失败重跑。将原演练段落中关于授权账本和历史的后续工作链接到新演练，保留生产范围缺口。用本次实测证据更新 A7，追加 A2 的历史与回执证据和 A3 的旧代拒绝证据。保留既有证据和三项原 readiness 状态，并列出 Scope 中的未覆盖范围。README 已链接部署手册，发布清单已覆盖测试和两份长期文档。
3. 执行下方格式化命令，再删除本文。以最终交付内容运行全仓、差异及残留检查。本地验证使用回环和合成状态，浏览器 E2E 继续由既有 PR CI 门禁负责。待当前 HEAD 的必需 CI 和明确 Codex 审查结论均通过，按 WORKER 流程交付。

```bash
pnpm exec prettier --write deploy/README.md docs/40-readiness/CURRENT-READINESS.md
rm docs/30-designs/RUNBOOK-EXECUTION-STATE-RESTORE.md
pnpm check
git diff --check
test ! -e docs/30-designs/RUNBOOK-EXECUTION-STATE-RESTORE.md
(
    if restore_refs=$(rg -n 'RUNBOOK-EXECUTION-STATE-RESTORE' README.md docs deploy 2>&1); then
        printf '%s\n' "$restore_refs"
        exit 1
    else
        restore_refs_status=$?
        test "$restore_refs_status" -eq 1 && test -z "$restore_refs"
    fi
)
```

PASS 为定向 2 pass、0 fail、0 skip，全仓检查和差异检查退出 0，长期说明及未覆盖项与当前代码实测吻合，RUNBOOK 已删除，且 `rg` 退出 1、无输出。提交本步后按已授权的 PR 流程交付。STOP 为 A 尚未合并、同步引入范围冲突、任一门禁失败、文档缺少实测证据或发现残留引用。报告 A 的合并状态、最后通过的步骤与 SHA、失败命令和实际结果。
