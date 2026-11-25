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

### T1a：生成隔离装配配置

前置状态：现场 T0 PASS；当前 checkout 已提交 A 专属验收入口、候选路径断言与三条 focused 测试，并能发现唯一 WEB-A10 Chromium 用例。允许产物 `provision-web.mjs`、`lease.json`、`compose.env`、`compose.overlay.yml`、`web.env`、`realm.json`、`identities.json`、`storage.pki.tar` 和 RUNBOOK（9），另核对 A 基线 `deploy/compose.yaml`（1）。禁止导入旧身份、旧卷及外部凭据。

1. 在 A10_ROOT 创建 `provision-web.mjs`，唯一动作 config 和 seed。config 生成各配置，用 `--project-directory` 将 Compose 的相对路径解析限定在本轮私有根，静态渲染只读使用 A 基线的 `deploy/compose.yaml` 模板。本轮 Web 镜像从冻结源码构建，Orchestrator 和 Worker 同 tree。覆盖 Compose 端口，仅发布 Web；其它服务全部留在独占私网。新增 MinIO 只使用已核对 Linux/amd64 缓存 ID `sha256:69b2ec208575b69597784255eec6fa6a2985ee9e1a47f4411a51f7f5fdd193a9`，准入时回读其实际版本再绑定批准。空状态启动前生成独立 bucket 凭据、CA 及叶证书。Web 和 Chromium 信任本轮 CA。
2. seed 在 T2b 调用。先验证 MinIO 健康，创建私有 bucket、最小对象及 multipart 权限、CORS 限 Web origin，匿名及跨 bucket 拒绝。按部署手册启用 Keycloak Organizations、邮箱验证、S256 PKCE、Standard Flow、auth_time mapper、Mailpit SMTP、OIDC callback/logout URLs。经管理 API 建立四名独立邀请用户（正常准入探针与 A、B、C 三名正式测试用户），回读组织身份、邮箱验证及不同 owner，登录材料仅写 `identities.json`。Chromium 使用隔离 context，互不继承 cookie。

```bash
cd "$HOME/bento-worker-a-openshell-0616/web-a10"
node --check provision-web.mjs
node provision-web.mjs config
docker compose --project-directory "$PWD" -p bento-worker-a-web-a10 --env-file compose.env -f "$HOME/bento-role-test-cd13f3d/bento-worker-a/deploy/compose.yaml" -f compose.overlay.yml --profile dev config --no-env-resolution --quiet
```

PASS：配置渲染成功、唯一宿主发布为回环 28884、专属状态与 TLS 资格可核对。STOP：端口冲突、旧资源引用、缺少获准 MinIO 镜像或跨项目权限。保留失败配置和报告，暂不启动；只提交 RUNBOOK 步骤移除，私有材料不暂存。

### T1b：接入两个真实 Worker 槽和独立卷控制

前置状态：T1a PASS。允许产物 `launcher.mjs`、`slot-proxy.mjs`、`sandbox-control.mjs`、`host.json`、`execution.env`、`sandbox-policy.yaml`、`launcher.test.mjs` 和 RUNBOOK（8），另核对 `apps/orchestrator/src/execution-service/command-host.ts`、`apps/worker/run-worker.ts`（2）。禁止修改通用 Worker、调度和权威账本。

