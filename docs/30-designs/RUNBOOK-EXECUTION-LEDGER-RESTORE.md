# 单节点业务执行账本备份还原演练

状态：草稿，待独立审核。建立日期：2026-11-13（Asia/Shanghai）。工作区：`/Volumes/storage/workspace/bento-b`。基线：`656fdc26cddd1cf1db9c9056230fd2d9599fe517`。审核通过后使用 `codex/execution-ledger-restore`。

## 执行者契约

当前只允许调查、起草及作者校验。收到 MASTER 对当前草稿 Git blob 的 `Executable` 审核结论后，按 T0 建立执行分支并单独提交该 RUNBOOK。收到同一审核提交的 WORKER 执行派发后，依序执行 T1、T2。每步全部命令、断言和文件清单符合要求才 PASS，随步骤产物提交 RUNBOOK 中该步的删除。发生 STOP 时保留当前步骤和用户文件，报告最后通过的步骤及提交、相关 symbol、复现命令、脱敏结果、继续所需决定。Git 提交失败保留当步待提交内容并按 WORKER 规则重试。

任务命令从仓库根目录以 Bash 逐条运行，遇到不符合 PASS 的结果立即停止。运行管道命令前设置 `set -o pipefail`。仅使用当前 checkout 的已装依赖、系统临时目录和测试进程的动态回环端口。禁止 Docker、远端运行环境、共享栈、A 的账号或 S3、`debug-workspace`、真实执行数据、项目配置和私有环境文件。PR 交付阶段的 GitHub 操作遵循单独派发的授权和 [PR Rules](../00-governance/PR-RULES.md)。

## 目标与断点

