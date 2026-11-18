# WEB-07-02 真实页面续聊验收

## 状态与执行契约

2026-11-18，WORKER A，起点 main `6b8eefa259386e4872320d179f9a714b49fb16f8`。状态 **Not Executable**，供 MASTER 复审。T0 已在本轮独占实栈通过真实浏览器、Worker、同一 Run 账本和正常 Space 回收探针，随后完成本轮撤场。最终两轮续聊和同键重投仍待 T3。范围获全流程授权，产品代码与 Git 分支需待 MASTER 判定 Executable 并下发。每步须留命令、版本、断言和脱敏证据。步骤数和每步文件范围按 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md) 和 [WORKER Skill](../../.agents/skills/bento-runbook-worker/SKILL.md)。

## 目标与边界

只关闭 [WEB-07-02 / WEB-A11](../10-requirements/WEB-REQUIREMENTS.md#web-07-02-happy-path-原任务继续对话mvp)。正常 HTTPS/OIDC 页面提交后续要求，第二轮读第一轮结果作为输入，原 Task、Session 和 Workspace 继续，新 Run 独立，同一浏览器发送重放只产生一个新 Run。首轮结果、增量/累计补丁与检查仍可从旧轮次回读。测试基于现有 WEB-A13 真实结果用例，保留该用例既有的两个写入轮次及另一个只读 Task，WEB-07-02 的计数只针对原 Task。批准后的真实测试需要实际 Worker、DSH、Gateway 和私有 Space 存储。

本步骤不修改产品或公开契约，不修改 Workspace Space 删除、持久门禁、可信结案或重试恢复。WEB-07-04 和对应异常方案在本文后部供 MASTER 审核另行派发。WEB-07-01、-03、-05、-06 不作为本次验收场景。

## 正式依据与当前断点

- [WEB Interface](../20-interfaces/WEB-INTERFACE.md) 的任务、Run、事件和结果路由以及 [WEB Design](./WEB-DESIGN.md) 的执行链。应用边界由 [Architecture](../00-governance/ARCHITECTURE.md) 管理。
- `apps/workspace/web/src/pages.tsx` 的 Task 详情 mutation 通过 `createTaskRun` 发送同页面后续要求。`apps/workspace/web/src/api.ts::taskMutation` 根据账号、操作、Task scope 和正文摘要复用 sessionStorage UUID，观察到成功后清键，网络失败保留键。若第一次 HTTP 202 在页面收到前丢失，仍可重投。
- `apps/workspace/api/execution-service-http.ts::taskForward` 转发认证后的 Task 路径、正文和幂等键。公开 `POST /api/tasks/{taskId}/runs` 用 `Idempotency-Key` 与唯一必填 JSON 字段 `prompt:string`，首次 202 与重投 200 均回 `{run:RunDTO}`。服务生成 Run ID 与 sequence。Store `enqueueTaskRun(owner,taskId,key,prompt)` 在事务中先按 Task 和 key 查原 Run 并校验 prompt，再检查 Task 写门禁、成功前序、创建 Run 和追加一条 user_message。异 payload 同键为 409 idempotency_conflict。新续聊 Run 的 retryOf 为 null。Run 状态可在重投之间推进，重投证据比较 ID、Task ID、sequence、prompt 和 retryOf。
- `apps/orchestrator/execution-service/store.ts::binding/projectBinding` 取 Task 同 ID 的执行 project，绑定 tenant、project、session、sandbox、volume。Orchestrator `taskRunView` 投影 canContinue，`driveRun` 派发同绑定，`finish` 以本轮基线结算结果。Session 和卷保持，authority generation 允许随派发推进。同轮读回使用实际传给 `host.worker` 的 `binding` 摘要和相同代次的 Worker 投影完成落盘；事后仅查询 Task 当前绑定两次不能替代。
- `apps/workspace/web/acceptance/web-a13.spec.ts::sendRound/awaitResult/readResult/verifyPage` 已包含页面上传、创建 Task、两个成功 Run、检查与两个 patch 视图及旧结果字节比较。当前缺少发送重放、独立的实际 Worker 绑定观察、旧轮次页面重开的检查断言。既有测试被 Chromium list-only 发现一项。此观察无运行证据。
- `apps/workspace/web/e2e/task.spec.ts` 的 mock 连续任务场景提供本地页面回归。`apps/workspace/web/acceptance/web-05-environment.spec.ts::replay` 提供测试内真实响应丢失模式，参考实现；无需重跑 WEB-05 或调用其现场脚本。

## T0：Linux 独占实栈与按 Run 取证

### 窗口与实际装配

- 本机无可用 Docker 运行时。经 MASTER 同仓环境说明与严格 SSH 已知主机校验接入测试 Linux。远端用户无法写 `/etc` 且 `sudo -n` 拒绝，改用该账号 HOME 下新的 `$HOME/.bento-web-a11`。目录通过原子 mkdir 登记，权限 0700，锁定 Docker daemon、Compose 项目 `bento-a-web-a11`、独占 Workspace/Temporal queue 与基线 SHA。登记窗口为 2026-11-18 16:18:40–18:18:40（Asia/Shanghai）。登记前 Docker 容器/网络/卷、同名 Gateway 与 18443/18444/18445/18808 监听无冲突。对外仅回环映射 18443 Web、18444 S3、18445 Gateway；18808 给 Gateway 容器内健康端口。当前 B 草稿未使用该资源组。旧 A/B 容器、卷、桶、账号、锁和租约退出执行范围。
- 主线源码以 `git archive` 冻结并传输到本轮 `source`。先构建独占 Worker。远端 Docker 的 Go 下载超时后，按同一 SHA 用本机 Go 1.25.3 交叉编译 Linux amd64 两个 Go 二进制，传输后复核 SHA-256，使用私有 Dockerfile 与独立 BuildKit named context 组装前端和 Orchestrator。Worker 私有 bootstrap 所需 DSH 包单独按锁文件装入独占 fixture 镜像。工作区仅调整本 RUNBOOK，其余准备件在 Git 忽略的 `debug-workspace/web-a11-t0` 与远端新私有目录。
- 运行固定的 8 个 Compose 服务，另加按容器 ID 登记的独占 Gateway。Web、Orchestrator、Worker、Worker fixture 镜像均带源 SHA 与 A 专属标签。完整 Image ID、各容器 ID、构建日志、TLS/OIDC/S3/Worker 探针证据在本轮私有 `evidence`。可直接按下面命令读脱敏版本及运行状态。PostgreSQL、MySQL、Temporal 数据均使用新专属 Compose 命名卷。

```sh
r="$HOME/.bento-web-a11"
test "$(cat "$r/daemon-id")" = "$(docker info --format '{{.ID}}')"
cd "$r/private/foundation"
docker compose -p bento-a-web-a11 --env-file compose.env \
  -f compose.yaml -f web-core.yaml -f execution.yaml config --quiet
docker compose -p bento-a-web-a11 --env-file compose.env \
  -f compose.yaml -f web-core.yaml -f execution.yaml ps -a \
  --format '{{.Service}} {{.State}}'
for role in web orchestrator worker worker-fixture; do
  docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "bento-a-web-a11/$role:6b8eefa"
done
```

### 已通过的探针与证据

- 私有 CA 分开签发 Web/S3 与 Gateway 证书，Chromium 使用本轮 NSS 信任目录，Node 使用本轮 CA。严格 HTTPS OIDC discovery 200，真实 Chromium 登录回调 303、应用 `/api/session` 200。测试账号由新 realm 创建并回读唯一组织成员绑定。Chrome 用自己的 DNS 规则映射两个本轮站点，Playwright APIRequest 使用 `browser/resolve-a11.mjs`，仅替换这两个名字的进程内地址解析，服务端主机名与证书校验保留。没有修改系统 hosts 或全局信任。
- `private/probe-foundation.py` 证明独立的新 S3 实例和私有桶支持匿名拒绝、SHA-256 multipart 写入和 ListParts 核对、条件完成、精确回读、删除、空桶。凭据仅作用于本轮独立 S3 实例，当前探针使用该实例专属凭据。随后从真实 Chromium 上传并读回已保存的 Space 文件，正常页面从该文件创建 Task、派发成功 Run。同一个 Space 项目清理后，项目和原结果分别返回 404。独立 SDK/卷检查与 S3 ListObjects/ListMultipartUploads 均确认回收。
- `private/probe-gateway.mjs` 证明新 CA 的 mTLS SDK 正例、无客户端证书负例与新 Workspace 初始为空。随后以 dedicated volume 做实际 sandbox/卷文件读回，完成后按登记的 sandbox/卷删除、SDK 与 Docker 分别确认不存在。卷标签采用实际驱动要求的 `openshell.ai/sandbox-attachable=true` 与 `openshell.ai/sandbox-attachable-workspace=bento-a-web-a11`，再附 A 专属归属标签。
- `browser/browser-run.mjs` 在新账号用正常页面提交空白 Task 与单轮请求。Temporal 私有 task queue 派发实际 Worker。Worker 无网络、无 Docker socket、无 Gateway mTLS 私钥，仅挂载本轮按 Run 建立的 Unix sockets。私有 DSH bootstrap 使用脚本化模型响应控制验收输入，运行真实 DSH 会话和 OpenShell 写入。未验证真实模型按同一提示生成工具调用的能力。恢复分诊时的失败尝试留在首个探针账号；成功证据来自另建账号及真实 Worker 入口 `apps/worker/run-worker.ts`。
- 生产入口成功的同一 Run 在真实页面可读结果和投影，`private/observe-web-a11.mjs` 在 Orchestrator 容器只读核对 admission、绑定摘要与同代 projection end，固定非法 ID 的请求拒绝。另一次诊断入口 Run 持久 DSH 事件 17 条、公开事件 2 条与同代 completion 1 条。实际 WEB-A11 两轮及同键重投由 T3 执行。

```sh
r="$HOME/.bento-web-a11"
cd "$r/private/foundation"
docker compose -p bento-a-web-a11 --env-file compose.env \
  -f compose.yaml -f web-core.yaml -f execution.yaml \
  exec -T orchestrator node "$r/private/observe-web-a11.mjs" smoke-readback \
  > "$r/evidence/production-admission.json"
test -s "$r/evidence/production-admission.json"
```

`smoke-readback` 只在本轮私有探针读取已登记的 Run。T2 交付脚本仅支持 Task ID 和 Run ID 两个固定参数。

### 进入实施前的门禁

- 重新核对新候选窗口截止、实际归属容器和镜像，确认专用验收账号、存储、任务队列、Gateway Workspace 与已有只读探针的证据。首个账号中的失败烟测属于本轮故障现场，不进入真实续聊验收。后续执行使用重新核对的空账号和干净业务边界。
- T0 的业务回收采用正常 Space 项目删除，经页面实证后分别读回原结果 404、SDK sandbox 缺失、卷缺失、S3 物理与 multipart 为空。独占 realm 及测试账号随基础设施销毁。额外尝试账号注销时，重认证 callback 返回 HTTP 500，原会话仍有效，MySQL 未标为 closed。其根因未确认，该路径退出本验收清理流程。失败烟测只按隔离环境回滚处置，无人工解除业务门禁。
- T0 本轮退场已完成。准确命令为 `bash "$HOME/.bento-web-a11/private/rollback-t0.sh"`。脚本先按记录的完整 Docker ID 和 Compose 项目核对 8 个服务与 6 个卷，停止 Web/Orchestrator，从原账本只读枚举本轮探针绑定，确认没有 queued/running/recovering/cancelling Run 或 Worker。以专属 SDK workspace 删除已登记沙箱，再查无挂载者并删除本轮标签的执行卷；最后按私有 Compose 项目 `down --volumes` 并独立盘点。作用域内容器、网络、卷、监听端口和 Unix sockets 均读回为空。本轮 realm、S3、私有 CA 签名材料和浏览器会话已退役。独立构建产物与脱敏读回留供复审。剩余诊断尝试通过销毁整个一次性环境清理，不能计入应用业务清理验收。
- T0 采用本地私有 `debug-workspace/web-a11-t0` 的 SSH、构建、基础设施、Host/Worker、浏览器和回收脚本。下一窗口需重新登记并新建空状态、专用账号和新凭据，再跑 TLS、S3、Gateway 和 Worker 阳性。前一轮运行状态及已失效的账号、私钥、会话文件不可复用。仅已验证的构建产物和源码模板可带入。T1/T2 的本地代码验证可在审定和分支下发后执行，T3 依赖新独占窗口。
- 故障安全门禁：无授权窗口、旧资源重叠、实栈模块需扩大共享权限、未确认资源登记、只读受信查找失配或撤场未核实均 STOP。保留脱敏证据，禁止修改旧 A 或 B。

## T2：按 Run 只读核对派发绑定

前置状态：`web-a13.spec.ts` 已有 A11 opt-in 续聊、重投和 Space 回收断言，`playwright.web-a13.config.ts` 已有对应浏览器配置。已核对 baseline T0 的只读 SQLite 探针。

允许修改：新增 `deploy/orchestrator/observe-web-a11.mjs`、`apps/workspace/web/acceptance/web-a13.spec.ts` 及 RUNBOOK。禁止修改生产 HTTP、运行适配器及数据库 schema。

执行：

1. 实现 `node /app/private/observe-web-a11.mjs <taskId> <runId>`。两个位置参数均须匹配 `/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/`，拒绝多余参数。使用 Node 的 `DatabaseSync(file,{readOnly:true})` 打开 Orchestrator 容器 `/data/business.sqlite`，只执行参数化查询。按 `r.id=? AND p.id=?` 从 `runs r JOIN projects p ON p.id=r.projectId` 选取 `r.sessionId,r.status,r.taskSequence,r.admittedGeneration,r.admittedBindingDigest,p.owner,p.id,p.sessionId AS boundSession,p.sandbox,p.volume`；要求恰一行、`status==='succeeded'`、taskSequence 是正整数、admittedGeneration 为非负整数，两个 Session ID 相等。另以 `WHERE runId=? AND generation=?` 查询 `task_projection_ends` 计数恰为 1。该证据来自 `service.ts::worker` 调用 `host.worker` 前按实际入参写入的 admission，以及同一运行代的真实 Worker 投影完成 ack。它与页面成功结果和已应用的补丁共同验证实际执行链。
2. 用 UTF-8 SHA-256 对固定键序 `{tenant:p.owner,project:p.id,session:p.boundSession,sandbox:p.sandbox,volume:p.volume}` 的 JSON 摘要与 `admittedBindingDigest` 比对。成功只写一行 `{taskId:string,runId:string,sessionDigest:string,workspaceDigest:string,bindingDigest:string}`，sessionDigest 对 Session ID，workspaceDigest 对键序 `{sandbox,volume}` 的 JSON，bindingDigest 为已核对的 admission 摘要。失败只输出固定 stderr `WEB-A11 observation rejected`，退 1。必须在 finally 关闭 DB。观察器无写入或监听能力；阈值为业务 Run 数，projection 证据只证明相同代次完成 ack，无法据此统计宿主进程总启动次数。
3. 部署固定版本的脚本作为本轮私有只读挂载 `$BENTO_WEB_A11_ROOT/private/observe-web-a11.mjs`。测试运行在同一 Linux 的本轮源码目录。新增 `observeContinuation(taskId:string,runId:string)`，读取绝对路径 `BENTO_WEB_A11_ROOT`，由 Node `execFileSync('docker', args, {encoding:'utf8',cwd:join(root,'private/foundation'),timeout:10000,stdio:['ignore','pipe','pipe']})` 依次执行以下命令的固定参数，位置 ID 分别取两个正常 Run。调用失败时只报固定字符串，不能转发整条命令或 child stderr。

```sh
docker compose -p bento-a-web-a11 --env-file compose.env \
  -f compose.yaml -f web-core.yaml -f execution.yaml \
  exec -T orchestrator node "$BENTO_WEB_A11_ROOT/private/observe-web-a11.mjs"
```

在上述固定 argv 末尾追加 `taskId,runId`。解析每轮 stdout，校验对应 ID 与所有摘要均匹配 64 位小写 hex。两个 Run 的 Session、workspace 和 admission binding 摘要分别相等。记录脱敏断言，脚本与证据读回随本轮挂载和卷一起清理。

验证，从仓库根目录：

```sh
node --check deploy/orchestrator/observe-web-a11.mjs
pnpm check
git diff --check
```

PASS：语法与仓库检查通过，观察器只读取指定账本和对应 Run；真正绑定证据等 T3。STOP：生产需新增接口、写权限或部署包才能读回时交 MASTER。无远端写入需要回滚。提交边界：获准后一次 `Test(execution-service): 按续聊轮次核对真实派发绑定`，包含新观察器、spec 调用和 RUNBOOK 步骤变化。

## T3：实栈、撤场及证据归档

前置状态：T0 与 T2 已完成，A11 页面与幂等断言已提交，已重新登记并读回当前独占窗口的完整装配和按资源 ID 撤场入口。旧窗口的证据只证明准备路径可行。

允许修改：Readiness 与本 RUNBOOK；运行只触及 T0 登记的资源。

执行：

1. 从 Linux 的固定源码目录执行：

```sh
export BENTO_WEB_A11_ROOT="$HOME/.bento-web-a11"
cd "$BENTO_WEB_A11_ROOT/source"
unset BENTO_WEB_A13_LIST_ONLY
export BENTO_WEB_A13_STORAGE_STATE="$BENTO_WEB_A11_ROOT/browser/browser-state.json"
test "$(stat -c %a "$BENTO_WEB_A13_STORAGE_STATE")" = 600
export BENTO_WEB_A13_URL=https://bento-a11.test:18443
export NODE_EXTRA_CA_CERTS="$BENTO_WEB_A11_ROOT/private/foundation/tls/ca.crt"
export NODE_OPTIONS="--import=$BENTO_WEB_A11_ROOT/browser/resolve-a11.mjs"
export HOME="$BENTO_WEB_A11_ROOT/browser/home"
BENTO_WEB_A11=1 "$BENTO_WEB_A11_ROOT/tools/node_modules/.bin/pnpm" \
  --filter @bento/web exec playwright test --config playwright.web-a13.config.ts --workers=1
```

2. 成功后用 `python3 "$BENTO_WEB_A11_ROOT/private/probe-foundation.py" --readback` 回读本轮专用桶对象和未完成 multipart 为空。使用独立 SDK 与 Docker 对 本次验收记录的两个 Task 绑定核对 sandbox 与卷已回收，之后按 T0 的同一 Compose 项目和专属资源清单撤场，销毁本轮 realm 和凭据。若存在 pending/UNKNOWN，保留本轮 ID 与资源边界并冻结新增请求，禁止人工解除业务门禁。
3. [Readiness](../40-readiness/CURRENT-READINESS.md#web-07-分项证据) 的 WEB-07-02 验收齐备后改为「已实现」。记录实际日期、已验 SHA、窗口类别、真实浏览器与 Worker 断言及撤场结果。WEB-07 汇总保持「部分实现」，-04 与 -05～-10 仍待。保留 WEB-A11 -01/-03 旧证据，核对与 B 对应行独立。删除 RUNBOOK，无临时引用。

验证：实栈 1/1 且具备页面、幂等、结果及只读绑定的独立断言、T0 撤场完整结果，末尾 `git diff --check`、`pnpm format:check` 均退出 0。STOP：任一缺证，保留原步骤及实际证据。提交边界：获准后一次 `Docs(task-entry): 记录原任务真实续聊验收`，只含 Readiness 和 RUNBOOK 删除。发布遵从 [Commit Rules](../00-governance/COMMIT-RULES.md)、[PR Rules](../00-governance/PR-RULES.md)。

## WEB-07-02 规模核算

基线代码范围，空行和纯注释排除，行范围重叠按集合只计一次。表中仅首项拟修改，其余为正常入口与门禁、部署测试或回归所需核对。未计外部脚本、文档与预估新增行。

| 文件                                              | 符号或行范围                                                                               | LOC |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | --: |
| `apps/workspace/web/acceptance/web-a13.spec.ts`   | 15–339、368–371，结果常量、页面助手、真实前两轮、旧结果、context 清理                      | 310 |
| `apps/workspace/web/playwright.web-a13.config.ts` | 1–39，HTTPS/OIDC state 与 Chromium 配置                                                    |  36 |
| `apps/workspace/web/src/api.ts`                   | 337–381、399–405，`taskMutation/createTaskRun`                                             |  51 |
| `apps/workspace/web/src/pages.tsx`                | 1155–1176、1372–1412，页面提交与轮次选择                                                   |  63 |
| `apps/workspace/api/execution-service-http.ts`    | 78–101，`taskForward`                                                                      |  24 |
| `apps/orchestrator/execution-service/store.ts`    | 160–168、841–942、1217–1232、1627–1635、1754–1764、2268–2273，门禁、入队、游标、派发与绑定 | 144 |
| `apps/orchestrator/execution-service/service.ts`  | 720–749、1033–1053、1109–1133、1160–1191、1388–1452，`taskRunView/worker/finish/driveRun`  | 170 |
| `apps/workspace/web/e2e/task.spec.ts`             | 858–907、958–1007，页面续聊 mock 与旧结果                                                  |  97 |

合计 895 LOC，8 个基线文件。T2 新脚本及新增实现按 0 LOC 计。WEB-07-02 在独立拆出后满足 500 LOC 与 5 文件门槛。

## 后续 WEB-A12 审核边界

[WEB-07-04 与 -07～-10](../10-requirements/WEB-REQUIREMENTS.md#web-07-04-happy-path-用户安全重试) 共用同一失败轮次、受信停止证据与双检查点边界。待 -02 独立验收后另立 RUNBOOK。当前主线 `apps/orchestrator/execution-service/command-host.ts::commandHost` 无 `taskRecovery`，`service.ts::retryReason` 首先需要该能力和 StopProof，否则返回 stop_unconfirmed。实际 SDK 部署仍需审核受信 Host 模块如何确认旧 Worker 退出、撤权、没有 UNKNOWN、独占卷恢复及独立摘要读回，尤其不能把 local fixture 的恢复能力视为实际 OpenShell Host 能力。旧 A 失败锁和运行状态排除。候选证据只从当前主线源码及 Readiness 引用。

- **-04**：用专用新 Task 的首轮成功写持久标记。后续轮在本轮 Task/Run 定向证明 Workspace 部分写入、DSH 历史已追加，再诱发明确失败和已证实的旧代停止，避免引入取消依赖。正常页面点击「安全重试」「确认重试」。另证据分别记录该失败轮前的文件快照和 DSH Session checkpoint，与失败后两者均发生偏离的读回。按 attempt 捕获 Workspace ready receipt 与独立卷摘要、Session restore receipt 与历史摘要，之后才允许新 Run 的入队和 Worker 进入。新 Run 复用原 Task、原要求、原 Session/Workspace，retryOf 为失败 Run。成功改动仍在，失败侧部分文件与会话后缀均不进入重试的执行基线。202 receipt 含 attempt id 与预分配 runId；重投同一浏览器原无正文 POST 得 200，id/runId 固定，state 可从 preparing 前进到 queued。原失败 Run 与首轮结果从正常页面可查。两个恢复必须在实际 Worker 进入前可独立回读。
- **-07**：用另一个 Task 的单个已定向 UNKNOWN 操作，验证待核对页面、续聊不可提交和无安全重试入口。以同一已登录浏览器发真实 POST 负控，两个操作均拒绝；断言续聊 409 task_busy（needs_review 属于持久 pending Run）、retry 409 run_not_retryable / reason needs_review。以持久 Run、attempt、Worker 进入与操作执行次数为证，无新增且无重放。保留旧记录，结案走单独获审的可信入口。
- **-08**：只移除失败轮次 `task_run_checkpoints` 对应行，先证明 `history_checkpoints` 及可恢复历史仍有效。现有代码检测缺行；若要测工作区内容损坏，必须另补受理前对 workspace 解析/摘要检查，当前 `retryReason` 仅检查 workspace 行存在，损坏在 `verifiedStopProof` 才发现。正常页面禁用，同认证直投 409 checkpoint_unavailable，无 attempt、卷和 Session 变化。
- **-09**：另一个 Task 只移除失败 Run 对应 Session 检查点，工作区原 checkpoint 校验仍通过。相同页面、HTTP 与无 attempt/卷/Session 变化断言，故障目标按真实绑定区分。
- **-10**：两独立 Task 分别测试 Workspace 和 Session 变体。用受审屏障在 attempt 提交并返回 202 后、恢复任何写之前，只移除该轮目标 checkpoint，再释放屏障。原尝试仍可查，预分配 Run 不存在，attempt=blocked / lastConfirmedPhase=preparing，卷和 Session 摘要与故障前相同。第二次同键同路径无正文 POST 返回 200，id/runId 不变、state=blocked。无后续执行、重复恢复或队列写入。门禁继续持有，撤场须经可信结案及本轮资源清理。生产 command host 缺结案观察能力同样需 T0 解决。
- **-05/-06**：本设计用明确失败作 -04 正例，取消链路可独立验收，暂缓两项。正式要求安全重试开放前通过适用 Bad Case，MASTER 须确认启用覆盖及剩余边界。WEB-A12 与 WEB-07 汇总保留部分实现。-04、-07、-08、-09、-10 各在真实证据齐备后单独更新对应行。-10 所有选定变体通过且已确认撤场才收口。

后续定位：`service.ts::retryReason/verifiedStopProof/advanceTaskRetry/verifyRestoredTask`、`store.ts::acceptTaskRetry/advanceTaskRetry/finalizeTaskRetry/taskCheckpoint`、`command-host.ts::commandHost`、`service.test.ts` 的 “SDK evidence does not enable Task retry without trusted workspace recovery”、“private Task HTTP preserves earlier results across a fenced retry” 和 “Task retry blocks when its history checkpoint disappears before workspace restore”，以及 `apps/orchestrator/openshell/remote-session.test.ts` 的 “a verified retry restores the checkpoint prefix and reopens with its original receipt”。候选只列入口与断言，真实注入、恢复屏障和结案前置未就绪，不能执行。

## 与 B 协调

B 负责 WEB-03-02/-06/-07。当前 -02 仅验收代码和 Readiness，正常续聊经过 `Store.taskWriteGuard` 与 source/file hold，且 T0 账号撤场涉及持久门禁。若 B 改 `Store.enqueueTaskRun/taskWriteGuard/acquireTaskInputDeleteHold`、source deletion/purge 或私有 Task forward，MASTER 应冻结候选版本并指定合入顺序，新基线复验续聊与删除互斥、账号清理，Readiness 对应行合并核对。后续 -04 和 -10 涉及 attempt 持有/转移门禁，需额外验证 `acceptTaskRetry/finalizeTaskRetry`、blocked 结案释放以及 B 删除/purge 的事务交叉。A 不修改 B 的工作区或文件删除行为。
