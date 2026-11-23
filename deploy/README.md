# Bento 部署

[Bento Compose](compose.yaml) 是整体部署入口，包含个人端、MySQL、Keycloak、PostgreSQL 和 Orchestrator。同一份文件提供开发用 Temporal、Mailpit 和可选的 Worker 镜像构建目标。组件职责见[整体架构](../docs/00-governance/ARCHITECTURE.md)。在仓库根目录运行以下命令，使用 Docker Compose 2.24.4 或更新版本。

## 准备配置

```sh
mkdir -p debug-workspace/execution debug-workspace/keycloak-import
```

在仓库根目录的受控 `.env` 中设置 `BENTO_MYSQL_PASSWORD`、`KEYCLOAK_DB_PASSWORD`、`KEYCLOAK_ADMIN_PASSWORD` 和 `BENTO_EXECUTION_BEARER`。四项分别生成，例如分别执行 `openssl rand -hex 32`。Web 和 Orchestrator 使用同一个 `BENTO_EXECUTION_BEARER`。本地入口默认为 `http://127.0.0.1:8080`。远端部署设置 `BENTO_PUBLIC_ORIGIN` 为用户实际访问的 HTTPS origin，由受信反向代理转发到宿主机回环的 8080，并覆盖 `Host` 和 `X-Forwarded-Proto`。容器内的 Web API 和浏览器都必须能访问该 origin。

准备受控的 Keycloak Realm 导出文件，放入 `debug-workspace/keycloak-import/`。默认 Realm 为 `bento`，其他名称通过 `BENTO_KEYCLOAK_REALM` 配置。Realm 启用 Organizations、邮箱验证和 SMTP，关闭公开注册。设置组织 alias，创建启用 Standard Flow 和 S256 PKCE 的 confidential client，ID token 提供 `email`、`email_verified`、`organization` 和 `auth_time` 声明。若客户端未关联含 `auth_time` mapper 的 `basic` scope，为该客户端配置 Keycloak 的 `AUTH_TIME` 用户会话注记到 ID token。账号注销使用 `prompt=login` 和 `max_age=0` 重新认证并校验该时间。登记 `<BENTO_PUBLIC_ORIGIN>/api/oidc/callback` 回调和 `<BENTO_PUBLIC_ORIGIN>/auth` 退出回跳地址。Keycloak 的浏览器入口为 `/identity/`。部署入口对 Keycloak 管理路径应用管理访问控制。

在 `debug-workspace/web.env` 中设置以下变量。若没有配置文件空间，省略三项 `BENTO_SPACE_*`。对象存储凭据通过运行环境的 AWS 凭证链提供。

```dotenv
BENTO_OIDC_CLIENT_ID=<客户端 ID>
BENTO_OIDC_CLIENT_SECRET=<客户端凭据>
BENTO_OIDC_ORGANIZATION=<组织 alias>
BENTO_SPACE_DB=/data/space.sqlite
BENTO_SPACE_S3_ENDPOINT=https://storage.example.com
BENTO_SPACE_S3_BUCKET=bento-private
AWS_REGION=us-east-1
```

