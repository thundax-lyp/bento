# WEB-06-06 至 WEB-06-09 临时 RUNBOOK

状态 **Not Executable，返修草稿，待同版审核**。建立于 2026-11-24。checkout 为 `/Volumes/storage/workspace/bento-b`，分支 `main`，基线 `2a097471e0da1ae255a2382c5a4b02a5e3920b2b`。WORKER `01a20c7d-abe5-7482-9e9e-9d29248f7d84`，MASTER `01a20c7c-59e6-7801-8d33-a7d0875f3cb3`。

## 执行者契约

本版只允许核对基线、走读和审核。T1 返修基于已获审 blob `0761490adeb4d2aa49f1aea888c0c66f95640af8`，等待本次修改的同版复审。只有同一 blob 获得 Executable 且 MASTER 发出分阶段指令后才能实施。PASS 需要实际运行、断言逐项成立和同版本证据。STOP 保留现场，记录最后通过步骤、基线、具体符号、最小复现及脱敏结果。各实施步骤通过后按 WORKER 规则移除该步并提交，单步含 RUNBOOK 最多十个文件。

## 目标与正式依据

四个场景共用原 Run 的待核对入口及 WEB-A10 实栈。A 的一次落盘中断产生待核对，可信侧用三个独立 Run 分别演练成功、失败及证据不足结案。保留 WEB-06-01 至 05 现有证据。

- WEB-06-06 保留原 Run、Session、Workspace，拒绝旧代写入。B 在最初 Worker 交付，C 从队列推进。独立观察 A 副作用恰好一次且无重放。
- WEB-06-07 可信侧确认完整成功结果后，在 A 原页面交付原 Run 补丁。
- WEB-06-08 原页面显示脱敏失败原因，安全证据齐备才开放重试。
- WEB-06-09 证据不足且确认停止、撤权及清理安全后可信结案。原 Task 关闭执行和交付，用户可读结论并独立新建，删除及注销清理继续，审计可回读。

依据为 [WEB Requirements 的 WEB-06、WEB-A10、WEB-01](../10-requirements/WEB-REQUIREMENTS.md)、[Web Interface 的执行输入与任务、Task 生命周期及项目删除](../20-interfaces/WEB-INTERFACE.md)、[Web Design 的详情、停止证明与可信结案](WEB-DESIGN.md)、[平台架构](../00-governance/ARCHITECTURE.md) 和 [Readiness 的 WEB-06、WEB-A08、A7](../40-readiness/CURRENT-READINESS.md)。

## 当前调用链和不变量

- `start.ts` 的 `BENTO_REVIEW_MODULE` 以进程内 installer 注入 `reviewRun`、`closeTaskRun` 和 `readTaskClosure`。用户 HTTP v1 入口没有这些能力。
- `service.ts:reviewRun` 接收必填 `runId:string`、`failedGeneration:number`、`readyGeneration:number`、`stableOperationId:string`、`expectedSnapshotSha256:string`。正整数旧代，READY = 旧代 + 2，恢复代 = 旧代 + 1，摘要为 64 位小写十六进制。要求原 Run 待核对、无 receipt、绑定一致、原代对应操作为 UNKNOWN。可信 snapshot 与摘要匹配后产出增量及累计 diff，现有 `Store.publishTaskResult` 提交。相同 proof 回读，冲突或摘要不符不发布。真实 SDK 中断与确认在 T5b 实栈验证。
- `service.ts:closeTaskRun` 接收必填 `runId:string`、`decision:'failed'|'unconfirmed'`、`expectedGeneration:number`。要求原 Task Run 有持久 admit、旧代退出证明、同绑定的新代 READY 无 Run/capability、历史无打开 handle 或未结 batch。当前 `TaskEvidenceStore.closeTaskRun` 在同一事务插入 `task_closure_audit(runId, decision, authorityGeneration, stopDigest, closedAt)`，以原 Run 为键，状态设 failed，写固定摘要。unconfirmed 同事务设置 Task 的 `closedReason='unconfirmed'`。相同代次与决定可重试，冲突拒绝。审计表独立于业务记录，停止摘要含退出回执摘要、绑定摘要、旧代和新代。数据库与 SessionHistory、authority 各有持久边界。
- `task-run-view.ts:taskRunViews` 从权威 Run 读取 summary 和 resultVersion，再基于 Task、最新 Run、持久 StopProof、Workspace 和历史 checkpoint 计算 retryReason。无 StopProof 得 `stop_unconfirmed`。可信确认失败属于结果判断，开放重试依然需要 `stopAndProve` 和现有 `taskRetryRecovery.readProof`。项目/注销不得替用户代结案。
- 公开 diff 只允许成功且已发布结果。UNKNOWN 不自动重放，旧代不能发送写操作。结案、重启和幂等重投必须维持原 Run 身份与门禁。确认成功、确认失败和无法确认三个分支各自用原 Run 结果取证。

## 范围与文件

以下为基线逐文件走读范围。计入直接相关生产逻辑、验证入口及验收复用部分，排除空白和纯注释，同行只计一次。表内范围供确定实施边界，最终修改白名单待 T0 后固化。

| 文件                                                                 | 基线行段                    | LOC | 归属                         |
| -------------------------------------------------------------------- | --------------------------- | --: | ---------------------------- |
| `apps/orchestrator/src/execution-service/service.ts`                 | 215–307、371–565、1338–1413 | 356 | 可信处理与删除/注销服务门禁  |
| `apps/orchestrator/src/execution-service/task-evidence-store.ts`     | 141–185                     |  45 | 原 Run 结案及审计            |
| `apps/orchestrator/src/execution-service/task-run-view.ts`           | 15–104                      |  88 | Run 结果投影及重试判断       |
| `apps/orchestrator/src/execution-service/task-retry-recovery.ts`     | 34–114                      |  79 | 复用 StopProof 验证          |
| `apps/orchestrator/tests/execution-service/reconciliation.test.ts`   | 240–423                     | 182 | 中断与可信确认回归           |
| `apps/orchestrator/tests/execution-service/project-deletion.test.ts` | 220–329                     | 109 | 现有 owner drain 验证        |
| `apps/workspace/api/src/server.ts`                                   | 158–218                     |  59 | 现有 `sweepAccounts` 验证    |
| `apps/workspace/web/acceptance/web-a08.spec.ts`                      | 97–355                      | 253 | 三账号验收和租户隔离取证参考 |

合计 1,171 LOC、8 个文件。补查 `apps/workspace/api/src/space-project-deletion.ts:spaceProjectDeletion` 与 `apps/workspace/web/src/pages/tasks/details/run-result.tsx:TaskRunResult`，尚未判定需要修改。

A 负责 A4 Workspace/Volume 引用、并发和物理回收。B 验收通过现有 `service.ts:advanceProjectDeletion`、`purgeOwner`、`purgeTaskSource` 调用 `execution.purge(binding, host.purge.bind(host))` 和 `Store.purgeProject`，以及 Workspace 的 `spaceProjectDeletion`、`sweepAccounts`。用无共享引用的项目与账号分别核对上下游，当前没有证据要求 A4 新能力才能验证 B 门禁。共享热点为 `service.ts` 和 `store.ts`，若 A 触及上述调用方或 `Store.ownerDrained/purgeProject`，两份计划须由 MASTER 对照实际文件与符号定合入顺序，再以合入版本复验。B 计划复用现有回收契约，A3/A4/A6 公共契约、共享卷物理回收及 WEB-07 新行为在范围外。

## T0：隔离资源与现有入口核验

前置状态为同版获审及显式开工指令。只读检查，产物为私有前置报告，无 Git 提交。本轮返修已再次确认草稿基线。远端已按环境说明认证，Docker Server 28.1.1。B 无根目录 `ENVIRONMENTS.md`，已定位 Git 忽略的 `dev.env`，以主 checkout 环境说明查 Docker、SSH、模型。远端在用户目录、`/tmp` 和 `/var/tmp` 搜索 A12/lease 私有材料。实测 13 份 host binding、16 份 overlay、51 份 host、19 份 candidate。与 Readiness WEB-A12 2026-11-23 的私有 harness 摘要匹配的 candidate 恰一份，对应 lease `cf3b6327-a443-464a-8cde-092e3cba32f1` 和源码 `1c4303e384b564a7af237b51e76334ad824cb4f2`。同一归档内的 `hook.mjs`、`host.mjs` 各有一个文件匹配 candidate 的 `privateSources`，host binding 文件存在。下列命令已按原文在受控宿主执行，退出 0。历史 A08 登录配置在这些搜索范围未命中。正式 A08 已从三独立受邀身份跑通，复用其 login 创建独立 Chromium context。新栈创建三名独立的 Keycloak 用户，启用邮箱验证状态和已配置的 Bento 组织成员身份，逐一确认 `oidc.ts` 验证的 organization、email_verified 和三个独立 owner；登录凭据写本轮 0600 私有文件。Compose 的 realm 指定和部署手册的组织邀请是装配依据。

连接 ENVIRONMENTS 指定 SSH 宿主后直接运行下列只读命令。它验证来源并仅输出成功标记。期望摘要来自 Readiness 的最终私有 harness binding 记录，文件散列取该 candidate 的 `privateSources`。不把旧 lease 下载、放入新状态或作为可运行配置。

```bash
python3 - <<'PY_A12'
import hashlib, json, os, pathlib, subprocess

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

expected = 'a3cc1514308a520cfaa7816c5958ace01dbacd4c151db13986c2e43d46150c81'
lease = 'cf3b6327-a443-464a-8cde-092e3cba32f1'
result = subprocess.run(
    ['find', os.environ['HOME'], '/tmp', '/var/tmp', '-maxdepth', '9',
     '-type', 'f', '-name', 'candidate.json'],
    capture_output=True, text=True, check=False,
)
candidates = [pathlib.Path(path) for path in result.stdout.splitlines() if lease in path]
matches = [path for path in candidates if os.access(path, os.R_OK) and sha(path) == expected]
assert len(matches) == 1
candidate = matches[0]
data = json.loads(candidate.read_bytes())
assert data['revision'] == '1c4303e384b564a7af237b51e76334ad824cb4f2'
state = candidate.parent.parent
host_binding = state / 'configuration/a12-host-binding.json'
assert host_binding.is_file()
tree = state / 'archive/debug-workspace/web-a12'
for name in ['host.mjs', 'hook.mjs']:
    files = [path for path in tree.rglob(name) if path.is_file()]
    hits = [path for path in files if sha(path) == data['privateSources'][name]]
    assert len(hits) == 1
print('A12_REFERENCE_VERIFIED')
PY_A12
```

PASS 为唯一候选、两份源码同归档精确匹配且输出 `A12_REFERENCE_VERIFIED`。若归档移位且复查失败，唯一恢复输入为可读候选所在的受控 A12 lease 归档根，它必须包含同摘要的 candidate 与其中登记的两个源码。

开工时用环境说明连接远端，以 `docker ps -a`、`docker network ls`、`docker volume ls`、`ss -H -ltn` 复核 `bento-web-a10` 前缀及回环 `28080`（Web）、`28494`（Mailpit）。前次四类冲突均为 0，A 另用 `bento-a4`。Gateway、Temporal namespace/task queue、Compose/网络/卷、S3 测试前缀和私有状态使用本任务前缀，内部服务无宿主端口。仅复用不可变镜像和依赖缓存，按 A7 和 A08 装配方法使用新状态、新三账号及独立业务凭据。核对现有 SDK schema `ExecSandboxEventSchema`、已识别 A12 监督文件的必要方法，核对可重建的 Keycloak 邀请与 S3 前缀配置。环境或身份归属无法确认时 STOP 在 T0。尚未创建新资源不构成外部阻断。