[需求 A7、A8](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)要求单节点备份还原演练及可重复证据。[实施设计](APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计)包含单执行宿主备份还原，[架构的当前接线](../00-governance/ARCHITECTURE.md#当前实现接线)区分实际 TS 执行账本与目标 Go Orchestrator。现有 [部署手册](../../deploy/README.md#启动与检查)只说明保留命名卷以重启。现有 `service.test.ts` 的 `private HTTP, three-account FIFO, next generation and immutable diff across restart` 复用原状态目录。缺口是从独立备份在全新位置恢复后，以正常业务入口读取并重放已完成 Run。

交付链路为本地合成项目 → 真实执行服务生成已完成 Run → 优雅停服 → SQLite backup API 生成独立文件 → 核对完整性与 SHA-256 → 仅将该文件复制到全新状态目录 → 同一服务入口读取项目、Run、diff、幂等重放 → 清理 → 部署手册与 Readiness。

范围仅包括当前 Compose Orchestrator 的 `business.sqlite` 和其中已结束 Run 的证据。未覆盖 `authority.sqlite`、`history.sqlite`、控制器锁的恢复、其他数据卷、OpenShell Workspace、MySQL、Keycloak/PostgreSQL、Temporal 历史、S3、运行中 Run 的接管、生产备份编排、生产灾难恢复、回滚、RPO/RTO 和多节点。各步骤均不修改产品实现、协议、Schema、镜像或 CI。

## 依据与不变量

- [Compose](../../deploy/compose.yaml) 的 `orchestrator` 将 `bento-execution-data` 挂载至 `/data`，以 `BENTO_STATE_DIR=/data` 调用 [start.ts](../../apps/orchestrator/execution-service/start.ts)。其入口调用 [service.ts](../../apps/orchestrator/execution-service/service.ts) 的 `serveExecution`，后者获得控制器锁，打开 `Store(join(dir, 'business.sqlite'))` 并绑定 `executionHttp`。演练复用 `serveExecution` 的正常启动、扫描和 HTTP 路径，由既有测试 `start(state, host)` 提供本地适配器及动态端口。
- [store.ts](../../apps/orchestrator/execution-service/store.ts) 的 `Store` 使用 WAL、FULL 和外键。备份源在 `serveExecution.close()` 完成后以只读 SQLite 打开，通过 `node:sqlite` 的 `backup` 生成一致的单库文件，禁止复制活跃的主库或从原状态目录带入 WAL/SHM、其他数据库和本地卷。完整性检查独立只读打开备份。摘要只比对备份与启动前还原副本，服务重开后可能写入 SQLite 元数据。
- `projects` 中 `id,owner,name,status,createdAt,sessionId,sandbox,volume` 均为必填 TEXT，`source` 为可空 TEXT。HTTP 项目创建接受 `name: string` 和 `files: {path: string; text: string}[]`，owner 来自经 bearer 验证的 `x-bento-owner-id`。服务生成项目/Session UUID、沙盒/卷标识与 ISO 时间。项目 GET 投影 `id,name,status,createdAt`。
- `runs` 中 `id,projectId,sessionId,key,prompt,status,createdAt,updatedAt` 为必填 TEXT，`summary,baseline,diff` 为可空 TEXT，`receipt,reconciled,cancelWorkerClosed` 为 INTEGER 默认 0，`cancelGeneration` 为可空 INTEGER。`Store.addRun` 在 `BEGIN IMMEDIATE` 中按 `(projectId,key)` 查找及入队。调用方提供 `Idempotency-Key` 和 `prompt: string`， [runInput](../../apps/orchestrator/execution-service/input.ts) 对 prompt 做 trim，直接与落库 prompt 比较，无请求哈希。服务生成 Run UUID 和 ISO 时间。worker 完成后 `Store.received` 写 `receipt=1`，`serveExecution.finish` 通过 `Store.status` 保存 diff 并标记 `succeeded`。
- [http.ts](../../apps/orchestrator/execution-service/http.ts) 的 `executionHttp` 对新提交返回 202，同键同输入返回 200 和当下的 `runView`，同键异输入返回 409 和 `error.code=idempotency_conflict`。幂等回执是原 Run 的投影。其字段为 `id,projectId,sessionId,status,createdAt,updatedAt` 和非空时的 `summary`。详情 GET 额外给出 `prompt`。列表 GET 返回 `{runs: runView[]}`，diff GET 返回纯文本，错误 owner 的详情 GET 返回 404。数据库 `receipt` 与 HTTP 重放回执分别断言。新增事件、outbox、Archive、Schema 和权限规则均不适用。
- 仅合成 fixture 允许备份与启动。备份、源、还原目录互为不同位置，由同一个权限受限的 `mkdtemp` 创建。还原文件独占创建，启动前验证内容，启动还原实例后仅读取或重放原请求。任何失败关闭 SQLite 连接和服务，清除本次临时目录。测试只有全部断言和清理成功才打印摘要。

## 机械步骤

### T2：登记 Readiness 并收口

前置状态：T1 已提交，提交中有两份交付文件，当前 RUNBOOK 只剩 T2。T1 PASS 证据记录了实际 Node 版本、命令、SHA-256 及通过数。

允许修改：`docs/40-readiness/CURRENT-READINESS.md` 与本 RUNBOOK。专门核对 `deploy/README.md` 的新小节、`apps/orchestrator/execution-service/service.test.ts` 的测试名和 `public-files.json` 中两份文档的条目（合计 5 个）。

禁止修改：A8 状态、其他验收项、永久手册与产品行为。测试范围不得扩大到外部服务。

执行：

1. 仅替换应用与编排表中 A7 行的说明列，保留「部分实现」。写入本次实际验证日期（Asia/Shanghai）、T1 的完整提交 SHA、Node 版本以及如下证据：`business.sqlite` 合成项目及终态 Run 在停服后备份，新隔离目录还原，正常 HTTP 读取、diff、同键同输入回执一致，异输入冲突，零重复 Run。链接 `../../deploy/README.md#单节点业务执行账本备份还原演练` 作为命令入口。列明未覆盖授权账本、会话历史、Workspace 卷、其他部署数据库和存储、Temporal、生产恢复、部署回滚及 RPO/RTO。A8 的可重复证据由 A7 的链接和版本提供，A8 整体门槛继续按原行记录。
2. 删除本 RUNBOOK。仅格式化 Readiness。核对没有跟踪文件引用被删除的 RUNBOOK。执行下面的验证，核对实际输出后暂存仅 Readiness 和 RUNBOOK 删除，提交 `Docs(execution-service): 记录单节点账本还原证据`。回读 SHA、文件清单及 `git status`，随后按 WORKER 派发与仓库 PR 规则交付。

验证：

```bash
pnpm exec prettier --write docs/40-readiness/CURRENT-READINESS.md
test ! -e docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md
git grep -nF 'RUNBOOK-EXECUTION-LEDGER-RESTORE.md'
rg -n '^## 单节点业务执行账本备份还原演练$' deploy/README.md
rg -n 'deploy/README\.md#单节点业务执行账本备份还原演练' docs/40-readiness/CURRENT-READINESS.md
git diff --check
pnpm check
```

PASS：`git grep` 退出 1 且无输出，其余命令退出 0。完整检查覆盖现有 TS、Go、lint 和格式入口。复核 A7 仍为「部分实现」，且 A8 行和其他验收行的内容一致。Readiness 链接锚点在部署文档中存在。全产品浏览器 E2E 及真实外部运行不属本地演练验证；实际远端必需检查按 PR 门禁执行。

STOP：存在残留引用、实际证据不足、任何检查失败或需要改动文件范围之外的内容。失败时先还原本步骤删除的 RUNBOOK（仅从 T1 提交恢复该文件），保留 Readiness 草稿和失败证据，留在 T2。
