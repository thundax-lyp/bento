# RUNBOOK A5 最终执行链

状态 **Not Executable · 返修送审草稿**。建立日期 2026-11-25。基线 `cd13f3d7895d55115ee46d7212cdf01bc6777199`，独立 checkout `bento-b`。T0 的隔离基础探针已通过。正式候选的装配、Task 与故障验收从 T1 起，须经同 blob 审核和明确开工。

## 目标与约束

按 [A5-01～03](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#a5-最终执行链)，在同一生产候选版本、模型和 transport 上，通过正常个人端 Task/Run 入口完成真实工具链、禁用入口和工具后强杀验收。依据包括 [执行链实施设计](APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计)、[平台架构](../00-governance/ARCHITECTURE.md)、[Web Interface](../20-interfaces/WEB-INTERFACE.md) 和 [Readiness](../40-readiness/CURRENT-READINESS.md)。

- 业务 Session、Run、Workspace 和工具实际结果分别回读，以同一 Run、Session、generation、工具调用和结果关联。子 Agent 沿用业务 Session 授权的沙盒和卷。Workspace 卷归数据生命周期管理。
- Transport 和持久化入口执行当前作用域与代次校验。旧代连接关闭、宿主 Worker 退出与沙盒进程停止各有独立证据。UNKNOWN 按原标识对账，重复投递保持上游启动及实际副作用次数不变。
- 仅使用服务器 WORKER B 归属资源和该 checkout 对应的受控模型配置。敏感材料只存于受控目录。A/MASTER、共享配置、WEB-06 专属结果与结案、本机 Docker、对旧部署的迁移均超出范围。共享停止、撤权和账本由 MASTER 确认归属及顺序，A5 先复用其契约。

## 当前断点

| 场景 | 代码与证据 | 恢复条件 |
| --- | --- | --- |
| A5-01 | WORKER B 常驻栈 Orchestrator 启动证据确认 local fixture，`start.ts` 明示该模式关闭模型及 OpenShell。正式 Worker base 有独立 SDK transport 和 `ModelAdapterFactory` 装配点，缺正常 Task 所需的 `publicEvents`。带 `publicEventsUrl` 的 `runDshWorker` 在 followup 前返回 review。Task wrapper 依赖基运行时已有 `publicEvents` 及 `trustedTaskChecks`，自身无法补足。 | T0 已证实官方 SandboxClient、固定 SDK 和沙盒挂载。T1a 固定正式候选与策略，T1c 交付模型工具装配、结果投影和可信回执。 |
| A5-02 | `sdk-ingress.ts` 的 `forward` 在 `reserveExec` 和打开上游之前拒绝 `tty`，gRPC status 7。`createSshIngress` 的 `DENIED` 只证明授权检查失败，合法授权成功时可进入 relay。基线公共栈没有专项部署的能力清单及 SSH 禁用证据。 | 确认候选禁用 PTY、SSH 的配置/入口，以及独立的上游请求和沙盒进程计数读口。合法 Task 身份仍须被禁用能力拒绝。已禁用的 PTY 不计入 A5-01 正向覆盖。 |
| A5-03 | 当前执行服务 TS 持有权威账本，Go 子进程承担 Temporal 调度交接。正式架构要求 Go 单权威，Readiness A3-01/A3-06 仍部分实现。TS `stopAndProve` 依赖受信退出观察、SDK 解码及 `observeSdkRetrySafety`，旧代 UNKNOWN 时不生成安全重试证明。命令宿主的 `loadTaskObservations` 允许部署提供这些观察，但 fixture 与局部复用验收没有证明真实链路的该契约。 | 在证据中固定实际账本权威和提交。TS 候选可验证 A5 分项，切 Go 后按 A3/A5/A6 联合扩验。涉及共享核心变更时由 MASTER 明确归属及顺序。候选提供对具体旧代的宿主及沙盒停止观察、新代绑定与历史保留证据、真实 SDK UNKNOWN 和独立副作用观察。明确故障窗口及合法恢复入口，禁止把 UNKNOWN 作为允许安全重试的证明。 |

WEB-A08 可复用浏览器入口与结果回读方式，配置固定 HTTPS、单 Chromium worker、零重试，测试通过独占账号提交任务。WEB-A12 用于复用同槽位停止、状态观察和负测的证据形态。Worker reuse 的 `harness` 使用真实生产 ingress 及固定 SDK，但上游及模型为 fixture，适合作为观测样例。三份既有证据均须保留各自测得范围。

## 逐文件相关范围

以下为基线直接核对范围。行数扣除空行和纯注释。代码范围并非修改授权。

| 文件 | 基线行及符号 | LOC |
| --- | --- | ---: |
| `apps/worker/base-bootstrap.ts` | 22–319，`BaseBootstrapConfig`、`ModelAdapterFactory`、`configuration`、`consumedFields`、`bootstrap` | 288 |
| `apps/worker/dsh-worker.ts` | 73–154，`DshWorkerBootstrap`、`runDshWorker` | 79 |
| `apps/worker/task-bootstrap.ts` | 8–91，Task `bootstrap` 与可信检查投影 | 79 |
| `apps/orchestrator/src/openshell/sdk-ingress.ts` | 229–427，`forward` 的启动、TTY 拒绝和结果观察 | 196 |
| `apps/orchestrator/src/openshell/ssh-ingress.ts` | 8–48，`createSshIngress` 授权与 relay 边界 | 41 |
| `apps/orchestrator/src/execution-service/service.ts` | 349–404、442–525，`taskExit`、`sameBinding`、`readyBinding`、`stopAndProve` 的观察和证明边界 | 137 |
| **合计** | **6 个代码文件** | **820** |

## T0 环境和权威门槛

前置状态：WORKER B 专用栈及受控本地说明可读。允许修改：无。禁止修改：服务进程、容器、网络、卷、配置或持久数据。

已执行的只读核对：本地从绑定 checkout 运行下列命令。远端按本地说明 SSH 登录，以 Compose 项目标签筛选 B 资源并核查 Orchestrator 的挂载和 fixture 启动信号。

```sh
git rev-parse HEAD
git rev-parse --absolute-git-dir --path-format=absolute --git-common-dir
git status --short
git remote get-url origin
```

远端命令仅针对 WORKER B 项目标签返回的 Orchestrator。只读检查确认 compose 工作目录和 `/app/private` 源均归 B。用 `test -r` 检查该只读挂载源根目录的 `host.json`、`host.mjs`、`runtime.json`，三项均未发现可读文件。检查未覆盖其他目录，也未能区分文件不存在与不可读。启动模式及配置文件检查说明常驻栈缺少可直接复用的接线，不能据此推断 B 缺 Docker 或模型授权。

### T0 已验证资产

B 专属候选为 `bento-worker-b-a5-prep-20261125`。服务器私有运行目录、入口、资产归属及只读复验记在本 checkout 的本地 `ENVIRONMENTS.md`。固定镜像 OpenShell 0.1.6 (Linux/amd64)，固定 SDK revision `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47`。SDK 创建卷挂载使用 `spec.template.driverConfig`，卷 admission 使用 `openshell.ai/sandbox-attachable=true` 和 `openshell.ai/sandbox-attachable-workspace=default`。使用本轮签发的 mTLS，Gateway 仅监听回环。复验已验证命令：

```sh
cd "$HOME/.bento-worker-b-a5-prep-20261125"
sha256sum -c artifact-digests
curl --noproxy '*' -fsS http://127.0.0.1:24762/readyz
node sdk/probe.mjs auth
node sdk/probe.mjs status
```

PASS：Gateway ready，带证书 ListSandboxes 成功，无证书明确拒绝，probe sandbox ready。此前真实 Exec 写卷、独立只读回读、隔离同版 warm Worker SIGKILL 后 exit 137/PID 0、SDK stop 与已记录沙盒/supervisor ID 双重确认、同卷重启均有记录。首次停止响应超时由独立回读确认，第二轮 22 秒门限通过。STOP：摘要、身份、健康或授权失败。记录对应 probe、资产身份和脱敏输出，继续使用常驻 fixture 会使本步失败。T0 涉及代码 0 文件，专门核对本地环境说明、服务器摘要清单、SDK probe 三个复验文件，无提交。

Gateway、签发、SDK、隔离沙盒与可控卷已可由 B 自主准备。探针使用独立 warm Worker 和管理侧 SDK，Task 的正常入口、模型及账本关联由后续步骤交付。保留运行中的探针候选，正式 Task 使用同 B 隔离范围内的新 Compose 项目、新数据和单独 Sandbox/卷，避免复用探针业务资源。

### T0 新增已验证输入：独占空 commandHost 候选

服务器私有目录 `$HOME/.bento-worker-b-a5-task`。相对该目录，`candidate.id`、`worker.id`、`broker.pid`、`broker.started`、`asset-digests` 为本轮资产证据。Orchestrator 使用基线 B 镜像、独占可写 state、`--network none`、私有 socket 和只读配置/SDK/客户端证书运行。宿主 broker 可启动只认固定镜像、固定 argv 和一个 warm 槽位的 Worker。空候选启动后真实 Worker 发送 `ready`，Worker 无挂载和网络；commandHost 的绑定专用只读 control 走容器回环、Unix relay 和真实 mTLS SDK。该 control 只接受 smoke fixture 的 `running/stopped`，目标必须为空。错误 binding、未知操作、非法 launcher 握手和重复 warm 均拒绝。任务目录与 Gateway 探针目录分离。校验入口：

```sh
cd "$HOME/.bento-worker-b-a5-task"
sha256sum -c asset-digests
sh check.sh
sh cleanup.sh --dry-run
sh ipc-smoke.sh
```

`check.sh` 验证实际预热 Worker 身份及真实 commandHost control 正反例。`cleanup.sh --dry-run` 验证候选/Worker 容器 ID 与 owner、broker PID/开始时间/命令、两个精确 socket，执行零清理。`ipc-smoke.sh` 会启动短生命周期的隔离 probe，使用私有租约目录只读挂载至 `/app/a5-run`。容器实际回环 24101、24102、24103 分别转发至 `persistence.sock`、`operation.sock`、`sdk.sock`，验证 HTTP 和 h2c 字节流、路径及合成认证头正确穿过。该证据只覆盖空候选与部署原语，尚未把业务 WorkerRequest 送进该 IPC，也未执行 Workspace 生命周期变更或模型请求。候选仍运行。此复验组共 4 个入口文件，HOST/Worker 资产通过摘要核验，当前无提交。

## 待审核装配

以下路径和命令为目标白名单。私有运行文件以服务器 `$HOME/.bento-worker-b-a5-task` 为根，Playwright 与 pnpm 命令从候选源码根执行。T0 通过与正式步骤 PASS 分别记录。获准执行前由作者处理文末开工缺口。

### T1c：正常轮次的文件、Bash、子 Agent 与公开结果

前置：T1c 本地 focused 15/15 通过并冻结 manifest。B 私有真实 profile 已以源锚点 b707e82a135c21be4d959e2b813c358b3cc6c2ed、manifest SHA-256 7a5e873a23be6866e718f98fe43fe2165444f689f2a5a4d48ecea70d313896a9 通过 T1r 挂载、负例及实际 assembly 回滚复验，再切回同版真实 profile。B 正式独占 Compose 已 healthy，Web netns→Orchestrator 通，容器/浏览器两侧同 issuer。原合成 Run 的 execute/recover 已完成受控恢复，权威 g3 READY，无活动 Run/capability。相同 warm 槽的两轮私有 recover 帧验收已确认旧 token 被拒、旧 socket 已断、两路均清理。真实 control 卷生命周期与 purge 双缺失及模型 TLS 中继通过。持久卷挂在 /sandbox/project/workspace，当前沙盒读文件 full confinement 已复验。Playwright 从本轮浏览器侧登录候选 Realm，登录后从正常 Task 页面提交。

T1c 第一次真实验收后已保留原 Run。定向合成探针重现 rc.4 defineTool 在父 Session 初始化后拒绝 marker 的 minLength/maxLength（JsonSchemaError）。修正为 DSL 支持的 type=string、required=true，并保留工具执行时的长度/字符验证。固定后的同版合成探针已通过父会话/工具注册并在模型调用前主动停止。修正候选以 9a77e14f9a9f7edd2d5038d049824ea832dcba6b 为源锚点，私有 manifest SHA-256 bb28e5244f538d5216e68001a3bc959c6b6ae96bebe62ed28e2e840057c834b7。真验须先按已通过 T1r 的安全切换边界从 assembly 复验并装载这一版本，核四份实际挂载源；首次失败证据和原卷保持留存。

白名单 10 文件：`apps/worker/base-bootstrap.ts`、`apps/worker/base-bootstrap.test.ts`、`apps/worker/remote-session.ts`、只读 `apps/worker/task-bootstrap.ts`、`apps/worker/protocol.ts`、私有 `container/deepseek-model.mjs`、`container/a5-tools.mjs`、`apps/workspace/web/playwright.a5.config.ts`、`apps/workspace/web/acceptance/a5-tools.spec.ts` 和本 RUNBOOK。模型配置预检已通过，实际请求只发当前 checkout 对应的官方 Messages 服务。上游凭据从 Git 忽略的本地配置分别写入部署受控文件，不进入 stdout 或镜像层。factory 按 `ModelAdapterFactory` 每轮新建 adapter 和 disposer。模型 tool_use 的 id/name/input 映射为 DSH tool-call，tool 角色的结果按原 toolCallId 和 isError 回传 tool_result；工具执行发生在 Worker 绑定服务，模型输出不能生成可信检查。

使用 `ToolRuntime.register`，在 OpenShell provider 与 AgentLoop 就绪后、顶层 followup 之前依序注册下列三项。各 tool handler 需要 forward 已有 `exec.signal`，超时或未获执行回执时返回失败。前缀回归使用文件、Bash 和子 Agent 三项，四工具正式验收使用 T1d 后的同一轮。每项使用本 Run 合成标记，禁止从其它 Run 输入取结果。空候选的 Worker 保持无普通网络，模型流量由受信宿主提供独立 Unix 转发，只允许已核对的 HTTPS 目的地，TLS 由模型客户端端到端校验；候选已启动该专用转发，T1c 只装配真实模型。

| 注册名称 | 绑定和最小断言 |
| --- | --- |
| `a5_file` | 使用同授权 `ctx.fs` 写入、读回本 Run 工作区文件 `a5-file.txt`。独立 snapshot 核对精确字节。 |
| `a5_bash` | 通过本绑定 `ctx.sandbox.confine` 及 `ctx.subprocess.spawn` 在沙盒执行 Bash，无 PTY；创建 `a5-bash.txt` 并核对真实退出码、SDK 终态和实际文件。 |
| `a5_child` | 调用 `AgentRegistry.create` 指定 parentAgent 与 child origin，真实模型子轮通过原 sandbox/volume 绑定回读 `a5-bash.txt`。创建选项固定 `parentAgent`、新的 `sessionId`、`meta.origin = "subagent"`、`meta.parentSession` 指向当前父会话、`delegationDepth = 1`。相同业务沙盒及子结果；不得为子会话额外创建业务沙盒。 |

子 Session scope factory 每个请求创建一次。装配在 `remoteSessionPersistence` 插件选项内，可信函数先登记生成的子 ID 再调 `AgentRegistry.create`。AgentLoop 在 `setup` 前通过 runtime persistence 占用写所有权，因此 setup 只组合子工具范围。顶层 ID 走原 RemoteSession，当前登记的子 ID 走本轮内存，未知来源拒绝。所有带 id/header.id 的父 RPC 发送前必须严格等于顶层 ID，recover 不登记子 ID。

| 公开调用 | 内存子 Session 行为 |
| --- | --- |
| `create(header,options)` | 仅接收登记子 ID，无种子继承、冻结 header、唯一 write handle；create 成功后立即对 stat/list 可见。重复或已取消按公开契约失败。 |
| `open(id,access,options)` | 未知报 not found；read 不争写权，write 仅无现有写 owner 时取得。 |
| `stat(id)` / `list()` | 只返回本轮已创建的子记录，缺失 stat 返回 undefined，父 list 维持既有语义。可见前缀改变时更换 opaque revision。 |
| `read(offset,length,options)` | 连续 seq，返回自有数组与冻结事件，eventState 按公开 ABI；处理边界和 cancellation。 |
| `append(events,options)` | 校验活跃 write handle、owner、连续 seq，复制输入，新读观察到已接受前缀。read handle 拒写。 |
| `handle.flush(options)` / `service.flush()` | handle 只允许 write，read handle 返回 SessionReadOnlyError；service 调父 flush 并独立处理当前所有子写 handle，汇总错误。 |
| `close()` / `Symbol.asyncDispose` | 幂等，write 完成最终 flush 再释放，关闭后所有操作拒绝。 |

scope factory 捕获 parent、当前 binding 和受限子只读文件工具。登记子 ID 后调用 create，再调用 followup、whenIdle、flush，读取匹配工具结果。finally 中 dispose Agent、关闭该子 scope 的 handles、等待未完成工作并清除登记。create/setup 失败与取消进入同一清理顺序；取消先中止再等待退出。父工具从真实子结果构造父 tool/result，父 RemoteSession 持久。独立读取 history.sqlite 比对父工具 ID/result，确认无子 ID 行；受控出站 RPC 只记操作名、ID 关系和次数，证明子 ID 和未知 ID 零 HTTP。子 Agent 有独立实际 Session ID、同 Run/沙盒/卷，无额外沙盒。

公共事件由同一已持久化事件窗口映射。assistant 可公开文本用 `{offset,kind:"agent_reply",text}`。工具注册名/通过的实际结果使用固定文案 `step` 或 `command`，offset 为对应事件在本批次中的索引。可信检查仅用 `{version:1,offset,outcome}` 关联实际调用结果，由原 task-bootstrap 投影成 `check`。严禁输出秘密、原始 argv/环境和私有路径；工具结果与实际调用 ID 对账留在受控证据。独立核对 Run、Session、Workspace 和工具输出。

```sh
pnpm --filter @bento/orchestrator test:worker-runtime
pnpm --filter @bento/web exec playwright test --config playwright.a5.config.ts acceptance/a5-tools.spec.ts --grep "A5 prefix"
```

PASS：前缀 Task 一次 Run 完成，三项实际调用和结果均可回读，本部署关闭 PTY。Readiness 仍待同轮四项。STOP：模型拒绝协议、工具未注册/未完成、公开结果缺项或绑定不符。保留现场且不重交同任务。提交边界为生产投影落点、直接回归、验收文件和本步清理。子 Agent 内存 handle 的 ABI 与父/子 RPC 负测见开工缺口。

### T1d：Bento 专用 PTC 控制 transport 与同轮四工具验收

候选依赖确实可取得。受控 registry 的官方 `@deepseek-ai/dsh-ptc-runtime-node@0.2.1-rc.4` tarball 已下载，SHA-256 `4af325d07edde96e78eada6771e8939b5c3d0a387bd000bd78e8073b71c76606`。`lib/process.js` 是可固定的一次性 helper，SHA-256 `e25ce53b26bb3e96e62cb7433f74612395f3865b4627a695d3d4fd42c4706790`。rc.4 `NodePtcRuntime` 接受 `executionMode:"per-call"`、`launch:{kind:"node-script",executable,bootstrapPath}`，显式指定镜像内预装绝对路径可解决远端路径映射。源码表明 helper 仍从 duplex FD 7 读取控制协议，而宿主 runtime 发送 `stdio.control:"pipe"`。锁定的 `dsh-sandbox-openshell@0.1.0-rc.1` 在 spawn 前拒绝 control，且固定官方 SDK 方法只提供 stdin/stdout/stderr/exit。已查 `dsh-plugin-openshell` 固定 `81f3ab3415e0621a5e40ce5689d7a0ec33a793dd` 的 Dockerfile 和 helper，其镜像只打包 confine/fs，不含控制桥。helper 字节可复用，隔离控制 transport 仍缺。

Bento 内有可行的独立扩展点，暂无证据表明必须修改外部仓库。锁定 Cordis 4.0.5 的公开 `ctx.isolate("subprocess")` 可提供局部 `SubprocessRuntime`。本地已做作用域隔离小探针，根作用域保持原 provider，子域读取独立 service。官方 `NodePtcRuntime` 仅通过注入读取 fs/subprocess/sandbox/sandboxPolicy；将它装在该子域，沿用父域 FS 和已绑定的原 OpenShell sandboxPolicy/confine，不替换普通 subprocess。PTC 工具通过显式持有的子域 runtime handle 调用，不从模型输入选择 provider。

- Bento Worker 在每轮 `base-bootstrap` 中创建专用 `SubprocessRuntime` adapter，并以 `ctx.isolate("subprocess")` 安装官方 `NodePtcRuntime`，`executionMode:"per-call"`、规定的 `launch.kind:"node-script"` 和沙盒内 Node/helper 绝对路径。沿用父域 FS、受限 sandbox 与 sandboxPolicy。记录父域普通 `subprocess` service identity，装配前后及 dispose 后须相同。`resolveExecutable` 只允许固定 Node，经父 provider 解析。confine 的已登记 argv 必须精确匹配该次 SDK 启动，工作目录必须在绑定卷内。完整模式检查失败停止。总入口使用既有 scoped official `SandboxClient.execInteractive(binding.sandbox, fixedArgv,{tty:false,noLoginShell:true,workdir,timeoutSecs,signal})`，禁止允许 caller 选择 helper、参数、env、SDK 目的地或权限。Node runtime 提交的 env 去除请求仅接受 `undefined` 值，桥使用自身最小环境。
- 固定镜像根所有、只读位置 `/opt/bento-ptc/bridge.mjs` 与 `/opt/bento-ptc/process.js`。桥使用镜像 Node 启动官方 helper，子进程 FD 7 为真实 duplex，`DSH_SUBPROCESS_CONTROL=pipe`。bridge 自身是可信沙盒启动程序，官方 helper 以已登记的原 confinement argv 执行，独立进程组内等待。验证 confine wrapper 未关闭 FD 7 并能保护卷外、环境和网络。不能用探针镜像内的无策略 exec 代替。
- 桥协议固定二进制。22 字节 header，版本 1 字节取 1、tag 1 字节、16 字节每次随机 nonce、4 字节 big-endian payload 长度。单帧 payload ≤65536 字节，任一方向待发送数据 ≤262144 字节，分帧收包只留一个未完成帧；超限、截断、未知 tag、错 nonce、错次序立即拒绝并触发停止。host→bridge 仅 `1 HELLO`、`2 CONTROL`、`3 CONTROL_EOF`。bridge→host 仅 `1 HELLO`、`2 CONTROL`、`3 CONTROL_EOF`、`4 STDOUT`、`5 STDERR`、`6 STOPPED`。HELLO、CONTROL_EOF、STOPPED 无 payload。相同 nonce 双向 HELLO 完成前禁止其他数据。每边最多一个 EOF，之后该方向禁止 control 数据。桥将子 stdout/stderr 原字节包装为 4/5，模型数据始终不能生成外层控制帧。桥协议帧仅走 SDK stdout，SDK stderr 仅受控诊断且限制长度。STOPPED 后禁止应用帧，必须另收可信 SDK exit。发送背压以实际流的 drain 为准，禁止无限缓存或把日志写回控制通道。
- 向官方 runtime 提供公开 `SubprocessHandle`。CONTROL 以单独 `Duplex` 读写，STDOUT/STDERR 投到独立流，关闭、退出和异常按 one-shot settle。桥正常路径只在确认自己的 helper 进程组为空后发 STOPPED。Worker waitForExit 只在 STOPPED、可信 SDK exit、通道关闭齐备时返回 true。EOF/取消/超时触发桥终止、等待该次受管进程组，无法确认则由现有信任侧观察整个绑定旧沙盒及 Worker 双侧停止，返回未确认或抛错，保持 UNKNOWN 零重放。SDK 断流和单独退出码不可当作 proof。校验单独取消、异常 FD、逃逸后的证明撤回与已知旧代没执行。不得为适配降低原 full enforcement。
- 真实宿主 bindings 固定测试一个回调往返：同轮 PTC TypeScript 通过一个受限异步 binding 请求读取原 `a5-file.txt`，在校验回传的 JSON 值后调用同允许列表中的第二个 binding，结果关联本 Run 唯一标记。请求未知函数、异常 JSON、取消未完成 binding 均由官方 runtime/adaptor 失败关闭。独立卷读口核对内容，防止把 JS 常量当成实际 PTC binding。成功、异常、日志帧伪造、故障终止均通过同版官方 SDK 实栈证明。
- 已验证原语：Cordis 4.0.5 双服务隔离、本轮 OpenShell 0.1.6 实沙盒 FD 7 双向。均在先前探针上执行，完整 helper bindings、协议和 managed range 未实证。不改外部 provider、SDK 的公共方法或权限。

外部兼容备选仅当 Bento 独立适配被已证实的 ABI 或 confinement 阻断，再由 MASTER 决定。最小外部提交应在 provider 的 opt-in 独立 PTC provider/镜像桥上交付上述 transport，根 provider、通用 spawn、SDK 和权限不变。Bento 随后只锁定新的 provider 版本与镜像摘要。当前暂无这个前提，禁止改其他仓库。

T1d 拟白名单 10 文件：`apps/worker/ptc-subprocess.ts`、`apps/worker/ptc-subprocess.test.ts`、`apps/worker/base-bootstrap.ts`、`apps/worker/package.json`、`pnpm-lock.yaml`、私有 `container/ptc-bridge.mjs`、`container/a5-tools.mjs`、私有 `ptc-sandbox.Dockerfile`、`apps/workspace/web/acceptance/a5-tools.spec.ts`、本 RUNBOOK。把官方三个直接依赖 `dsh-ptc-runtime-node`、`dsh-subprocess`、`dsh-sandbox-policy` 锁到 rc.4，provider 仍 rc.1。产物为隔离 scope、固定镜像/运行时和同轮四工具证据。验证命令固定如下，adapter 回归包括 framing 纯协议和连接 B 的实际 SDK 两个用例。私有配置只由候选进程读取，未配置时测试失败，禁止 skip。

```sh
pnpm check:worker
node --import ./register-paths.mjs --experimental-strip-types --test apps/worker/ptc-subprocess.test.ts
pnpm --filter @bento/web exec playwright test --config playwright.a5.config.ts acceptance/a5-tools.spec.ts --grep "A5 four tools"
```

PASS：真实沙盒 PTC 宿主 bindings 双向成功、协议与终止负例通过、同模型同一轮四工具实际结果和四方对账全部成立。STOP：帧协议、防混用、确切 termination 或实际 full enforcement 未证明。回退仅撤回此轮镜像/依赖绑定并保留现场。外层 framing、managed-range 合同和回归命令已固定，实现后仍需实测 Linux/Docker 管理范围和 confinement。

### T2：禁用入口

白名单 6 文件：新 `apps/workspace/web/acceptance/a5-disabled-entrypoints.spec.ts`、只读 `apps/workspace/web/playwright.a5.config.ts`、`apps/orchestrator/src/openshell/sdk-ingress.ts`、`apps/orchestrator/src/openshell/ssh-ingress.ts`、`apps/orchestrator/src/execution-service/service.ts`、本 RUNBOOK。使用正常 Task 的实时合法 binding/grant。先以同租约可用的 SDK GetSandbox 证明授权有效，再送带 tty=true 且目标匹配的 SDK Exec 入口，验证 gRPC 7，独立读取 B 候选 `state/authority.sqlite` 的 `operations` 按 `session,generation` 查 `id,digest,state`，过滤 `id LIKE 'sdk:%'`，专项窗口前后无新保留；生产代码在打开上游前先完成该保留。另取同 owner、sandbox 及精确容器 ID 的 Docker 运行观察，以及独立只读卷标记计数，均无变化。此关系证明候选 SDK 没有发出 Exec。若要求来自 Gateway 原始请求的独立计数，需确认已验证的 Gateway 读口，不得把同一 SQLite 另跑一次冒充。SSH 使用真实官方 OpenShell 能力申请。由 B 本轮 Worker 租约复用固定 SDK gRPC transport，调用 `OpenShell.CreateSshSession({sandbox:binding.sandbox,workspaceScope:{selection:{case:"workspace",value:"default"}}})`，路径 `/openshell.v1.OpenShell/CreateSshSession`。该实际方法不在生产 sdk-ingress allowlist，gRPC 7 才算拒绝。前后用同一 grant 的 `GetSandbox` 证明合法身份。独立从 B 专属 Gateway SQLite 以只读方式执行 `SELECT count(*) FROM objects WHERE object_type = 'ssh_session' AND workspace = ?`（`default`），该窗口前后均须为 0，表列和对象类型已由固定 Gateway 源码及服务器只读 schema 检查确认。只读取统计，不解析 token payload。同期核对候选 Docker sandbox/supervisor ID、Worker 网络下无 SSH relay 或新增进程启动。不得调用不存在的网络端点或使用错 grant 充当拒绝。

`pnpm --filter @bento/web exec playwright test --config playwright.a5.config.ts acceptance/a5-disabled-entrypoints.spec.ts`

PASS：合法身份证据、每个禁用入口的拒绝证据及零启动齐备。STOP：缺正常 SSH 能力调用位置或可信独立计数时不得声称通过。恢复只关闭本轮探针租约。提交边界为 spec 与本步清理。

### T3a：旧代观察

白名单 6 文件：私有 `container/task-observations.mjs`、`container/host.json`、`host/broker.mjs`、只读 `apps/orchestrator/src/execution-service/types.ts`、`apps/orchestrator/src/execution-service/command-host.ts`、本 RUNBOOK。Broker SQLite 对 `bindingDigest,runId,generation` 存已绑定的容器 ID、镜像、startedAt 和实际退出时间。派发前持久记录身份；退出时间只来自独立 Docker wait/inspect，读取端只读。安装原 `taskObservationModule`。 `observeWorkerExit` 返回 `sessionId/runId/generation/bindingDigest/exitedAt`；`observeTaskVolumeStopped` 返回对应身份及 `restoreIdle:true/volumeWriters:0/sandboxStopped:true/observedAt`；`taskRecovery.observeSdkRetrySafety` 返回原退出身份，加 `observedAt/workspaceOnly/unknownOperations`；`taskRecovery.retryObservation` 仅返回后两字段。证据不足返回 null 或拒绝，绝不报告已停止、零 UNKNOWN 或安全。`queryRestore` 无本轮记录返回 null，`restoreTask` 记录调用次数后明确拒绝，保持原卷。A5 路径不执行 WEB-07 restore，两个验收均须审计 `restoreTask` 调用计数为零。

`cd apps/orchestrator && node --import ../../register-paths.mjs --experimental-strip-types --test tests/execution-service/task-retry-sdk.test.ts`

PASS：基线定向门禁通过、实栈观察错 binding/代次/未退出时不可出具证明。STOP：账本或观察缺证据；禁用本轮观察模块并保留数据，无格式迁移。提交边界为受控证据及本步清理。

### T3：已结算和 UNKNOWN 故障窗

白名单 7 文件：`apps/workspace/web/acceptance/a5-crash-recovery.spec.ts`、只读 `apps/workspace/web/playwright.a5.config.ts`、私有 `host/crash-probe.mjs`、`host/broker.mjs`、只读 `apps/orchestrator/src/execution-service/service.ts`、`apps/orchestrator/src/openshell/single-host.ts`，本 RUNBOOK。分别创建正常 Task、Run、独立卷，Bash 业务工具在探针合成文件追加一个由验收创建的标记。控制器仅匹配 broker 当前租约、精确 Worker ID 和 generation，按 `docker kill --signal KILL <recorded-worker-id>` 触发。读口以 SQLite 只读连接读取 B 私有 `state/authority.sqlite` 的 `operations(session,generation,id,digest,state)`、`execution_sessions(session,generation,state,run)` 和 `state/history.sqlite` 的 `events(id,seq,event)`、`batch_receipts(id,epoch,batch,digest,first,count)`。按既有 session/generation 及唯一标记关联，强杀前冻结历史前缀摘要，恢复后比对相同 seq 范围。沙盒状态从同绑定 Gateway SDK GetSandbox 读回，与已登记 Docker 容器 ID 停止证据互验，卷由独立只读挂载核对精确标记行数。

1. 已结算。独立看到标记追加，收到 SDK 可信 exit 并查询原操作 SUCCEEDED。下一模型回合由测试专用 adapter 等待信号，确认 history 已持久并断言无额外工具后强杀。确认宿主退出、旧代写拒绝、旧沙盒双侧停止；只接受当前权威表在同一 session、sandbox、volume 上发布的合法物理新代，且确认旧身份无法写、无旧 capability。以该新代为只读核对边界，独立读取旧 Session 原 seq 前缀与 batch receipts、读取同一已挂载原卷，验证历史不变且副作用恰好一次。禁止分配新的业务 Session 或调用 WEB-07 restore。
2. UNKNOWN。工具在追加标记后、退出前等待独立 release 文件；`crash-probe.mjs` 观测到标记且放行文件仍不存在时强杀 Worker。回读同一 SDK operation 仍 UNKNOWN。验证真实双侧停止及旧代拒写，物理新代 READY 后原 Run 保持需核对。正常入口核对重复投递/尝试重试未产生新执行、历史仍在、卷相同、副作用一次。禁止写 release、重派工具或修改 SDK 状态。基线 `settle` 可发无 prompt 的 `recover` 帧读取并完成持久历史，随后再次 fence；记录实际代次序列，仅将 execute admission、模型和工具调用计为业务执行。
3. 两例分别回读 `restoreTask` 调用计数为 0。基线 SDK 同连接可信终态负责 SDK 结算。A5-03 的 UNKNOWN 零重放无需新增任意归账 API。WEB-07 的无法确认结案仍按原归属。

`pnpm --filter @bento/web exec playwright test --config playwright.a5.config.ts acceptance/a5-crash-recovery.spec.ts`

PASS：两例均满足窗口、停止、代次、历史、卷和副作用独立计数，并证明 UNKNOWN 业务未放行。STOP：实际 exit 早于预期窗口、目标租约不匹配或历史/卷不可读，保留现场，按原控制侧只停止本轮，禁止重用失败样本。提交边界为验收文件和本步清理。

### T4：汇总与收口

白名单 3 文件：`docs/40-readiness/CURRENT-READINESS.md`、`docs/40-readiness/evidence/A5.md`、本 RUNBOOK。执行：

```sh
pnpm check:worker
pnpm --filter @bento/orchestrator typecheck
pnpm --filter @bento/web typecheck
pnpm --filter @bento/orchestrator test:worker-runtime
pnpm --filter @bento/web exec playwright test --config playwright.a5.config.ts
git diff --check
```

PASS：同一版本三份实栈 spec 的预期用例全部运行、观察及断言通过，记录实际权威版本和未覆盖范围，更新 Readiness 后删除 RUNBOOK 并执行 `rg -n 'RUNBOOK-A5-FINAL-EXECUTION' docs` 核对无残留。STOP：命令、任何证据或生产版本不匹配，保留草稿和未达到的 Readiness。提交边界为长期证据与 RUNBOOK 删除。

## 开工前剩余作者核对

- T0 私有资产与 T1a 正式候选装配已通过。T1c 仍须实证子 Agent 内存 persistence ABI、真实模型三工具与父级投影。
- T1d 有公开 Cordis/SubprocessRuntime 和既有 SDK 的 Bento 内独立路径。官方 helper 摘要和沙盒内部 FD 双向原语已确认。专用桥、完整宿主 bindings、隔离范围终止和镜像 confinement 未实证，需按该白名单复审后实施。
- T2 的 SSH 禁用路由和 T3 的故障窗观测命令等待业务候选落地。已固定独立账本、历史、Gateway/Docker 与卷读口及预期绑定。相关拟新增 specs 尚未执行。
- 当前无可越过四工具同轮的交付条件。STOP 时记录最后通过 STEP、触发条件、对应代码、最小复现命令、脱敏输出和恢复条件。当前没有正式实施 PASS。
