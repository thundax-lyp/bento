# Bento 部署

[Bento Compose](compose.yaml) 是整体部署入口，包含个人端、MySQL、Keycloak、PostgreSQL 和 Orchestrator。同一份文件提供开发用 Temporal、Mailpit 和可选的 Worker 镜像构建目标。组件职责见[整体架构](../docs/00-governance/ARCHITECTURE.md)。在仓库根目录运行以下命令，使用 Docker Compose 2.24.4 或更新版本。

## 准备配置

```sh
mkdir -p debug-workspace/execution debug-workspace/keycloak-import
```

在仓库根目录的受控 `.env` 中设置 `BENTO_MYSQL_PASSWORD`、`KEYCLOAK_DB_PASSWORD`、`KEYCLOAK_ADMIN_PASSWORD` 和 `BENTO_EXECUTION_BEARER`。四项分别生成，例如分别执行 `openssl rand -hex 32`。Web 和 Orchestrator 使用同一个 `BENTO_EXECUTION_BEARER`。本地入口默认为 `http://127.0.0.1:8080`。远端部署设置 `BENTO_PUBLIC_ORIGIN` 为用户实际访问的 HTTPS origin，由受信反向代理转发到宿主机回环的 8080，并覆盖 `Host` 和 `X-Forwarded-Proto`。容器内的 Web API 和浏览器都必须能访问该 origin。

准备受控的 Keycloak Realm 导出文件，放入 `debug-workspace/keycloak-import/`。默认 Realm 为 `bento`，其他名称通过 `BENTO_KEYCLOAK_REALM` 配置。Realm 启用 Organizations、邮箱验证和 SMTP，关闭公开注册。设置组织 alias，创建启用 Standard Flow 和 S256 PKCE 的 confidential client，提供 `email`、`email_verified` 和 `organization` 声明。登记 `<BENTO_PUBLIC_ORIGIN>/api/oidc/callback` 回调和 `<BENTO_PUBLIC_ORIGIN>/auth` 退出回跳地址。Keycloak 的浏览器入口为 `/identity/`。部署入口对 Keycloak 管理路径应用管理访问控制。

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

启动失败时运行 `docker compose -f deploy/compose.yaml logs --tail=100`。核对 Realm 导入、OIDC 客户端配置、容器对 issuer 的连通性，以及适配器的启动日志。用同一 Compose 项目名执行 `stop` 和 `up -d` 恢复。保留命名卷以延续账号、身份、空间及执行状态。

## 单节点业务执行账本备份还原演练

从仓库根目录使用已安装锁定依赖的 Node.js 22 和 pnpm 12.15.0。确认当前 Node 22 提供 `node:sqlite.backup`。命令使用测试进程的动态回环端口和私有临时目录。

```bash
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores the completed Run business ledger from an isolated backup$' apps/orchestrator/execution-service/service.test.ts
```

演练生成合成项目及成功 Run，等执行服务关闭后，以 SQLite backup API 读取 `business.sqlite` 并生成单库备份。备份通过完整性、外键和已提交回执检查，才复制到一个全新目录。启动前核对备份与还原文件的 SHA-256，再用同一个执行服务入口启动还原实例。SQLite 使用 WAL，运行中直接复制主库文件可能遗漏已提交事务。其他数据库、WAL/SHM、锁文件和本地 fixture 卷均不随该备份复制。

PASS 时只通过一个匹配测试，报告备份 SHA-256。项目、Run、diff、同键同输入的原 Run 回执均一致，同键异输入返回冲突，其他 owner 读不到该 Run，列表只有原 Run，且没有调用还原侧 fixture 的执行入口。摘要来自合成数据，每次运行可变化。命令失败时使用测试输出定位失败断言，测试会关闭服务并清理本次临时目录。修复前置条件后重新执行，下一次使用全新目录。测试进程被强杀后，先核实进程已退出，再清理仅属于该次运行的 `bento-ledger-restore-*` 临时目录。

