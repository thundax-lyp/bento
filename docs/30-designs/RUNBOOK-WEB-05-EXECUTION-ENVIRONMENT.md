# WEB-05 执行环境验收 RUNBOOK

## 状态与授权

2026-11-17，交审草稿，审计结论 **Not Executable**。B checkout 的 main、origin/main 与远端 main 在本次核对时均为 `646d11a95b12ae89f9952f9c1f13b4ffa3fcdada`，目标 main 无开放 PR。T0 由作者与 MASTER 关闭。T0 完成、MASTER 审核对应文档指纹并派发后，方可建立实施分支。T1 至 T6 为待审核计划，实施前需复验 T0 的运行时租约及独立审计指纹。

执行者按顺序执行单个步骤，每步最多涉及 10 个文件（含本 RUNBOOK 和专门核对的文件）。PASS 后删本步、修正后续前置状态并提交。STOP 时保留现场，回报最后通过步骤及提交、失败符号、最小复现、脱敏结果和缺少的决定。保留 A 的真实上传优先窗口。A 先合涉及 Readiness、集成入口及共享文件的改动，B 同步并复验受影响入口。涉及共享机器重启、同租约、账号、桶对象或全局 OpenShell 配置时交 MASTER 排期。

## 交付与断点

从正式受邀注册的空账号发起空白任务，在真实 OpenShell 中执行，关闭页面后用原账号找回结果。保留原地址、原输入和原版本重准备的路径，验证丢失回执及变更后另建。用最小文件快照确认提交后版本冻结，并用同一任务续写和独立任务读取确认隔离，检查公共页面、事件、结果、补丁及脱敏运行记录无平台密钥值。依据 [WEB-05、WEB-A06、WEB-A07 与 WEB-A11](../10-requirements/WEB-REQUIREMENTS.md)、[Task 接口](../20-interfaces/WEB-INTERFACE.md#task-生命周期--目标契约)、[Web 设计](./WEB-DESIGN.md#现有项目入口)、[应用架构](../00-governance/ARCHITECTURE.md)及 [Readiness](../40-readiness/CURRENT-READINESS.md)。

- 当前已具备空白提交、Task 冻结版本、原址重准备及独立绑定。失败详情的原址重准备控件旁缺少说明和确认另建的入口。全局新建表单可创建空白任务，来源项目可按现有选文件流程另建。把两者接到失败详情的确认流程属于本次唯一已确认的公开 UI 改动。
- 启动时验证部署版本与可信 host 版本一致。仓库内 `commandHost` 把已冻结版本传给控制命令并核对回执，B 的私有 daemon 已查明只支持当前环境版本，镜像和策略引用固定。此前的 WEB-A13 证明受控版本下的结果发布、同 Session 续写及新 Task 读原快照，未覆盖旧版跨轮换后首次准备、原址故障修复、空账号起步及本轮密钥扫描。私有 Worker 仅验证过 A13 范围，尚未证明能执行 WEB-05 空白和隔离场景。
- Web 设计「现有项目入口」的总述仍将沙盒准备和续聊列为目标。本文以正式 WEB-05 要求和 Task 接口确定行为，以实际源码和 Readiness 确定实现覆盖。
- 本轮在基线复验双 HTTP WEB-A07 1/1、启动/适配器版本门禁 2/2、Chromium Task routes 1/1。浏览器重准备使用模拟响应。真实 A13 配置 list-only 枚举 1 项，真实执行证据来自 Readiness 的 `36ab687` 与私有 Worker。实机证据和本地不同入口分别记录。

文件快照业务整体、WEB-06/07 的故障与安全重试验收、Worker 迁移、通用版本平台、公共 API 扩展、数据库迁移、fixture 扩建均不在范围内。现有 Checkpoint、取消、恢复及结果存储契约在本 RUNBOOK 中不适用变更。

## 契约和不变量

- React `pages.tsx::TaskComposer/TaskDetailsContent` 经 `api.ts::createTask/createTaskRun/prepareTask` 调用 Workspace API。创建正文为必填 `{name:string,source:{kind:"blank"}|{kind:"space_snapshot",spaceId:string,fileIds:string[]}}`。续写正文为必填 `{prompt:string}`。创建和发送使用客户端存于 sessionStorage 的 UUID 提交键，超时及非 4xx 保留，同页相同提交复用。准备 POST 正文与键均缺省。
- `server.ts::taskEntryServer` 从账号会话决定 owner。空白的内部 `id/sourceSpaceId` 均为 null，`inputFiles:[]`、`inputManifest:[]`、`inputDigest=SHA256("[]")`（小写 hex，无前缀）。快照由 `space-execution.ts::createTask/reconcileTask/advanceTask` 持久化意图、冻结文件及清单，再使用同一键提交。文件元素为必填 `{path:string,text:string}`，清单元素为必填 `{fileId:string,path:string,bytes:number,sha256:string}`。
- `http.ts::handleTasks` 与 `store.ts::Store.createTask/prepareTask` 持有权威状态。创建首写冻结 `environmentVersion:string`，空白 ID 由 Store 分配，快照 ID 由 Space 意图分配。Store 在一个事务保存 Task 和 owner/key receipt，哈希取名称、来源 ID、排序后的清单和输入摘要。同键同哈希返回原 Task（202 首次、200 重放），异哈希为 409 `idempotency_conflict`。准备以同 Task 的失败状态条件转 preparing，返回 200 `{task}`，preparing/ready 重放回现态。原输入、版本、Task ID 不变。对外通过既有 DTO 暴露 `status`、`environmentVersion`、`inputDigest` 及可空 `prepareError`，不返回输入原文、控制器原始错误或凭据。Run 提交另有原键与 receipt，首受理和重放必须只产生同一 Run。
- `types.ts::executionEnvironmentVersion` 对固定字段序 `JSON.stringify({imageDigest,policyDigest})` 做 SHA-256 并加 `sha256:`。两项来自可信部署且格式为 `sha256:<64 lowercase hex>`。`start.ts::main` 在打开数据库、监听前拒绝错配。可信 `provisionTask(binding,files,environmentVersion)` 按冻结版本选择配置，返回 `Observation & {environmentVersion:string}`。`service.ts::importProject` 检查版本、快照、独立 binding，成功后 ready，失败保存脱敏 `preparation_failed`。轮换只影响新受理 Task，历史版本无法准备时明确失败，保留原记录。恢复靠原 durable receipt 和冻结字节。原绑定及用户结果持续可读。无需新增事件、outbox 或 receipt。
- Worker 的命令和文件操作限定在授权 Run 绑定的 OpenShell Session/Workspace。同一任务后续 Run 复用绑定，独立 Task 的 Session、sandbox、volume 均不同。平台密钥只在需要的受信阶段可用；扫描输出仅含匹配计数和表面类别。

## 基线代码计数

下表为必需的现有实现路径和测试代码，非预计 diff。逐个范围计非空非纯注释行，同文件内无重叠。未采用与本次无关的文件 CRUD、大段故障恢复或相邻需求的全部测试。

| 文件                                                  | 基线行范围                        |  LOC |
| ----------------------------------------------------- | --------------------------------- | ---: |
| `apps/workspace/web/src/pages.tsx`                    | 1069–1112、1257–1312              |   99 |
| `apps/workspace/web/src/api.ts`                       | 330–398、407–408                  |   70 |
| `apps/workspace/api/server.ts`                        | 340–416                           |   77 |
| `apps/workspace/api/space-execution.ts`               | 586–638                           |   51 |
| `apps/orchestrator/execution-service/http.ts`         | 127–196、313–337                  |   94 |
| `apps/orchestrator/execution-service/store.ts`        | 736–837、1593–1616                |  126 |
| `apps/orchestrator/execution-service/service.ts`      | 1233–1280                         |   46 |
| `apps/orchestrator/execution-service/command-host.ts` | 86–166                            |   81 |
| `apps/workspace/web/e2e/task.spec.ts`                 | 1033–1047                         |   13 |
| `apps/workspace/web/acceptance/web-a13.spec.ts`       | 34–156、249–277、283–308、336–365 |  195 |
| `apps/workspace/api/space-files.test.ts`              | 1370–1446                         |   73 |
| `apps/orchestrator/execution-service/service.test.ts` | 3816–3919                         |  103 |
| 合计                                                  | 12 文件                           | 1028 |

## T0：审核并锁定 B 独占实机前置

前置状态：仅调查，B 内没有本地 ENVIRONMENTS.md，已按派工核对 MASTER 本地说明相关章节。

允许修改：本 RUNBOOK。

禁止修改：任何远端状态、生产代码、环境和用户文件。

执行：

1. 对 B 独占 Compose 和原 A13 留档做只读对账。上一聊天的只读记录已核实租约 manifest、完整栈目录、两份 SQLite 存在。七个应用容器退出，专用 S3 在运行，五个项目标记卷及一个项目标记网络存在。MySQL、PostgreSQL 与 S3 挂项目专用卷，Web 有独占命名桶引用、HTTPS S3 配置和 issuer 配置，Orchestrator 有只读 host JSON（镜像/策略摘要格式有效）及 Gateway 挂载。仅从 issuer 存在无法确认 realm owner。桶内 prefix、当前对象权限和短期凭据、OpenShell 运行可用性未实测。
2. 查对私有控制命令实际 `provisionTask` 的版本选择和回执来源。已定位实际控制 daemon、现有镜像和策略。按下方最小接线固定两个可信候选的不可变引用、实际装载观察、历史版本选择和仅作用于 B 的故障入口。
3. 找到 A13 认证、浏览器和 Worker 脱敏扫描的固定启动/停止入口。确认可注册的新受邀账号、授权独占时间窗、可安全使用的独立数据目录及私有桶前缀、匹配 OpenShell 资源，以及可执行最小字节探针的现有 Worker/受信验证工具。A13 旧账号和留证数据库不得作为新账号空状态。A13 定制工具只支持其特定场景时，先核实已有原生命令/文件工具接线；有缺口时固定最小接线，交由 MASTER 审核。
4. 作者锁定私有清单及 runner 的内容 SHA，记录命令、参数名、步骤、预期结果、正反控制与回滚。固定 B 的资源归属和数据留存范围。审计者只看布尔、计数及非秘密摘要。实机配置及原始输出留在受控区。

验证：比对当前 `git rev-parse HEAD`、`git ls-remote origin refs/heads/main`、`gh pr list --state open --base main`，依上述项目标记做只读容器和挂载核验。T0 复核版须附可机械执行的私有事实回读命令。

本次回读确认 B 本地留存六套历史清单。已通过本地登记配置和历史 SSH 入口只读回读 Docker 挂载，B 的控制适配器只读挂载唯一匹配，Compose 目录和 host 配置存在，host 配置有一对有效摘要。历史 helper 默认依赖的 `HANDOFF.md` 已不存在，本次由唯一匹配的挂载定位 B。探针只返回存在性、计数及源码指纹。下列入口仅用来定位可复用的已归档行为。按目录执行 `shasum -a 256 -c SHA256SUMS`，依次通过 9、11、6、3、9、10 项。校验只证明留档完整，实际资源、授权与本轮入口仍需逐项锁定。

| 相对 checkout 的私有目录               | 已查实的历史入口                                                                                                         | WEB-05 仍需固定                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `debug-workspace/web08-acceptance`     | `acceptance.sh`、`start-web-localhost.sh`、`check-bound-env.py`、`archive-revoked.py`                                    | 绑定本轮独占租约的前置回读、启动及清理 runner。清理需要逐项列出停止与保留的资源，覆盖失败路径。    |
| `debug-workspace/web08-stack/a13`      | `auth-probe.cjs`、`run-live-a13.sh`                                                                                      | 本轮独占 realm 归属证明、一次新邀请及正常登记入口。新 storage state 由 runner 创建并放在受控目录。 |
| `debug-workspace/web08-stack/compose`  | `start-seven.sh`、`stack-health.py`、`stack-preflight.mjs`                                                               | 同一 B 部署的发布与恢复命令，证明 SQLite、项目文件及已有 sandbox 的持久状态一致。                  |
| `debug-workspace/web08-stack/keycloak` | `realm-candidate.py`、`probe-oidc.py`                                                                                    | 独占 realm 和正常邀请的本轮验证入口。                                                              |
| `debug-workspace/web08-sts-r2`         | `stage-renewal.sh`、STS 源码及测试                                                                                       | 本轮独占 prefix、短时授权的正反控制及撤销证明。                                                    |
| `debug-workspace/web08-worker-runtime` | `entry.a13.ts`、`web-a13-tools.ts::registerWebA13Tools`，历史工具注册 `bento_workspace_read` 和 `bento_workspace_append` | 支持空白、快照和命令/文件实测的可信工具及脱敏扫描入口。                                            |

只读结论：唯一 B Compose 项目有 8 个容器。私有 `web08-control.mjs` 将请求转发给 `control/control.sock`，接收方是租约根目录的 `host-daemon.mjs::broker/volumeAction`（原 SHA-256 `816ca2d3dffc9c2219d945a8ad97bcabbebf94e2912eba1e318b57a90e8e1438`）。CLI 的 `sandbox create --from/--policy`、`sandbox get --policy-only`、`policy get --full` 均已回读帮助。原 runtime 在 Docker 本地，无 RepoDigest；旧配置的 imageDigest 等于 Docker Image ID，policyDigest 等于原策略文件字节的 SHA-256。当前 `provisionTask` 仅接受默认版本，`boundContainer` 比较实际容器镜像 ID 和绑定。原 daemon 和发布材料均可复用。

B 入口固定为本地登记环境加 `debug-workspace/web08-ssh.py` 的鉴权路径（源 SHA-256 `ea77fee0f2186ad1b32825b3a66d57cb63e062bb274ccacf2fcec74e8de73246`）。仅以只读 Docker inspect 中唯一的 `/app/private/web08-control.mjs` 挂载定位远端租约根，再用 `web08-manifest.json` 及 Compose 标签复核所有权。T0 从该租约的 `web-a13/full-stack` 留档读取启动材料，不使用已撤销的 `web-a13/stack.env`。历史启动、邀请探测、短时授权与关闭入口以表中的目录及其 `SHA256SUMS` 为准。经核对，历史入口 `acceptance.sh` 的 SHA-256 为 `db428964c5555c52eaedef9faa66793c43014f83e8bdcd3c1b0355a9b6601e1a`；Compose 用 `start-seven.sh --approved-live` 的既有参数组合，浏览器使用 A13 的认证及 Chromium 启动路径。旧脚本仅作只读复制来源。隔离副本固定放在已核对租约根的 `web05`，现有 host 材料的派生发行包放在 `release/web05`。本轮唯一 runner 为 `web05/acceptance/run.sh`，与其不可变脚本、私有候选源码、Compose 覆盖的指纹写入同目录 `SHA256SUMS`。可变控制文件和凭据不记入清单，T4 固定后，T5/T6 从租约根以 `sha256sum -c web05/acceptance/SHA256SUMS` 回读，摘要与审核记录不符即 STOP。租约 ID、项目名、Gateway scope、队列、issuer、桶前缀和实时镜像摘要一律从受控入口运行时回读。

PASS：唯一 B 租约和隔离归属匹配，正常邀请与短时授权入口可定位，旧 A13 资源没有被引用为本轮状态。T0 到此只读。

STOP：任何归属、授权、指纹或入口无法复核。当前唯一未能查实的是新建测试沙盒的有效策略 YAML 是否可按下文选定的结构比较规则和发行策略精确对账；只读已确认 CLI 输出契约，需 T3 在隔离副本验证真实载荷。

私有命令的工作目录统一为 B 租约根目录。仓库命令从绑定 checkout 执行。所有 T0 复制来源只读。发布包保留 T2/T3 的材料与校验命令；T4 文件仅保留在私有验收副本。原 WEB-A13 文件、配置、沙盒和库保持原状。新文件计入所属步骤，因当前尚无代码，新增 LOC 在该步提交前据实回读。已有 12 个公开代码文件、1028 LOC 满足基线门槛。私有和附加基线核对范围：T3 原 `host-daemon.mjs::boundContainer/volumeAction` 汇集原文件第 241–260、302–375 行，共 94 个物理行；T4 `service.ts::work` 第 1472–1509 行、`store.ts::dispatchSnapshot/dispatchReserved/schedulableRuns` 第 2184–2249 行，共 96 个非空非注释行；准备故障直接复核第 1233–1280 行的 46 LOC，已计入基线，不重复计。这些附加行未计入 1028 LOC；待实现私有源码的非空、非纯注释行逐个路径记录。

## T1：在原失败详情确认另建

前置状态：T0 PASS，当前基线复验成功，共享顺序由 MASTER 确认。

允许修改：`apps/workspace/web/src/pages.tsx`、`apps/workspace/web/e2e/task.spec.ts`、本 RUNBOOK。

禁止修改：Workspace API、Task 路由契约、提交键与模式、任务列表及详情历史行为。

执行：

1. 复查 A 的合并状态。若 A 已先合，先同步 B 的 main 并复验受影响的现有入口，按新基线回读文件及行数。若验收入口、共享文件或 T0 私有配置变动，先将新基线和草稿 SHA-256 交 MASTER 复审。获派发后从批准的基线建立实施分支。只暂存已审核的 RUNBOOK 并单独提交。用 `git show --format= --name-only HEAD` 核对该提交仅包含本文件，用 `git show HEAD:docs/30-designs/RUNBOOK-WEB-05-EXECUTION-ENVIRONMENT.md | shasum -a 256` 核对提交内容与审计指纹一致；任何不符即 STOP。若 A 在分支建立后先合，则在触及共享文件前同步 A 的合并提交并复审受影响边界。
2. 在 `TaskDetailsContent` 新增 `const [confirmNewTask, setConfirmNewTask] = useState(false)`。在现有失败准备 section 的重准备按钮下新增 type=button「更换输入或环境，另建任务」，以现有 `!mutable || pending` 为禁用条件，点击显示「另建任务将使用重新选择的输入和当前运行环境，原任务及失败记录会保留。」以及「确认另建」「返回」。返回关闭确认并留原址。确认是 Link，空白前往 `/`，快照前往现有 `/space/` 加编码后的 sourceSpaceId。只有已有目的地表单的提交操作发 POST。确认区域只在失败且 `mutable && !pending` 时可用。保留既有重准备动作。
3. 在 `task.spec.ts` 的 Task routes 用例的原 snapshot 重准备之前，断言另建入口先显示确认；点击返回后仍原 URL、Task 数不变、原有失败提示仍在。再打开并确认快照入口的 href 等于原来源项目路径，原址的重准备仍返回同 Task。真实流程走确认链接和正式表单，由 T6 核对原失败记录。

验证：

```bash
pnpm --filter @bento/web exec playwright test task.spec.ts -g 'Task routes retain idempotency'
pnpm --filter @bento/web typecheck
```

PASS：focused Chromium 1 项通过，类型检查退出 0，确认和返回均没有提前创建，原址重准备仍通过。

STOP：任一断言不符或来源路由需要契约变化，保留 diff 并交作者复核。

## T2：构建两版可重复发行构件

前置状态：T0 和 T1 PASS，MASTER 独立审计并派发，已单独提交并回读批准稿。A 的共享顺序已确认。

允许修改（8 个文件）：`release/web05/Dockerfile`、`release/web05/policy-old.yaml`、`release/web05/policy-new.yaml`、`release/web05/build.sh`、`release/web05/versions.json`、原 `plugin/deploy/openshell/policy.yaml`（只读）、原 `web08-manifest.json`（只读）、本 RUNBOOK。

禁止修改：原镜像引用、原策略和 A13 运行状态。

执行：`build.sh` 从原 manifest 的 runtime 读取并核对本地 Docker Image ID，以 B 专用 tag 引用该基底。Dockerfile 仅增加合成文本 `/opt/bento-web05-version` 和 `/opt/bento-web05-policy/probe.txt`，继承原入口、用户和依赖。旧策略复制原文件；新版仅在 `filesystem_policy.read_only` 增加 `/opt/bento-web05-policy`。以原 ID 和新 `docker image inspect .Id`、两份策略文件 SHA-256 生成两条 `{environmentVersion,runtimeRef,imageDigest,policyPath,policyDigest}`，版本按公开契约派生。这里的 imageDigest 是 Docker 镜像配置 ID。OCI manifest digest 如存在仅记录来源。

验证：

```bash
bash release/web05/build.sh build
bash release/web05/build.sh verify
```

PASS：验证两个 ID 及两个策略摘要各自不同，引用解析到记录的 ID，策略只新增一个允许读取的路径。发布包可重复验证。

STOP：基底不符、结构差异超出一项或摘要对不上。用 `bash release/web05/build.sh undo` 只回收本步骤新增、未被容器引用的 tag 和生成清单，保留 B 原镜像和产物证据。

## T3：在现有 host adapter 接入两版

前置状态：T2 PASS，隔离副本的专用 Gateway 与控制入口可用。

允许修改（10 个文件）：原 `host-daemon.mjs`（只读）、原 `host-probe.mjs`（只读）、`release/web05/versions.json`（只读）、`release/web05/host-daemon.mjs`、`release/web05/host-probe.mjs`、`release/web05/host-adapter.sh`、隔离副本 `web05/compose.adapter.yaml`、`web05/host.json`、`web05/stack.env`、本 RUNBOOK。

禁止修改：公开协议、原 A13 ledger、沙盒、数据库、镜像与 daemon 文件。

执行：`host-daemon.mjs::volumeAction` 在资源变更前核验恰好两条不同版本的配置、策略文件摘要、镜像引用与 ID，且默认版本命中其中一条。原 `provision` 使用默认，`provisionTask` 只使用请求的冻结版本。沿用原卷、seed、CLI 创建与绑定检查，用选中引用替换固定镜像和策略。可信 `boundContainer` 以容器 `Image` 校验实际镜像 ID，按已验证绑定的 sandbox 名称在同一个 B Gateway 与 workspace 执行 `cli/openshell sandbox get "$sandbox" --policy-only`，读取活跃策略 YAML。受信探针把观察值与发行文件作为 YAML 单文档解析，拒绝重复键和其它文档，递归排序对象键、保留列表顺序，再比较 JSON 结构。引用文件字节的 SHA-256 仍负责版本派生。任何字段差异均失败；T3 不猜测字段或丢弃额外项。保留现有 binding ledger，仅在新记录增加 `environmentVersion`，因为后续 snapshot/start/stop/purge 必须检查原容器镜像。旧 A13 ledger 不挂载到副本。

未知版本、损坏配置或不一致 ledger 在改变资源前拒绝。实际镜像或生效策略不符时拒绝 ready 回执和正常执行，仅清理本次新建且通过 ownership 校验的沙盒、卷和 creating 记录；已有记录只告警并保留现场。对外沿用脱敏 `preparation_failed`。所有失败验证都检查版本或原始错误没有泄漏。

安装：`host-adapter.sh install` 以旧版初始化副本 `web05/host.json` 的 `imageDigest/policyDigest` 和 `web05/stack.env` 的 `BENTO_EXECUTION_ENVIRONMENT_VERSION`；`compose.adapter.yaml` 只读挂载该 JSON 到现有容器路径，并复用 B 的控制 socket 与 Worker 启动方式。

验证：

```bash
bash release/web05/host-adapter.sh install
bash release/web05/host-adapter.sh probe
```

PASS：复用专用 OpenShell，验证两版、未知版本、损坏配置、绑定记录损坏、镜像与策略错配、原版本重放。用同一新版镜像分别加载旧、新策略，经 `sandbox exec` 验证合成路径分别拒绝与允许；OpenShell 策略回读与发行材料对账通过。脚本只输出布尔、计数及非秘密摘要。

STOP：观察读不到、错配仍返回 ready，或清理所有权不明。用 `bash release/web05/host-adapter.sh undo` 停副本 adapter、解除本轮挂载并只清理本步标记的独占探针；状态不明时保留并复核。

## T4：固定 B 私有排队、故障和生命周期控制

前置状态：T3 PASS，T0 私有租约和凭据入口已签核。

允许修改（10 个文件）：`web05/acceptance/SHA256SUMS`、`web05/acceptance/service.ts`、`web05/acceptance/compose.yaml`、`web05/acceptance/control.json`、`web05/acceptance/worker-probe.ts`、`web05/acceptance/run.sh`、`web05/acceptance/probe.mjs`、仓库 `service.ts`、`store.ts`（后二者只读）、本 RUNBOOK。

禁止修改：T3 发布包、生产代码和原 A13 部署。

执行：

1. `run.sh hold <task-id>` 在提交 Run 前写入目标，`run.sh release <task-id> <run-id>` 核对同 Task、同 Run、仍为 `queued` 且无 reservation 后清除它。私有 `service.ts` 的两处 `db.dispatchSnapshot(slots)` 使用同一规则过滤 `queued`：以 `db.findRun(id).projectId` 匹配目标 Task，保留其它候选和 occupied 槽位。损坏控制 JSON 时停止验收。验收不使用槽位饱和模拟。
2. `run.sh fail-prepare <owner-id> <unique-task-name>` 在首次提交前设置准备故障。私有 `service.ts::importProject` 在现有 try 内、host 变更前对该账号及名称失败。首次响应后 `run.sh bind-prepare <task-id>` 从只读 SQLite 核对同账号及名称并固定 ID，`run.sh clear-prepare <task-id>` 核对后解除；同一名称无并行创建。活跃探针用 `run.sh active-pause <task-id>` 在提交前设目标，Worker 工具在第一笔沙盒探针写入前等待匹配。浏览器关闭后用 `run.sh active-release <task-id> <run-id>` 在核对该 Run 已实际进入探针且仍 `running` 后放行。
3. `web05/acceptance/control.json` 固定为 `{heldTaskId:null|string,prepareFailure:null|{ownerId:string,taskName:string,taskId:null|string},activePause:null|{taskId:string}}`。B 租约操作账号独占写入，0600；通过同一 UID 或只读同 UID 挂载供私有服务及 Worker 闸点读取。runner 复用租约根的 `.acceptance.lock`，对配置校验后在同目录写临时文件并原子替换，不向浏览器或沙盒暴露控制文件。Worker 探针只从现有受信 launcher 得到本 Run 的等待决定。
4. `run.sh observe <task-id> <run-id>` 只输出匹配状态、计数和非秘密摘要。T4 以固定输入核验控制及探针，首次实机 `rotate` 在 T6 执行。

验证：

```bash
bash web05/acceptance/run.sh probe
```

PASS：固定输入下目标可保持、解除并以同 ID 领取；未持有的对照 Task 可继续领取；准备故障限目标且解除后原 Task 可继续；活跃探针及泄露正控制通过。配置和 runner 指纹固定。

STOP：出现提前 reservation、实例重叠、库或队列改变、目标和对照无法区分、探针无法观察实际沙盒。执行 `bash web05/acceptance/run.sh cleanup` 回收该次专用探针、临时授权与副本服务，保留证据和状态不明的 Run。

## T5：固定真实验收脚本与控制面探针

前置状态：T0 至 T4 PASS，固定私有 runner 和浏览器入口已回读。

允许修改：新增 `apps/workspace/web/acceptance/web-05-environment.spec.ts`，在 `public-files.json` 中紧接 WEB-A13 spec 登记新文件，再更新本 RUNBOOK。复用现有 A13 的隔离 HTTPS 配置与结果读取路径。T0 须固定必要私有接线的文件和命令。

T5 当前专门核对 6 个公开文件（待增 spec、`public-files.json`、本 RUNBOOK、`apps/workspace/web/playwright.web-a13.config.ts`、`apps/workspace/web/acceptance/web-a13.spec.ts`、`apps/workspace/web/src/pages.tsx`）。前三个为产物，后三个只读核对入口。T5 实际只读的私有文件为 `web05/acceptance/run.sh`、`web05/acceptance/SHA256SUMS`，加上上述公开文件共 8 个。Chromium spec 通过 runner 调用上述控制命令，读取浏览器正常接口、页面和下载结果，以及 runner 脱敏观测。控制文件、原始凭据和 SQLite 由受信侧读取。

禁止修改：A13 断言、公共部署默认、文件快照实现、Service Store 或公共 DTO。

执行：

1. 场景名固定为 `WEB-05 real execution environment`。从邀请登记的新账号 storage state 起步，先断言任务和项目列表为空。用主页空白表单提交。以浏览器拦截单次成功响应为准，只丢向浏览器的回执，后端实际受理。在原页同正文重按提交，记录 UUID 键相同、首个 202、重放 200、原 Task ID 和版本相同。对首 Run 同样丢一次回执并同键重试，查询原 Task 的 Run 列表确认为一条，执行探针标记只写一次。确认原 Run 的公开状态是 `running`，先由可信探针保持该 Run 活跃，再关闭页面。关闭后释放探针，在浏览器关闭期间通过受信侧等待原 Run ID 进入成功终态。随后用同一账号的新上下文从 `/runs` 找回原地址，读取同一 Run 的结果和补丁；确认仅一条 Run，标记仅写一次。
2. 另建受控失败 Task，故障只作用于 B 的目标准备请求。确认显示脱敏失败，恢复后在原 URL 并发调用两次 prepare（空正文无键），核对只有一次实际重准备、原 ID/inputDigest/version 不变，随后可执行。随后按 A13 的正常入口新建项目并上传首个路径。在旧默认下以该路径创建快照并制造失败 Task。保存原 URL、Task ID、输入摘要、版本和公开失败码。保留该 Task，在步骤 3 的唯一一次轮换后继续确认另建及回读。Web 新建请求无可覆盖版本字段。
3. 使用步骤 2 的同一个项目及旧默认，复用 A13 的正常项目文件选择流程创建另一 Task，记录第一个路径、内容摘要和实际环境。调用 T4 的 `hold` 保持领取前状态，提交 Run，核对原 Run ID 已持久排队。排队后在该项目页用「文件」选择内容和路径均不同的第二个文件，点击「确认上传」，观察完成后重新打开项目核对新增路径。通过固定发布入口切至新版，保留同部署数据库、项目对象和已有绑定，回读原 Run 仍排队、ID 未变。释放同一 Run，核对其实际沙盒内读取到冻结字节、第二个路径缺失、命令和文件操作均发生在分配的沙盒。由受信观察核对镜像 digest 与实际生效策略 digest 为旧版，并据此计算实际环境版本，与 Task 冻结值一致。API 或控制命令中的版本回显只用于对账。随后在旧 Task 上续写，核对原 Session、sandbox、volume。在原失败详情确认另建，进入正式项目选文件表单，选择两个路径并提交。核对新 Task ID、新输入摘要和新版本，从受信侧核对该 Task 的实际镜像和策略为新版，且看不到旧 Task 未交付写入、绑定独立。回读原失败 URL，确认旧 Task 仍为准备失败且原 ID、输入摘要、环境版本及公开失败码一致。完成回读后恢复单 Task 准备故障，从原地址重准备，核对原输入与版本及实际镜像和策略均为旧版。完成两组断言只切换一次默认版本。
4. 将受控合成标记用于披露扫描的正控制，证明扫描器能发现注入的明文样本。真实密钥值仅由私有扫描程序从受信材料读取，浏览器 DOM/接口、公开消息和事件、摘要、检查、补丁及受控范围运行记录匹配数均为 0。沙盒进程中探测凭据变量时只返回是否存在。失败输出避免原值和原始日志。

验证：

```bash
BENTO_WEB_A13_LIST_ONLY=1 pnpm --filter @bento/web exec playwright test --config playwright.web-a13.config.ts --list acceptance/web-05-environment.spec.ts
pnpm --filter @bento/web typecheck
```

PASS：精确列出新增 Chromium 场景 1 项，类型通过，私有 runner 的版本/失败切换和泄露正控制通过 T4 的预检。

STOP：必须增加公共协议、改 A13 语义或授权不明确。保留原 fixture 和现场，回交作者。

## T6：真实验收、全量校验与 Readiness 收口

前置状态：T0 至 T5 PASS，B 独占窗口与脚本指纹复核成功。

允许修改：[Readiness](../40-readiness/CURRENT-READINESS.md) 的 WEB-05 一行、本 RUNBOOK、隔离副本的 `web05/host.json` 和 `web05/stack.env`。另只读核对 `web05/acceptance/run.sh`、`web05/acceptance/probe.mjs`、`web05/acceptance/compose.yaml`、`release/web05/versions.json`、`apps/workspace/web/acceptance/web-05-environment.spec.ts`，共 9 个文件。实机仅使用 T0 审核后的副本资源。

禁止修改：A 的资源、A13 留档和本需求以外的 Readiness 结论。

执行：

1. 用 T4 锁定的 `run.sh verify` 启动正式 Web、Orchestrator、认证、存储和 OpenShell。使用正常邀请路径生成受控 storage state，运行唯一真实场景，记录启动指纹及各断言结果。runner 内固定使用 `pnpm --filter @bento/web exec playwright test --config playwright.web-a13.config.ts --workers=1 acceptance/web-05-environment.spec.ts`。真实模式禁用重试、截图、视频、trace 和不必要的日志。
2. 在 T5 场景指定的轮换点首次实机执行 `run.sh rotate <task-id> <run-id>`。核对目标处于 hold、原 Run 为 `queued` 且无 `run_dispatches` 记录。停止并等待唯一旧 Orchestrator 退出。在停机窗口原子更换 `web05/host.json` 的 `imageDigest/policyDigest` 和 `web05/stack.env` 的 `BENTO_EXECUTION_ENVIRONMENT_VERSION`，启动前重算并对账。复用原 B 隔离副本的同一 Compose 项目与参数，执行 `up -d --no-deps --force-recreate orchestrator` 只重建 Orchestrator，使单文件 bind mount 指向新 inode。确认只有一个运行中的实例，从容器内读回已挂载 JSON 的两个摘要及容器环境版本，与新版记录核对，只输出匹配结果。保持同一业务库、authority 库、Temporal namespace/task queue、Gateway、对象、控制文件与绑定。确认同一 Run 仍排队且无 reservation，再 release，核对领取的是同一 Run。
3. 实机结束或失败时执行 `bash web05/acceptance/run.sh cleanup`，按 T0 固定范围停止本轮传输和服务，回收临时授权，按资源清单核对新沙盒，保留旧 A13 及本轮排障证据。状态不明的 Run 保留现场，避免更换任务或重发写入遮盖失败。
4. 所有真实断言通过后将 WEB-05 改为「已实现」，记录日期、候选版本、真实验证范围、结果与未覆盖项。长期配置行为仍引用现有 Task 接口及部署说明。删除本 RUNBOOK 及仅指向它的引用，再运行最终验证。全部通过后按 WORKER/PR 规则交付。若最终验证失败，保留失败证据、恢复本步骤的 RUNBOOK 和此前的 Readiness 状态，交 MASTER 处理。
5. 完成真实验收、清理及 Readiness 迁移后，同一候选版本运行一次下列完整本地验证，保留本机和实机证据边界。当前默认 e2e 共 20 项，随 A 同步后记录实际数量；所有必要场景必须执行。仓库既有可选 Temporal 场景的 skip 单列说明。

验证：

```bash
bash web05/acceptance/run.sh verify
```

删除和迁移完成后的最终验证：

```bash
pnpm check
pnpm --filter @bento/web exec playwright test
git diff --check
test ! -e docs/30-designs/RUNBOOK-WEB-05-EXECUTION-ENVIRONMENT.md
! rg -n -F 'RUNBOOK-WEB-05-EXECUTION-ENVIRONMENT.md' docs
python3 - <<'PYLINK'
import re
from pathlib import Path

readiness = Path('docs/40-readiness/CURRENT-READINESS.md')
rows = [line for line in readiness.read_text().splitlines() if line.startswith('| [WEB-05 ')]
assert len(rows) == 1 and rows[0].split('|')[2].strip() == '已实现'
links = re.findall(r'\]\(([^)]+)\)', rows[0])
assert '../10-requirements/WEB-REQUIREMENTS.md#web-05-执行环境' in links
for link in links:
    assert not re.match(r'^\w+://', link), 'WEB-05 evidence links must be repository relative'
    relative, _, fragment = link.partition('#')
    target = readiness.parent / relative if relative else readiness
    assert target.is_file(), link
    if fragment:
        headings = re.findall(r'^#{1,6} +(.+)$', target.read_text(), re.M)
        anchors = [re.sub(r'[^\w -]', '', heading.lower()).replace(' ', '-') for heading in headings]
        assert fragment in anchors, link
PYLINK
```

PASS：迁移后的完整本地检查和 WEB-05 链接校验通过，实际 WEB-05 Chromium 1/1 无跳过，首次实机轮换的跨重启排队与容器内摘要断言、T5 各项功能断言、正控制与秘密零匹配通过，本地检查及 Chromium 通过，A13 和 A 资源归属未改变。

STOP：实机证据或范围核对缺失、命令失败、版本漂移、真实 Worker 或 OpenShell 不可用。记录受影响断言，维持 Readiness「部分实现」。