1. 复用既有 A 探针的 create/start/inspect/wait 模式。宿主 `launcher.mjs` 启动两份正式 `run-worker.ts --warm`，Docker `--network none`，独立 slot socket，不挂载 Docker socket、Gateway 或 review 私钥。接受 commandHost warm WorkerRequest 换行协议，透明返回 Worker stdout。在转交 WorkerRequest 前记录 `{leaseId,slot,containerId,startedAt,runId,sessionId,generation,bindingDigest,mode}`，grant 和 prompt 不落盘。只允许按既有 admission 的容器 ID、StartedAt、lease 和 slot 定向 kill，wait 和 Docker inspect 共同证明退出。
2. `slot-proxy.mjs` 的可信半端加入 Orchestrator netns，并通过本槽 Unix socket 向 Worker 容器 loopback 透传。宿主 launcher 通过只读候选 image 启动 `--network container:<本轮 Orchestrator ID>` 的代理半端，连接本轮 socket 挂载。两侧均由 launcher 预登记相同 slot 和当前 admission，worker 侧只得到本槽 Unix 路径。仅放行当前 WorkerRequest 的 persistence、operation、SDK 三条环回地址；端口来自现有 grant/request，按 slot 和原 admission 校验。Worker 侧半端仅监听自身回环，结束 admission 后撤销端口列表与连接。禁止直连 Gateway、review 或跨槽。
3. `sandbox-control.mjs` 实现 commandHost action。只接受本 lease 登记 binding；原 project 为 UUID、sandbox 为 b- 加 16 位 hex、volume 为 bento-workspace- 加原项目 UUID。卷带 lease 和项目归属及 OpenShell attachable 标签，核对 sandbox 的 ID、namespace、workspace 和唯一 RW 挂载。provisionTask 使用固定环境版本创建真实沙盒并导入文本，snapshot 通过断网只读卷 helper，stop/start 用 A CLI，stopped 要求 Gateway 状态和 Docker 运行挂载一致，purge 只删本绑定并回读不存在。host.json 固定 `prewarmWorker:true,workerSlots:2` 及下一步 observation 模块，命令通过私有 UDS 连接宿主，Orchestrator 容器本身无 Docker socket。
4. 固定控制协议：`state/<leaseId>/control.sock` 以一条换行 UTF-8 JSON 包读取 `{leaseId,action,binding,files?,environmentVersion?}`，action 枚举 `provision|provisionTask|snapshot|stop|start|stopped|running|purge`。成功在 socket 回 `{ok:true,value}`，stop/start 的 value 为 null；拒绝回 `{ok:false,code}`。control 客户端解包按 commandHost 的返回输出，stop/start 不写 stdout，拒绝或无响应均非零退出。专用 `launcher.sock` 启动命令首行发 `{leaseId,action:'warm'}`；宿主分配两个空槽之一，等待 `run-worker.ts --warm` 自带的首行 `ready\n`，校验并原样转发一次。launcher 禁止合成或重复发送 ready；之后透明传现有 WorkerRequest/Worker stdout；每个连接固定一槽，收到 EOF/SIGKILL 只清理该槽符合记录的实例。任一拒绝不得伪造 worker receipt。Orchestrator 的 worker/control 命令分别运行 `node /app/private/launcher.mjs worker-client` 与 `node /app/private/sandbox-control.mjs client`，由 host.json 明确 args 和受控 lease 环境变量。
5. launcher 单测验证错 lease/slot/run/StartedAt、额外端口、跨项目卷拒绝和正常目的地放行，使用独立临时 socket。focused 握手正控运行真实 `run-worker.ts --warm`，用独占测试 bootstrap 完成首条合法 WorkerRequest。断言客户端先收到且只收到一次真实 ready，发送首条请求后下一行就是该请求的合法业务 receipt（正控固定 `completed`），若读到第二条 ready 即失败。真实暖槽设备可用性已有 T0 证据，业务 admission 在 T2b 验。

```bash
cd "$HOME/bento-worker-a-openshell-0616/web-a10"
node --check launcher.mjs
node --check slot-proxy.mjs
node --check sandbox-control.mjs
node --test launcher.test.mjs
```

PASS：验证全部通过，错身份命令未到达后端。STOP：Worker 能访问未授权地址或无法独立对账卷。失败只停止本轮测试 socket，保全证据。提交仅 RUNBOOK。

### T1c：接入受信观察、复核与落盘屏障