本次只读回查：SSH 退出 0，Docker 28.1.1、Compose 2.35.1；专属前缀容器、网络、卷、Compose 项目标签、两回环端口监听和 Docker 发布冲突分别为 0，私有根尚不存在。用仓库基础 Compose、探针占位配置和内存 overlay 验证合并结果，实际输出 `A10_PORTS_VERIFIED`，未创建服务。A12 candidate、应用版本、host binding 及全部 15 个 privateSources 文件均可读且摘要各有唯一匹配；签名范围内 `host.mjs` 含 Worker 退出观察和 restore 查询，未找到同名 `observeSdkRetrySafety`、`restoreTask`、`retryObservation` 或新物理停写方法。T1 只能把现有监督链用作来源，新增适配仍需提供这些受信语义并验证。已只读检查锁定 OpenShell 源包，`proto/openshell.proto` 声明两个 Exec RPC 均返回 `ExecSandboxEvent`；仓库现有 worker-reuse 入口以生成的 `ExecSandboxEventSchema` 序列化终态，并调用正式 decoder。实际本轮配置加载、A12 恢复命令适配、私有 realm 导入、三个新账号、S3 专属身份和前缀、Gateway、Temporal 与 Chromium 均待获审后核验或装配。本地 `dev.env` 可读且 Git 忽略，B 当前无本地 realm 导入目录。

## 实施步骤

每步允许文件包含本 RUNBOOK。下文列出的目录缩写仅用于明确完整路径：ES = `apps/orchestrator/src/execution-service/`，ET = `apps/orchestrator/tests/execution-service/`，W = `apps/workspace/web/`。从仓库根运行命令。每步只提交列出的产物，PASS 后移除已完成步骤并验证 staged diff，提交失败保留该阶段产物并重试同一次提交。STOP 保留现有工作区和独占现场并向 MASTER 报告。数据库与卷失败现场只做只读保全，由下一轮用新资源重跑。

逐步文件盘点含 RUNBOOK，表中「另查」为该步专门查证且不修改的文件。命令对依赖的常规构建或测试遍历不列为专门查证。

| 步骤  |                                                                                                                                                   修改或产物文件数 | 另查                                                                                                                                                                                                                   | 合计 |
| ----- | -----------------------------------------------------------------------------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| T0    |                                                                                                                                                       1（RUNBOOK） | `deploy/compose.yaml`、`deploy/README.md`、`docs/40-readiness/CURRENT-READINESS.md`、`apps/workspace/api/src/oidc.ts`、`W/acceptance/web-a08.spec.ts`、可信归档 `candidate.json`、host binding、`host.mjs`、`hook.mjs` |   10 |
| T5bw1 | 8（RUNBOOK、`lease.json`、`web.env`、`keycloak-import/bento-web-a10-realm.json`、`storage-ca.pem`、`storage/ca.key`、`storage/public.crt`、`storage/private.key`） | 无                                                                                                                                                                                                                     |    8 |
| T5bw2 |                                                                                                                  3（RUNBOOK、`lease.json`、`compose.overlay.yml`） | `deploy/compose.yaml`、`compose.env`、`web.env`、`storage-ca.pem`、`keycloak-import/bento-web-a10-realm.json`、`state/<leaseId>/oidc-loopback-fixture.mjs`、`state/<leaseId>/web-nginx.conf`                           |   10 |
| T5bf  |                                                                                                                     8（RUNBOOK、五个候选源码文件、两份私有适配器） | `apps/orchestrator/acceptance/single-node-restore/driver.ts`、`lease.json`                                                                                                                                             |   10 |
| T5bi  |                                                          6（RUNBOOK、`host.json`、`lease.json`、`compose.env`、`workspace-profile.json`、`runtime-approval.json`） | `apps/orchestrator/acceptance/web-a10/run.mjs`、`apps/orchestrator/src/execution-service/types.ts`、`deploy/compose.yaml`、`compose.overlay.yml`                                                                       |   10 |
| T5b   |                                                                                                                          3（RUNBOOK、`logins.json`、`lease.json`） | `apps/orchestrator/acceptance/web-a10/run.mjs`、`host.json`、`compose.env`、`deploy/compose.yaml`、`compose.overlay.yml`、`trusted-entry.mjs`、`review.mjs`                                                            |   10 |
| T6    |                                                                                                                                                                  6 | `package.json`、`apps/orchestrator/acceptance/web-a10/run.mjs`                                                                                                                                                         |    8 |

### 私有适配器依赖裁定

本轮依赖裁定以适配后的实际入口为准：