按[配置执行服务](#配置执行服务)准备 `debug-workspace/execution.env` 和受信适配器，再按需设置 [Temporal](#temporal-配置)。

## 启动与检查

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
```

Compose 在数据库、Keycloak 和 Orchestrator 健康后启动 Web。使用默认回环 issuer 时，Web 会等待 NGINX 代理的 OIDC discovery 可用，再启动 API。打开 Bento 首页，使用组织邀请完成登录，检查同一账号重复登录复用稳定 `owner_id`。提交任务并通过原链接读取结果。启用文件空间时，从浏览器验证 S3 分块上传和下载。

Compose 的 `auth-build` 阶段独立生成个人端认证 HTML 和 CSS。运行镜像通过 NGINX 和 Go 入口将 `/auth` 请求转发给 TypeScript task-entry，由它根据当前业务会话提供构建产物。启用 OIDC 时若启动日志提示 `Workspace auth build artifacts are unavailable`，运行 `docker compose -f deploy/compose.yaml build bento-web` 后重新启动服务。

Web 和 Orchestrator 的 Go 构建使用 BuildKit 持久缓存：`bento-go-mod-1.25` 保存 `/go/pkg/mod`，`bento-go-build-1.25` 保存 `/root/.cache/go-build`。同一 builder 上重建时复用已下载模块及编译结果，即使构建层失效或上次构建失败，也无需重新下载已缓存的模块。依赖版本仍由各自的 `go.mod` 和 `go.sum` 决定。缓存属于 builder，不进入运行镜像；日常案例清理只删除本次容器和镜像，不清理共享构建缓存。首次下载、缓存被回收或切换 builder 后仍需要可用网络，缓存不能替代代理或网络配置。

启动失败时运行 `docker compose -f deploy/compose.yaml logs --tail=100`。核对 Realm 导入、OIDC 客户端配置、容器对 issuer 的连通性，以及适配器的启动日志。用同一 Compose 项目名执行 `stop` 和 `up -d` 恢复。保留命名卷以延续账号、身份、空间及执行状态。

## 单节点业务执行账本备份还原演练

从仓库根目录使用已安装锁定依赖的 Node.js 22 和 pnpm 12.15.0。确认当前 Node 22 提供 `node:sqlite.backup`。命令使用测试进程的动态回环端口和私有临时目录。

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores the completed Run business ledger from an isolated backup$' apps/orchestrator/tests/execution-service/restore.test.ts
```

演练生成合成项目及成功 Run，等执行服务关闭后，以 SQLite backup API 读取 `business.sqlite` 并生成单库备份。备份通过完整性、外键和已提交回执检查，才复制到一个全新目录。启动前核对备份与还原文件的 SHA-256，再用同一个执行服务入口启动还原实例。SQLite 使用 WAL，运行中直接复制主库文件可能遗漏已提交事务。其他数据库、WAL/SHM、锁文件和本地 fixture 卷均不随该备份复制。

PASS 时只通过一个匹配测试，报告备份 SHA-256。项目、Run、diff、同键同输入的原 Run 回执均一致，同键异输入返回冲突，其他 owner 读不到该 Run，列表只有原 Run，且没有调用还原侧 fixture 的执行入口。摘要来自合成数据，每次运行可变化。命令失败时使用测试输出定位失败断言，测试会关闭服务并清理本次临时目录。修复前置条件后重新执行，下一次使用全新目录。测试进程被强杀后，先核实进程已退出，再清理仅属于该次运行的 `bento-ledger-restore-*` 临时目录。

Compose 当前的 TS 执行服务持有该业务账本。演练覆盖其中已结束 Run 的读取和幂等重放。授权账本与会话历史见下方[三库停服演练](#单节点执行宿主停服备份还原演练)。生产恢复还需单独验证外部 Workspace、Temporal、账号与身份数据、S3 及部署级回滚。演练产物只用于本地校验，禁止覆盖已运行或曾运行的状态目录。

## 单节点执行宿主停服备份还原演练

从仓库根目录使用 Node.js 22、`node:sqlite.backup` 和已安装的锁定依赖。命令通过动态回环端口在私有临时目录运行单库与三库演练。

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores (the completed Run business ledger from an isolated backup|stopped execution state and continues fenced session history)$' apps/orchestrator/tests/execution-service/restore.test.ts
```

三库演练等待源执行服务关闭。在源服务持续关闭且无写者的同一窗口，使用 SQLite backup API 依次备份 `business.sqlite`、`authority.sqlite`、`history.sqlite`。逐库核对完整性、外键和 SHA-256，在全新隔离目录还原。还原侧以同一项目绑定路径排他创建经字节校验的合成 `README.md`，供后续 Run 读取基线。演练产物仅包含合成状态，禁止覆盖已运行或曾运行的状态目录。

PASS 时两项测试通过，零失败、零跳过。三库演练报告三个备份摘要，原 Run 的详情和同键重放各自一致，旧代 append、flush、close 均返回 403，新 Run 在下一代读回旧历史并追加一批事件，两代持久回执均与 RPC 结果一致。失败时按测试输出定位断言，测试会关闭服务、数据库句柄并清理临时目录。修复前置条件后用新目录重跑。若测试进程被强杀，先确认其退出，再清理仅属于本次运行的 `bento-execution-state-restore-*` 目录。

该演练验证已完成 Run 的停服边界，真实 OpenShell Workspace 卷及其生命周期、真实 DSH provider/checkpoint、未结批次与故障注入、在线备份和部署级恢复需单独验收。

## 单执行节点真实备份恢复与重启验收

声明范围为单执行节点的执行子部署：正式 commandHost、生产 Go Orchestrator、真实 Temporal、官方 DSH/OpenShell、独立工作区卷及真实模型。正常持久轮次完成后停止执行进程和写入者；OpenShell Gateway 的身份、证书及模型服务在演练中保留。账号 MySQL、Keycloak/Postgres、S3 和完整网站恢复不属于该集合。

在独立 Linux/amd64、Node.js 22 环境准备 Docker CLI、Git、官方 SDK/CLI、受控 bootstrap 和私有配置。配置包含独立资源归属、精确镜像 ID、源码提交、Gateway 身份及通过的能力门禁；不接受缺失证明或其他 owner 的资源。DSH 和官方文件/DeepSeek 插件固定 `0.2.1-rc.4`，Cordis 固定 `4.0.5`，按 frozen lockfile 安装。私有配置、凭据、数据库、备份和报告放在仓库外受限目录。

```sh
BENTO_A7_CONFIG=/absolute/private/case-restart.json node apps/orchestrator/acceptance/single-node-restore/run.mjs --case restart
BENTO_A7_CONFIG=/absolute/private/case-restore.json node apps/orchestrator/acceptance/single-node-restore/run.mjs --case restore
```

两个用例分别使用全新业务状态和独立归属。恢复用例停止服务并备份执行账本、授权账本、Session 历史和 Temporal 四个 SQLite 数据库，校验 integrity、外键和 SHA-256，同时归档真实工作区卷并建立独立保全副本。独立数据库快照固定为 DELETE journal mode；校验拒绝未纳入清单的 WAL、SHM 和 journal 文件。恢复前校验绑定和完整清单，仅写入空目标。归档 helper 断网并只读挂载源卷；解包使用受控 root 恢复新卷的文件所有权。无法证明停写、归属冲突、非空目标和损坏备份均拒绝继续。

PASS 要求八项断言全部通过：完整业务账本、原回执、原工作流、Session 历史、文件字节、幂等、owner 可见性和原 Session 后续执行。CaseReport 记录源码、恢复版本、已确认记录丢失数、实测 RTO 及停止/清理结果。RTO 从停止边界计到恢复后第二轮完成，属于本次演练观测值。失败时保留源数据库、卷及备份，核对本次资源身份后处理；不得执行全局清理或覆盖曾运行的状态目录。成功时仅清理本轮资源，失败现场先归档保全。实际结果见 [A7 证据](../docs/40-readiness/CURRENT-READINESS.md#a7-单执行节点真实恢复验收)。

本入口验证计划停服及进程重启，不覆盖在线备份、机器掉电、Gateway 灾备、完整子进程 confinement、多节点或 HA。

## 单节点 Web 镜像回滚演练

在经批准的 Linux/amd64 开发宿主使用独立 Compose 项目。演练使用正式 Web 镜像构建输入、启动入口和健康检查，配合 mock 业务模式、独立 MySQL 和合成数据。故障镜像只把 `/api/session` 改为返回 503。该流程用于验证同源码版本的 Web 镜像替换和恢复。发布版本降级及数据兼容需要独立验收。

复跑时从已通过的计划提交提取命令，以该提交作为演练计划 HEAD。源码固定在计划声明的基线。正式构建需要本地 Go 1.25.3 和按 `go.sum` 校验的缓存，宿主需要已核验的 Node 和 MySQL 镜像以及公开 apt、Corepack 和 pnpm 依赖下载。

```bash
git show 1b0fdca6e1e8e1351ee69b2baa525be762465ea0:docs/30-designs/RUNBOOK-A8-WEB-IMAGE-ROLLBACK.md
```

按提取的启动入口生成传输包和 launcher。传输包只包含源码归档、Linux/amd64 Go 入口和 SHA-256 清单。首次复跑前核对演练目录、项目、网络、卷、镜像标签及回环端口可独占，沿用同一项目锁。在原宿主再次演练时，为本轮分配尚不存在的私有目录并同步 launcher 与上传目的地，保留前轮记录。禁止使用现有部署的卷、端口、凭据或运行配置。

PASS 要求基线 Web 健康，首页和匿名会话返回 200、401。候选 Web 必须保持运行，首页返回 200、会话返回 503，且 Docker 健康状态变为 `unhealthy`。随后用原镜像 ID 重建 Web，恢复健康和原 HTTP 状态。MySQL 容器 ID、启动时间、合成账号行，以及 Web 卷挂载和标记 SHA-256 必须一致。退出时校验演练资源已移除、端口释放且证据清单通过。

若构建或断言失败，按记录中的阶段检查受控目录。候选切换期间失败时，退出流程先尝试恢复原镜像，再按本轮标签清理。身份不匹配时保留现场，待核对后处理。仅保存脱敏结果与摘要。实际结果见 [Readiness A8](../docs/40-readiness/CURRENT-READINESS.md)。

## OpenShell 执行宿主

### 接入前检查

1. 使用受信执行入口接入启用 mTLS 的 OpenShell Gateway。将后端管理凭据限制在受信服务端。确认 Worker 无法直连 Gateway 或访问 Docker 管理接口。
2. 为 Workspace 准备独立持久 Volume。受测 Docker driver 启用 `allow_driver_config`，卷使用 `sandbox-attachable=true` 和 `sandbox-attachable-workspace=default` 标签。部署后核对沙盒挂载、工作目录与策略。
3. 通过测试 Session 验证文件和命令访问同一卷。重建沙盒时保留原卷，确认旧执行已退出、新沙盒的策略和挂载正确后再发布新代 READY。严格隔离模式应拒绝仅提供 partial enforcement 的环境。

运行边界和既有实验结果见[需求完成状况](../docs/40-readiness/CURRENT-READINESS.md)。

### 配置执行服务

部署方从可信 launcher 配置取得 `BENTO_EXECUTION_IMAGE_DIGEST` 和 `BENTO_EXECUTION_POLICY_DIGEST`，两项都使用 `sha256:` 加 64 位小写十六进制。导出这两项后运行：

```sh
node -e 'const {createHash}=require("node:crypto"); const imageDigest=process.env.BENTO_EXECUTION_IMAGE_DIGEST; const policyDigest=process.env.BENTO_EXECUTION_POLICY_DIGEST; if (![imageDigest,policyDigest].every(x=>/^sha256:[0-9a-f]{64}$/.test(x??""))) process.exit(2); process.stdout.write("sha256:"+createHash("sha256").update(JSON.stringify({imageDigest,policyDigest}),"utf8").digest("hex")+"\n");'
```

把输出保存到 Compose 根 `.env` 的 `BENTO_EXECUTION_ENVIRONMENT_VERSION`。执行服务启动时校验该值与宿主公开的环境版本一致。命令适配器从私有 host JSON 的 `imageDigest` 与 `policyDigest` 生成版本。模块适配器从相同的可信摘要生成 `ExecutionHost.environmentVersion`。配置缺失或不一致时拒绝启动。

新建 Task 固定当前版本。可信 `provisionTask` 必须按请求中的冻结版本准备并返回独立观测到的版本、sandbox 和 volume。轮换时保留旧版本的可信配置和已准备的绑定。旧版本无法准备时保留原 Task 和冻结输入，以便恢复该版本后重新准备。

在 `debug-workspace/execution.env` 选择一种受信适配器。私有文件放在 `debug-workspace/execution/`，在容器内以只读方式挂载到 `/app/private`。Orchestrator 镜像包含 Go Temporal 控制面、执行服务和 DSH Worker 源码及运行依赖。容器以 UID 1000 运行，私有文件须允许该身份读取。

- `BENTO_HOST_CONFIG=/app/private/host.json` 使用命令适配器。JSON 包含 Gateway、workspace scope、mTLS 文件、固定 SDK 的 `raw.js`，以及可信的 `control` 和 `worker` 命令。命令与文件路径以容器内路径为准，二进制须匹配容器平台。控制命令负责项目导入、独立读卷、沙盒停启及观察。Worker 命令由受信启动器执行，启动器隔离 Worker 与宿主管理凭据，并向 Worker 提供 `BENTO_DSH_BOOTSTRAP`。协议见[命令宿主适配器](../apps/orchestrator/src/execution-service/command-host.ts)。
- `BENTO_HOST_MODULE=/app/private/host.mjs` 使用可信模块。模块默认导出工厂，实现 [ExecutionHost](../apps/orchestrator/src/execution-service/types.ts)，并提供 SDK ingress 配置。仅配置一种适配器。

执行 HTTP API 通过 Compose 网络提供给 Web，使用同一服务 bearer。Worker 的持久化、操作和 SDK 入口仍绑定容器回环。Compose 不向宿主发布执行 HTTP 端口。OpenShell Gateway、模型服务与私有对象存储由部署环境提供。Worker 由受信适配器按任务启动。容器化配置应验证所选适配器可以访问外部服务及独立持久卷。

在私有 `BENTO_HOST_CONFIG` 中设置 `"prewarmWorker": true`，并给 [DSH Worker 入口](../apps/worker/run-worker.ts)传入 `--warm`，即可启用单槽预热。Worker 导入 bootstrap 后进入空闲状态，每次收到 Run 才绑定当次 Session、Workspace 和授权。bootstrap 必须为每次调用创建独立运行时，并在回执前关闭该次运行的 Agent、连接和监听器。bootstrap 模块可预加载依赖，运行数据与授权只放在该次调用内。

受信适配器需要单独的 Worker 镜像时，通过同一 Compose 构建。受信启动器以交互 stdin/stdout 连接镜像，按环境挂载私有 bootstrap 并设置 `BENTO_DSH_BOOTSTRAP`。镜像工作目录是 `/app/apps/worker`，bootstrap 可挂载到此目录下，以解析镜像中的 Worker 依赖。Worker 的协议包括单次 JSON 请求、`--warm` 模式的逐行请求和回执。

```sh
docker compose -f deploy/compose.yaml --profile worker-image build bento-worker
```

启用 Temporal 和预热后，在同一份宿主配置中设置 `"workerSlots": 2` 可开启两个槽位。每个 Run 占用一个槽位直到执行或恢复结束，两槽都占用时其他 Run 留在队列。项目与 Session、Workspace 一一绑定，同一项目仍只接受一个未结束的 Run。调低槽位数或回退到旧版本前，先排空执行宿主。

受信启动器负责隔离 Worker 及其子进程，并将终止信号传给整个容器或进程组。异常退出、租约超时或需要人工核对的回执会淘汰该 Worker。执行服务在旧进程关闭后补位。关闭服务时等待预热进程退出，随后释放控制器锁。停用预热时，排空后移除私有配置中的 `prewarmWorker` 和 `workerSlots`，移除 Worker 命令的 `--warm`，再重启执行服务。

遇到 worker 失联时，执行服务撤销旧代授权并在原卷上恢复 Session。恢复 worker 只对账会话历史，原 prompt 不重发。Run 进入 `needs_review` 时，可信部署端先独立核对预期修改，再通过[进程内 `reviewRun`](../apps/orchestrator/src/execution-service/service.ts) 提供代次、稳定操作 ID 和预期整卷哈希。执行服务核对恢复回执、绑定、UNKNOWN 操作及卷快照，原子保存确认记录和 diff。核对失败时，Run 继续等待可信核对，diff 暂不可用。

仓库内的 TypeScript 启动命令使用 `node --import /app/register-paths.mjs` 解析 `@/` 路径。Compose 和 Worker 镜像已配置此参数。自定义启动器直接调用 Node 时也需加载该文件。

使用 `start.ts` 的部署可设置 `BENTO_REVIEW_MODULE`，指向仅由可信部署端控制的模块。模块默认导出同步安装函数 `(reviewRun, closeTaskRun, readTaskClosure, closeTaskRetry, readTaskRetryClosure, reconcileTaskRetry) => cleanup`。原只接收 `reviewRun` 的模块仍可使用首参。安装函数接入部署端的复核工具，并在停服时通过 `cleanup` 停止接收新请求、等待在途复核结束。复核提交须包含 `runId`、`failedGeneration`、`readyGeneration`、`stableOperationId` 和 `expectedSnapshotSha256`。模块与执行服务同进程运行，部署端应限制模块文件及复核入口的访问权限。

- `reviewRun({runId,failedGeneration,readyGeneration,stableOperationId,expectedSnapshotSha256}):Promise<void>` 在原执行结果与可信快照相符时发布该 Run。
- `closeTaskRun({runId,decision,expectedGeneration}):Promise<void>` 在退出、撤权和静止证据通过后，以 failed 或 unconfirmed 结案。
- `readTaskClosure(runId):TaskClosureAudit|null` 读取 Run 结案审计。项目或账号清理后仍可按原 ID 查询。
- `closeTaskRetry({attemptId,expectedGeneration}):Promise<void>` 在可信宿主证明该恢复已停止、卷无写入者和资源可安全清理时关闭 blocked 重试。
- `readTaskRetryClosure(attemptId):TaskRetryClosureAudit|null` 读取重试结案审计。保留规则与 Run 结案审计相同。
- `reconcileTaskRetry({attemptId,expectedGeneration}):Promise<"pending"|"queued">` 对账原卷与会话恢复回执。两份证据均完整时沿原 attempt 排队；证据缺失时保持 pending。

这些回调仅交给可信模块。业务 HTTP 不开放结案、可信对账或审计读取。

SDK 宿主要提供安全重试，须具备 `sdk.decodeExecEvent`、独立的 `observeWorkerExit` 和 `taskRecovery.observeSdkRetrySafety(binding,runId,generation)`。最后一项由沙盒外的受信部署适配器生成，不能由 Worker、模型或 HTTP 调用者提交。服务核验同一 Run、绑定和代次的独立退出、SDK 停止与撤权、新代 READY/无 capability、UNKNOWN 为零及 History 静止后，才持久化停止证明；恢复仍须验证双检查点和独占写入。缺少任一能力或完整证据时保持待核对，不因 SDK 或回调存在而开放重试。字段与时间约束见 [Web 设计](../docs/30-designs/WEB-DESIGN.md)。

项目删除和账号注销清理需要可信宿主实现幂等的工作区删除。命令宿主处理 `{action:"purge",binding}`，只删除该绑定独占的沙盒与卷，独立确认两者不存在后返回 `{sandbox,volume,absent:true}`。自定义宿主实现 `ExecutionHost.purge(binding)`。删除失败应报错，Bento 会保留清理请求以便重试。Docker 驱动的宿主可用 [dockerOpenShellPurge](../apps/orchestrator/src/execution-service/docker-openshell-purge.ts)，并提供与部署时一致的卷标签。

### Task 事件投影

Task 的 execute 请求含可选 `publicEventsUrl`，与当次 grant 一起交付 Worker。私有 DSH bootstrap 返回的 runtime 必须实现 `publicEvents(events): readonly PublicWorkerEvent[]`。收到 Task 请求但缺少此回调时，Worker 在提交 prompt 前返回待核对。旧项目请求继续使用原路径。

回调以本轮 DSH 事件的零基索引作 `offset`。每个索引至多一项，按索引递增。回复、步骤和命令使用 `{offset,kind,text}`，检查使用 `{offset,kind:"check",name,status,output}`。检查状态为 passed、failed、not_run 或 unavailable。仅投影用户可见内容，命令只给出脱敏名称，检查输出只给出可公开摘要。禁止输出工具参数、环境变量、原始 DSH 帧或凭据。Worker 每批最多 100 项及 256 KiB，单个 text/output 最多 4096 UTF-8 字节，name 最多 120 字节。空批标记投影完成；发布结果前服务须收到此批。生产 bootstrap 的投影和保密性使用部署场景验收。

使用仓库自带的 Task 投影适配器时，将 `BENTO_DSH_BOOTSTRAP` 指向 `apps/worker/task-bootstrap.ts`，并将 `BENTO_DSH_BASE_BOOTSTRAP` 指向受信私有运行时的容器内绝对路径。私有基运行时在当次 Workspace 和 Session 中执行工具，并在 Session flush 后由 `publicEvents` 提供可公开内容，由 `trustedTaskChecks` 提供已与真实工具调用及结果关联的检查回执。适配器合并两种投影。模型回复、工具参数和私有诊断字段不能充当可信检查回执。

真实结果交付验收使用 [WEB-A13](../docs/10-requirements/WEB-REQUIREMENTS.md#验收标准)，在已配置 HTTPS、独立测试身份、私有 S3 和真实 DSH/OpenShell Worker 的环境中执行。以受控环境变量提供 `BENTO_WEB_A13_URL` 和 `BENTO_WEB_A13_STORAGE_STATE`，取消设置 `BENTO_WEB_A13_LIST_ONLY`，运行：

```sh
pnpm --filter @bento/web exec playwright test --config playwright.web-a13.config.ts --workers=1
```

该配置仅选择 WEB-A13。WEB-05 独占 runner 使用 `playwright.web05.config.ts` 和对应的 B 环境。

## Temporal 配置

在 `debug-workspace/execution.env` 设置 `BENTO_TEMPORAL_ADDRESS`、`BENTO_TEMPORAL_NAMESPACE` 和 `BENTO_TEMPORAL_TASK_QUEUE`。正式环境填写受信网络内的 Temporal 服务地址。每个控制器使用独占 Task Queue，重启时保持状态卷、Namespace 和队列名。

本机开发可使用同一 Compose 的 `dev` profile，将 `BENTO_TEMPORAL_ADDRESS` 设为 `temporal:7233`，Namespace 设为 `default`。如果启用测试邮件，在 Keycloak 将 SMTP 配置为 `mailpit:1025`。

```sh
docker compose -f deploy/compose.yaml --profile dev up -d --build
docker compose -f deploy/compose.yaml --profile dev exec temporal temporal operator cluster health --address 127.0.0.1:7233
```

Temporal UI 位于宿主回环 `18233`，Mailpit 位于 `18494`。Temporal 开发实例使用持久卷保存 SQLite。开发模式命令见 [Temporal CLI 文档](https://github.com/temporalio/cli/blob/main/README.md#run-via-docker)。反向代理路径配置见 [Keycloak 文档](https://www.keycloak.org/server/reverseproxy)。

诊断时按 Workflow ID 查询 `advanceRun` 历史，与 Bento Run 状态核对。停用 Temporal 前先排空执行宿主，再停止并清除三项 Temporal 配置。完成状况见[需求完成状况](../docs/40-readiness/CURRENT-READINESS.md)。

## 独立本地 Temporal Activity 重投验收

在仓库根运行固定入口；已安装工作树依赖，使用 Node 22、仓库 Go 版本，以及 curl/tar：

```sh
pnpm --dir apps/orchestrator test:temporal-retry
```

该入口校验官方 Temporal CLI 1.5.1 archive 并提取工具，运行独立真实 Server 1.29.1。支持平台固定为 Darwin arm64 和 Linux x64，其他平台直接失败。下载来自固定官方 release asset，大小/SHA-256 按[工具锁定](../apps/orchestrator/acceptance/temporal-retry/tool.ts)验证；HTTP/1.1 Range 最多 8 分钟/12 次请求，签名 URL 只在内存使用，网络/完整性或任一测试失败均返回非零，不静默 skip。

本机默认复用仓库外 `../bento-sdk-cache/temporal/1.5.1/<平台架构>/release.tar.gz`，平台目录为 `darwin-arm64` 或 `linux-x64`。归档不存在时从锁定官方来源下载，完成大小、SHA、成员、二进制及版本校验后原子写入缓存；每次命中仍完整核验，损坏时明确失败，不静默换源。设置 `BENTO_A6_TEMPORAL_ARCHIVE` 可优先指定其他仓库外、本平台官方 archive 的绝对路径。CI 按固定版本、平台和 SHA-256 恢复归档缓存，未命中时获取官方资产，命中后仍校验；运行目录及 Temporal 数据库继续独立创建和清理，不删除共享归档。`BENTO_A6_EVIDENCE_DIR` 可指定仓库外私有目录保存脱敏 CaseReport、SQL/文件回执及真实 history；不设置时输出摘要并清理运行状态。

测试自己创建 loopback 临时端口、专属 namespace/taskQueue、Temporal DB 和执行宿主 SQLite；不读取部署 Temporal 配置。先完成内部 HTTP→生产 Go Workflow/Activity→生产 TS 宿主→真实文件/回执的正常路径，再注入成功回包丢失、宿主/Worker 重启与原 Temporal DB 重启。执行 host 明确为本地 fixture，不需 Docker、真实模型、OpenShell、IdP 或对象存储。全九项测试通过、三例业务输出 passed 且 cleanup 全 true 才是成功，实际副作用一次、原 receipt/Run/execution/结果保持一致。

结束或失败时按持有的 ChildProcess 关闭 host/proxy/Go/server，等待 close 后才删运行目录；正常 close 有界，失败升级只针对本任务准确句柄。不能确认停止时保留该例私有现场并硬失败，修复后从相同固定入口复跑。工具/binary/DB/log/evidence 保持仓库外，发布检查以实际已安装依赖树执行 npm pack 正负断言。该入口已纳入 `pnpm check`；范围及未覆盖项见[A6-02证据](../docs/40-readiness/CURRENT-READINESS.md#a6-02-真实-temporal-重投)。

## 空间上传实栈验收

在同一独立开发栈独占测试账号，确认 Web 和私有对象存储均可从 Chromium 访问。使用空测试空间，服务端应返回 100,000,000 字节单文件上限、200,000,000 字节账号额度及 16 MiB 分块。按顺序运行：

```sh
node apps/workspace/web/scripts/verify-web-a02.mjs --check
node apps/workspace/web/scripts/verify-web-a02.mjs --small
node apps/workspace/web/scripts/verify-web-a02.mjs
node apps/workspace/web/scripts/verify-web-a02.mjs --quota
```

通过受控环境注入 Web 和存储 origin（`BENTO_A02_ORIGIN`、`BENTO_A02_STORAGE_ORIGIN`）、测试账号（`BENTO_A02_LOGIN`、`BENTO_A02_PASSWORD`），以及只读检查器路径 `BENTO_A02_STORAGE_CHECK`。检查器接收 `saved` 或 `absent` 和 `space/{uploadId}`，并确认该键无 multipart 残留。`saved` 模式可接收第三个参数 `expectedBytes`，HEAD 字节数必须等于该值，缺省为 100,000,000。两块预检传入 16,777,217。`absent` 模式确认对象不存在。满足条件时退出 0。

先通过两块预检再跑边界。脚本打印阶段、分块编号、HTTP 状态和成功时间，边界传输采用两分钟无进展截止及十分钟阶段截止。签名自然到期单列等待。清理每次轮询最多 12 分钟。失败时查看阶段和受限临时目录中的 `recovery.json`，按原项目与上传 ID 回读。取消未完成上传，待签名失效并确认分块清理后，通过正常项目删除入口清理。核对下载入口失效、对象和分块不存在及账号用量回到起始值，再删除恢复记录和临时文件。可用 `--download-boundary` 单独复核 100 MB 下载和清理。上传记录过期回收由 API 受控时钟回归覆盖。

## Worker 正式运行时与复用验证

前置：锁定依赖已安装，部署端已准备与沙盒环境相符的helper/node路径、独立SDK模块及受信模型factory。启动器仍负责容器/进程组隔离、信号与当次授权；Gateway管理凭据和mTLS留在Orchestrator。选择`BENTO_DSH_BOOTSTRAP=/app/apps/worker/base-bootstrap.ts`，将可信只读JSON绝对路径放入`BENTO_DSH_RUNTIME_CONFIG`。该入口导出正式base，既有launcher仍要求显式选择bootstrap。

```json
{
    "schema": 1,
    "sdkModule": "/app/private/openshell-sdk/index.js",
    "modelAdapterModule": "/app/apps/worker/production-model.mjs",
    "provider": "trusted-provider",
    "model": "pinned-model",
    "workspaceRoot": "/sandbox/project",
    "helper": "/runtime/ptc.mjs",
    "fileSystemHelper": "/runtime/fs.mjs",
    "node": "/usr/local/bin/node"
}
```

九项字段均必填；示例helper路径须替换为部署沙盒内实际安装路径。SDK和factory须为Worker内现存绝对文件路径；SDK模块还需提供其锁定运行依赖，单独挂载index.js不足以完成装配；factory可挂载于Worker工程目录以解析其锁定依赖。factory契约见[ModelAdapterFactory](../apps/worker/base-bootstrap.ts)：每次只接收provider/model，返回新的官方LlmAdapter与异步disposer；请求、凭据和取消器按本轮持有，disposer须等待在途请求和连接关闭。禁止跨轮复用adapter或缓冲会话数据，base会拒绝单例。此接口仍依赖部署端信任和审核factory自身实现。

base每轮新Context/SessionStore/provider，回执前依次关闭Agent、root fiber、SDK transport和模型资源；清理异常使本轮失败并沿原warm池策略退出补位。recover不创建SDK或模型；Task公共事件投影当前不由此base提供，缺投影的Task请求返回review。实际Task交付仍需满足上文投影与可信检查契约。

复用测试使用随机loopback端口、私有临时SQLite、真实生产ingress及受控mTLS上游，模型HTTP和helper返回确定性fixture；旧事件负测在前轮已清理、新轮base尚未创建时观察SDK/模型/persistence/operation的真实请求计数，再在新provider内验证文件目标隔离。运行：

```sh
pnpm --filter @bento/orchestrator test:worker-runtime
pnpm --filter @bento/orchestrator test:worker-reuse
node apps/orchestrator/acceptance/worker-reuse/check-package.mjs
```

默认 `soak` 模式成功须五case无skip、64轮四项隔离全通过、跨度至少315秒、同一实际PID，以及撤权/清理失败换PID、同库重开与资源归零。PR CI 显式设置 `BENTO_A6_WORKER_REUSE_MODE=burst`，保留全部64轮与逐轮断言但不补足轮间5秒等待；main CI及本地默认使用 `soak`。本地可在上述命令前设置同名变量复现连续模式，其他值直接失败。诊断输出记录模式、间隔和实际跨度；连续模式通过不能作为长期驻留证据。测试失败按对应case和分项定位，保留失败结论；只清理本次准确拥有的临时资源，不删除其他服务状态。SDK默认走原[官方准备工具](../apps/orchestrator/tests/openshell/binding-grants/sdk.ts)及六项schema探针；固定源码revision为`ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47`，TLS/安装和构建预算不变。官方源码归档首次下载并通过固定SHA-256校验后，保存到仓库旁的`../bento-sdk-cache/openshell/<revision>/source.tar.gz`；后续准备逐次复验并复用，npm/Buf下载内容分别缓存在同级`npm/`和`buf/`。每次构建仍使用独立临时目录，清理测试不会删除缓存；源码缓存损坏时明确失败，应先核对原因再删除该版本缓存并重新获取。

本轮本地可显式指定`BENTO_A6_WORKER_REUSE_SDK_BUNDLE`为仓库外、已经审核身份的受控输入；wrapper逐项核验固定历史清单/完整SHA，隔离复制并执行相同六探针，错误不回退来源。该本地输入绑定本轮已核SDK，不能自行重签manifest或将任意SDK路径当成受控输入；CI不设置该变量，按官方来源真实构建。验收模式必须与[Readiness](../docs/40-readiness/CURRENT-READINESS.md#a6-05-worker-长期池复用)证据对应，受控来源通过不表示默认网络准备已恢复。临时SDK、mTLS材料、config、数据库和trace均在仓库外，不进入npm包；完整门禁保留真实Temporal九项。