前置状态：T1b PASS。允许产物 `bootstrap.ts`、`review.mjs`、`trusted-entry.mjs`、`task-observation.mjs`、`sdk-relay.mjs`、`trusted-entry.test.mjs`、`runtime.json` 与 RUNBOOK（8），另查 `apps/worker/task-bootstrap.ts` 和 `apps/orchestrator/src/openshell/sdk-ingress.ts`（2）。禁止添加公开复核 API 或向业务账本注入状态。

1. `bootstrap.ts` 接正常 Task bootstrap，使用确定性 DSH 模型和真实 ToolRuntime，固定角色输入 `WEB-A10 <A-write|A-cancel|B|C> <UUID>`。A-write/B/C 以一次正常 SDK Exec 在实际工作区文件追加 marker 并 fsync。marker 只作独立 argv。recover 走正常历史恢复，零目标 Exec。A-cancel 原 Run 在持久会话开始后等待停止并零写，受信观察释放前返回 null；同一业务请求的安全重试从持久 retry attempt 与原 admission 分类并正常结束。07-02 的追加请求与 07-03 的独立请求另以 spec 的固定角色和 marker 区分。
2. `trusted-entry.mjs` 实现现有 hook 动作枚举。在 A/B runtime.initialize 返回、发出任何 SDK 或 history RPC 之前等待独立槽 gate。按 caseId 回读两个原 Run 的持久 admit、不同槽和 Docker 启动身份，C 回读 queued、无 admit/receipt，并核对没有第三 Worker。持久证据成立后放 A。A 原 Worker 独立退出后只放 B。gate 的外层期限为 60 秒，超时立即撤销冻结、释放等待并判失败。
3. `sdk-relay.mjs` 的上游固定 `https://127.0.0.1:28881`，校验 A Gateway CA 和客户端证书。commandHost 的 gateway 固定为 Orchestrator netns 内 `https://127.0.0.1:18789`，由可信 sidecar 监听并透明转到本轮 `sdk-relay.sock`；宿主 relay 在该 UDS 终止入站 TLS 并验证 client certificate，独立新叶证书由 A CA 签发并包含 127.0.0.1 SAN，私钥仅挂可信 relay。禁止让 Worker 接触此端口或私钥。可信宿主再以 A mTLS 转发，只针对本 case 的原 A 标记 Exec。先将原请求转发到真实 Gateway，再扣住对应 terminal event 和 trailers。使用锁定 schema 与原 binding，要求外部 RO 卷 marker 恰 1、原代 SDK UNKNOWN 恰 1、business receipt 为零且原 SDK 流仍打开后，按 launcher 的原 admission 容器身份强杀 A。目标 SDK 自首请求帧起超时 8 秒（生产 SDK 上限 10 秒）。其他流透传，失败关闭目标流。旧 grant 负测只在可信进程内对原 SDK ingress 以目标写类请求验证撤权后请求被拒绝，核对无上游调用及副作用次数不增长，grant 不出该进程。日志不得代替独立卷和两侧账本。
4. `review.mjs` 只通过现有进程内 installer 暴露私有 UDS 方法。成功用原 UNKNOWN 的 `sdkOperationId` 和独立快照 SHA-256；failed 使用同绑定 READY；unconfirmed 还须 restore idle、零运行 RW 挂载、Gateway stopped。只回读同原键审计。`task-observation.mjs` 组合独立 launcher wait、持久业务与授权账本和 Gateway/Docker 证据以提供退出、可信停止、retryObservation/queryRestore/restoreTask/observeSdkRetrySafety。restore 按原 attempt 独占绑定和持久 manifest。取得 stopped、零 RW 挂载后，先将完整文本写入同卷的新 staging 目录并 fsync，核对 `expectedSha256`。发布使用同文件系统的原子目录交换，重复 attempt 只核对既有发布及 ready 标记。重新启动后独立读回绑定、实效 policy 和快照摘要，成功后才报告 ready。身份冲突或读回不一致立即 STOP，保留 staging 和原证据。三个物理停写负控逐个保持 restore busy、实际 RW 或沙盒未停，门禁及审计均不变。
5. `review.sock` 为 0660、本轮可信进程独占。单行 JSON 包 `{leaseId,action,payload}`，仅 `reviewRun`、`closeTaskRun`、`readTaskClosure`；payload 分别为上文 SDK proof、`{runId,decision,expectedGeneration}`、`{runId}`。校验原 Run 与 lease 后将现有回调结果包为 `{ok:true,value}`，无返回值用 null；预期拒绝用 `{ok:false,code}`，禁止携原始日志。hook 通过单独可信 `trusted.sock` 发送同形外包及既有枚举、BarrierInputs；`trusted-entry.mjs` 才能派生 review proof。两 socket 无宿主 TCP 发布。
6. `task-observation.mjs` 的 `observeSdkRetrySafety(binding,runId,generation)` 只返回 null，或精确 `{sessionId,runId,generation,bindingDigest,exitedAt,observedAt,unknownOperations,workspaceOnly}`。字段来源如下：
   - runId/generation 来自可信 launcher 原 execute admission，并与持久 Run.admittedGeneration 匹配；sessionId 来自原 binding，与持久 Run.sessionId 相等；bindingDigest 用 `executionBindingDigest(binding)` 与 admission/Run 持久摘要交叉核对。
   - exitedAt 与 `observeWorkerExit` 返回并由 `taskExit` 持久化的时间字节相同，源是与原 container ID、StartedAt 匹配的 Docker wait/inspect FinishedAt，经同一 ISO 归一化；仅进程退出后采集 observedAt，满足 exitedAt ≤ observedAt ≤ 消费时刻。
   - unknownOperations 为从 authority 操作账本按原 session 与 `g` 经独立只读核对的 UNKNOWN 条数，必须为 0，并由生产 `stopAndProve` 复核；workspaceOnly 由目标 SDK 受限操作清单、实际 sandbox policy 和唯一同 binding 卷，以及无额外能力/外部目的地的 launcher 观察共同判定。未知一律 null。
   - `historyQuiescence(session)` 由生产 `stopAndProve` 在接收观测后直接核对 `handleOpen=false,pendingBatches=0`；可信宿主不可替生产进程返回该状态。最后生产复查 READY `g+1` 与原代 UNKNOWN，才持久化 proof。