| 来源调用                                                                                                                                              | 本轮用途                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launcher.mjs` → `relay-boundary.mjs:parseWorkerIngress/listenUnixToLoopback`                                                                         | 原样复用绑定入口解析和每条请求的私有 relay，关闭时释放该请求的 relay。持续运行、信号与 IPC 转交由新 `launcher-supervisor.mjs` 按 T1a 接管。relay 文件无相对私有导入。                                                                                                                                                            |
| `accept-a-prelaunch.mjs` → `accept-supervisor.mjs:loadHostConfig/createSupervisor/workspaceSupervisor`，`docker-worker-driver.mjs:dockerWorkerDriver` | 保留当前 lease 的 prelaunch、空间见证和原容器检查。原单次 Worker 启动/完成调用不进入 warm 执行链，由 T1a supervisor 替代。SDK 安全重试只消费当前见证。                                                                                                                                                                           |
| `accept-supervisor.mjs`、`docker-worker-driver.mjs` → `worker-supervisor.mjs:workerSupervisor/assertPrivateDirectory/findCreated`                     | 保留原受控目录、容器身份与见证用的发现能力；`dockerWorkerDriver.wait` 的实际容器 wait 可供新 supervisor 使用。`observeAttached` 的 CLI 子进程退出不能生成 Worker 退出证明。                                                                                                                                                      |
| `worker-supervisor.mjs` → `exit-proof-gate.mjs:exitProofKey/newExitProofGate` 与 `workspace-witness.mjs`                                              | 复用身份键、见证格式及现有读取校验。原单次 gate 及发布生命周期不得代替新 warm supervisor 的独立 wait 与持久发布。`host-exit-observer.mjs:exitObserver` 按新目录读回持久记录。                                                                                                                                                    |
| `workspace-control-server.mjs:workspaceServer`、`workspace-control.mjs:workspaceControl` → `workspace-control-wire.mjs`                               | 保留既有 read/validate/call，T1b 只扩本轮观察动作。保留 `sdkWorkspaceDriver` 和 `volume-io.mjs` 的实际卷操作。                                                                                                                                                                                                                   |
| `host-overlay.mjs:withTrustedObservation` → 旧 `host.mjs:workspaceRecovery` 与 `worker.ts:invokeProcess`                                              | T1c 用本轮 exit observer、workspace wire 和 prelaunch 见证接线替代整个旧 `installBase` 及其单次 Worker 包装。历史 `host.mjs` 不复制。保留 `withTrustedObservation` 的独立身份、profile/witness 和 SDK 安全重试判定。                                                                                                             |
| 动态 `config.observationModule`、`sdkEntry`、`volume-io.mjs:support`                                                                                  | 前者固定为同轮配置提供、冻结时校验摘要的受信 `readSandbox` 导出，禁止沿用 A12 路径。SDK 入口固定本轮锁定安装的 `SandboxClient` 导出。volume helper 的动态支持固定本轮候选树的 `shared/text-snapshot.ts`，workspace witness 的 `types.ts` 也指向该候选树。三项归运行装配核验，不从 A12 复制源码。不能定位或导出不匹配时拒绝启动。 |

`accept-a-observer.mjs:readSandbox/bindSandboxObservation` 保留真实 Gateway 绑定、Docker 容器及卷挂载观察，继续复用 `readTrusted` 和 `sdkWorkspaceDriver`。其动态 `accept-a-site.mjs:readRuntimeProfile` 由 本轮已用受信读取与实际 SDK 已加载策略核对替代旧动态导入，核对 lease、实际运行 profile 摘要、权限和同一 Gateway/容器身份；原 site 动态入口与其递归依赖 `accept-a-site-live.mjs`、`accept-a-policy.mjs`、`accept-a-gateway.mjs`、`accept-a-external.mjs`、`accept-a-bridge.mjs`、`accept-a-probe.mjs` 均是历史部署装配，已查证来源唯一，均不进入本轮执行链。T5a 在本轮受控 host 配置指向 `adapter/accept-a-observer.mjs` 及同一配置的 `workspaceObservation`（`profile,profileSha256,volumeNamespace,runtimeApproval,runtimeApprovalSha256,sdkEntrySha256`），通过装配门禁核对受控 bytes 与实际已加载策略。禁止把历史 profile 摘要当成实际运行身份的证据。

A12 一次性接口边界已按保全摘要核对：`dockerWorkerDriver.create/start/kill` 不进入 warm 执行链，分别由本轮 create、attach 和带身份重验的 TERM/KILL 替代；`inspect/wait` 原样复用。旧 `workerSupervisor.create/permitStart/collect/verifyExit` 及 `workspaceSupervisor.exitPublish/findCreated` 依赖 A12 单次容器 proof 标签和阶段文件，不进入 warm 派发或结案。当前 admission 以新 supervisor 的逐次持久登记为唯一进程身份来源。`exitProofKey` 与 `exitObserver` 保留；`newExitProofGate` 不代替实际 runtime wait。prelaunch 只复用绑定与 profile/witness 核验；不能把旧创建、启动或退出发布串回执行链。relay 辅助函数要求创建时父目录 0700、socket 初始 0600，三条 relay 建好并校验 owner/本槽路径后，再只对本轮专用 Worker 视图设置已批准的 GID 与 0710/0660，随后才发当前请求，关流后按原 inode 清理。生产 T5b 实测相同 UID 的连接和隔离。

### Warm witness 已通过的装配前置

远端同版 launcher / warm container / witness fixture 18/18 通过，零跳过。私有产物 SHA-256 分别为 supervisor `0bd77254dbb34198d02bce13a7e073b51ac6e980d0880566a0132c842e19daf4`、overlay `aea012054834513f5d3fb59b5668a338928064c265be53ba504cfd133a17af02`、witness `20697a8f6514d447c3ce833e8dd6d4ac7e00a0bb6edf6d9c58efaf4d742ed396`、fixture `106b9381b0f120a2d22ce4890af5a7ee9adb50664672d61cb2f564a86813be93`。真实 Sandbox、容器、挂载与策略仅 T5b 验收。

T5b 的私有观察门禁由同 lease `taskObservation.acceptance:true` 和 `retryGateDirectory` 启用。释放文件名是 `<exitProofKey>.release.json`，必填 `{leaseId,sessionId,runId,generation,bindingDigest}`，模式 0600，只作用于读端。控制端须已独立确认 `needs_review/READY+1/UNKNOWN=0` 和完整 launch、exit、workspace witness，再原子发布。缺证据不会因释放而创建或开放安全重试。

### T5a 已保全证据

本轮 lease `19ad1918-3833-43e9-b2e8-f737e6f0ce9b` 私有输入归属、权限、配置摘要、空登录 fixture 和双槽核对通过，远端输出 `A10_T5A_PRIVATE_INPUTS_VERIFIED`。按获审结构命令运行两项模块语法检查与 Compose 结构解析，输出 `A10_PORTS_VERIFIED`。占位仅限结构解析进程，持久配置无占位和真实环境身份，应用未启动。OpenShell CLI 0.1.6、SDK 清单 693 个文件、A12 profile 参考摘要、10 个基础镜像 ID 与 Linux/amd64 MinIO 客户端发行摘要已登记到本轮 lease。可信通知私有 fixture 通过去重、重开读回及错租约拒绝。T5bf 仍须完成双适配器实际接线，T5bi 独立绑定实际运行身份，T5b 验收业务行为。

#### 生产接线字段核对

以下为从现有实际消费入口追出的必需输入，T5a 在已经允许的私有配置中登记，T5b 冻结候选后补齐并读取。配置和生成状态使用同一个 `state/<leaseId>`，相同字段不做跨 lease 回退。

| 阶段           | 必须可读、可验证的输入与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行服务启动   | `host.json` 需要 `taskObservationModule`、`prewarmWorker:true`、`workerSlots:2`、同轮 SDK workspace、Gateway/mTLS、锁定的 `sdkRaw` 与 image/policy digest。冻结绑定同文件内须带 `environmentVersion,workspace,taskObservation:{directory,exitDirectory,workspaceSocket,profilePath}`、候选树/manifest 字段与 `workspaceObservation:{profile,profileSha256,volumeNamespace,runtimeApproval,runtimeApprovalSha256,sdkEntrySha256}`。由同轮 Gateway/profile 验证产出 profile 文件，其严格字段为 `candidateSha256,environmentVersion,isolationPassed,leaseId,runtimeProfileSha256,sandboxImageId,validFrom,validUntil,workspace`。先启动 0600 workspace socket 和独立两槽 supervisor，再加载观察模块；socket、profile、证据目录需在启动时存在。 |
| 每次派发和退出 | supervisor 配置使用同轮 `project,leaseId,business,exitDirectory,slots[0..1]`，每槽包括独占 socket、容器镜像及 daemon、relay 视图、bootstrap 文件及依赖摘要、映射 GID。 `business` 指向服务实际落账的 `business.sqlite`，派发时必须以可信 owner 只读打开，当前 UID 的证据目录不能挂入 Worker。三份证据以同一 lease、admission、绑定和 Supervisor 记录关联。A10 冻结命令只根据实际容器 ID/StartedAt 停止 A，B 原身份不变。                                                                                                                                                                                                                                                                                                                    |
| 重启与可信读取 | 冻结树、受控 profile、两槽 supervisor、workspace socket 与业务/authority/history SQLite、退出和 witness 状态仍指向同一 lease。启动前检查既有登记并拒绝错身份；重建 Orchestrator 容器须随之重建 sidecar、清除旧端口登记并重跑三 ingress 和 mTLS 探针，停止顺序先关闭业务派发和 sidecar，再停止本轮两个宿主 supervisor 与受信上游；重启服务后走原 `exitObserver`/witness 读端校验，不能以重启生成缺失证据。可信模块用 `BENTO_REVIEW_MODULE` 装载，通知消费者需实际收取持久 needs_review，按 Run ID 去重并重启读回。                                                                                                                                                                                                                           |
| T5 观察与关闭  | 识别 launch、退出、workspace 观察三份原证据及其摘要，另记录业务原 receipt、SDK UNKNOWN、authority 代次与撤权、Session History、StopProof 和原 checkpoint 摘要；结案实体还须来自独立的绑定停写 query。真实策略、挂载、relay 及容器启动/结束事实与同候选 CaseReport 绑定。缺配置、部署身份不符或缺任何强制证据均停在当前步骤。                                                                                                                                                                                                                                                                                                                                                                                                                |

同 lease 的 sandbox 与模型输入按实际消费点补齐：

- 私有 `host.json` 的 `gateway` 指向 A10 mTLS relay，`ca/cert/key` 绑定该连接，`control:{command,args,cwd,env}` 指向 workspace controller 的本轮私有入口，`worker:{command,args,cwd,env}` 指向本轮 warm launcher。SDK raw 入口必须为 lease 锁定的 `raw.js`。`imageDigest` 和 `policyDigest` 分别取实际 sandbox image ID 和已加载 policyHash（规范成 `sha256:<64 hex>`）。直连 Gateway 的地址及 TLS 材料仅供受信 workspace driver 和独立观察，不挂入 warm worker。
- `workspace-profile.json` 是 SDK workspace driver 的运行参数。必填 `gateway,workspace,owner,runtimeDigest,runtimeRef,runtimeRoot,sdkEntry,cliPath,cliConfig,policyPath,volumeIo,textSnapshot,exchange,caPath,certPath,keyPath,dockerPath,dockerDaemonId,volumeNamespace,leaseId,environmentVersion`。其中 `owner` 为 `bento-web-a10`，workspace、命名空间、CLI 配置与 TLS 文件均归本轮，`sdkEntry` 和 `exchange` 指向已保全副本，`textSnapshot` 必须来自冻结树，`volumeIo` 用本轮已验适配器。直接观察 Docker daemon ID、名下 volume、sandbox 容器、实际镜像与唯一 RW 挂载。恢复 helper 在启动前预检 `volumeIo`、`textSnapshot`、`exchange` 的实际只读挂载。
- `host.json.workspaceObservation.profile` 是上述 profile 的 JSON **对象**，`workspaceObservation.runtimeApproval` 是独立的策略批准对象 `{policyHash,policy,workspaceMount}`，两者的 `*Sha256` 分别对消费者所用 `JSON.stringify` 字节计算。另将受信 `runtime-approval.json` 写至 `taskObservation.profilePath`，它只包含 `candidateSha256,environmentVersion,isolationPassed,leaseId,runtimeProfileSha256,sandboxImageId,validFrom,validUntil,workspace`。其中 `candidateSha256` 等于候选 archive SHA-256，`runtimeProfileSha256` 取独立观察器对 daemon、workspace、image、policyHash、规范化 policy 和 mount 三元组的实测摘要，与 profile 文件字节摘要各自登记。独立回读要求 SDK policy source 为 sandbox、活动 revision 已加载且无错误，并与绑定、Docker 容器和挂载相符。禁止用配置中的预期摘要替代已加载事实。
- Worker 模型装配使用 T5bd 的同租约 fixture provider 和依赖锁。它仅消费本次派发 prompt、binding、SDK grant、persistence/operation 两条本槽 relay 和只读 bootstrap；无模型外网或凭据需求。T5b 仍需记录独占 Gateway、Temporal、S3、两个槽、三独立 OIDC owner 以及浏览器可达和 TLS 信任。真实模型凭据与正常部署模型仍由原门禁管理。

### T5bm 已保全证据

本轮冻结 Worker 源码与依赖锁在 desktop-linux 构建成功，388 项供应链条目通过。传输归档 SHA-256 `7837e04b59a25c0e0a8878083aa7ce590537884e6578bb669fb1b6a949b5e1e7`。开发机 Docker `.Id` 为 OCI index `sha256:395d8095fce5dfd5c553aa4dde4b9da59692a0ee13b5e243dff06cd6e9bf9f2c`；从归档 `manifest.json` 的唯一同标签成员核对 config 原字节摘要，与测试宿主加载后 `.Id` `sha256:894e1f6c23e569c6f4600ba0735fedabd2a00e4af581184f7979fce2913eafea` 一致。两端平台 Linux/amd64、13 个有序层一致。测试宿主回读 pnpm lock、Worker 声明及两入口 DSH 包导入，输出 `A10_BOOTSTRAP_IMAGE_IMPORTS_VERIFIED` 和 `A10_BOOTSTRAP_IMAGE_TRANSFER_VERIFIED`，本轮 lease 已登记实际远端镜像 ID。尚无真实 Worker 启动 fixture 结论。

### T5bd 已保全证据

`A10_DSH_BOOTSTRAP_FIXTURE_VERIFIED` 已在本轮 T5bm 镜像以真实 `run-worker.ts --warm`、官方 DSH 和锁定 SDK 取得。三个独立角色各一次 Exec，exit 与 trailers 在 8 秒内，A-cancel 零写 Exec，未知角色和缺 bootstrap 均拒绝。Gateway 为无外网的容器内 fixture，真实卷和正式 relay 尚待 T5b。 服务器额外复跑 `A10_DSH_BOOTSTRAP_FIXTURE_VERIFIED`，A-write/C 使用正式服务发出的无末尾斜杠 ingress URI，B 覆盖带斜杠形式。复跑后同 lease 的 base 为 `89adfd2282aaed4eed705db8f9aafe867cb22b7cc5f2082b0483fe9ed6ccd917`，fixture 为 `406a51818e2bb89056618695d4bef36d65b0a6aad679b9c73e071296050aff0e`，依赖锁为 `a053d17942b1d3617880da07bcc1d766fcf63614693fd816aedd3df13ad54ecf`，原摘要保留为早次证据。已逐成员校验 A12 源参考和 SDK 补全证据。本轮 lease 回读 `A10_BOOTSTRAP_LEASE_BOUND`，锁 SHA-256 `1995694c361a472e85e3896a338131347e68692ca46a9dda32e7a0dad62c520e`，base `39136e1161228316607f41c016e88691dcb4d307c96ccb74d9b6a347c1cfc206`，fixture `474889803f6ba91d33f588672505b7aecd0c0c6e89370d1ce851d697a255cebc`。

本轮 `base.ts` 默认导出 `DshWorkerBootstrap`。固定用仓库 Worker 声明的官方 DSH 依赖安装真实 SessionStore、projection、AgentRegistry、AgentLoop、LLM 和 ToolRuntime。仅在本轮私有入口注册 provider `web-a10-fixture`、model `scripted`，通过 DSH 正常工具调用和 Session persistence 运行。执行 prompt 由 T5bf 浏览器驱动发送，固定为 `WEB-A10 <role> <marker>`，role 仅允许 `A-write|A-cancel|B|C`，marker 仅允许单个 UUID。拒绝其他 execute prompt；按现有 Worker 契约保留 recover。A-write、B、C 通过官方 SDK `SandboxClient.execStream` 执行同一个文件工具：在 `request.binding` 对应沙盒的真实 workspace 以 append 写入 `web-a10.txt` 的一行 marker 并 fsync 文件，成功即正常结束。目标 argv 用独立参数传递 marker，禁止拼接到 shell 程序。A-cancel 原 Run 在持久会话开始后等待取消，获准的新重试 Run 按 T5br 无写入正常完成。两者均不发起 SDK 写。A-write 不插入模型阻塞或沙盒延时，不替代实际 SDK 帧、不调用账本、不代写 receipt。Worker 仅用 admission 的 SDK loopback grant 和本槽现有 Unix relay，不读取直接 Gateway mTLS 私钥。本步骤的脚本模型只保证验收时序可复现，正常部署模型配置、资格和真实模型覆盖按现有门禁处理。

依赖锁与装配契约为 `dependency-lock.json` 固定记录 `leaseId,baseSha256,fixtureSha256,workerPackageSha256,pnpmLockSha256,sdkManifestSha256,sdkLockSha256,sdkEntrySha256,sourceRuntimeManifestSha256`，摘要均为文件原字节 SHA-256。目录模式 0710，两个挂载文件模式 0440，owner 为受控宿主 UID，组为 Worker GID 1000。两个 warm 槽只读挂相同 lease 的不可变 bootstrap 字节到 `/app/.bento-bootstrap`，各槽保留独立 relay 及 admission 证据。已以 0600 临时文件、fsync 和同目录原子 rename 将 `bootstrap:{directory,lockSha256,baseSha256,fixtureSha256}` 登记到本轮 `lease.json`。T5bf 从 lease 将该记录纳入冻结身份，T5bi 将同一记录绑定在正式启动许可下，T5b 用实际容器挂载与 Worker 字节重验。Worker 构建使用当前候选的 `deploy/worker/Dockerfile` 与冻结 pnpm lock 安装 DSH，随后用本轮已锁的 SDK 目录做独立 build context，在私有验收 Worker 镜像内只读安装到 `/app/.bento-sdk`，`base.ts` 从该目录的 `dist/index.js` 导入。T5b 对实际镜像重验 SDK 闭包、DSH 锁、启动 argv、UID/GID 和只读挂载。本步只用 T5bm 已登记的隔离 fixture 镜像，T5b 使用冻结候选构建的 Worker 镜像。

### T5bn 已保全证据及运行拓扑

仅经 SSH 在测试服务器执行。无业务 Runner 的 fixture 输出 `A10_LOOPBACK_NETNS_PREFLIGHT_VERIFIED`，三协议、实际宿主 Unix relay、TLS 透传、同 netns、背压、错误登记拒绝、宿主和 `--network none` 直连拒绝及清理均通过。合成 ports 由 fixture 原监听分配，生产端口仍在 T5b 启动后回读。Compose 静态渲染仅发布 28080/28494。预检报告 SHA-256 `395e02b8d0e0f907df9144a644b81c66494dc9a9d513f662962e99bfaeb59c53`，已将 overlay、三个桥接文件和报告摘要登记同一 lease。预检的早次超时只清理经过标签与身份核验的临时资源，服务器没有遗留预检容器、网络或 socket。业务 Compose 仍未启动。整合时补齐获审的 Orchestrator 同绝对路径挂载和 bridge 环境，服务器静态渲染输出 `A10_ORCHESTRATOR_SHARED_STATE_SHAPE_VERIFIED`。overlay 新 SHA-256 `a8d118cd683e4c4eacdb6cad25a67efc31c410308c81011546fade84d6a4469e` 已回绑同 lease。

以下拓扑在 T5bf 冻结后与 T5bi/T5b 沿用。

1. `compose.overlay.yml` 包含唯一服务 `a10-loopback-relay`，使用本轮已登记的 Node Linux/amd64 镜像 ID，命令为 `node /bridge/loopback-bridge.mjs --serve`，`network_mode: service:orchestrator`、`depends_on.orchestrator.condition: service_started`、`user: "1000:1000"`、`read_only: true`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`。用 YAML 字符串 `"no-new-privileges:true"`。本轮 overlay 对 Orchestrator 与 sidecar 均设置 `restart: "no"`，禁止自动重启后继续使用旧端口登记。侧车无 `ports`、额外 `networks`、`privileged` 或宿主 PID，共享的只有该 Orchestrator 的网络命名空间。挂载 `loopback-bridge.mjs` 为 `/bridge/loopback-bridge.mjs:ro`，另只挂本轮 socket 目录 `state/<leaseId>/br` 为 `/bridge/sockets:rw`。运行版本和租约 ID 由无凭据信息的 env 传入。该容器无 Docker socket/CLI、业务卷、lease 源文件或 Gateway/mTLS 密钥。
2. 宿主 supervisor 仍用同轮已验 Docker driver，留在可信宿主。其两个各自 UID/GID 1000、0600 宿主 socket 保持原地址，Orchestrator 可信 launcher 仅通过其受控配置的这两个 Unix socket 派发。Host launcher 运行位置固定为 Orchestrator 容器内的 `commandHost.worker` 子进程。host 与 Orchestrator 的相关私有路径按同一绝对路径挂载，sidecar 仅视图挂载上述 `br`，warm Worker 继续 `--network none`，只见该槽原 relay 视图及只读 bootstrap。两槽 relay 的 `queue-gate.sock`、supervisor socket 与 `br` 相互独立。所有 socket 根归宿主 UID 1000，`br` 目录 0700，sidecar socket `bridge.sock` 与宿主受信上游 socket `upstream.sock` 均 UID/GID 1000、0600，真实端到端 Unix 路径在 Linux sun_path 限制内。
3. `launcher.mjs` 在透传原 WorkerRequest 前，从其 `persistenceUrl,operationUrl,gateway` 取得三个不同的实际回环端口，拒绝非 `http://127.0.0.1:<port>`、重复或外来源。向 `bridge.sock` 单次登记 `{leaseId,kind:'register',ports:{persistence,operation,sdk}}`，等确认后继续原派发。登记只能来自挂入 `br` 的可信侧，Worker 无该目录。进程生命周期内第一组绑定后仅允许幂等重登，拒绝端口变更。宿主 `relay-boundary.mjs:listenUnixToLoopback` 在正式受信配置通过 Unix bridge 打开 `{leaseId,kind:'connect',role,port}` 对应角色（由原 socket 文件名固定映射），桥仅拨已登记的三条 **sidecar 自己** 的 `127.0.0.1` 端口。保持原 Worker grant 端到端和输入背压。固定首行最大 1024 字节、控制应答 `OK
`、再双向原样转发后续字节，注册、连接和源校验失败即关闭。现有注册与数据 Unix socket 连接禁止以其他路径回退。仅既有明确 fixture 模式保留同进程直连，真实运行无桥配置必须拒绝。禁止把桥暴露成任意 TCP 转发。
4. mTLS 冻结层继续由可信宿主的 `trusted-entry.mjs` 持有，只在 `br/upstream.sock` 接收原 TLS 流并终止/转发到本轮真实 Gateway。Sidecar 另外只在共享 netns 中监听 `127.0.0.1:18789`，通过 `upstream.sock` 双向透传 TLS，既不读也不持有密钥。Orchestrator 的 trusted host `gateway` 使用 `https://127.0.0.1:18789`，证书必须包含该 IP SAN，沿用 Orchestrator 私有客户端证书。宿主真实 Gateway 通过隔离 bridge 网络的已登记地址访问，连接使用实际证书身份与同轮 CA。要求镜像 ID、daemon、网络和 Gateway 身份可重验。持久配置不发布此端口。禁止为可达扩大至宿主监听、开通额外端口或给 sidecar/Worker 注入 TLS 文件。

