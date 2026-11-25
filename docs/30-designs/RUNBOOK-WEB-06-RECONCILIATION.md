# WEB-06 待核对、结果确认与可信结案

**2026-11-25，作者续稿，待同版审核。** WORKER A，checkout `/Volumes/storage/workspace/bento-a`，`main`，基线 `cd13f3d7895d55115ee46d7212cdf01bc6777199`。MASTER `01a21119-d9a7-7f81-aa87-e84a0a848f08`。

## 执行契约与范围

当前授权限于起草和只读核验。T0 未满足时保留草稿和环境，向 MASTER 报告。获得同 blob 的 Executable 结论和开工指令后才进入实施。每步通过后，将阶段产物和该步骤的移除同一提交，最多十份文件（含专门核对文件）。失败记录最后通过步骤、源码版本、实际命令、符号、脱敏输出和恢复条件。任何未规定的业务或架构判断交回作者。签名、配置、数据库、OIDC 登录材料、原始执行日志及私有适配器保留在 A 的受控环境。

[WEB-06-06～09 与 WEB-A10](../10-requirements/WEB-REQUIREMENTS.md#web-06-任务提交与结果)共用原 Run 和同一套三账号装配。终点为四项实栈证据和 [Readiness](../40-readiness/CURRENT-READINESS.md) 状态更新。继续采用 [WEB-06 证据](../40-readiness/evidence/WEB-06.md)的 01～05。按 [Web Interface](../20-interfaces/WEB-INTERFACE.md#task-生命周期--目标契约)、[Web Design](WEB-DESIGN.md#清理可信结案与事件投影)、[平台架构](../00-governance/ARCHITECTURE.md) 及[部署手册](../../deploy/README.md)保持调用方向。Go 权威链、通用 Worker 调度、共享卷回收新行为、MASTER/B 部署和共享配置均超出范围。生产代码只在已定位且能用具体失败断言证明正式需求受阻时，通过重新审核的白名单修改。

## 起点、调用链与不变量

- `apps/workspace/web/acceptance/web-a10.spec.ts` 已有四轮 `interruptedCase`、安全重试、项目删除、OIDC 注销和审计回读。现有断言覆盖 A 的旧代拒写、标记次数、receipt、B Worker 身份、C 队列门槛。原 A 的 Session/Workspace 同一性、独立 SDK 执行次数/恢复后零重放、账号清理完成和审计等值仍需独立对账。浏览器断言的 `!ok()` 也会接受故障 5xx。
- `apps/workspace/web/acceptance/web-a10-hook.ts:callA10Hook` 只接受枚举 action、UUID、摘要和角色约束。结果为扁平的布尔值、非负整数与受限 ID/摘要。它要求 host 上 owner-only 私有 lease、准确的 project、frozen tree/archive、审批绑定和可信 entry 摘要。Playwright 配置锁定上一轮 project/origin；`apps/orchestrator/acceptance/web-a10/run.mjs:main` 只接受 `--freeze`。`freeze` 要求五个路径全部与 HEAD 有差异。当前这些路径已入基线，基线零差异以及只修一处的候选均无法冻结。旧稿的 `--prepare/--verify/--cleanup` 尚无公开实现。
- 可信入口由 `apps/orchestrator/src/execution-service/start.ts` 的 `BENTO_REVIEW_MODULE` 在进程内安装。执行服务 `service.ts:reviewRun` 的必填 proof 为 `{runId:string,failedGeneration:number,readyGeneration:number,sdkOperationId:string,expectedSnapshotSha256:string}`。原代 `g` 取持久 execute admission，`sdkOperationId` 必须是该代账本的 `sdk:<uuid>`，不得传 `stableOperationId`，以 `reconciliation.test.ts` 1255 附近真实 SDK schema 正控为准。持久 `recoveryGeneration=g+1`、原 binding READY `g+2`、原代 UNKNOWN 且无 receipt，可信快照与 64 位十六进制摘要匹配。用原 Run 发布增量与累计结果，相同 proof 幂等回读。
- `service.ts:closeTaskRun` 输入 `{runId:string,decision:'failed'|'unconfirmed',expectedGeneration:number}`。可信调用者从同绑定 READY 读取代次。两分支要求原 admission、同绑定可信退出证明、无 active/assigned/receipt、无打开历史 handle 或未结 batch。failed 通过 `stopAndProve(run,'observe-ready')` 尝试取得重试证明。unconfirmed 必须回读匹配的 `{sessionId,runId,generation,bindingDigest,restoreIdle:true,volumeWriters:0,sandboxStopped:true,observedAt}`，观察时刻介于可信退出和当前时间之间。`task-evidence-store.ts:closeTaskRun` 在同一事务写 failed 摘要及 `task_closure_audit(runId,decision,authorityGeneration,stopDigest,closedAt)`。unconfirmed 同事务锁闭 Task。审计原键回读，相同决定和代次幂等，冲突返回 `review_unavailable`。同部署重开从持久状态回读。
- `task-run-view.ts:taskRunViews` 从权威 Run 读取摘要、状态及结果版本，按 Task 关闭状态、最新 Run、StopProof、Workspace 和历史证据计算重试入口。只有已发布的 succeeded Run 能提供 diff。正式 HTTP 契约待核对 diff 返回 409。公开页面与 API 不承接可信复核写入。旧代写被拒，UNKNOWN 先对账，恢复不能补发目标操作。
- 项目删除从 `apps/workspace/api/src/space-project-deletion.ts:spaceProjectDeletion` 到 `service.ts:advanceProjectDeletion`。注销由 `apps/workspace/api/src/server.ts:sweepAccounts` 推进到 `service.ts:purgeOwner`。两者沿既有 `execution.purge`、host 和 Store 回收路径，待核对时保留门禁，可信终态后才能推进。使用独占项目/账号取证，独立审计在业务资源删除后可回读。

### 两条权威推进路径

- **06-07 成功确认**。原 admission 代次为 `g`。落盘屏障强杀原 execute Worker 后，让生产调度驱动 `service.ts:settle` 完成。首次 `fence` 经 `SingleHostExecution.takeover` 使原 binding READY `g+1`，原代 UNKNOWN 阻止 `stopAndProve` 得出证明。紧接着 `settle` 持久标记已尝试恢复，以同一 Run/Session/Workspace 的 `g+1` grant 启动 mode=recover，无原 prompt，无目标 SDK 写。只接受真实 Worker 的 `recovered` 结果，随后 `db.recovered` 记 `recoveryGeneration=g+1`。第二次 `fence` 将同一 binding 推进至 READY `g+2`，认证无活动 Run/capability。读到持久 needs_review、原代 UNKNOWN、receipt 缺失以及独立快照后，才允许 `reviewRun`。复核只观察已形成的 READY，不推进代次。06-08 的含 UNKNOWN 不安全分支可复用这条中断路径，传 READY `g+2` 给可信 failed，仍无 StopProof。
- **06-08 正控确认失败并可重试**。在原 A-cancel 实际 execute admission `g` 持久、会话开始后从正常页面发起 running cancellation，等待 `service.ts:driveCancellation` 经 `execution.takeover(session,g)` 撤权并重建原 binding 到 READY `g+1`。可信 launcher 回读原 Worker 退出。A-cancel 无写操作，观察闸保持 `observeSdkRetrySafety` 返回 null，生产 cancellation 先持久 `needs_review`，且不派 recover。等待 READY `g+1`、needs_review、原代 UNKNOWN=0 后才释放该观察，调用 `closeTaskRun({runId,decision:'failed',expectedGeneration:g+1})`。它调用 `stopAndProve(run,'observe-ready')`，此模式只读已形成的 READY 再写业务 StopProof，不调用 takeover。以原页、安全重试 202 及原 Run/新 Run 身份关系验收，任何来历不明的代次或外部代写均 STOP。

## 逐文件范围

当前 HEAD 的直接相关行段，扣除空行和纯注释，同行只计一次。范围包括验收与需核对的既有代码。

| 路径 | 行段及符号 | LOC |
| --- | --- | ---: |
| `apps/workspace/web/acceptance/web-a10.spec.ts` | 13–401，浏览器 helpers 与 WEB-A10 | 370 |
| `apps/workspace/web/acceptance/web-a10-hook.ts` | 10–121，action 契约与 `callA10Hook` | 108 |
| `apps/workspace/web/playwright.web-a10.config.ts` | 4–43，环境与项目配置 | 38 |
| `apps/orchestrator/acceptance/web-a10/run.mjs` | 19–286，lease、冻结和入口 | 258 |
| `apps/orchestrator/tests/execution-service/reconciliation.test.ts` | 250–472、556–920、1013–1318，落盘中断、可信处理与 SDK 原 Run 发布 | 888 |
| `apps/orchestrator/src/execution-service/service.ts` | 218–307、560–697、1465–1539，可信处理及清理门禁 | 296 |
| `apps/orchestrator/src/execution-service/task-evidence-store.ts` | 133–185，审计读写与结案事务 | 52 |
| `apps/orchestrator/src/execution-service/task-run-view.ts` | 15–104，公开结果与重试投影 | 88 |
| `apps/workspace/api/src/server.ts` | 158–218，`sweepAccounts` | 59 |
| **合计** | **9 个文件** | **2,157** |

共享热点为 `service.ts`、`task-run-view.ts` 和项目/账号清理调用方。计划先复用生产实现。发现需要改动时，向 MASTER 报出具体行段、失败用例和跨任务符号冲突，先确定归属、候选基线和合入顺序。邻接回归在最终实际合入候选重新执行。

## T0：A 常驻栈与真实验收资格

前置状态为指定独立 checkout 与 `ENVIRONMENTS.md`。允许修改仅本草稿。远端仅可读取 A 目录和 A 项目状态。禁止检查其他栈私有配置、使用历史 lease 执行、创建资源或执行浏览器业务场景。

1. 本地核对 HEAD、origin、git-dir/common-dir 与清洁起点。
2. 按本 checkout 环境说明连接服务器并在 A 项目目录运行下列命令。只记录状态与归属。以本地相同版本的 SHA-256 对照远端 Compose、执行服务、freeze 和浏览器入口。仅验证已提供的发布文件，远端目录无 Git 元数据，镜像标签仅作旁证。

```bash
cd ~/bento-role-test-cd13f3d/bento-worker-a
docker compose --env-file dev.env --profile dev ps
sha256sum deploy/compose.yaml apps/orchestrator/src/execution-service/service.ts apps/orchestrator/acceptance/web-a10/run.mjs apps/workspace/web/acceptance/web-a10.spec.ts
docker compose --env-file dev.env --profile dev exec -T orchestrator sh -c '
  test -n "$BENTO_HOST_MODULE" && echo EXTERNAL_HOST_CONFIGURED || echo EXTERNAL_HOST_UNCONFIGURED
  test -n "$BENTO_REVIEW_MODULE" && echo REVIEW_CONFIGURED || echo REVIEW_UNCONFIGURED
'
```

3. 已核验：Docker 28.1.1、Compose 2.35.1，A 七个容器均 running/healthy，网络和命名卷均为 A 前缀，四个 bind 源均在 A 目录内，三个回环 UI 各返回 200。上述四文件与本地基线摘要一致。运行配置未设置两个可信模块，常驻栈按环境说明使用 local fixture。上一轮固定路径仅确认文件存在，归属和版本未确认，其中私有配置未读取。A 目录内未发现 WEB-A10 lease/candidate。
4. A Gateway `c526ef707a66` ready 200，独立 commandHost 健康候选 `94fe435c4771` 保留，原 A 常驻 fixture 7/7 healthy。该候选的既有复验为匿名 401、认证 200 空结果。A 独有真实 Gateway/mTLS、固定 SDK、独立受控沙盒与卷、launcher 定向终止及双侧停写已有实际证据。A 本地 Git 忽略的 `ENVIRONMENTS.md`「WORKER A 专属 OpenShell 环境」记录受控入口、摘要和只读复验命令。续稿时再次核验 Gateway 200、候选匿名 401、原 fixture 7/7、端口 28884～28888 空闲且本轮 Compose 项目名未占用。
5. T0 PASS 只依赖既有环境及新资源名可归属。按 `ENVIRONMENTS.md` 运行只读复验，再核对下列命令。T1a～T1c 创建本轮 lease、身份、Temporal、MinIO 和私有可信接线，T2 才核对正常 admission、冻结及审批。这些均由本 RUNBOOK 产出。这些任务产物在相应步骤验证，只有既有环境或新资源归属核对失败才 STOP。本步无提交。

```bash
test ! -e "$HOME/bento-worker-a-openshell-0616/web-a10"
test -z "$(ss -H -ltn 'sport = :28884')"
test -z "$(docker ps -aq --filter label=com.docker.compose.project=bento-worker-a-web-a10)"
test -z "$(docker volume ls -q --filter label=com.docker.compose.project=bento-worker-a-web-a10)"
test -z "$(docker network ls -q --filter label=com.docker.compose.project=bento-worker-a-web-a10)"
```

### A 装配路径与权限来源

- 复用 [部署手册的配置执行服务](../../deploy/README.md#配置执行服务)的命令适配器路径。在 A 独占运行根的私有挂载内使用 `BENTO_HOST_CONFIG=/app/private/host.json`，利用现有 `apps/orchestrator/src/execution-service/command-host.ts:commandHost` 的 `prewarmWorker:true`、`workerSlots:2` 和 `taskObservationModule`。后者由 `loadTaskObservations` 验证 `observeWorkerExit`、`observeTaskVolumeStopped`、`taskRecovery.retryObservation/queryRestore/restoreTask/observeSdkRetrySafety`。配置 SDK `raw.js` 及可信绝对路径的 `control`、`worker` 命令。Worker 由 launcher 传递 `BENTO_DSH_BOOTSTRAP` 并使用 `--warm`。固定镜像和策略摘要按部署手册生成环境版本。继续使用 Go/Temporal 两槽接线。
- `BENTO_REVIEW_MODULE=/app/private/review.mjs` 使用现有进程内 installer，通过 A 私有控制通道接 reviewRun、closeTaskRun 和 readTaskClosure。宿主 `trusted-entry.mjs` 是浏览器测试驱动的受信进程，调用 A lease 下的 supervisor/独立卷读取及私有 review 通道。它以现有 hook 的 action 和输出契约为基础。私有挂载交由 UID 1000 只读，宿主 lease 与 entry 归本轮验收用户且为 0600，两侧权限分别核验。固定旧路径上的文件没有用于本轮判断。
- 已有 A 隔离验收授权涵盖在该环境内新建可弃置的 A 运行根、私有 lease 和适配 glue、专属 Compose 覆盖与状态卷、专属 Temporal namespace/task queue、A 专用测试账号和 Chromium 上下文、专属回环端口；使用 A 自有 MinIO 和本轮专属 bucket、凭据及前缀验证真实对象读写和清理。沿用 [WEB-07 确定性模型实栈先例](../40-readiness/evidence/WEB-07.md)，用 A 私有脚本提供确定性模型响应，仍通过真实 DSH Worker、OpenShell SDK 和沙盒执行。Gateway 测试 sandbox/Volume 由 WORKER 在 A Gateway scope 交接后创建。审核和开工后才落实。A 常驻 fixture 原服务和数据继续保全。需另选未冲突端口，使用 A 所有的资源前缀，由环境所有者确认新运行的资源额度和宿主授权。
- 网关/mTLS、Docker 受信控制、固定 SDK 与镜像输入、独立卷/进程观察已有本轮环境证据。环境探针没有业务 Run，task admission、业务 StopProof 与可信 review 需要在新 lease 中取得。

## A 专属装配

服务器私有根为 `~/bento-worker-a-openshell-0616/web-a10`（A10_ROOT），只接受不存在或空目录。Compose 项目、Temporal namespace、task queue、Keycloak realm、MinIO bucket 均名为 `bento-worker-a-web-a10`。每轮生成 UUID lease，私有配置 0600，运行根 0700。新 Web 仅发布宿主回环 28884，Chromium 加入 Web netns，以 `http://127.0.0.1:8080` 访问 Web 和同源 OIDC。MinIO 在 Compose 网内使用 `https://minio:9000`、独立 CA、SAN=minio，不发布宿主端口。仅可信端从 A 既有 Gateway 状态与证书读回 identity，使用固定 SDK，Gateway 不重启。沙盒和卷按原业务 binding 生成并独立清理，现有 A 探针沙盒/卷不得复用。登录、对象存储和服务 bearer 均新生成。

A 专属私有配置已生成。服务器私有根内可回读 `lease.json`、`compose.env`、`compose.overlay.yml`、`web.env`、`realm.json`、`identities.json`、`storage.pki.tar` 和 `provision-web.mjs`。当前准备的 Compose 仅发布回环 28884，状态未启动。T2b 启动后从 A10_ROOT 运行 `node provision-web.mjs seed` 配置专属 MinIO 和发送四份本组织邀请，再按 T2b 验证邀请、独立 owner 和真实签名上传。

A10_ROOT 已保全 `launcher.mjs`、`slot-proxy.mjs`、`sandbox-control.mjs`、`host.json`、`execution.env`、`sandbox-policy.yaml` 和 `launcher.test.mjs`。在 A 宿主运行 `node --test launcher.test.mjs` 4/4 通过，覆盖真实 warm 首条 ready 与 completed、租约/槽/进程启动身份、跨项目卷与真实临时 UDS 路由约束。正式环境仍须在同版候选的 T2b 检验真实 admission、沙盒卷读写和运行策略。私有宿主入口是 `node launcher.mjs host <A10_ROOT> <workerImageId> <orchestratorId>` 和 `node sandbox-control.mjs host <A10_ROOT>`。两个 `slot-proxy.mjs bridge` 半端只加入本轮 Orchestrator netns，各用本槽独立 traffic socket 与可信 registration socket。host.json 仍固定两个 warm 槽、18789 上游及私有 observation 模块。

### T1b1：补齐 A 专属 DSH 沙盒 runtime

前置状态为 T1b 已通过并提交 `8de90fa9ac20c87c0edeaca536048786b9be343a`。A10 Compose 保持未启动。仅该步经同版复审后才能执行。T1b1a～T1b1c 全部通过才进入 T1c。保持现有 A Gateway、常驻栈、健康候选和已有探针不变。

本机 A runtime 构建已通过四文件 SHA 校验及锁定 npm ci，`~/.bento-worker-a-web-a10-runtime` 保全 0400 的 `runtime-image.tar` 和 `runtime-image.json`。本机 Docker 报告 `linux/amd64`，tar SHA 复核一致。服务器导入及其实际镜像身份由下一步独立回读。

已在 A 私有 `inputs/workdir` 保全新标签 `bento-worker-a-web-a10/sandbox-runtime:8c769482-workdir` 的 0400 镜像归档与 manifest，双侧 SHA 通过。新 tar SHA-256 `1c9378cee350dcae70e7e0daffbd8123664b19da802e1e4f564a3e60f8d78097`，本机 index `sha256:218518e8f913e7c2340a1003fd5075cf85b63f92299f137314db9a80d597f850`，Linux/amd64 config ID `sha256:1292c9637ac04d618009ee08d4ee9d20c6a54be56a546c508f6c7dc57c0cbbaa`。镜像只把 OCI WorkingDir 改成 `/sandbox`，原 11 层完整保留、附加层为空。业务卷目标不变，仍为 `/sandbox/work`。升级前探针使用同租约的 `a10r2-<lease 前 8 hex>` 与 `bento-worker-a-a10r2-<lease 前 8 hex>`，已停写，保留 `runtime-image-workdir-report.json`。原 `a10rt-<lease 前 8 hex>` 沙盒、`bento-worker-a-a10rt-<lease 前 8 hex>` 卷、原镜像和失败报告保持现场。

HWE 后原 A Gateway、空候选和常驻栈已复验。宿主 Linux `7.0.0-44-generic`、Landlock ABI 8。A10_ROOT 的 `runtime-image-post-hwe-report.json` 已记录原 tar 与全层身份、`a10r3-<lease 前 8 hex>` 与 `bento-worker-a-a10r3-<lease 前 8 hex>` 的实际镜像和策略。真实 SDK 的锁定 helper 返回 full，包裹 argv 执行通过，FS 返回原标记，独立卷检查无 runtime 文件，专属探针与卷清理通过。rt/r2 旧失败现场与报告保全。

A10_ROOT 的 `sandbox-control.mjs`、`host.json` 与 `execution.env` 已绑定 post-HWE 报告的实际 A 镜像配置 ID、已验证策略和执行版本。T1b 四项 focused 与版本回读通过，原三文件在 0400 的 `runtime-rollback.tar` 保全，本轮业务尚未启动。

### T1b2：新卷 subpath 与可恢复原子交换

从 `b4ff9fb7377aafec19ab33a2062996580f24e9f1` 安全点继续。post-HWE full/FS 报告及配置版本保持有效。T1b2 三步通过才进入 T1c。仅本轮尚未创建的业务卷采用新布局，正式 A10 Compose 仍未启动。原 a10rt、a10r2、其卷和报告、既有 Gateway 及所有 fixture 保留。只修改本轮私有接线，不变更产品 Go、账本、接口或公共配置。

A 私有 `inputs/exchange-linux-amd64` 和 `inputs/exchange.sha256` 已保全。Go 1.25.3 静态 Linux/amd64，CGO=0，双侧摘要与服务器 0500 验证通过。其唯一动作是 `exchange` 或 `fsync-only`，均相对同一卷父目录及已核验的兄弟目录，成功须收到 `A10_PARENT_FSYNCED`。

A10_ROOT 的 `subpath-probe-report.json` 已保全真实 OpenShell v0.1.6 mount subpath、同 sandbox/volume 的 inode 和前后字节。停写、交换一次、崩溃窗口回读与 fsync-only 一次、重新启动读到新 inode、专属探针/卷清理全部通过。rt/r2 原失败现场保留。

本轮私有 `sandbox-control.mjs` 对全新卷初始化 `current/`，快照只读 current，实际 mount 使用并核对 `subpath:current`，原文件已在 0400 回退 tar 保全。私有布局回读和 launcher 4/4 通过，原镜像、策略及环境版本不变。

私有 launcher 的原授权单次负控已通过 focused 5/5，其中合成同路径同方法正控 0、撤权后同 token 负控 16、计数与卷证据不变、无登记/错身份/超时拒绝，原文件 0400 回退包已保全。真实 T2b/T2c 正负控仍待同候选审批。

A10_ROOT 已保全同版 `bootstrap.ts`、`runtime.json`、`sdk-relay.mjs`、`trusted-entry.mjs`、`review.mjs`、`task-observation.mjs` 及 `trusted-entry.test.mjs`。A 服务器 focused 6/6，完成双槽 gate/超时、错租约、分帧完整性、物理停止门槛和恢复 inode 判断。私有调用、原 grant 拒绝、真实 DSH 与 restore 尚须同候选验收。T2a 的 prepare 编排应启动 `node trusted-entry.mjs host <A10_ROOT> <orchestratorId>` 及相邻已有的 launch/control；可信侧证书仅供 SDK relay，review socket 位于 `state/<leaseId>/review-sockets` 并仅对 Orchestrator 读写，其他 observer/launcher socket 保持私有。本轮 Worker 镜像需带已验 Linux SDK 至 `/app/.bento-sdk`，Worker 只接本槽 UDS 和候选 runtime 配置。restore 通过已核验的同卷 exchange 工具，已交换的重投先重 fsync，核原 binding 和新 inode 后才落 ready。

A 私有 launcher 已完成一次性预备正控 focused 6/6，原 0400 回退包保留。候选 prepare 必须只在匹配本轮 C smoke marker 的正常已核 admission、WorkerRequest 转发前，用当前 grant 经原负控使用的相同 SDK ingress 执行固定 `ExecSandbox /usr/bin/true`；独立 relay 审计须由 0 到 1，gRPC status 须为 0。正控独立于旧 grant 记录，无取回接口，grant Buffer 在 finally 清零。0600 `valid-grant-proof.json` 绑定 lease、run、session、generation、bindingDigest、sandbox 与计数，T2b 对照浏览器的预备 Run。

A 私有 relay 叶证书已签发，CA、127.0.0.1 目标、服务端/客户端用途、key 配对和 0600 权限检查通过。仅可信 relay 读取私钥；上游限定网关 28881，下游限定本租约 Orchestrator netns 的 18789。真实 mTLS 和正控证据待 T2b 同候选审批后取得。

T2a 的 runner 白名单 3/3，Chromium 发现 1 项，验收源码类型检查通过，SDK reconciliation 7/7，retry SDK 32/32。A 宿主私有 `ops.mjs` 语法、Compose 静态配置和无租约调用拒绝已复核。ops 包含 build/prepare/verify/cleanup 四个入口，复验不可变输入及每次真实动作的同版 approval。prepare 使用只读 Docker CLI 与只供可信 launcher 的 daemon socket，两个槽和 SDK relay 加入同版 Orchestrator netns，先核两槽真实 ready，再做 smoke 和独立上游计数；正式浏览器在同版 Web netns 运行。冻结、实际构建、真实 admission、执行和清理按后续步骤取证。

T2b1 已在 A 宿主从只读 bundle 移交。候选源码 commit 为 `3684eaa97bbb020ab414ff1bc1b670d169b31368`，tree 为 `6026bfa0524492ea149a63c65eed0cdf2ec2aac2`，bundle SHA-256 为 `83de23c000346f10d83a4ecb746e6bb083c4cf1642d25c972ea1c40dd6b9baed`。对端摘要、commit/tree 和 clean 工作区均已核对。T2b 使用该已移交候选，本步骤的文档提交不进入它。

### T2b：冻结、批准与真实常规 admission

前置状态：T2b1 PASS。最终 `configurationSha256` 绑定已验证的 exchange binary SHA 和 `subpath-probe-report.json`。审批 `imageIds.sandboxRuntime` 必须等于 post-HWE 报告的 A 配置 ID，prepare 前重核 Docker ID、策略摘要和执行版本。以 `execution.env` 的已验证 `BENTO_EXECUTION_ENVIRONMENT_VERSION` 覆盖 `compose.env` 的静态预检版本，审批证据来自最终 Compose 渲染。在 A 宿主的 `~/bento-worker-a-openshell-0616/web-a10/source` 操作。允许实际写入 `manifest.json`、`source.tar`、`lease.json`、`runtime-report.json` 和 RUNBOOK（5），另核对 `approval.json`、`ops.mjs`、`compose.overlay.yml`、`host.json`、`run.mjs`（5）。`approval.json` 由 MASTER 审核后经 A 私有根交接，文件 mode 0600、由 A 授权身份拥有，WORKER 只读校验。禁止从非冻结树构建或执行。prepare、verify、cleanup 都通过同候选 runner 执行，每次从 manifest 读回 SHA-256 并对原 tar 和实际展开文件逐一校验。

```bash
cd "$HOME/bento-worker-a-openshell-0616/web-a10/source"
export BENTO_WEB_A10_CONFIG="$HOME/bento-worker-a-openshell-0616/web-a10/lease.json"
node apps/orchestrator/acceptance/web-a10/run.mjs --freeze
candidate_dir="$(dirname "$BENTO_WEB_A10_CONFIG")/state/$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.BENTO_WEB_A10_CONFIG)).leaseId')/candidate"
archive_sha="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).archiveSha256' "$candidate_dir/manifest.json")"
printf '%s  %s\n' "$archive_sha" "$candidate_dir/source.tar" | sha256sum -c
test "$(stat -c %a "$candidate_dir/source.tar")" = 600
node "$HOME/bento-worker-a-openshell-0616/web-a10/ops.mjs" build
```

归档通过后从同 tree 构建，记录实际 Docker 镜像 ID、锁文件、Compose 渲染和私有配置摘要。受信审批 `approval.json` 保存 `{leaseId,sourceCommit,sourceTree,archiveSha256,configurationSha256,imageIds,gatewayId,namespace,taskQueue,approvedAt}`，文件 0600。lease 写回 `composeApproval`、tree、archive 与 entry 摘要，消费者各自比对。不可变摘要清单不包含审批文件或写入审批后的整个 lease 字节，避免循环依赖。归档维持 runner 要求的 0600；部署和 Chromium 以只读挂载消费展开目录。任何变化重新冻结审批。等 MASTER 回读同版许可后运行：

```bash
cd "$HOME/bento-worker-a-openshell-0616/web-a10/source"
export BENTO_WEB_A10_CONFIG="$HOME/bento-worker-a-openshell-0616/web-a10/lease.json"
node apps/orchestrator/acceptance/web-a10/run.mjs --prepare
```

PASS：先以本轮专用预备 Run 用正常有效授权经相同生产 ingress 与固定 `ExecSandbox /usr/bin/true` 成功并核独立上游计数，正控授权不进入旧 grant 单记录。正常浏览器用专用预备账号从 Web 提交无屏障 C 场景，实际 Go/Temporal 派发、可信原 admission、真实 DSH/OpenShell 标记、成功 receipt 与原 Run 下载均可对照。 同版 admission 实际运行的沙盒镜像 ID 必须等于 T1b1 报告的 A 配置 ID，实际生效策略必须匹配其中的策略摘要及生效记录。独立三测试身份、MinIO 正常签名上传和独立读回、匿名拒绝都通过。预备工作区清理后才开始故障案例。STOP：只取得 warm ready、正常 admission 或读回失败、候选身份漂移。保全同 lease 证据，只提交 RUNBOOK。

### T2c：同候选验收与清理

前置状态：T2b PASS，审批记录仍与当前运行容器与源码相符。允许产物 `CaseReport.json`、`cleanup.json` 和 RUNBOOK（3），另查 `manifest.json`、`approval.json`、`runtime-report.json`、`lease.json`、`ops.mjs`（5）。只运行冻结候选，不修改断言。

```bash
cd "$HOME/bento-worker-a-openshell-0616/web-a10/source"
export BENTO_WEB_A10_CONFIG="$HOME/bento-worker-a-openshell-0616/web-a10/lease.json"
node apps/orchestrator/acceptance/web-a10/run.mjs --verify
node apps/orchestrator/acceptance/web-a10/run.mjs --cleanup
```

PASS：同一 lease 与 tree 的 Chromium 用例 1/1、零跳过，审计、07 回归和逐条矩阵证据均齐，CaseReport 绑定镜像/配置/源摘要和状态来源。仅清理该 lease 的容器、网络、卷、对象及 Gateway sandbox，按实际资源身份逐个回读 after。清理前后核对既有 A Gateway、健康候选及 fixture 仍健康。STOP：失败时先安全停写、用 SQLite backup API、独立卷快照及证据清单保全，再按明确归属清理，身份冲突保留现场。任何源或环境变更返回 T2b。仅提交 RUNBOOK，脱敏事实进入 T3。


## WEB-A10 断言矩阵

本矩阵由 T2a 补足实现、T2c 实跑并与同 tree 批准记录核对。

| 场景 | 操作与 PASS 证据 | STOP |
| --- | --- | --- |
| 06-06 | `interruptedCase` 锁定 A/B 原 Worker，先证明 C queued、无 admission。目标真实 Exec 写入并落盘后，受信独立只读卷见标记和 SDK 原代 UNKNOWN，业务 receipt 为零，才只强杀 A 原 PID/启动身份并丢弃冻结终态。在原页读 needs_review、无链接、直接 diff 409。可信账本对照原 Run/Session/Workspace 相同，旧 grant 写被拒，恢复前后目标 SDK 上游调用次数和独立标记次数均为 1。B 原 Worker 身份不变且下载正确 marker，C 随槽位释放才首次进入并完成。 | 身份证据缺失、使用日志代替独立对账、任何重放、B 换 Worker 或 C 提前执行。 |
| 06-07 | 用独立 A Run 走上一个中断路径。可信侧核对原 SDK 操作与独立快照摘要后调用 `reviewRun`，原页面及原 Run result 均回读 succeeded、补丁下载字节与对应 result version 一致，并可应用回原基线得到可信快照，重投同 proof 无新 Run 或新结果。 | patch 发自另一 Run、确认前可下载、proof 无法溯源。 |
| 06-08 | 新一轮中断用 `confirmFailed` 显示脱敏原因。含 UNKNOWN 的原 Run 无重试入口，直接重试为契约冲突且 Run/attempt 计数不增。独立取消路径用 `verifySafeRetry`，释放受信观察后显式调用 `confirmFailed` 并断言 `closed:true`，原页显示可信失败原因，且可信停止及 checkpoint 齐备后入口启用，202 只追加一条绑定原 Run 的安全重试，新 Run 完成、原 failed 保留。 | 失败原因缺失、把 5xx 当重试拒绝、证据不足仍可重试、重复新增 Run。 |
| 06-09 | 两个独立案例用 `closeUnconfirmed`。restore 未闲、仍有真实写者、sandbox 未停止分别拒绝，审计与清理门禁不变。全部通过后原 Task 能读结论，直接提交与重试均拒绝，diff 409，原 Run 无新增 admission。独立 Task 可执行。一个案例完成项目删除，另一案例真实 OIDC 重新认证并等账号与业务资源清理终态。两次均按原 Run 键回读相同审计字段和停止摘要。 | 只见注销 cookie 失效、只见删除页面跳转、审计变更/丢失，或清理波及其他账号。 |

### WEB-07 同候选复验

T2c 复用 `verifySafeRetry` 验证 07-04 的有证据正控和无证据拒绝。再在成功确认后以独立浏览器上下文回读同一原 Task、Run 和有序无重复事件，断开再重连时按 sequence 比较，确认原 diff 字节不变（07-01）。以同一幂等键在原 Task 追加依赖已确认内容的要求并重放，得到同一个新 Run，原历史和原补丁仍可读，使用只读 `deploy/orchestrator/observe-web-a11.mjs` 对照两个物理 Run 的 Session、绑定摘要和各自终态投影（07-02）。在同一来源项目另建 Task，观察其 Workspace 绑定不同且独立卷快照不含前一任务未交付 marker（07-03）。这些断言在原验收 spec 与受信 action 回读，部署采用本 RUNBOOK 的 A 专属拓扑。07-05 排队取消保持既有聚合 suite 的回归入口，未修改该行为。

## 逐步文件核对与提交范围

| 步骤 | 修改或产物 | 另行核对 | 合计 |
| --- | --- | --- | ---: |
| T0 | RUNBOOK（1） | `ENVIRONMENTS.md`、`deploy/compose.yaml`、`deploy/README.md`、`apps/orchestrator/src/execution-service/service.ts`、`apps/orchestrator/src/execution-service/command-host.ts`、`apps/orchestrator/src/execution-service/types.ts`、`apps/orchestrator/acceptance/web-a10/run.mjs`、`apps/workspace/web/acceptance/web-a10.spec.ts`（8） | 9 |
| T2b | 冻结产物、lease 更新及 RUNBOOK（5） | 只读 approval 等本步白名单（5） | 10 |
| T2c | 验收、清理产物及 RUNBOOK（3） | 本步白名单（5） | 8 |
| T3 | 本步列出的两份正式文档与 RUNBOOK（3） | T2c 的私有 CaseReport、`public-files.json`、`package.json`（3） | 6 |

本表覆盖专门走读与提交文件。命令测试遍历不计作另行核对。按各步的专门核对和交付文件计算。命令产生的容器状态及私有日志单独留存。实际需要另行核对文件、变更端口或改变可信边界时，回到作者修订并同版复审。

## T3：邻接回归与证据收口

前置状态为同候选 T2c PASS。允许修改 `docs/40-readiness/CURRENT-READINESS.md`、`docs/40-readiness/evidence/WEB-06.md` 和本 RUNBOOK。若有受审的正式契约或发布文件变化，先在对应实施阶段同步归属文档与登记。

```bash
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/tests/execution-service/reconciliation.test.ts apps/orchestrator/tests/execution-service/task-retry*.test.ts apps/orchestrator/tests/execution-service/project-deletion.test.ts
node --import ./register-paths.mjs --test apps/workspace/api/tests/space-project-deletion.test.ts apps/workspace/api/tests/oidc.test.ts
pnpm --dir apps/workspace/web exec playwright test e2e/task.spec.ts e2e/task-recovery.spec.ts e2e/task-results.spec.ts --reporter=line
pnpm --dir apps/workspace/web test:e2e
pnpm check
npm pack --dry-run --json
git diff --check
```

PASS 为相同候选 focused 与聚合门禁通过，零新增跳过，同版 A 环境具备 WEB-07 实际受影响断言（安全重试、原历史与旧结果、继续提交幂等），以及项目删除和账号注销回归。同候选 A 实栈使用 WEB-A10 矩阵明列的 WEB-07 断言及同一 Playwright 入口。WEB-06-01～05 保留原证据。记录候选 tree、镜像、脱敏实测证据、清理 after 和未覆盖边界，四子项及父项满足后才标已实现。最后删除 RUNBOOK，搜索残留当前文档引用并核对该步暂存文件。STOP 为证据缺失、边界回归、产物越过公开登记或版本不一致。提交产物为 readiness/evidence 和 RUNBOOK 删除，PR 交付按 MASTER 后续指令。