7. `observeWorkerExit(binding,runId,generation)` 返回上述同源的前五个身份和退出字段或 null；`observeTaskVolumeStopped` 回相同四个 binding/run/代次字段及 `{restoreIdle:true,volumeWriters:0,sandboxStopped:true,observedAt}` 或 null。 `retryObservation(binding,runId,generation)` 返回 `{unknownOperations:number,workspaceOnly:boolean}`，两值复用上述只读来源，证据不全拒绝。 `queryRestore(binding,attemptId)` 返回 null 或 `{attemptId,phase:'prepared'|'published'|'ready',sha256}`；`restoreTask(binding,attemptId,files,expectedSha256)` 接受当前 attempt 的规范文本数组 `{path:string,text:string}[]`，返回 `{attemptId,sha256}`，仅在 ready 后成功。阶段和摘要从原子持久 manifest 回读。以上观察和恢复使用独立 `observe.sock` 同 0660、同包结构，action 仅允许这五类加 `observeSdkRetrySafety`，各 payload 恰为该签名字段。禁止浏览器直接接入。
8. 单测错租约、未登记、重复放行、跨槽、临界超时、停写不足和合法双槽后只放 B。review 输出限定 UUID/摘要/计数/布尔，私有入口无浏览器侧凭据可读。

```bash
cd "$HOME/bento-worker-a-openshell-0616/web-a10"
node --check trusted-entry.mjs
node --check review.mjs
node --check sdk-relay.mjs
node --check task-observation.mjs
node --test trusted-entry.test.mjs
```

PASS：focused 检查无跳过，拒绝分支均未产生可信结论。STOP：事实来源相互覆盖或证据采集超出运行契约。保留报告，关闭测试 socket，仅提交 RUNBOOK。