### T5bg 已保全证据及运行契约

服务器运行 `node --check`、`node --test`，7/7 通过、零跳过。覆盖错租约/原 admission/绑定/SDK origin、未撤权零请求、真实 locked SDK 到 loopback fixture 的只读 GetSandbox、并发重入、超时、失败、主动释放、进程退出、Buffer 清除，以及 0600 证据仅含 gRPC 状态和摘要。已在同 lease 回读 `A10_OLD_GRANT_FIXTURE_BOUND`。私有 supervisor SHA-256 `96ae0a8b36f7f58286f0c2ee4f869d989dd4d2d4fbfca2da83ed435309b0c730`，探针 `57558a6047d1cc4a22450c4b2e3ec9cfc6ebda255c3baf2459d99ecb81beb148`，fixture `2908f58156e7d3164ade659106d0ccc45b4d037d357c96533711ce016932e735`。使用本次 SSH 进程 netns 作为参数进行 `sudo -n -l` 完整 argv 许可检查，输出 `A10_NSENTER_ARGV_PERMISSION_PREFLIGHT_VERIFIED`。真实 netns 切换、真实失效 grant 拒绝留 T5b。未运行本机 Docker。

T5bf 保留探针同进程约束。可信宿主在已准许的 A-write 排队屏障登记时，写入同 lease 0700 `grant-probe-cases/` 中 0600 `<markerSha256>.json`，只含 `{leaseId,markerSha256,deadlineNs}`，`deadlineNs` 为服务器 `process.hrtime.bigint()` 的十进制字符串。同一 deadline 同时限制屏障与探针。T5bi 冻结核验后显式开启 `oldGrantProbe.enabled`，T5b 启动受信 supervisor 时传 `BENTO_WEB_A10_OLD_GRANT_PROBE=1`、校验后的 `BENTO_WEB_A10_ORCHESTRATOR_PID`。能力不经此记录传播。

1. `old-grant-probe.mjs` 仅由本轮私有 `launcher-supervisor.mjs` 同进程调用。只有同 lease 显式开启 WEB-A10 探针、`execute`、且持久 admission 与 `WEB-A10 A-write <UUID>` 原 prompt 同时匹配，才从 supervisor 已收到的原 `WorkerRequest` 将 opaque grant 保留为一次性进程内 Buffer，并固定 `{leaseId,runId,sessionId,generation,bindingDigest,gateway}`。原 gateway 必须为该 WorkerRequest 的三 ingress 登记中 `sdk` 的原回环 URL，绑定到启动时核实的 Compose 项目、Orchestrator netns 与正式 ingress 进程。B、C、A-cancel、recover、普通 host 和无显式验收配置时不捕获。不得由数据库哈希重建 token。不得增加 Worker 权限或修改正常派发。
2. 真实探针由可信宿主 supervisor **直接**在 Orchestrator netns 连接原 h2c SDK ingress。验收 Orchestrator 启动后，用服务器受控的单次 `nsenter --net=/proc/<已核 Orchestrator 容器 PID>/ns/net` 启动两个宿主 supervisor，启动后立即以宿主 UID/GID 1000、保留原 Docker socket 访问组、`no-new-privileges` 身份运行 Node。只切 netns，保留宿主 PID、mount、Unix socket 与原 Docker driver，启动器与命令参数均不含 grant。启动命令固定为 `sudo -n /usr/bin/nsenter --net=/proc/<pid>/ns/net -- /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs <宿主已核 Node 绝对路径> <私有 launcher-supervisor.mjs> <本轮 lease.json> <slot>`。用只含本轮 supervisor 启动所需配置路径与标识的环境。只读核验已确认服务器有 nsenter、setpriv、sudo，当前 SSH UID/GID 为 1000 且 CapEff 为零，`sudo -n -l /usr/bin/nsenter` 返回 0。正式准备仍须先核对实际 argv 的许可与降权后的身份，当前未执行提权或 netns 启动。启动验收前逐槽核对 netns inode 与 Orchestrator 相等，并核对 UID/GID、Docker 保持原已验证权限和无有效 capability。之前 T5bn 的 sidecar 维持现有 Worker 数据桥和 TLS 透传，探针字节不经过其 Unix bridge。禁止让其他进程替探针连网、在新增端口转发 token 或给 sidecar/Worker 增权。若服务器无本轮已批准的受控 netns 启动方式、不能在降权后保持原 Docker 访问、或无法保证直接 origin，STOP 并单列所需服务器启动权限，禁止临时开端口或扩大容器权力。
3. 定向终止后先由原 supervisor 发布独立 OS wait 退出记录，原 slot 正常释放。一次性探针保留在**同一 supervisor 进程**的受控后台任务中，不占用 Worker 槽。读原 admission 与执行服务 authority，要求原 session、绑定、原代和原 Run 的证据一致，独立观察到该代撤权已完成（同代 `DRAINING` 无 capability，或同绑定已经推进且持久行不再含原 capability digest）。为原 token 计算比较摘要只在内存使用。确认撤权前不向 ingress 发送任何探针，且请求租约、绑定或原 gateway 不匹配时销毁记录。探针仅经直接连接向原 SDK ingress 发送一次正式 SDK schema 编码的 `GetSandbox`，目标限原 admission 的 sandbox/workspace；该调用是只读授权检查，不发 `ExecSandbox`、不提交写操作、不触发账本保留。要求收到正式 gRPC `16`（已撤权拒绝），连接超时、成功、其他状态均失败。只记拒绝状态和以固定租约、admission、绑定、origin 身份计算的证据摘要。证据路径由已校验原 admission 的 `exitProofKey` 导出，为同轮 0600 `<key>.grant-denied.json`。文件不得含 token、Authorization header、token digest 或请求载荷。
4. 探针发起前将记录移出可请求集合，结束立即清零自有 Buffer、解除临时 header 和其他引用，重入及重复触发拒绝。验收失败、取消、主动释放、超时、gate 关闭与 supervisor 停止均清除。只有 A 的独立退出后的探针等待可跨槽释放保留，最长到本案单调期限；不能因槽被复用、正常收尾或 supervisor 重启而重新取得 token。除正常路径已获授权的原 Worker 派发，其余禁止把 grant 给浏览器、host hook、sidecar、TLS relay、其他进程、命令行、日志或文件。Probe 模块只向正式 ingress 直接使用原 token，不暴露取回 token 的 API。若运行环境只能通过其他进程转运探针，即为 STOP。

