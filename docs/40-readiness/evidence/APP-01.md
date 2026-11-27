# APP-01 验收证据

当前部署的 Go 权威路径见 [Go 权威路径复验](#go-权威路径复验)。以下 TS 基线和 Go 接管前复核按各自的候选环境留档。

2026-11-26，本 checkout 的 TS Orchestrator，独占临时状态目录，Node 22 本地执行夹具。

```sh
node --import ./register-paths.mjs --experimental-strip-types --test apps/orchestrator/orchestrator-execution-host/tests/execution-service/app-boundaries.test.ts
```

用例通过。分别以个人端和管理端服务凭据提交两个 Run，再走各自的内部查询接口，并只读 SQL 回读同一业务账本中的两个独立 Run，核对 ID、项目和成功状态。管理端同键重试得到原 Run。分别用个人端身份调用管理路由、管理端请求未授权方法、管理端提交和查询未授权 Workspace，获得对应的三个拒绝码。每次拒绝后比较业务和执行授权库的快照。管理诊断查询也拒绝读取同一 Workspace 内的普通 Run。

上述本地夹具的覆盖限于内部接口。独立 Keycloak Realm、浏览器及真实 Worker 的覆盖见下节。Go 接管后复用相同的用例断言，以 Go 服务的部署启动和权威观察方式替换 TS 夹具。设置 `BENTO_APP_ACCEPTANCE_ADAPTER` 为适配模块路径，模块默认导出返回测试文件中的 `AppFixture`，提供独占服务地址、A/B 种子数据、两端服务身份、权威 Run 读取、业务与授权快照以及清理。保持测试请求与断言原样。

## 测试服务器独占 Docker 验收

2026-11-26，基线 `57630e3` 加当前 APP-01 改动。使用独占 Compose 网络、数据库卷、Temporal namespace、OpenShell Gateway 和 Worker 启动器。管理端和个人端分别登录独立 Keycloak Realm。管理端通过「运行诊断」提交，个人端通过已登录的 Chromium 页面调用 Workspace API 提交。两端分别发起独立查询，再以只读 SQL 从同一 TS 权威来源核对 Run ID、项目归属和状态。

### APP-01-01 双端正向验收

管理端只列出授权 Workspace A，在浏览器点击「运行诊断」并独立访问 Run 状态页。个人端在同一 owner 下的 Workspace B 提交，通过已登录 Chromium 页面访问个人端项目 Run API。两端使用不同浏览器会话。分别将浏览器查询结果与只读 SQL 回读核对，两个 Run ID 不同，且各自的 Workspace 和 owner 匹配。

| 入口   | 权威 Run 状态 | 执行回执 | 授权账本观察                                                    |
| ------ | ------------- | -------- | --------------------------------------------------------------- |
| 个人端 | `succeeded`   | 1        | 第 2 代，`READY`，无存活执行凭据，4 条 SDK 操作均为 `SUCCEEDED` |
| 管理端 | `succeeded`   | 1        | 第 2 代，`READY`，无存活执行凭据，4 条 SDK 操作均为 `SUCCEEDED` |

首轮两条 Run 进入 `needs_review`，回执为 0，无工具操作记录。持久会话记录了 OpenShell 文件系统操作失败。更换为专属 Gateway 签发的 mTLS 凭据后，个人端一次试跑产生成功 SDK 操作，模型轮次达到输出上限。最终在新项目上使用简短的个人端确认任务，以及原有的管理端固定诊断指令，两条 Run 均成功。原 `needs_review` Run 保留。

### APP-01-02 三类拒绝复验

在两条成功 Run 状态稳定后，独立测试进程直接请求内部接口。每次拒绝后通过只读 SQL 比较业务数据库和执行授权数据库的全部表的逻辑快照。四次快照均与请求前一致。

| 用例                                             | HTTP / 错误码                  |
| ------------------------------------------------ | ------------------------------ |
| 个人端服务身份请求管理端提交操作                 | 403 / `caller_denied`          |
| 管理端服务身份请求删除授权范围内的诊断 Run       | 403 / `operation_denied`       |
| 管理端向同一 owner 的未授权 Workspace B 提交诊断 | 403 / `workspace_scope_denied` |
| 管理端请求 Workspace B 中真实存在的个人端 Run    | 403 / `workspace_scope_denied` |

### 版本与复跑边界

验收使用已缓存的测试运行时镜像，挂载当前个人端 Web 构建和 APP-01 TS 文件，管理端镜像使用当前 Go 源码交叉编译组装。容器内 `admin-diagnostics.ts`、`http.ts`、`service.ts`、`start.ts`、`store.ts` 按此顺序拼接的 SHA-256 为 `e237b85b5fc25c7ff2b6f3405b6dc25d70a79ee86dcb21b87064379e1b362166`，与 checkout 一致。管理端浏览器使用测试 TLS，管理端 API 使用该候选证书校验 OIDC。浏览器脚本、只读 witness 和原始结果保存在测试服务器私有 APP-01 候选目录。

此次覆盖 TS 权威账本上的真实单节点部署。后续个人端页面表单和冷构建补验见下节。Go 接管权威 Run 账本后的同套复验待执行。Go 轮次保留双浏览器、两条成功 Run、独立权威回读以及拒绝前后两库快照等断言，替换执行服务和账本观察适配器。

## 个人端页面表单补验

2026-11-26，在同一测试服务器独占环境使用当前个人端 Web 构建。Chromium 通过个人端 Keycloak Realm 登录，在首页填写任务名称并点击「创建空白任务」，再在任务详情页填写「任务要求」并点击「发送要求」。浏览器观察到表单触发的 Run 提交返回 202。随后发起独立 GET，确认同一 Run 为 `succeeded`。

独立只读 SQL 从 TS 业务账本和执行授权账本核对 Run ID、Task、owner 与执行 Session 的归属。Run 有 1 条完成回执，授权第 2 代回到 `READY`，无存活凭据，4 条 SDK 操作均为 `SUCCEEDED`。浏览器脚本、只读观察脚本和脱敏摘要保存在测试服务器私有 APP-01 候选目录。Go 复验使用相同的页面表单和断言。

## 独占 Docker 冷构建补验

2026-11-26，在测试服务器以基线 `57630e3` 加当前 APP-01 源码建立专用 `docker-container` BuildKit builder。构建开始前 `docker buildx du` 显示总缓存 **0 B**，未导入外部构建缓存或清理公共 builder。使用仓库 Compose 中的四个应用构建定义，启用 `admin`、`worker-image` profile，并使用 `--no-cache --pull`。输出使用本轮专用镜像标签。

测试服务器直连部分公开制品源超时。将官方 BuildKit 镜像加载为引导输入，并通过临时通道下载基础镜像和依赖。Worker 完成后，Orchestrator 的 npm 下载停滞。其余三个镜像改走测试服务器直连 npm，仍在该轮 builder 中使用 `--no-cache --pull` 完成构建。本轮拉取的基础镜像与同轮的依赖下载缓存可以复用，未复用已有应用镜像构建层。

四个输出均已独立通过 `docker image inspect` 验证为 `linux/amd64`。

| 构建目标       | 镜像 ID                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `bento-web`    | `sha256:70edaba45d3cdcd8c5e0f166f520e34f155284130d2e92a489be8b18bb3024cf` |
| `bento-admin`  | `sha256:5c923a8cd3e7c5acbb314e3950f88329480f97c7712ddc7444b3577a1b436ba5` |
| `orchestrator` | `sha256:2ad614e5fe246a2d8e14c149be4537c8c754d5b6beebf195ba80d1d34004ef57` |
| `bento-worker` | `sha256:a0d5076c7464737da37839d201e4a5af8ea76f750bdf600ac68e737daa9c8168` |

构建日志、初始缓存报告和镜像清单保存在测试服务器私有 APP-01 候选目录。页面表单补验使用既有独占运行栈的当前 Web 构建。上述冷构建镜像独立验收，保留供该候选部署使用。Go 接管后的冷构建及双端执行验收待复跑。

## Go 接管复核

2026-11-26，复核远端 `main`（`1a964cc`）及测试服务器 APP-01 独占候选。主线 Compose 仍启动 TS 执行服务，由 TS 打开 `business.sqlite`。Go 入口运行 Temporal 控制。候选容器内通过只读进程检查确认，Node 持有业务账本的可写句柄，Go 控制进程持有该账本的句柄数为 0。

该次检查时 Go 尚未接管 Run 权威账本，因此当轮未启动 Go 复验。接管后复跑冷构建、双端浏览器表单提交、独立权威回读和三类拒绝用例。

同日补查候选。远端仅有 `main`，无开放 PR。已合并的 #104 交付共享卷多会话执行与回收。仓库就绪度仍将 Go 权威状态列为 A3-01 待实现范围。在已检查的远端和本机 Bento checkout 中未找到可部署的 Go 账本接管候选。

## Go 权威路径复验

2026-11-26，在测试服务器既有 APP-01 独占项目中以新执行账本卷启动候选，基线为 `863168d` 加本轮 APP-01 接线。候选启用 `BENTO_GO_AUTHORITY`，使用当前 TS 执行入口及从当前源码交叉编译的 Go 控制程序。运行容器内 Go 二进制的 SHA-256 为 `7a4994c4b3b67362fa898ac9659532d9db4cece9173068ca807cb6dc3aaa2989`。管理端诊断 Run 与诊断来源标记由 Go `business enqueue` 在同一事务写入。执行阶段和授权使用主线的 Go `business` 与 `authority` 命令。

- 个人端通过独立 Keycloak Realm 登录，使用正常 Task 页面表单提交真实 Worker Run，随后单独查询。只读账本回读确认同一 Run 属于原 Task 和 owner，状态为 `succeeded`，完成回执为 1，成功 SDK 操作为 4。授权回到 `READY`，无存活执行凭据。
- 双端访问使用各自的 Keycloak Realm 和浏览器会话。管理端点击「运行诊断」，个人端在范围外对照 Workspace 中从已登录 Chromium 调用项目 Run API 提交。两条独立 Run 均为 `succeeded`，各有 1 条完成回执和 4 条成功 SDK 操作，无存活执行凭据。只读观察另行核对两条 Run 的 Workspace、owner 和管理诊断来源标记。
- 错误调用方、未授权操作、未授权 Workspace 的提交和回读共四次请求，分别返回 `403 caller_denied`、`403 operation_denied` 和两次 `403 workspace_scope_denied`。每次拒绝后，业务和执行授权账本全表逻辑快照均与请求前一致。

本地接口复验使用编译后的 Go 控制程序及 Node Worker 夹具。浏览器实栈通过既有独占测试运行时镜像与当前 Go 控制程序和 TS 执行源文件装配。原始结果保留在测试服务器受控候选目录。

同轮从初始缓存 **0 B** 的独占 BuildKit builder 执行 `--no-cache --pull`，完成 Web、管理端、Orchestrator 和 Worker 四个应用的冷构建。通过 `docker image inspect` 独立确认所有输出均为 `linux/amd64`。基础镜像与依赖走公开制品源，测试服务器直连失败的制品请求使用临时下载通道。四个冷构建镜像与前述浏览器运行栈分别验证。

| 构建目标       | 镜像 ID                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `bento-web`    | `sha256:fd1263b4098cf2a63d2f9757ab7439cafaf440bf09427d1ba706e04e040490d9` |
| `bento-admin`  | `sha256:f7e98db85f1eaea7438e96ffb9af9acaffcdd5d2e8ca8ea6fc877ab7be510519` |
| `orchestrator` | `sha256:c48e97c5e63c8731c102dc321d4c4f147774a8abe1776853dbf7488e2206f6e1` |
| `bento-worker` | `sha256:6819841b50b312431a11bff8a280cfc1bb09e4d77ac57afe0c0bdd2cff1bb6b3` |

本地 `BENTO_A6_WORKER_REUSE_MODE=burst pnpm check` 通过，覆盖 Go 账本模式下的 APP-01 接口用例。Worker 子套件使用连续 64 轮模式。