### T2a：完成最终候选与私有编排

前置状态：T1c PASS。本步公开源码在本地 `/Volumes/storage/workspace/bento-a` 修改并验证，私有 ops.mjs 在 A SSH 宿主的 A10_ROOT 编写与语法验证，运行时读服务器冻结归档。允许改 `apps/workspace/web/acceptance/web-a10.spec.ts`、`apps/workspace/web/acceptance/web-a10-hook.ts`、`apps/orchestrator/acceptance/web-a10/run.mjs`、`ops.mjs` 和 RUNBOOK（5），另查 `deploy/orchestrator/observe-web-a11.mjs` 和 `apps/orchestrator/src/execution-service/task-run-view.ts`（2）。本步完成矩阵及 WEB-07 受影响用例。运行器的项目与 lease 路径换成 A 专属，保留路径、owner/mode、白名单及同版本检查。私有 `ops.mjs` 仅接受 build/prepare/verify/cleanup，runner 校验其摘要后调用。运行路径必须是只读候选归档。build 从已冻结归档构建并输出实际镜像与配置绑定报告；prepare 核对合法批准、启动专属 Compose、配置 Temporal、seed OIDC 与 MinIO、做正常 admission；verify 从实际浏览器执行矩阵；cleanup 按 lease 精确枚举并保全，只删本轮归属。Chromium 镜像和二进制按冻结 Playwright lock 及安装清单核对。归档和审批后才能进入真实部署。

```bash
cd /Volumes/storage/workspace/bento-a
node --check apps/orchestrator/acceptance/web-a10/run.mjs
node --test apps/orchestrator/acceptance/web-a10/run.test.mjs
pnpm --dir apps/workspace/web exec playwright test --config playwright.web-a10.config.ts --list
```

在 A 宿主从 A10_ROOT 另执行 `node --check ops.mjs`。从本地同候选源码执行权威流程 focused 测试：

```bash
cd /Volumes/storage/workspace/bento-a
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern 'trusted SDK selector publishes only|Task operation reconciliation stays conservative' apps/orchestrator/tests/execution-service/reconciliation.test.ts
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/tests/execution-service/task-retry-sdk.test.ts
```

PASS：唯一正式 Chromium 用例及三条 runner 白名单用例发现/通过，同版 focused 中 SDK selector、恢复中断及 retry SDK suite 通过，私有动作只有已批准的同版输入可启动。STOP：生产缺陷或命令涉及越权资源。保留候选，按具体失败另审核，提交仅收允许的公开验收文件和 RUNBOOK。

### T2b1：将本地提交态只读移交到 A 宿主

前置状态：T2a PASS 并已提交，绑定本地 repo。允许产物本地临时 `candidate.bundle`、A 宿主 `inputs/candidate.bundle`、`source` 源码归档展开目录和 RUNBOOK（4），另查 `ENVIRONMENTS.md`、`lease.json`（2）。禁止以 rsync/scp 上传工作区或私有运行配置。以下脚本在本地 `/Volumes/storage/workspace/bento-a` 执行。使用环境说明的 SSH 命令和终端认证流程。