### T5br 已保全证据及运行契约

同 lease 的 SQLite 血缘 fixture 输出 `A10_RETRY_CLASSIFICATION_VERIFIED`，覆盖未入账或未 queued、伪造、错 Task/session/代次/绑定/租约、缺字段与重复拒绝。服务器真实 warm Worker fixture 输出 `A10_DSH_BOOTSTRAP_FIXTURE_VERIFIED`，原 Run 等待取消，复用同 prompt、同 session 的独立新 Run 正常完成，均零 SDK 写。缺分类、伪造、错租约和错 admission 均拒绝，A-write/B/C 原终帧断言仍通过。该 fixture 使用合成持久样本和受控分类应答，真实 API 重试链留 T5b。

已通过 `A10_RETRY_CLASSIFICATION_BOUND` 绑定本轮字节。分类器 `f2b464fec442c2d4e625c7529213f20aa9aa8e858e6769fdee734c1d0a8885b0`，当前 supervisor `5586193bdc0722f24258214f7b84b6d77b2bbc5f827e288d668adfbf02537eee`，分类入口 `e588619be846e871412645661ab9205b2833fcd73923a71819150eaccd9695ba`，bootstrap 锁 `ab89597f64ea6535d7c50f578f548a4fa44677bd104390d31cb8d21becd4b4d2`，base `68cb5887adacf2e1cc9a176113c983f2a8925ea41900f6abbf1ba349e27ca691`，fixture `603fa5e1f7436a981373b3295e026a2c1413a606742682437a8ca05ca308e1bd`。T5bg 探针模块及测试字节不变，lease 中共享 supervisor 摘要已更新。T5bf 将当前分类器、supervisor 与最终 trusted-entry 摘要绑定候选。

1. `Store.finalizeTaskRetry` 固定复制 `source.prompt`，以 `retryOf=source.id`、`expectedGeneration=attempt.newGeneration` 插入新 Run。同一事务将 attempt 置为 `queued/history_restored`。私有 supervisor 在原有 `admission(request)` 完成后、发布本槽私有登记前，仅在 WEB-A10 验收且匹配 `execute + WEB-A10 A-cancel <UUID>` 时，调用 `adapter/retry-classification.mjs:classifyA10CancelAdmission`。只读打开同 lease 服务持久库，使用 supervisor 已核身份做参数化读取。检查 current Run `id,projectId,sessionId,taskSequence,prompt,receipt,status,admittedGeneration,admittedBindingDigest,retryOf,expectedGeneration`。必须是持久真实 Task、同 WorkerRequest 绑定、原 prompt、运行中、receipt 为 0，当前 generation/digest 与 admission 一致。其他角色、recover 和未启用的正常 host 不执行分类。
2. 只产生两个分类。若 current Run 的 `retryOf`、`expectedGeneration` 都为 null，且 `retry_attempts` 不存在将它列为 `newRunId` 的记录，分类 `cancel-source`。否则只允许 `safe-retry`，要求唯一 `retry_attempts` 记录同时满足 `newRunId=current.id,sourceRunId=current.retryOf,taskId=current.projectId,phase=queued,lastConfirmedPhase=history_restored,error=null,newGeneration=current.expectedGeneration=current.admittedGeneration`。原 Run 必须存在、状态 `failed`、本身非重试、与新 Run 同 Task、session、prompt、admittedBindingDigest，且 `oldGeneration=source.admittedGeneration`、`newGeneration=oldGeneration+1`。原 Run 有 `task_closure_audit.decision=failed`、同新代的 closure audit，以及持久 stop proof 和 Workspace/History checkpoint。attempt 的两摘要须与该 checkpoint 对应。任何缺字段、关联不唯一、伪造或错租约/Task/session/原 Run/绑定/代次均拒绝，不回退到 original 或完成路径。分类器 fixture 使用与生产字段相同的独立 SQLite 只读样本，不能改应用库。
3. supervisor 将分类写入当前槽的原有 0600 admission 登记，仅在该 A-cancel 派发持有，随槽切换清除。复用该槽现有 `queue-gate.sock`，`trusted-entry.mjs` 识别 `{kind:'classify-cancel',runId,generation,bindingDigest,markerSha256}`，按 socket 固定槽与只读登记核对相同 lease/admission/marker，单 admission 只应答一次。回复字段固定为 `{leaseId,runId,generation,bindingDigest,markerSha256,classification}`。bootstrap 以本地已锁 `dependency-lock.json` 的 leaseId 加原请求身份逐项校验，遇缺失、重复、错字段、错值或 socket 超时直接失败。此分支只分类，不等待 A/B 放行，不传业务 grant、retry 请求、attempt 细节或 DB 路径。不加网络监听、不改 WorkerRequest、Run、Web/API 契约或调用方身份。
4. 私有 `base.ts` 原 A-cancel 必须取得 `cancel-source`，正常完成首轮 Session 持久化后等待原取消，SDK 写调用为零。新 A-cancel 取得 `safe-retry` 后用同一已锁脚本模型正常发布成功结论、正常结束，仅允许原有只读 provider 请求，SDK 写调用仍为零。禁止用 prompt、Run ID 格式、代次大小、空会话或缺字段推测角色。现有 A-write/B/C 和 recover 流程保持原样。

T5b 通过普通用户界面的安全重试调用，交叉比对 API 分配的 `newRunId`、持久 attempt 的 `newRunId/sourceRunId/taskId`、新 Run 的 `retryOf`、原 session、start generation 与 supervisor 应答使用的实际新 admission。要求是同一个新 Run，状态真实进入 `succeeded`，原 Run 仍为原 ID 且状态 `failed`，两次均零 SDK 写。只记脱敏证据及摘要，禁止用 fixture 回执取代实栈。

### T5bo 完成记录

服务器无业务 NGINX fixture 通过 `A10_NGINX_OIDC_LOOPBACK_VERIFIED`。原代理头、8080 与容器回环 28080 分工、其他容器直连拒绝、错误 issuer 拒绝及现场清理均通过。结构检查 `A10_NGINX_OIDC_COMPOSE_VERIFIED` 验证有效只读配置 bind、原 Web 数据卷、严格 issuer、原有两条发布及第三条发布拒绝。NGINX 配置 SHA-256 为 `b2c97491fce5b790e9647cc8f6d3d18b6eb69cc85c9d76d588207dd8f8c312c6`。fixture、报告及合并 overlay 摘要依次为 `9c366298ad4f03025da1148979b8a0fb7329d70e01a0ec1a35e262d3b1e391bc`、`f6ebf29afe3ff6b1a8de49e9f0c38b7030b41af77f5514be899778dfb84396af`、`2e54d02b07ab67ba89bc774fab7cad75c534d1dccf7043f2e4c8a9c9be257a42`，已由 `A10_NGINX_OIDC_LEASE_BOUND` 核对本轮 lease 回读。实际 OIDC discovery、redirect/callback 及登录证据仍归 T5b。

### T5bt 完成记录

服务器对 `dev` 和 `dev + worker-image` 分别通过 OIDC 挂载和双端口结构断言。三镜像结构对账、分别缺每个镜像变量的拒绝、`dev` 下无 Compose Worker 均通过，输出 `A10_IMAGE_OVERLAY_STRUCTURE_VERIFIED`。同轮 lease 回读输出 `A10_IMAGE_OVERLAY_BOUND`，新 overlay SHA-256 `880d4570107aa6d0f83d053b73bdfd1e0a7a3e5dced65c31e90065685953b729`。T5bo 报告仍绑定原 overlay 摘要，未持久化结构占位，也未启动应用。

### T5bw1：为本轮 Web 准备启动输入

前置 T5bt PASS，所有私有路径均以服务器 `$HOME/bento-web-a10` 为根。只处理表中 8 条路径，属主为本轮受控 UID/GID 1000。新目录 0700，私有文件 0600。敏感文件只在该宿主私有目录，生成命令禁止 shell trace、输出值、放进命令行参数、Git、候选归档与 CaseReport。生成和确认都在同一 lease 内完成，已有输入重跑必须属主、摘要与租约一致。所有 Docker 操作只经 SSH 在服务器执行。

1. 生成私有 `web.env`，允许的键精确为 `BENTO_OIDC_CLIENT_ID`、`BENTO_OIDC_CLIENT_SECRET`、`BENTO_OIDC_ORGANIZATION`、`BENTO_SPACE_DB`、`BENTO_SPACE_S3_ENDPOINT`、`BENTO_SPACE_S3_BUCKET`、`AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`NODE_EXTRA_CA_CERTS`。固定 client ID `bento-web-a10-web`、组织 alias `bento-web-a10`、DB `/data/space.sqlite`、S3 origin `https://bento-web-a10-s3:9000`、bucket `bento-web-a10`、region `us-east-1` 和容器 CA 路径 `/run/bento-web-a10/storage-ca.pem`。用受控进程的加密随机源生成 client secret 与独立限桶访问对，按原子 0600 文件写入；不写 MinIO 管理凭据。依赖 Compose 既有 `BENTO_AUTH_MODE`、公开 origin/issuer、`BENTO_ONE_TWO_URL` 与 bearer、MySQL host/user/db/password，保留最终镜像的 `BENTO_ONE_MODE=http`、`BENTO_ONE_PORT=4101` 和 Web 用户 1000。原 `/data` 专属卷继续为可写。不得设置 `NODE_TLS_REJECT_UNAUTHORIZED`、`AWS_CA_BUNDLE` 或额外的凭据搜索链变量。
2. 生成 `keycloak-import/bento-web-a10-realm.json`，realm 启用组织功能，仅登记同 alias 组织和上述 confidential client，client secret 与 `web.env` 同值，启用标准授权码和 S256，精确 redirect URI `http://127.0.0.1:28080/api/oidc/callback` 、精确 post logout redirect `http://127.0.0.1:28080/auth` 及有效公开 origin，沿正式 `openid email organization:*` 请求取得组织 claim。文件内无用户、业务数据或历史账号。用已有 Keycloak realm import/health 顺序在 Web 启动前导入；三账号仍在 T5b 双视角预检后建好并加入该组织。重跑不能把已有 realm 覆盖成新 client 或改动账号。
3. 用本轮私有 CA 签发 MinIO 叶证书，SAN 仅 `DNS:bento-web-a10-s3`，EKU 为 serverAuth。CA 公钥输出 `storage-ca.pem`，签发密钥仅保存在 `storage/ca.key`（不挂载），叶证书及密钥固定为 `storage/public.crt`、`storage/private.key`。可以用 openssl 的 stdout/进程替换处理 CSR 与扩展，避免新增持久文件。对固定 hostname 执行 `openssl verify -purpose sslserver -verify_hostname bento-web-a10-s3 -CAfile storage-ca.pem storage/public.crt`，要求另一个 hostname 用相同命令失败。验证三项 env 输入与 realm 的结构、secret 同一性仅返回布尔。Lease 登记用途、路径与公开 CA/叶证书摘要；`web.env` 和含密钥配置仅在私有 lease 保存完整性摘要，Git、候选归档、CaseReport 只记录键名和存在/权限等布尔结论。PASS 以 `A10_WEB_INPUTS_BOUND` 及当次 TLS 正反例通过为准。错归属、生成、读取或比对不符则 STOP。

### T5bw2：固定同轮 Web 和 Keycloak 的私有挂载

前置 T5bw1 PASS，overlay 原 SHA-256 必须等于 T5bt 活动摘要。只处理表中 10 条路径，保持五份候选改动原样。