Compose 当前的 TS 执行服务持有该业务账本。演练覆盖其中已结束 Run 的读取和幂等重放。生产恢复还需单独验证授权账本、会话历史、外部 Workspace、Temporal、账号与身份数据、S3 及部署级回滚。演练产物只用于本地校验，禁止覆盖已运行或曾运行的状态目录。

## OpenShell 执行宿主

### 接入前检查

1. 使用受信执行入口接入启用 mTLS 的 OpenShell Gateway。将后端管理凭据限制在受信服务端。确认 Worker 无法直连 Gateway 或访问 Docker 管理接口。
2. 为 Workspace 准备独立持久 Volume。受测 Docker driver 启用 `allow_driver_config`，卷使用 `sandbox-attachable=true` 和 `sandbox-attachable-workspace=default` 标签。部署后核对沙盒挂载、工作目录与策略。
3. 通过测试 Session 验证文件和命令访问同一卷。重建沙盒时保留原卷，确认旧执行已退出、新沙盒的策略和挂载正确后再发布新代 READY。严格隔离模式应拒绝仅提供 partial enforcement 的环境。

运行边界和既有实验结果见[需求完成状况](../docs/40-readiness/CURRENT-READINESS.md)。

### 配置执行服务

在 `debug-workspace/execution.env` 选择一种受信适配器。私有文件放在 `debug-workspace/execution/`，在容器内以只读方式挂载到 `/app/private`。Orchestrator 镜像包含 Go Temporal 控制面、执行服务和 DSH Worker 源码及运行依赖。容器以 UID 1000 运行，私有文件须允许该身份读取。

- `BENTO_HOST_CONFIG=/app/private/host.json` 使用命令适配器。JSON 包含 Gateway、workspace scope、mTLS 文件、固定 SDK 的 `raw.js`，以及可信的 `control` 和 `worker` 命令。命令与文件路径以容器内路径为准，二进制须匹配容器平台。控制命令负责项目导入、独立读卷、沙盒停启及观察。Worker 命令由受信启动器执行，启动器隔离 Worker 与宿主管理凭据，并向 Worker 提供 `BENTO_DSH_BOOTSTRAP`。协议见[命令宿主适配器](../apps/orchestrator/execution-service/command-host.ts)。
- `BENTO_HOST_MODULE=/app/private/host.mjs` 使用可信模块。模块默认导出工厂，实现 [ExecutionHost](../apps/orchestrator/execution-service/types.ts)，并提供 SDK ingress 配置。仅配置一种适配器。

执行 HTTP API 通过 Compose 网络提供给 Web，使用同一服务 bearer。Worker 的持久化、操作和 SDK 入口仍绑定容器回环。Compose 不向宿主发布执行 HTTP 端口。OpenShell Gateway、模型服务与私有对象存储由部署环境提供。Worker 由受信适配器按任务启动。容器化配置应验证所选适配器可以访问外部服务及独立持久卷。

在私有 `BENTO_HOST_CONFIG` 中设置 `"prewarmWorker": true`，并给 [DSH Worker 入口](../apps/worker/run-worker.ts)传入 `--warm`，即可启用单槽预热。Worker 导入 bootstrap 后进入空闲状态，每次收到 Run 才绑定当次 Session、Workspace 和授权。bootstrap 必须为每次调用创建独立运行时，并在回执前关闭该次运行的 Agent、连接和监听器。bootstrap 模块可预加载依赖，运行数据与授权只放在该次调用内。

受信适配器需要单独的 Worker 镜像时，通过同一 Compose 构建。受信启动器以交互 stdin/stdout 连接镜像，按环境挂载私有 bootstrap 并设置 `BENTO_DSH_BOOTSTRAP`。镜像工作目录是 `/app/apps/worker`，bootstrap 可挂载到此目录下，以解析镜像中的 Worker 依赖。Worker 的协议包括单次 JSON 请求、`--warm` 模式的逐行请求和回执。

```sh
docker compose -f deploy/compose.yaml --profile worker-image build bento-worker
```

启用 Temporal 和预热后，在同一份宿主配置中设置 `"workerSlots": 2` 可开启两个槽位。每个 Run 占用一个槽位直到执行或恢复结束，两槽都占用时其他 Run 留在队列。项目与 Session、Workspace 一一绑定，同一项目仍只接受一个未结束的 Run。调低槽位数或回退到旧版本前，先排空执行宿主。