```bash
cd /Volumes/storage/workspace/bento-a
set -euo pipefail
test -z "$(git status --porcelain)"
stage="$(mktemp -d -t bento-a-web-a10)"
trap 'rm -f "$stage/candidate.bundle"; rmdir "$stage"' EXIT
git bundle create "$stage/candidate.bundle" HEAD
chmod 400 "$stage/candidate.bundle"
candidate_sha="$(shasum -a 256 "$stage/candidate.bundle" | awk '{print $1}')"
candidate_commit="$(git rev-parse HEAD)"
candidate_tree="$(git rev-parse HEAD^{tree})"
python3 - "$stage/candidate.bundle" "$candidate_sha" "$candidate_commit" "$candidate_tree" <<'A10_TRANSFER'
import pathlib,re,shlex,subprocess,sys
path,digest,commit,tree=sys.argv[1:]
assert re.fullmatch(r"[a-f0-9]{64}",digest)
assert all(re.fullmatch(r"[a-f0-9]{40}",value) for value in [commit,tree])
source=pathlib.Path("ENVIRONMENTS.md").read_text()
ssh=shlex.split(re.search(r"^ssh (.+)$",source,re.M).group(1))
remote = r"""
set -eu
umask 077
root="$HOME/bento-worker-a-openshell-0616/web-a10"
cd "$root"
mkdir -p inputs
test ! -e inputs/candidate.bundle
test ! -e source
cat > inputs/candidate.bundle
chmod 400 inputs/candidate.bundle
printf '%s  inputs/candidate.bundle\n' DIGEST | sha256sum -c
git init -q source
git -C source fetch --no-tags "$root/inputs/candidate.bundle" HEAD
git -C source checkout --detach --quiet FETCH_HEAD
test "$(git -C source rev-parse HEAD)" = COMMIT
test "$(git -C source rev-parse HEAD^{tree})" = TREE
test -z "$(git -C source status --porcelain)"
printf 'A10_REMOTE_SOURCE_VERIFIED %s %s\n' COMMIT TREE
""".replace("DIGEST",digest).replace("COMMIT",commit).replace("TREE",tree)
with open(path,"rb") as payload:
    subprocess.run(["ssh",*ssh,remote],stdin=payload,check=True)
A10_TRANSFER
```

PASS：服务器 bundle SHA-256 与本地一致，readback commit/tree 精确相同，服务器源码 clean。STOP：既有 source/归档、额外 tracked/untracked 文件或 SHA 不符。SHA 未通过不展开。只清理本步唯一临时文件，保留服务器本轮失败现场。T1a 的 Compose 静态渲染从已有 A 基线源码读取，不在 A10_ROOT 预先创建 source。T2b1 提交仅移除 RUNBOOK 步骤；若此文档提交发生在 bundle 之后，在 T2b 以 bundle 的已授权候选 SHA 为准。

### T2b：冻结、批准与真实常规 admission

前置状态：T2b1 PASS。在 A 宿主的 `~/bento-worker-a-openshell-0616/web-a10/source` 操作。允许实际写入 `manifest.json`、`source.tar`、`lease.json`、`runtime-report.json` 和 RUNBOOK（5），另核对 `approval.json`、`ops.mjs`、`compose.overlay.yml`、`host.json`、`run.mjs`（5）。`approval.json` 由 MASTER 审核后经 A 私有根交接，文件 mode 0600、由 A 授权身份拥有，WORKER 只读校验。禁止从非冻结树构建或执行。prepare、verify、cleanup 都通过同候选 runner 执行，每次从 manifest 读回 SHA-256 并对原 tar 和实际展开文件逐一校验。

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

PASS：正常浏览器用专用预备账号从 Web 提交无屏障 C 场景，实际 Go/Temporal 派发、可信原 admission、真实 DSH/OpenShell 标记、成功 receipt 与原 Run 下载均可对照。独立三测试身份、MinIO 正常签名上传和独立读回、匿名拒绝都通过。预备工作区清理后才开始故障案例。STOP：只取得 warm ready、正常 admission 或读回失败、候选身份漂移。保全同 lease 证据，只提交 RUNBOOK。

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
| T1a | 私有 Compose、OIDC、MinIO 产物与 RUNBOOK（9） | 部署入口（1） | 10 |
| T1b | launcher、slot、卷控制产物与 RUNBOOK（8） | commandHost、Worker 入口（2） | 10 |
| T1c | DSH 与可信复核产物和 RUNBOOK（8） | Task bootstrap、SDK ingress（2） | 10 |
| T2a | 候选、编排和 RUNBOOK（5） | WEB-A11 观察器和 Run 投影（2） | 7 |
| T2b1 | 两份 bundle、源码展开目录与 RUNBOOK（4） | ENVIRONMENTS、lease（2） | 6 |
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