1. 仅在本轮 overlay 将 Web 的 `env_file: !reset []` 改为 `env_file: !override`，设置唯一绝对路径 `$HOME/bento-web-a10/web.env`、`required: true`、`format: raw`。向 Web volumes 追加 `storage-ca.pem` 到 `/run/bento-web-a10/storage-ca.pem` 的长式只读 bind，`create_host_path: false`，保留原 NGINX bind 和 Web 数据卷。Keycloak 用完整 `volumes: !override` 固定恰好两项只读 bind：冻结源码的可信原 `deploy/keycloak/theme` 到 `/opt/keycloak/themes/bento`，本轮唯一 realm 文件到 `/opt/keycloak/data/import/bento-web-a10-realm.json`。两项均使用 `create_host_path: false`。命令改为 `[start, --import-realm]`，保留数据库、固定 realm/issuer 和无发布。禁止挂 CA 签发密钥、S3 叶私钥或历史目录。
2. 依 T5bt 同样的镜像与版本占位在单次命令作用域，用服务器 `docker compose --profile dev [--profile worker-image] --project-name bento-web-a10 --env-file "$root/compose.env" -f deploy/compose.yaml -f "$root/compose.overlay.yml" config --format json --no-env-resolution` 分别渲染两套 profile。JSON 只送入断言，先检查 Web 唯一 env_file 的路径、required/raw，分别查证属主、0600 及 T5bw1 允许键名，核对 CA、realm 和 NGINX 挂载源/目标/只读及原数据卷。对每套渲染，机器断言 Keycloak 有效 volumes 的完整集合恰等于上述两个 bind，逐项比对真实绝对源、目标、只读及禁止自动建路径。额外的 `/opt/keycloak/data/import` 父 bind、`debug-workspace`、任何历史输入或额外挂载均拒绝。复用 T5bo OIDC/端口 fixture，两套都必须精确只发布 Web/Mailpit。对断言输入替换成历史 env 路径、可写 CA 或第三条发布，均须拒绝；不得运行 Compose up、打印或归档渲染。原子更新 lease 活动 overlay 的三份登记摘要，同步保留 T5bo 原报告所指旧摘要和 T5bt 验收记录。挂载来源、权限或实际渲染不符则 STOP。PASS 输出 `A10_WEB_STARTUP_STRUCTURE_VERIFIED` 与两套结构断言，仅 RUNBOOK 提交。恢复按 T5bt 相同规则以原摘要与唯一精确替换重算。

### 2026-11-24 最小实栈阶段记录

- 基线已同步 #97 的 Readiness 变更。服务器本轮源归档的 tree 为 `94282e657b64ae7ef1ab3b3785fd2607788c15ff`，archive SHA-256 为 `0c0f2edff2eb0ba18cd06f7ccfa9652daf2966dea5c60467db3cca461f2b6579`。这是最小启动归档。T5bf 的正式候选冻结和与本次提交的等同性门禁仍待完成。
- **已实测通过**：本轮 Web、Keycloak、MySQL、Postgres、Temporal、Mailpit 和私有 MinIO 启动。Web 首页 200，匿名会话 401，discovery 200，OIDC 授权入口 303，回调 URI 与 S256 核对通过。三个隔离 Chromium context 完成真实 OIDC 登录并回读三个不同账号。Chromium 仅在临时信任库导入本轮 CA 后完成签名 PUT 200，独立限桶凭据验证 PUT/GET，未信任 CA 时请求拒绝。宿主发布仅为 Web 28080 与 Mailpit 28494 两个回环端口。
- **已实测通过**：独占 OpenShell Gateway 的 mTLS、同轮新 workspace 的实际 SDK 请求、配置探针沙盒加载 sandbox 来源的策略并进入 ready。策略回读摘要为 `3ca9183bd50568bd91b488f6421800d4574533d940168d1c1dbdfcd018aa8cd8`。Docker 停止前回读确认该探针的本轮卷为实际可写挂载。完整独立 runtime approval、真实 Run 的挂载身份和停写观察仍待完成。
- **实际故障与定向修复**：服务器 Web 构建的 `go mod download` 访问公共代理超时，使用同锁公共依赖归档 `8e6e04071591fb329383d98c32acad9c9ce58d469d991fbe0dff448a299af783` 验证并离线重建。首次 Web 启动因归档解包模式导致 `/app/register-paths.mjs` 读取 `EACCES`，按归档原模式重新构建后恢复。Temporal 的 SQLite 卷初次写入失败，修正本轮卷属主后健康检查通过。Keycloak client 添加应用请求的 `email` scope 后真实登录通过。Chromium 使用已核 Noble NSS 公共包 `0bb7919188cb21d3bfba5d45b5aa45848aa61b92ced34ff3f8ecda7b92d788c0`。Gateway 探针先遇命名长度、策略回连及卷标签拒绝，定向修复后取得上述 ready 和策略回读。
- **待续接**：本轮按用户要求停止在最小启动验证。启动报告 `minimal-startup-evidence.json` 的 SHA-256 为 `47761d4618295180827c388a3efd78c0d5e339ae3f18df6a66ae66480ec4f1e6`。T5bw1 的私有输入已实际使用。T5bw2 的正式双 profile 完整结构断言未签字。续接从同租约只读核对输入和已保全状态开始，再完成 T5bf 的正式 runner 入口以及 T5bi 的独立 profile、停写接口与真实环境许可。Orchestrator 未启动，A/B/C 未提交 Run，完整 WEB-A10、可信结案和删除注销验收均未通过。本轮未创建 PR。
- **运行现场**：停止前后证据摘要分别为 `5ae3c23da44cb8bade667b3cae9abd334fc6eb923729e64d55520efc459f4c42` 和 `b87d7a9889903e5ff009362444fbb0ff5e8737fac4d878f7660211f614ef9bcf`。12 个确认归属的容器均已停止或在停止后消失，按 Compose、lease 和 OpenShell namespace 标签复核运行中为零。保留 5 个 Compose 卷和 3 个 lease 标记卷、网络、候选镜像和私有原始证据。
- **候选保留**：验收 runner、浏览器配置、用例和受信 hook 保留在本 checkout 工作区。runner 当前只有 `--freeze` 的 CLI 入口，`--bind-environment`、`--prepare`、`--verify`、`--cleanup` 尚未完成。验收草稿与上述私有配置、凭据和原始运行证据均未纳入提交。

### T5bf：实现验收入口并冻结候选

前置状态：同一 lease 的 T5a、T5bm、T5bd、T5bn、T5bg、T5br、T5bo、T5bt、T5bw1、T5bw2 已保全证据均通过。允许修改 W 下 `src/pages/tasks/details/index.tsx`、`playwright.web-a10.config.ts`、`acceptance/web-a10.spec.ts`、`acceptance/web-a10-hook.ts`，以及 `apps/orchestrator/acceptance/web-a10/run.mjs`。本轮私有 `trusted-entry.mjs` 实现宿主 relay 和操作服务端，`review.mjs` 在同 lease 接入可信回调。两文件及私有配置、日志留在 checkout 外，由 `--freeze` 记录更新后的两文件摘要，T5bi 写入 lease，禁止提交。T5bf 同时冻结 lease 的 `webOidc` 配置、报告和 overlay 摘要，正式许可必须绑定这些同版输入。禁止将历史 A08/A12 状态装入本轮。

执行：

1. 在原详情待核对文案追加 T4 固定下一步。新增配置只运行 `web-a10.spec.ts`，用 T0 的独占 Chromium、Web origin 和本轮登录 fixture；入口要求 Compose 项目名 `bento-web-a10`。利用 WEB-A08 三独立浏览器 context 的邀请登录模式，按成功、失败、unconfirmed 三个独立原 Run 断言。A/B 同跑、C 排队期间通过受控 hook 等待 A 落盘后强杀 A 的实际 worker。独立卷读回只出现一次 A 标记；原 SDK grant 复用请求被拒；B 的 supervisor 身份不变且可下载，C 按队列推进。可信成功返回原 Run 的补丁；可信 failed 页面显示脱敏原因并分别验证安全和不安全重试；unconfirmed 仍无下载与执行，可信消费者重启后可查，独立新建可执行，独占项目删除与另一独立待结案账号注销清理完成仍可查审计。
2. 候选和命令入口统一为远端测试宿主的 `apps/orchestrator/acceptance/web-a10/run.mjs`，本步调用 `--freeze`。在 T1–T4 提交完成的 B 分支上，只把 T5 允许的行为文件用一次性私有 index 加入基线，写出候选 Git tree，并用 `git archive` 从该 tree 生成装配闭包。运行源码根、Web 构建、Orchestrator、Worker 和 Chromium 测试同一 archive，实际运行前将 archive 内容逐文件 SHA-256 与冻结 manifest 对齐。候选身份记录 `sourceCommit` 为该 tree 的基线提交，`sourceTree` 为 Git tree OID，`archiveSha256` 为 archive 原字节摘要。发布镜像标记候选 tree，运行时从 Docker inspect 读取实际镜像 ID，再记录 SDK 适配器、受信 hook、host 配置、Compose 配置与锁文件的 SHA-256。候选只含 T5 明确的改动，无需为通过本步先创建业务提交。

3. 在冻结前完成两份私有适配器及候选入口中的部署与证据接线。 在 `trusted-entry.mjs` 去掉先前草稿的 grant 缓存及二次请求代码。该入口只在 `readRunEvidence` 中按原 admission 的 `exitProofKey` 回读 T5bg 拒绝证据，要求状态 16 且证明摘要匹配，缺证据拒绝确认成功，不读取、接收或保存 grant。浏览器驱动发送 T5bd 固定 prompt。私有入口实现目标 mTLS relay 与 0600 的 `state/<leaseId>/trusted.sock` 服务端，`review.mjs` 完成同租约真实回调交接。实现下述显式事件屏障与超时释放。T5b 执行真实 action 及负例，T5bi 与 T5b 期间两份适配器和五个候选源码文件的字节必须与冻结记录一致。

```bash
set -e
export BENTO_WEB_A10_CONFIG="$HOME/bento-web-a10/lease.json"
node --check "$HOME/bento-web-a10/trusted-entry.mjs"
node --check "$HOME/bento-web-a10/review.mjs"
node --check apps/orchestrator/acceptance/web-a10/run.mjs
node apps/orchestrator/acceptance/web-a10/run.mjs --freeze
```

PASS：语法检查、私有 index、archive 与逐文件摘要核对通过，输出 `A10_CANDIDATE_FROZEN` 并保留同一候选供后续使用。STOP：候选闭包、适配器摘要或 lease 归属不符。保留未提交候选，验收源码与 RUNBOOK 留至 T5b 同版验收后一起提交。

#### A/B 占槽与 C 排队的事件屏障