受信启动器负责隔离 Worker 及其子进程，并将终止信号传给整个容器或进程组。异常退出、租约超时或需要人工核对的回执会淘汰该 Worker。执行服务在旧进程关闭后补位。关闭服务时等待预热进程退出，随后释放控制器锁。停用预热时，排空后移除私有配置中的 `prewarmWorker` 和 `workerSlots`，移除 Worker 命令的 `--warm`，再重启执行服务。

遇到 worker 失联时，执行服务撤销旧代授权并在原卷上恢复 Session。恢复 worker 只对账会话历史，原 prompt 不重发。Run 进入 `needs_review` 时，可信部署端先独立核对预期修改，再通过[进程内 `reviewRun`](../apps/orchestrator/execution-service/service.ts) 提供代次、稳定操作 ID 和预期整卷哈希。执行服务核对恢复回执、绑定、UNKNOWN 操作及卷快照，原子保存确认记录和 diff。核对失败时，Run 继续等待可信核对，diff 暂不可用。

仓库内的 TypeScript 启动命令使用 `node --import /app/register-paths.mjs` 解析 `@/` 路径。Compose 和 Worker 镜像已配置此参数。自定义启动器直接调用 Node 时也需加载该文件。

使用 `start.ts` 的部署可设置 `BENTO_REVIEW_MODULE`，指向仅由可信部署端控制的模块。模块默认导出同步安装函数 `(reviewRun) => cleanup`。安装函数接入部署端的复核工具，并在停服时通过 `cleanup` 停止接收新请求、等待在途复核结束。复核提交须包含 `runId`、`failedGeneration`、`readyGeneration`、`stableOperationId` 和 `expectedSnapshotSha256`。模块与执行服务同进程运行，部署端应限制模块文件及复核入口的访问权限。

项目删除和账号注销清理需要可信宿主实现幂等的工作区删除。命令宿主处理 `{action:"purge",binding}`，只删除该绑定独占的沙盒与卷，独立确认两者不存在后返回 `{sandbox,volume,absent:true}`。自定义宿主实现 `ExecutionHost.purge(binding)`。删除失败应报错，Bento 会保留清理请求以便重试。Docker 驱动的宿主可用 [dockerOpenShellPurge](../apps/orchestrator/execution-service/docker-openshell-purge.ts)，并提供与部署时一致的卷标签。

## Temporal 配置

在 `debug-workspace/execution.env` 设置 `BENTO_TEMPORAL_ADDRESS`、`BENTO_TEMPORAL_NAMESPACE` 和 `BENTO_TEMPORAL_TASK_QUEUE`。正式环境填写受信网络内的 Temporal 服务地址。每个控制器使用独占 Task Queue，重启时保持状态卷、Namespace 和队列名。

本机开发可使用同一 Compose 的 `dev` profile，将 `BENTO_TEMPORAL_ADDRESS` 设为 `temporal:7233`，Namespace 设为 `default`。如果启用测试邮件，在 Keycloak 将 SMTP 配置为 `mailpit:1025`。

```sh
docker compose -f deploy/compose.yaml --profile dev up -d --build
docker compose -f deploy/compose.yaml --profile dev exec temporal temporal operator cluster health --address 127.0.0.1:7233
```

Temporal UI 位于宿主回环 `18233`，Mailpit 位于 `18494`。Temporal 开发实例使用持久卷保存 SQLite。开发模式命令见 [Temporal CLI 文档](https://github.com/temporalio/cli/blob/main/README.md#run-via-docker)。反向代理路径配置见 [Keycloak 文档](https://www.keycloak.org/server/reverseproxy)。

诊断时按 Workflow ID 查询 `advanceRun` 历史，与 Bento Run 状态核对。停用 Temporal 前先排空执行宿主，再停止并清除三项 Temporal 配置。完成状况见[需求完成状况](../docs/40-readiness/CURRENT-READINESS.md)。