- 在私有 `base.ts` 的 `runtime.initialize()` 注册 DSH 插件后，首次返回到 `dsh-worker.ts:runDshWorker` 之前，A-write 和 B 通过本槽现有只读 relay 视图内的 `/run/bento-web-a10/queue-gate.sock` 等待释放。设置在 `persistence.stat(id)` 发出前，因此不占用 `remote-session.ts:rpc` 的 10 秒期限。禁止在 gate 前发起 persistence 或 SDK RPC。只有 T5bd 隔离 fixture 可用 `BENTO_WEB_A10_BOOTSTRAP_FIXTURE=1` 跳过该等待，warm launcher 环境拒绝该变量。C、A-cancel、recover 不进入 A/B 放行门禁。A-cancel 只用 T5br 在同 socket 的独立分类分支。
- `trusted-entry.mjs` 在两个已经有归属的槽 relay 根分别创建同 lease、Worker GID 可连的私有 socket，按槽路径和 supervisor 的持久 execute admission 校验 `{runId,generation,bindingDigest,markerSha256}`、只回 `{release:true}`。Worker 能连接本槽路径且只提交现有身份字段。宿主按同一 Case 登记查验当前槽、容器 ID 和 StartedAt，仅对匹配的连接提供释放。无登记、身份冲突、错槽、重复连接或超时均拒绝，不使用此 socket 读写业务账本。恢复/清理移除本轮两个 gate socket。
- 可信宿主在浏览器提交之前调用 `armQueueBarrier({caseId,aMarkerSha256,bMarkerSha256})` 注册一个一次性屏障，`caseId` 为 UUID，两摘要不同。只允许已登记的同租约浏览器编排，登记项需与服务存储的原 prompt 及可信 admission 一致。提交 A、B 后，调用 `awaitQueueBarrier({caseId,aRunId,bRunId})`，一次性读回两个仍挂起的原始 execute admission。要求两个 runId、槽、admission、绑定摘要、容器 ID 各不相同，并记录各自 Docker `StartedAt` 及持久登记。认不出目标或身份漂移即失败关闭。
- C 的 Task 预先创建、准备并登录独立 context。只有两条原 admission 均已锁定，才触发 C 页面已就绪的「发送要求」，经正常 `createTaskRun` 提交。该提交及排队回读受 60 秒外层期限约束，与 Worker 的 10 秒 RPC 时限无关。调用 `proveQueued({caseId,cRunId})` 后才可释放。该调用交叉读取业务原 Run 的持久 `queued` 状态、缺少受理代次/绑定/receipt、可信 supervisor 两槽仍为已锁定的 A/B，并确认 C 没有 execute admission。使用同一观测窗口前后重读两槽身份和 C 状态，变化则拒绝，并保留脱敏证据。C 的执行只能发生在该证据之后。
- 取得 C 排队证据后，为已锁定的 A 原 admission 执行 `armWriteFreeze`，再调用 `releaseQueueBarrier({caseId,role:'A'})` 允许 A initialize 返回并按正常路径发出 session stat。A 的真实 SDK 请求正常到达 Gateway。仅在 relay 实收 A exit event 和 trailers、独立证实原代 UNKNOWN、同一 binding 的真实卷只出现一次 marker 且 business receipt 为 0 后，允许 `killFrozenWorker` 按登记 ID 与 StartedAt 定向终止 A。此时 B 的 initialize 仍停在 gate，尚未发出 session stat。待独立 wait 证实 A 原 Worker 退出后，无需等待后续只读旧 grant 探针，调用 `releaseQueueBarrier({caseId,role:'B'})` 释放 B；核对 B 原 admission、容器 ID 和 StartedAt 保持一致，B 正常完成并下载，C 后续被受理及完成。不得以页面状态单独证明 admission、槽或 Worker 身份。 A 的原 Run 发布前，可信方还须核对同一原 admission 的 `grant-denied.json` 证据。
- 屏障从注册起使用宿主单调时钟限制为 60 秒。A 的 Exec 另使用由 relay 实收首个 SDK 请求帧开始的 8 秒封顶，同时要求定向 kill 前 ingress 流仍打开，有关闭、超时、取消或任一断言失败就禁止定向 kill。两段均使用事件通知及带截止的等待，禁止 sleep 作时序控制和伪造 SDK 帧。任何超时或失败，先使本案不可继续，立即终止本案的 gate 等待并释放两个 gate socket 连接，撤销冻结并关闭仅本案已扣帧的 SDK 流，再记录失败、STOP 并进入本轮证据保全与清理。应急释放不得生成通过证据，也不得影响同租约其他流。

### T5bi：绑定真实执行环境身份并生成启动许可

前置状态：T5bf PASS，候选及两份私有适配器摘要已冻结。按路径计 10 项：

1. RUNBOOK。
2. 私有 `host.json`。
3. 私有 `lease.json`。
4. 私有 `compose.env`。
5. 同 lease `state/<leaseId>/workspace-profile.json`。
6. 同 lease `state/<leaseId>/runtime-approval.json`。
7. 冻结候选 `apps/orchestrator/acceptance/web-a10/run.mjs`。
8. 冻结候选 `apps/orchestrator/src/execution-service/types.ts`。
9. 冻结候选 `deploy/compose.yaml`。
10. 私有 `compose.overlay.yml`。

本任务私有 lease 位于测试宿主用户目录 `$HOME/bento-web-a10/lease.json`，T5a 按 `umask 077` 新建。lease 必填 `leaseId:string`（新 UUID）、`project:'bento-web-a10'`、`sourceCommit:string`、`sourceTree:string`、`archiveSha256:string`、`webPort:28080`、`mailpitPort:28494`，以及 `hostConfigPath`、`composeOverlayPath`、`composeEnvPath`、`chromium`、`loginFile`、`reviewModulePath`、`trustedEntryPath`、`reportPath` 这些私有绝对路径。以 `$HOME/bento-web-a10/state/<leaseId>` 保存状态，配置来源为本轮 T0 预检的受控输入，分别使用仓库 `deploy/compose.yaml`、A7 独占部署装配、经 T0 认证的 A12 host 架构和 A08 邀请。凭据、登录文件及适配器留在受控目录，lease 记录配置摘要，测试使用本轮三身份。

在冻结源码根执行：

```bash
set -e
export BENTO_WEB_A10_CONFIG="$HOME/bento-web-a10/lease.json"
node apps/orchestrator/acceptance/web-a10/run.mjs --bind-environment
```

- 构建并 inspect 同 lease 实际沙盒镜像，从独占 Gateway 的验证沙盒独立回读已加载策略和 runtime profile，核对沙盒镜像 ID、加载策略摘要、profile 字节摘要及租约与候选树绑定。独占 Gateway 和验证沙盒在此步单独装配、登记并纳入清理，应用 Compose 栈保持未启动。
- 从冻结候选调用 `executionEnvironmentVersion(imageDigest, policyDigest)` 计算真实版本。核对独立 profile 的 `environmentVersion` 与计算值一致，原子保存本轮 profile 与 approval。将真实版本写入 `host.json`、`compose.env` 和 `lease.json`，将 T5bf 冻结的候选和私有适配器摘要一并写入 lease。每份配置用同目录 0600 临时文件写入并 fsync 后 rename，再 fsync 父目录。先写 host 与 env，再将 lease 最后发布，lease 保存二者字节摘要。中断或半写后按 T5bi 原输入重跑，禁止用旧许可启动。
- 将三个构建产物仅在服务器以本轮 lease 与冻结候选 tree 装配和标记，独立读回 `docker image inspect` 的实际 Linux/amd64 镜像 ID。Web 与 Orchestrator 均须由冻结归档构建。Worker 如复用 T5bm 既有本轮服务器镜像，先证明其构建闭包（Worker 源码、Dockerfile、锁及 SDK）与冻结树对应输入完全一致，否则在服务器按冻结输入重建。将三服务的候选 tree、lease、构建闭包证据与实际不可变 `sha256:<64 hex>` 镜像 ID 一一登记于 lease 及正式启动许可；按 T5bt 变量名将同一三项 ID 写入 `compose.env`。拒绝标记缺失、错误 tree 或 lease、未知缓存身份、可变标签、占位及历史业务产物。此步骤保持 T5bt overlay 字节不变。
- 清除父进程版本及三个镜像同名变量，以项目 `bento-web-a10`、本轮 env file、冻结树 `deploy/compose.yaml` 和本轮 overlay 分别运行正式 `config --format json --no-env-resolution`，两套 profile 为 `--profile dev` 和 `--profile dev --profile worker-image`，均不注入占位。仅后者包含 `bento-worker`，逐服务比对其渲染 image、已登记 ID 与服务器 inspect。仅 `dev` 的正式启动视图要求没有 `bento-worker`，Web 和 Orchestrator 镜像与镜像对账视图完全相同。将两份渲染摘要和三项镜像读回绑定正式许可。对两份渲染分别执行精确两条 TCP 回环映射断言（`bento-web 127.0.0.1:28080:8080`、`mailpit 127.0.0.1:28494:8025`），拒绝任一服务使用 host network，核对唯一 sidecar 的 `network_mode: service:orchestrator`、无端口、1000:1000 及仅两项许可挂载，并复核 T5bn 桥接摘要及 T5bo 的同 lease 只读 NGINX bind、issuer 与 `webOidc` 摘要。另断言渲染出的 Orchestrator 版本与重新计算值及 host、lease 字段逐字相等。仅在成功后原子更新 `lease.json` 中的 `composeApproval`，至少绑定 `leaseId,sourceTree,archiveSha256,environmentVersion,hostSha256,envSha256,baseSha256,overlaySha256,renderedSha256`，其中 `renderedSha256` 取正式检查的原始 JSON stdout 字节，只保留摘要。开始新一轮绑定前先原子移除旧许可。绑定和启动串行执行，`--prepare` 复核到调用 `up` 期间禁止修改同 lease 输入。

PASS：输出 `A10_ENVIRONMENT_BOUND`，回读配置和许可摘要一致。STOP：缺失、非法、占位、身份或摘要不符，以及任何构建、独立观察、持久化或正式检查失败。私有配置和许可留在同 lease，Git 源码和候选保持冻结。

### T5b：浏览器与专属实栈 WEB-A10

前置状态：T5bi PASS。仅更新 RUNBOOK、运行产物及本轮 `logins.json` 和 `lease.json` 的启动后证据字段。T5bf 的候选源码、两份私有适配器及绑定的 bootstrap 和依赖锁保持冻结，需变更时返回 T5bf 重新绑定，原许可失效。

T5b prepare 复验交换工具 ELF、大小、owner、0500 模式和二进制与源 SHA-256；以真实恢复 helper 配置核对有效只读 bind mount，缺失或错绑时拒绝恢复。

`run.mjs --prepare` 必须先读回 `composeApproval`，核对当前同一 lease、候选树、archive、环境身份与所有配置摘要。以与 T5bi 相同的 Compose 输入及两套 profile 再次执行正式 `config --format json --no-env-resolution`，分别核对两份渲染摘要、两个回环端口、无 host network 和环境值。用 `dev + worker-image` 逐项重验三个渲染 image 和服务器实际 ID，用单独 `dev` 重验 Web、Orchestrator 镜像及 `bento-worker` 不在启动视图。禁止变量覆盖、镜像重建或拉取。只有所有检查通过，才在同一 prepare 进程用已经复核的单独 `dev` 参数和相同配置输入执行 `up -d --no-build --pull never`。随后 inspect 实际 Web 和 Orchestrator 容器镜像 ID 与许可对账，并确认 Compose 项目无 `bento-worker` 容器。两个 warm Worker 由本轮 supervisor 原有路径按槽启动，分别按该次可信登记的精确容器 ID 独立 inspect 其实际镜像 ID 等于许可中的 Worker 镜像 ID。缺许可、错 lease/树/版本、输入漂移、占位或任一启动前预检失败均 STOP，禁止启动。启动后、创建或登录任何账号以及提交任何 Run 之前，先执行同版生产 ingress 探针。确认实际 Orchestrator 和 sidecar 的 Docker `/proc/<pid>/ns/net` inode 相同，读取三条实际回环监听。使用 Orchestrator 进程内已允许的私有 `review.mjs` 安装回调在 `serveExecution` 返回之后，从 `/proc/self/fd` 提取本进程 socket inode，与 `/proc/self/net/tcp` 中 IPv4 127.0.0.1 的 LISTEN 行联结。必须恰有三个监听，禁止猜端口、扫描其他进程或提交探针 Run。以无 grant 请求辨认角色：`POST /rpc` 为 HTTP 403 JSON `GrantDenied`，`POST /operations` 为 HTTP 403 空响应，HTTP/2 `GetSandbox` 为 gRPC 16。每角色必须唯一，登记同一端口表，随后从宿主经 bridge 对三个已登记角色分别重放同样协议探针并核对拒绝。launcher 首次真实派发的三端口仍须与启动登记完全相同。不得制造业务 grant 或落账。通过 Orchestrator 已有的私有客户端材料，从同一 netns 实测 `127.0.0.1:18789` 到宿主透明桥和本轮真实 Gateway 的 mTLS 握手及只读 SDK 探针成功。宿主与隔离 Worker 分别尝试直连三条实际端口的回环和 Orchestrator 容器网络 IP 两种目标并要求失败，实际容器发布仍仅 Web/Mailpit。逐项证据记录在同版 CaseReport，任一失败先 STOP 和独占清理，禁止账号或 Run 启动。启动后登记 Compose/Gateway/Temporal/容器/卷/端口/对象前缀身份。在录入账号、填写任何身份凭据或提交 Run 之前，在正式 Web 容器核对 `nginx -t -c /etc/nginx/bento.conf`、实际只读 bind 和文件 SHA-256，并以 Web 容器内 Node、以及独占 Chromium 的空 context 分别访问同一个 `http://127.0.0.1:28080/identity/realms/bento-web-a10/.well-known/openid-configuration`。两端 `issuer` 必须逐字等于 `http://127.0.0.1:28080/identity/realms/bento-web-a10`，`authorization_endpoint` 和 `token_endpoint` 须分别等于该 issuer 加 `/protocol/openid-connect/auth` 和 `/protocol/openid-connect/token`。Web 容器用 Node fetch 的 `redirect: manual` 发出无账号的 `GET /api/oidc/start`；Chromium 从实际页面点击「受邀用户登录」，用 Playwright `page.waitForResponse` 捕获浏览器导航产生的首个 `/api/oidc/start` 响应，禁止用宿主 APIRequestContext 代替浏览器请求。两端均要求 HTTP `303`，Location origin/path 等于 discovery 的 authorization endpoint，`redirect_uri` 恰一项且逐字为 `http://127.0.0.1:28080/api/oidc/callback`，`code_challenge_method=S256`。Chromium 随该原 Location 匿名导航，确认 Keycloak 登录页面来自同 origin 后立即销毁 context，不用该临时事务登录。回读新 realm 的 OAuth client 已登记同一精确回调，无通配规则。对同一验证器的错 issuer 合成输入必须拒绝，禁止改动实际 realm 做负例。再次独立核对正式 Docker 发布仅 Web/Mailpit，容器内 28080 无额外宿主发布。任一断言失败均 STOP 且不得登录。CaseReport 只保存两视角布尔结论及公开 issuer/callback 摘要，禁止输出 state、nonce、挑战、cookie 或凭据。该阶段只允许空状态，Web 与三独立 owner 可登录、专用 S3 PUT/GET 成功、两槽和 worker supervisor 可回读才返回 0。启动前用本轮 Worker 镜像、实际 `1000:1000` 和相同挂载视图逐槽执行预检，记录容器内有效 UID/GID，预读 `/warm-bootstrap.mjs`、`/app/.bento-bootstrap/base.ts` 与 `/app/register-paths.mjs`，并从容器内对本槽受控测试 Unix socket 执行实际 connect。确认其他槽、lease 和退出证据目录未挂载；任一预读、connect 或隔离断言失败则停止 prepare。

T5b 在登录与提交前，用 lease 的固定 MinIO 镜像 ID、专用容器、独占卷与正式 Compose 网络，在网内登记 `bento-web-a10-s3` alias，服务只消费本轮叶证书与密钥，无宿主发布。用 T5a 已校验 CLI 创建新私有 bucket、按 Web origin 设置 CORS、将本轮访问对限定在新 bucket 的所需对象及 multipart 操作，拒绝匿名与其他桶。实际 Web 容器 UID 1000 必须可读固定 CA 且通过正常 SDK 创建签名上传并读回；Chromium 验收容器共享实际 Web 容器的 netns，以原 origin 的容器回环监听访问 Web，以同网 DNS 访问 S3，临时信任存储仅加入本轮 CA，验证由真实 Web 发出的签名 PUT/GET 与 CORS，另验证无 CA 的独立测试进程及错 hostname 都拒绝。不得忽略 TLS 错误或输出 URL 签名及凭据。CaseReport 记录有效单一 `web.env`、CA 身份、S3 和 OIDC 双视角及两端口布尔结果。清理按本轮登记移除测试信任存储、资源与桶内容。

执行后续步骤：

1. `run.mjs --verify` 在同一专属网络执行 `playwright.web-a10.config.ts`。A/B/C 并发从空队列开始，按 T5bf 的屏障顺序执行。CaseReport 必须记录 A/B 原 admission 与固定槽身份、C 无 admission 的排队窗口、A 定向退出、B 释放及 C 随后受理的因果次序。四个可信结果病例各用新的 Task 和原 Run，分别为持久写后确认成功、持久写后确认失败且拒重试、取消后可信失败且安全重试、证据不足关闭交付及清理。每轮等先前工作流终止；删除和注销用两个独立 Task，注销放最后。受信入口 `trustedEntryPath` 只在验收宿主进程中执行，采用 `node --import ./register-paths.mjs --experimental-strip-types <trustedEntryPath> <leasePath> <action> <json>`。hook 按 A12 方式核对 lease 文件权限、ID、tree 和摘要，支持屏障的 `armQueueBarrier`、`awaitQueueBarrier`、`proveQueued`、`releaseQueueBarrier`，以及 `armWriteFreeze`、`lookupSdkUnknown`、`killFrozenWorker`、`readRunEvidence`、`releaseRetryObservation`、`confirmSuccess`、`confirmFailed`、`closeUnconfirmed`、`readClosure`、`readNotifications`。启动同租约 0600 `state/<leaseId>/trusted.sock` 的操作服务端，并将确认、读取等操作接到实际执行服务私有回调及独立宿主证据。prepare 先验证实际宿主客户端可以连接且读回本轮身份，同时实测错误 lease/tree/归档摘要、未登记 Run 和越权调用被拒绝。verify 使用步骤 3–5 的真实 action 和 mTLS relay 证据验证完整调用链。仅连接成功或语法通过均不能代替该验证。屏障 action 仅接受上节列出的参数，其余 action 只接收已登记原 Run ID 与各自声明字段；取消安全失败分支的 `releaseRetryObservation` 在实际持久 needs_review、READY+1 且 UNKNOWN 为零后才允许释放受信观察完成信号，首次观察在该信号前返回 null；`armWriteFreeze` 另需目标标记的 SHA-256；`confirmSuccess` 从本地受信查回原 SDK ID 和独立卷快照摘要，按 T2 调用 `reviewRun`；failed/unconfirmed 从 authority 回读期望代次并调用 `closeTaskRun`。只有 lease 归属的进程可触发，输出限定布尔值、代次、计数、操作 ID 和摘要，浏览器侧无访问凭据。
2. `run.mjs --cleanup` 先验当前 owner/lease 和已登记 ID，再删除本轮资源并记录独立 after。仅按本轮 Compose identity 停服务和删除本轮卷，移除本轮 Gateway 和 namespace，按本轮独占 S3 前缀列举并清除对象及未完上传，核对登记 ID 均不存在、两监听释放、其他任务状态未变。失败时使用同一 lease 保存停写后只读快照、报告及本轮资产清单，保全完成才执行本轮清理。发现归属冲突立即 STOP，不做全局操作。CaseReport 绑定源码和配置、镜像、实际运行命令、逐项断言、cleanup 和 after。T6 对 T5 提交的同范围 tree 重算行为文件摘要，禁止把文档提交后的不同源码标记为已验。
3. 验收的 `lookupSdkUnknown` 仅在可信宿主进程运行，只读打开执行状态目录 `business.sqlite` 和 `authority.sqlite`。以可信 supervisor 确认的 execute runId 查 `SELECT sessionId, admittedGeneration, admittedBindingDigest, receipt FROM runs WHERE id=?`，绑定摘要必须匹配；再查 `SELECT id FROM operations WHERE session=? AND generation=? AND state='UNKNOWN' AND id LIKE 'sdk:%' ORDER BY id`。A10 固定一次目标写且其他 Exec 都先完成，要求恰一行并校验 UUID。可信调用者取这个 ID，不接受浏览器或 Worker 提供 ID。
4. receipt 冻结只在 T5b 独占 mTLS 验收 relay 启用。只对 A-write 的目标 Exec，通过可信 supervisor execute admission、原绑定、该 sandbox 和 marker 摘要唯一定位目标。在请求已由 `SingleHost.sdkIngress` 记 UNKNOWN 后照常转发至真实 OpenShell。relay 拦住该流 terminal event 及 trailers，直到外部 `lookupSdkUnknown` 见一条原代账本、独立只读卷观察证明新增标记字节已存在、business receipt 仍为 0。随后按 supervisor 的 PID 与启动身份只强杀 A，丢弃被拦帧并关该流。B/C 及其他流原样转发。冻结点没有 Worker 写账本，也没有修改 production SDK ingress。
5. 同一 T5b 运行验证真实 A 原 admission 有独立实际 Worker 退出记录，B 的实际启动身份不变且完成。分别令受信 controller 看到本轮绑定的 restore 正忙、真实 RW 写者存活、sandbox 尚未停止，逐次尝试结案均拒绝，审计与清理门禁无变化。负例装配与释放仅作用于同 lease 的新测试绑定。释放负例后，经原绑定的可信停止操作取得 stopped，再由 T1b 联合观察取得三项事实后才结案。CaseReport 绑定 T1a、T1aw、T1b、T1c 私有源及适配结果摘要，另记录容器精确 ID、daemon/镜像摘要、实际运行的 `create/start/wait/inspect` 开始与结束结果、每次 relay 关闭及 A 的实际 `StartedAt/FinishedAt` 证据。

验证（远端执行，当前目录为 lease 已验证的冻结源码根）：

```bash
set -e
export BENTO_WEB_A10_CONFIG="$HOME/bento-web-a10/lease.json"
node apps/orchestrator/acceptance/web-a10/run.mjs --prepare
node apps/orchestrator/acceptance/web-a10/run.mjs --verify
node apps/orchestrator/acceptance/web-a10/run.mjs --cleanup
pnpm --dir apps/workspace/web test:e2e
```

PASS：正式许可回读与同版启动通过，专属实栈逐场景通过，零新增跳过，CaseReport 列出的断言逐项为 true，含真实 A/B 进程身份与独立退出，以及真实 SDK 只读旧 grant 拒绝与三个物理停写拒绝用例。STOP：私有任务装配不齐，缺 SDK 证据、通知仅有日志、B 换 Worker 或 C 未排队。提交产物为可复跑入口、浏览器场景、详情提示及 RUNBOOK 更新。

### T6：证据迁移与完整门禁

前置状态：同候选所有步骤 PASS。允许修改 [Readiness](../40-readiness/CURRENT-READINESS.md)、[Web Interface](../20-interfaces/WEB-INTERFACE.md)、[Web Design](WEB-DESIGN.md)、[部署手册](../../deploy/README.md)、`public-files.json` 和 RUNBOOK。禁止更改 WEB-06-01 至 05 原记录。记录 WEB-A10 同版脱敏证据、各场景结论、受信模块新输入及私有适配器契约。按实际发布闭包更新精确文件登记。迁移完成删除 RUNBOOK，并用 `rg -n 'RUNBOOK-WEB-06-RECONCILIATION' docs` 核对无引用。

```bash
pnpm check
npm pack --dry-run --json
git diff --check
```

PASS：门禁通过，必需用例同候选且零新增跳过，包内容与登记一致，私有产物不入包。STOP：任何必需证据缺失或版本不一致。提交产物为正式文档和 RUNBOOK 删除。PR 和审查合并等候 MASTER 分阶段发令。
