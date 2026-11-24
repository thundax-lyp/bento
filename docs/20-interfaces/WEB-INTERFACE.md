# Bento Web 接口契约

## 目的与范围

定义 [Web 产品需求](../10-requirements/WEB-REQUIREMENTS.md) 的浏览器接口、S3 数据面，以及工作区初始化和删除所需的内部执行接口。本文是 Web HTTP 契约的真相源。标记「现有」的接口来自当前工作区源码。标记「目标」的接口供后续开发和验收使用。

## 边界与传输

| 调用方 → 提供方       | 传输及归属                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器 → 任务入口     | 同源 HTTPS 和 Cookie。JSON 使用 UTF-8 `application/json`。所有 `POST` 和新增的 `DELETE` 校验 `Origin`。响应使用 `Cache-Control: no-store`。 |
| 浏览器 → 私有对象存储 | 用已授权的短期 URL 直传分块、下载文件或读取预览。存储地址只授予单个对象操作。                                                               |
| 任务入口 → 执行服务   | 内部 `/v1` 接口，使用服务 Bearer 和服务端从登录态解析的 `X-Bento-Owner-Id`。浏览器传来的 owner 或凭证不能用于授权。                         |

空间 ID 和旧执行项目 ID 分属两个命名空间。本文以 `spaceId` 表示空间项目，以 `projectId` 表示执行项目。Space 文件 ID 等于成功的 upload ID。所有嵌套访问都验证账号归属及父子关系。空间 ID、上传 ID 由客户端生成 UUID v4，执行项目和 Run ID 由执行服务生成。文件大小、额度与分块大小是整数实际字节。空间上传的 `expires` 为 Unix 毫秒，执行的 `createdAt` 和 `updatedAt` 为 ISO 8601 字符串。

## 受邀注册与登录 · WEB-01

### Keycloak 受邀认证 · 现有

| 方法与路径               | 行为                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GET /auth`              | 返回登录或已登录账号页面。                                                                                   |
| `GET /api/oidc/start`    | 创建短时登录事务，重定向到 Keycloak。                                                                        |
| `GET /api/oidc/callback` | 校验事务、授权码和组织准入。登录成功签发业务会话并跳转到 `/`。注销回调验证原会话与身份，关闭账号并登记清理。 |
| `POST /api/oidc/logout`  | 撤销当前业务会话，重定向到 Keycloak 结束身份会话。                                                           |
| `POST /api/oidc/close`   | 接收表单 `confirmed=yes`，发起重新认证。                                                                     |
| `GET /api/session`       | 已登录返回 `200 {account}`，否则返回 `401`。                                                                 |

### 邀请码开发模式 · 现有

下表适用于邀请码模式。Keycloak 模式的入口和注销流程见 [Web 受邀认证需求](../10-requirements/WEB-REQUIREMENTS.md#web-01-账号和访问控制)和[账号设计](../30-designs/WEB-DESIGN.md#个人端认证与账号)。

| 方法与路径           | 请求                          | 成功响应                            |
| -------------------- | ----------------------------- | ----------------------------------- |
| `POST /api/register` | `{account, invite, password}` | `201 {account}`，随后使用密码登录   |
| `POST /api/login`    | `{account, password}`         | `200 {account}`，设置会话 Cookie    |
| `GET /api/session`   | 无                            | `200 {account}`                     |
| `POST /api/logout`   | 无必填字段                    | `200 {}`，撤销当前会话并清除 Cookie |

注册要求预先配置的账号和邀请码，密码长度为 15 至 128 个字符。每个 ownerId 只能注册一次。会话 24 小时有效，任务入口重启后需重新登录，固定账号归属下的资源仍可找回。Cookie 为 `HttpOnly`、`SameSite=Strict`，HTTPS 下使用 `Secure` 和 host-only 作用域。重新登录前，客户端不可获取新的传输地址。

`POST /api/account/close` 接收 `{password, confirmed: true}`。调用方须持有账号的有效会话，且提交当前密码。成功返回 `200 {}` 并清除 Cookie。关闭记录按 ownerId 持久化，撤销全部会话并使原邀请码无法登录或重新注册。

确认时持久化清理请求并撤销访问。执行服务禁止该账号新增项目或 Run，并等待已提交的任务结束。处于 `needs_review` 的任务须先完成核对。随后清理项目、工作区、上传文件、任务记录和 diff。未完成的上传须等待已签发的分块地址到期。清理完成后只保留用于阻止重新激活的账号关闭标记。

未登录访问工作区时，Keycloak 模式进入 `/auth`，邀请码模式进入 `/login`。空间和任务由新会话的账号重新鉴权。

内部 `POST /v1/account/purge` 以服务凭证和 `X-Bento-Owner-Id` 调用。等待任务、工作流或清理确认时返回 `202 {complete:false}`，执行侧清理完成返回 `200 {complete:true}`。重复请求继续处理剩余资源。

## 我的空间 · WEB-02 / WEB-03

### 现有接口

| 方法与路径                                    | 请求                          | 成功响应                                                               |
| --------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `GET /api/space`                              | 无                            | `200 {projects, uploads, quota, fileLimit, partSize, saved, reserved}` |
| `POST /api/space/projects`                    | `{id, name}`                  | `200 {id}`                                                             |
| `POST /api/space/projects/{spaceId}/uploads`  | `{id, path, size, checksums}` | `200 Upload`                                                           |
| `GET /api/space/uploads/{uploadId}`           | 无                            | `200 Upload & {parts: number[]}`，只返回对象存储已验证的分块编号       |
| `POST /api/space/uploads/{uploadId}/part`     | `{number}`，从 1 开始         | `200 {url, checksum}`                                                  |
| `POST /api/space/uploads/{uploadId}/complete` | `{}`                          | `200 Upload`，状态为 `saved`                                           |
| `POST /api/space/uploads/{uploadId}/cancel`   | `{}`                          | `200 Upload`，返回当前清理结果                                         |
| `GET /api/space/files/{fileId}/download`      | 无                            | `302 Location`，指向原文件附件                                         |

- `projects[]` 的元素为 `{id, name}`。清理期间附加 `state:"deleting"`。名称去首尾空白后长度为 1–120，禁止控制字符。复用同一创建 ID 时，名称必须一致。
- `Upload = {id, project, path, size, state, expires}`。其中 `project` 为 `spaceId`。文件树由 `state = saved` 的记录按 `path` 生成。路径使用相对路径和 `/`，最长 1024 个 UTF-16 码元。拒绝空段、点段、反斜杠、控制字符、重复路径及文件与目录冲突。
- 目标值为 `quota = 200_000_000`（200 MB）和 `fileLimit = 100_000_000`（100 MB）。可用额度为 `quota - saved - reserved`。开始上传时，服务端在同一原子操作中按账号校验并预占声明大小。客户端以服务器返回的限制值为准。`partSize = 16_777_216`（16 MiB），单文件大小允许为 0。实现状态见[需求完成状况](../40-readiness/evidence/WEB-02.md#上传规格与验证基线)。
- `checksums` 按分块编号顺序列出 Base64 编码的 SHA-256，每块一个。分块数为 `ceil(size / partSize)`，100 MB 文件共 6 块，前 5 块各 16 MiB，末块为 16,113,920 字节。空文件提交空数组，无需请求分块签名。同一上传 ID 重试须使用相同项目、路径、大小和摘要清单。
- 浏览器对 `url` 执行 `PUT`，请求头 `x-amz-checksum-sha256` 使用返回的 `checksum`，由浏览器按 Blob 长度生成 `Content-Length`。签名绑定对象键、存储上传会话、编号、长度和摘要。地址最长 10 分钟有效，签名失效后，可在原上传记录仍有效时申请新地址。`Upload.expires` 是上传记录的期限，记录过期后停止签发和续传，清理结束后须使用新 ID 上传。续传时重新核对原文件并查询 `parts`，只补传缺失的块。合并的分块清单以对象存储回读结果为准。
- 下载只为 `saved` 签发最长 5 分钟的附件地址。中间分块、校验或清理中的对象不能下载。已签发的 URL 是限时权限，退出后不能获取新地址。

| 上传状态                           | 可见结果与额度                                                 |
| ---------------------------------- | -------------------------------------------------------------- |
| `preparing` / `uploading`          | 准备或可传输，计预占。浏览器另用本地传输进度展示当前活跃上传。 |
| `completing`                       | 正在确认对象，计预占。重复完成或查询状态后继续。               |
| `cleaning`                         | 停止发签名，保留预占直到确认对象清理。                         |
| `saved`                            | 可下载、计已保存用量，重复完成返回同一文件。                   |
| `cancelled` / `expired` / `failed` | 已停止且清理完毕，额度已释放。                                 |

### 项目详情及目标扩展

| 方法与路径                                   | 请求 | 成功响应                                                                                                  |
| -------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/space/projects/{spaceId}`          | 无   | `200 {id,name,execution,files}`。文件元素为 `{id,path,size}`，仅列已保存且可访问的文件。已实现。          |
| `GET /api/space/files/{fileId}/preview`      | 无   | `302 Location`，跳转私有对象的短期读地址，浏览器以严格 UTF-8 解码并仅作纯文本渲染。最多 256 KiB。已实现。 |
| `GET /api/space/projects/{spaceId}/deletion` | 无   | `200 {fileCount,uploadCount,runCount,diffCount,blockers}`。用于确认提示。已实现。                         |
| `DELETE /api/space/files/{fileId}`           | 无   | `202 {state:"deleting"}` 或无正文 `204`。已实现。                                                         |
| `DELETE /api/space/projects/{spaceId}`       | 无   | `202 {state:"deleting"}` 或无正文 `204` 已完成。已实现。                                                  |

- `blockers` 为稳定错误码数组，包含 `project_busy`、`upload_pending` 或 `project_importing`，没有阻塞时为空。其中 `uploadCount` 为尚未清理的上传数，`diffCount` 统计已发布补丁，包括零字节补丁。预检查仅为提示。真正删除时重新检查。
- 项目 DELETE 仅接受同源、已授权请求。未清理上传、初始化和未终结 Run 分别返回 `409 upload_pending`、`409 project_importing` 和 `409 project_busy`。执行门禁未确认或单文件清理尚未结束时返回 `503 project_delete_unconfirmed`，可用原项目 ID 重试。清理中的项目详情附加 `state:"deleting"`，文件和执行入口从详情隐藏。项目完成后，详情与影响预检查返回 `404 not_found`，原账号可继续用 DELETE 回读 `204`。
- 删除进入 `deleting` 后停止给待删资源签发新的访问地址。重复同一删除可查询原进度，已完成对原账号返回 `204`。项目删除包含其上传与文件、绑定的执行项目、历史任务和补丁。单个空间文件的删除保留历史任务和补丁。
- 单文件删除仅接受同源、已授权请求。初始化引用返回 `409 project_importing`，有未结束 Run 使用来源时返回 `409 project_busy`。门禁结果未确认返回 `503 file_delete_unconfirmed`，可用原文件 ID 重试。越权、资源不存在和不可删除的上传状态同为 `404 not_found`。
- 空间列表以 `deleting` 显示清理进度，清理期间计入已保存用量。确认对象不可读并释放关联门禁后，记录从空间列表移除，额度只回收一次。原账号用同文件 ID 重试返回 `204`。
- 已清理上传的 ID 在空间中全局保留为不计费的记录，禁止再次用于上传。只有原账号的 `saved` 文件可预览，越权、未保存或不存在统一返回 `404 not_found`。预览地址有效 300 秒。元数据超限返回 `413 preview_too_large`，浏览器也检查实际读取字节。超限或无法严格解码为 UTF-8 时显示原因并保留原附件下载。

## 执行输入与任务 · WEB-04 / WEB-06

### 从空间初始化工作区 · 现有

`POST /api/space/projects/{spaceId}/execution` 接收 `{fileIds: string[]}`，要求 `Idempotency-Key`。数组包含 1–100 个不重复的已保存文件 ID，按集合比较重试输入。首次接受返回 `202 Execution`，同键同输入重试返回 `200 Execution`。使用 `GET /api/space/projects/{spaceId}` 读取初始化结果。

`Execution = {state, projectId?, inputs?, issues?}`。

- `state` 为 `uninitialized`、`validating`、`importing`、`ready` 或 `failed`。首次绑定后，`projectId` 为原执行项目 ID。只有 `ready` 可以提交任务。
- `inputs[]` 为固定的 `{fileId,path,size,available}`，`available` 表示来源文件仍可访问。初始化按归属、已保存状态、相对路径、UTF-8、文件数量及合计字节验证。存在进行中或已绑定的初始化时，提交不同输入返回 `409 execution_already_bound`。已明确拒绝且尚未派发导入时，可以更正选择并用新键重试。发现输入超限时返回 `413 execution_input_too_large`。路径及 UTF-8 在后台校验，失败通过 `Execution.state = failed` 和 `issues` 返回。每项为 `{fileId?,path?,code}`。
- 存在未确认的初始化时先查询原记录，避免创建第二个执行项目。后续任务继续使用该执行 Workspace。初始化清单展示上传的来源，任务补丁相对该 Run 开始前的 Workspace 基线。

### 任务与补丁 · 现有

| 方法与路径                                           | 请求                                       | 成功响应                                                                        |
| ---------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/projects`                                  | 无                                         | `200 {projects: Project[]}`                                                     |
| `POST /api/projects`                                 | `{name, files: [{path,text}]}`，旧文本导入 | 真实模式 `201 Project`                                                          |
| `GET /api/projects/{projectId}`                      | 无                                         | `200 Project`                                                                   |
| `GET /api/projects/{projectId}/runs`                 | 无                                         | `200 {runs: Run[]}`                                                             |
| `POST /api/projects/{projectId}/runs`                | `{prompt}`，带 `Idempotency-Key`           | 真实模式首次 `202 Run`，同键同内容重试 `200 Run`                                |
| `POST /api/projects/{projectId}/runs/{runId}/cancel` | 无正文，沿用同源会话                       | `200 Run`。返回原 Run 当前取消状态。                                            |
| `GET /api/projects/{projectId}/runs/{runId}`         | 无                                         | `200 Run`。详情包含 `prompt`。                                                  |
| `GET /api/projects/{projectId}/runs/{runId}/diff`    | 可选 `?download=1`                         | `200 text/plain; charset=utf-8`。下载时附带 `Content-Disposition: attachment`。 |

- `Project = {id,name,status,createdAt}`，`status` 为 `importing`、`ready` 或 `failed`。
- `Run = {id,projectId,sessionId,status,createdAt,updatedAt,summary?}`，`status` 为 `queued`、`running`、`recovering`、`needs_review`、`cancelling`、`cancelled`、`succeeded` 或 `failed`。Web 任务链接绑定执行项目和 Run。原任务描述以详情返回的持久化 `prompt` 为准。
- 提交内容去首尾空白后为 1–8000 个字符。重试键作用域为账号下的执行项目。同键不同内容返回 `409`，同键同内容可在提交响应超时后安全重试。
- 排队取消返回 `cancelled`，已预留但尚未启动也可取消。受支持宿主的运行取消返回 `cancelling`，后续详情回读 `cancelled` 或 `needs_review`。重复请求返回原 Run 当前取消状态，不需要新幂等键。越权、不存在或项目关系不符返回 `404 not_found`。已接收完成回执、运行宿主缺少可信退出观察或状态不可取消时返回 `409 conflict`。结果不明时回读原详情。
- 只有 `succeeded` 且补丁已发布时可读取 diff。零字节 diff 是成功结果，未发布返回 `409`。待核对结果由可信部署侧处理。
- 私有执行服务保留现有同构 `/v1/projects` 和 Run 路径。Web 目标使用相同任务路由提交与读取，避免为来自空间的任务建立第二套 Run 接口。

### Task 生命周期 · 目标契约

表中路径以公开 `/api` 或私有 `/v1` 为前缀。私有请求由个人端附 service Bearer、认证派生的 `X-Bento-Owner-Id`。POST 要求同源会话校验。K 表示单一 UUID v4 `Idempotency-Key`。cancel 沿用现有无键的条件状态转换。URL 路径资源先校验再按 owner、Task、Run 关系查询。列表按创建时间、ID，Run 按 sequence，Event 按 sequence 升序。列表当前返回全量，events 未指定 after 时为 0，传入单个非负安全整数并按严格大于过滤。

| 方法和路径                                                         | 请求与转发                                                                                                                                                                                                                                                                                                                                                                                                                                   | 成功                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/tasks`                                                      | K。公开 `{name,source}`。blank source 为 `{kind:"blank"}`，snapshot source 为 `{kind:"space_snapshot",spaceId,fileIds}`。私有 `{id,name,sourceSpaceId,inputFiles,inputManifest,inputDigest}`，inputFiles 是 `{path,text}[]`。blank 的私有 id/sourceSpaceId 均为 null，Task ID 由 Orchestrator 在 receipt 首写分配。snapshot 的 id 是意图事务持久化的 UUID，Orchestrator 使用该 ID。同 owner/key 已受理的跨来源请求先按 canonical hash 检查。 | 首受理 202 `{task}`，重放 200 `{task}`。                                                                                                          |
| GET `/tasks`                                                       | 无正文                                                                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{items:TaskDTO[]}`                                                                                                                           |
| POST `/tasks/{taskId}/prepare`                                     | 无正文、无 K。按该 Task 原 create receipt 触发重准备。                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{task}`                                                                                                                                      |
| GET `/tasks/{taskId}`                                              | 无正文                                                                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{task}`                                                                                                                                      |
| GET `/tasks/{taskId}/events?after=0`                               | 转发 after                                                                                                                                                                                                                                                                                                                                                                                                                                   | 200 `{items:TaskEventDTO[]}`                                                                                                                      |
| GET `/tasks/{taskId}/runs`                                         | 无正文                                                                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{items:RunDTO[]}`                                                                                                                            |
| POST `/tasks/{taskId}/runs`                                        | K，`{prompt}` 原形转发                                                                                                                                                                                                                                                                                                                                                                                                                       | 首次 202 `{run}`，重放 200 `{run}`                                                                                                                |
| GET `/tasks/{taskId}/runs/{runId}`                                 | 无正文                                                                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{run}`                                                                                                                                       |
| POST `/tasks/{taskId}/runs/{runId}/cancel`                         | 无正文                                                                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{run}`                                                                                                                                       |
| POST `/tasks/{taskId}/runs/{runId}/retry`                          | K，无正文，Run ID 来自路径                                                                                                                                                                                                                                                                                                                                                                                                                   | 202 `{retry:{id,runId,state}}`，同键重放 200 同 receipt。state 为 preparing/queued/blocked/closed，runId 为预分配 ID，queued 前不得按其读取 Run。 |
| GET `/tasks/{taskId}/runs/{runId}/results`                         | 无正文                                                                                                                                                                                                                                                                                                                                                                                                                                       | 200 `{result}`                                                                                                                                    |
| GET `/tasks/{taskId}/runs/{runId}/results/1/diff?view=incremental` | view 必为 incremental 或 cumulative，可选单个 download=1                                                                                                                                                                                                                                                                                                                                                                                     | 200 `text/plain; charset=utf-8`，download 时使用固定附件名 `changes.patch`，字节相同。                                                            |

- `TaskDTO={id,name,sourceSpaceId,inputDigest,environmentVersion,status,prepareError,closedReason,reconciliation,createdAt,updatedAt}`。prepareError 为 null、environment_unavailable 或 preparation_failed。源 ID 无值用 null。输入展示另含 `inputs:{fileId,path,bytes,sha256}[]`，不含原文。
- `RunDTO={id,taskId,sequence,prompt,status,retryOf,canContinue,canCancel,retryReason,resultVersion,summary,createdAt,updatedAt}`。retryOf、summary、resultVersion 可空。retryReason 为 null 或 `task_closed|not_latest|not_terminal|needs_review|stop_unconfirmed|checkpoint_unavailable|environment_unavailable|task_busy|task_not_ready`。canContinue 要求 Task ready、closedReason 为 null、无活动 Run/attempt，且没有待重试的失败或取消工作区污染。排队取消且从未执行可继续。成功可继续，执行后明确失败或取消只开放符合条件的 retry。canCancel 使用现有取消门禁。retry 只考虑最新一次 Run 的失败或取消，防止回滚掉后续成功。
- `TaskEventDTO={id,sequence,runId,at,kind,text,check}`。kind 为 user_message/agent_reply/step/command/check。非 check 事件的 check 为 null。公开 event ID 不含提交键。check DTO 为 `{name,status,output}`，status 为 passed/failed/not_run/unavailable，output 为 string 或 null。采集未观察到检查时数组为空。
- `ResultDTO={runId,version:1,summary,checks,incrementalSha256,cumulativeSha256,createdAt}`。HTTP 仅白名单字段，追踪不包含原 DSH 事件、命令参数、未知原文输出、宿主地址、卷、token 或凭据。
- name trim 后 1–120 字符，prompt 沿用 `runPrompt`；拒绝多余字段、重复 ID、无效路径/query。公开有正文限 64 KiB，私有创建 8 MiB。JSON/schema/query 非法为 400 invalid_input，K 缺失或非法为 400 invalid_key，Origin 失配沿用 400 invalid_origin，认证缺失为 401。404 not_found 统一处理路径遗漏、资源不存在、越权及绑定不符。409 白名单为 idempotency_conflict、task_not_ready、task_busy、run_not_cancellable、run_not_retryable、diff_unavailable、project_busy、owner_closed，retry 拒绝含 `error.reason`。正文或文件上限为 413 too_large，租户队列 429 tenant_queue_full，缺 space 且要求 snapshot 时 503 source_unavailable，代理异常 502 backend_error。旧本地 mock 对 Task 业务路由固定 503 tasks_unavailable，Web 据此保留原 mock 入口。沿用 `{error:{code,message}}`，仅发送固定公开文案。
- 公开 `POST /tasks` 的空间快照选择整体校验。无效路径或 UTF-8 返回 `400 invalid_input`，附 `error.issues: {fileId,path,code}[]`，其中 code 为 `invalid_path` 或 `invalid_utf8`。选择最多 100 个文件、合计最多 1 MiB，超限返回 `413 too_large`。若单个文件已超过整组字节限制，issues 列出对应文件，code 为 `too_large`。仅合计或数量超限时显示选择级提示。校验失败不创建任务或删除原文件。

#### 环境配置

新增 `ExecutionHost.environmentVersion: string`。生产 command/模块工厂的受信配置包含 imageDigest、policyDigest，格式均为 `sha256:<64 lowercase hex>`。摘要输入固定为 `JSON.stringify({imageDigest,policyDigest})`，按 UTF-8 SHA-256 后加 `sha256:`。模块从自身的可信镜像/策略配置构造版本。command host 从仓库内 `apps/orchestrator/src/execution-service/command-host.ts::Settings` 读取两项。该类型由 `commandHost(configPath)` 用于解析 `start.ts::main` 传入的 `BENTO_HOST_CONFIG` 文件；部署时该文件位于只读私有挂载，由操作者预先配置。两项用于构造默认 launcher 环境。禁止从浏览器请求覆盖。启动读取 `BENTO_EXECUTION_ENVIRONMENT_VERSION`，要求格式正确且等于 host 值；在监听、打开数据库前校验。Compose 的 orchestrator 注入 `${BENTO_EXECUTION_ENVIRONMENT_VERSION:?Set BENTO_EXECUTION_ENVIRONMENT_VERSION}`，不向 Worker 环境扩散。README 使用以下生成命令，变量由操作者从可信运行配置提供。

```sh
node -e 'const {createHash}=require("node:crypto"); const imageDigest=process.env.BENTO_EXECUTION_IMAGE_DIGEST; const policyDigest=process.env.BENTO_EXECUTION_POLICY_DIGEST; if (![imageDigest,policyDigest].every(x=>/^sha256:[0-9a-f]{64}$/.test(x??""))) process.exit(2); process.stdout.write("sha256:"+createHash("sha256").update(JSON.stringify({imageDigest,policyDigest}),"utf8").digest("hex")+"\n");'
```

Task 首写冻结版本。可信 host 新增 `provisionTask(binding,files,environmentVersion):Promise<Observation & {environmentVersion:string}>`，基线 `provision/snapshot` 保持给原项目使用。版本轮换后，已冻结而未准备的 Task 按旧版本显式请求 provisionTask，adapter 只从可信历史版本映射取配置，未知版本返回失败。已准备的绑定继续使用原环境，部署适配器不可因默认版本切换改造既有 sandbox。启动与恢复验证 provisionTask 回执、完整 binding 和独立 snapshot 摘要。原地址通过 prepare 动作按原 create receipt 从 failed 转 preparing，后台继续使用冻结版本和原字节。并发 prepare 在一个 Store 条件更新中只触发一次；preparing 或 ready 回当前 Task，deleting 回 409 task_not_ready。重复 POST create 只回原 Task。更换输入/版本需要用户显式另建 Task。

#### 私有清理与注销

- 空间 pin 仅保护冻结和准备。READY 校验通过后释放 pin；Orchestrator 继续保留 `task_input_refs(taskId,fileId)`，主键为两字段，随 Task 创建事务从 manifest 写入，随 Task 清理删除。Space 的 space_task_inputs 同样长期保留 taskId/fileId，readPinned 为 0/1，READY 时从 1 改为 0，项目/账号清理时才删引用行。文件 ID 仍留在冻结 manifest，源文件的终态删除不改冻结副本。
- 新私有 `POST /v1/task-sources/{spaceId}/files/{fileId}/deletion-holds/{operationId}` 取 hold，`DELETE` 释放，同源路由只由 Space 调用，认证使用 Bearer + 可信 owner header。两者都无正文，不再额外需要 K。可选 `legacyProjectId=<id>` 仅来自 Space 的既有已验证文件关联。二者均回 `200 {state:"held"|"denied"|"released"}`，scope 或关联不符为 404，原键更改 legacyProjectId 为 409 idempotency_conflict。
- Store `task_input_delete_holds(owner,spaceId,fileId,operationId,legacyProjectId,state)` 的主键为前四字段，legacyProjectId 可空，state 为 held/denied/released。acquireTaskInputDeleteHold 的 Store.write 先回读同 owner/source/file/key receipt，关联字段变化报 409 idempotency_conflict。新取时总按 (owner,spaceId) 检查 source deletion，无需 legacyProjectId。source 为 held/committing 时记 denied 并回 200 denied，已 deleted 时回 404 not_found；owner 已 drain 时回 409 owner_closed。再校验请求给出的旧项目 owner 及原项目门禁，并检查引用该文件的 Task 是否 preparing、有活跃 Run 或持门禁的 retry attempt。任一引用繁忙则持久 denied，否则持久 held。项目取门禁也在同一 Store.write 检查该 source 的 held 文件门禁，故两个动作按同账本事务提交顺序线性化。
- Space 在保存 checking 前于空间 SQLite 验证 owner/space/file、saved 状态和 pin。受信调用经此验证，Orchestrator 以 header owner 限定查询；零 Task 引用且无 legacyProjectId 是有效空集合，走同一 source/owner 检查并在无阻断时持久 held。held 期间引用该文件的 Task 新 Run、retry 和重准备，以及关联旧项目写入均拒绝 project_busy。不相关文件无影响。同键重放已有 held/denied/released 在 owner drain 后照常回原状态。release 先回读同键，held 转 released，denied/released 回 released；缺记录写 released tombstone（source 已删回 404），迟到的 acquire 不能复活。release 允许已 drain 的 owner 收敛原操作。
- `space.ts::deleteFile` 的 SQLite 事务先检查 pin，再保存原 `space_file_deletions` receipt 为 checking，即使无旧执行项目也发新 hold。快照创建只接受没有删除 receipt 的已保存文件。若已有 pin，则拒绝删除，不派发 hold。若已有 checking，则拒绝新来源 pin。先入队时，hold 被拒绝并保留原文件；先取 hold 时，入队拒绝。活跃引用门禁由持久 Run/attempt 状态派生，终态原子解除，无内存计数。Space 在 held 后进入 deleting，确认对象已删除才进入 releasing，原键 release 确认后持久 deleted。任一回包未知按同一 receipt 和 phase 续作；未确认取 hold 前不得删对象。denied 后回收 checking intent 并返回 project_busy。新取明确收到 owner_closed 或 not_found 时也回收 checking intent 并转发对应错误，保留对象且不发送 release；未知结果继续原键查询。终态后删源文件，不影响未来从已冻副本续聊。

- 私有 GET /v1/task-sources/{spaceId}/deletion 返回 200 {runCount,diffCount,blockers}。GET 与 DELETE 可带 legacyProjectId，取自 spaceExecution.deletionProject 的已确认映射。DELETE /v1/task-sources/{spaceId} 只接受 phase=hold、commit、release，要求 K。旧 DELETE /v1/projects/{projectId} 原样保留。
- Store 的 task_source_deletions 主键为 (owner,spaceId,operationId)，字段为 legacyProjectId nullable、state、denialCode nullable。hold 以一个 Store.write 事务检查该 source 的所有 Task 与可选旧执行项目。检查准备中、活动 Run/attempt、文件删除门禁、旧项目删除操作及 owner drain。阻断时按 project_importing、project_busy、owner_closed 优先级持久 denied receipt，无资源冻结。成功写 held 及每个目标的 item receipt。held/committing 同时阻止所有目标的新写和旧项目直删。held 不触发清理。
- 以下错误只用于私有 source 路径，个人端按当前 phase 消费。相同操作键但关联字段不同回 409 idempotency_conflict。hold 遇 held 回 202 {state:"held"}，committing 回 202 {state:"deleting"}，deleted 回 204，denied 回原 409，released 回 409 deletion_released。commit 只将 held 转 committing，committing 重放回 202 deleting，deleted 回 204，denied 回原 409，缺 receipt 或 released 回 409 deletion_not_held。release 将 held 转 released 并解冻，缺 receipt 建 released tombstone，released/denied 同键均回 204，committing/deleted 回 409 deletion_committed。其他键只与 held/committing/deleted 冲突。owner drain 后继续处理已有 receipt 的同键操作。
- committing 每项等待 Temporal 关闭并执行可信 sandbox/volume purge，再用同一 Store 事务清理关联业务记录并标项 cleaned。旧 binding 也使用该 item 作清理授权。所有项完成才将 receipt 标 deleted，空集合也留 receipt。晚到的 Task create 若来源已删返回 404。
- space_project_deletions 的 phase 固定为 holding/committing/releasing/cleaning/deleted，原 executionProjectId 为可空字段。holding 由 deleteProject 在 SQLite 写入，原子拦住新来源意图及文件写入。先对账已有来源请求再发 hold。hold 回 held 先持久 committing，回 deleting 同样进入 committing，回 204 进入 cleaning。hold 明确拒绝时先持久 releasing 及原错误，再发 release。release 回 204 删除本地门禁并返回原拒绝，回 deletion_committed 则改为 committing 并续作。未知响应仅重放当前动作，commit 未知禁止 release。只有明确取得 commit 204 才物理回收文件。接受迟到 hold 的 204 视为同一 commit 已完成。
- 账号关闭用原 account sweep 和 POST /v1/account/purge。新增私有 POST /v1/account/drain，无正文，回 204，认证规则同 purge，仅持久 Store.drainOwner。sweepAccounts 先标空间 owner drain，再等 API inFlight 收敛，调用 drain 得 204。随后等待 space.drain(owner) 的已有本地 phase 与来源 receipt 全部收敛，再调用原 purge。该分离避免来源 receipt 等待远端关写而 purge 又等待 space.drain 的死锁。尚未送达的冻结意图可标 abandoned，结果未知的先以私有 GET /v1/tasks?creationKey=<K> 查询同 owner receipt，回 200 {items:TaskDTO[]}，至多一项。查不到时只在 owner drain 后原键重放确认拒绝；明确拒绝后释放 pin。task-sources 私有门禁和 account/drain 都由 execution-service-http.ts 的现有 Bearer 与 owner header 映射转发，后者的 Operation kind 固定为 drainOwner。Orchestrator drain 持久关闭新业务写，等待 held/committing 操作收敛和全部 Run 终态、调度关闭。needs_review 阻止 purge，项目删除和账号注销均不代结案。

#### 重试待核对与结案

- 重试 receipt 的 phase 只能为 preparing、workspace_restored、history_restored、blocked、queued、closed。持久 `lastConfirmedPhase`，只允许 preparing、workspace_restored、history_restored，初始 preparing。每次确认恢复阶段时原子更新 phase 和 lastConfirmedPhase；进入 blocked、queued 或 closed 时保留最后已确认阶段。在 blocked 的可信对账补齐证据并入队时，这一事务同时将 lastConfirmedPhase 推进至 history_restored。
- preparing、workspace_restored、history_restored、blocked 持有一份队列预留、Task 写门禁以及文件/项目删除和 owner purge 门禁。finalize 将 attempt 变为 queued、插入原预分配 Run、转移队列预留和门禁至新 Run，在同一 Store.write 内完成。queued receipt 自身不占额度、不持门禁，后续以新 Run 状态判断，Run 终态后不再阻塞删除或 purge。可信结案将 blocked 变为 closed、释放所有 attempt 预留和清理门禁、关闭 Task 后续写入，在一个事务完成。queued/closed 的同键同 hash 读回原 receipt，异 hash 返回 409。receipt 与业务记录同生命周期，独立审计由原保留规则处理。后台重启只扫描 preparing、workspace_restored、history_restored 并验证原阶段证据，blocked 仅供可信侧对账或结案；queued/closed 不进入恢复扫描。
- `blocked` 是预分配重试的待核对态。尝试保留 lastConfirmedPhase 和原阶段证据、Task 写锁和队列预留；原 Run 的终态、旧结果和断点保持。公开同键 retry receipt 读回 blocked，新增 `TaskDTO.reconciliation` 为 null 或 `{attemptId,state:"blocked",reason:"restore_conflict"}`，可见原因固定，不暴露证据原文。不同提交键的写入回 task_busy。后台不重发恢复、不排队、不释放资源。项目删除和账号 purge 继续等待。
- 可信模块新增第四个安装参数位置 `closeTaskRetry({attemptId,expectedGeneration}):Promise<void>`，仅对 blocked 执行“结果无法确认”结案。服务在保持 attempt 写门禁时核对原持久退出回执和绑定、authority READY 且无 Run/capability，SessionHistory 无打开 handle 或未结批次，并调用可信 host 的 `observeRetryCleanup(binding,attemptId,generation)`。该可选方法返回 null 或 `{attemptId,generation,bindingDigest,restoreIdle:true,volumeWriters:0,sandboxStopped:true,observedAt}`。该证据必须来自当前绑定的独占停止观察，确认旧/新执行写入和 restore 均不再进行。local fixture 使用同一恢复互斥，在排除 in-flight 恢复后 stop + stopped 回读并维持 Task 门禁；普通 command host 不实现。缺证据返回 review_unavailable，保持 blocked。UNKNOWN 不再执行、不标确认成功，可在前述清理安全事实齐备时人工结案。
- 同一可信模块的第六个参数 `reconcileTaskRetry({attemptId,expectedGeneration}):Promise<"pending"|"queued">` 只观察 blocked 的既有证据。一律先读取原 StopProof、queryRestore、通过 restoredHistoryDigest(proof) 校验 History 的原 restore receipt 和当前摘要，核对原 attemptId、Workspace ready receipt、Workspace 与历史各自摘要、当前 authority generation 和同一 binding，并独立回读 volume SHA。History 接口缺原同 attempt receipt 或摘要不符时返回 pending。只在两次恢复均已完整落盘、绑定已就绪且无 UNKNOWN 时，使用原 attempt/预分配 Run ID 原子完成 finalize；重复请求返回原 queued。任一项缺失或未知返回 pending，继续保留 blocked，不发新的 restore、stop 或用户操作。与 closeTaskRetry 对同一 attempt 互斥，Store 终态条件写防止二者同时成功。
- Store `task_retry_closure_audit(attemptId PRIMARY KEY,authorityGeneration,evidenceDigest,closedAt)` 无业务外键。evidenceDigest 为按字段序 {exitReceiptDigest,bindingDigest,authorityGeneration,cleanupObservation} 序列化后的 SHA-256。确认后 `Store.closeBlockedTaskRetry` 在一事务内比对 attempt/authority generation、插入审计、phase=closed、Task.closedReason=unconfirmed、释放队列预留和删除门禁。closed 终态无新 Run，重放返回原 closed receipt。Task 继续可读旧结果，禁止新执行；项目删除和 purge 可按原 receipt 继续。受信读回使用第五参数 `readTaskRetryClosure(attemptId):TaskRetryClosureAudit|null`；项目与账号 purge 均保留最小审计。相同 generation 的结案可重复确认，异代拒绝。拒绝结案只保留 blocked 和原未知证据，不写闭合审计或释放门禁。

### 私有执行接口与目标扩展

| 方法与路径                                                                 | 契约                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/projects`                                                        | 新增可选 `Idempotency-Key`。启用时按 owner 和提交键绑定输入，首次 `201 Project`，同键同输入重试 `200 Project`，同键异内容 `409`。旧调用保留原行为。已实现。                         |
| `POST /v1/projects/{projectId}/runs/{runId}/cancel`                        | 无正文。受信服务身份和 owner 校验。成功及重复返回 `200 Run`，状态冲突为 `409 run_not_cancellable`。                                                                                 |
| `GET /v1/projects/{projectId}/runs/{runId}`                                | 只在详情返回已持久化的 `prompt`。任务列表保持现有形态。已实现。                                                                                                                     |
| `POST / DELETE /v1/projects/{projectId}/file-deletion-holds/{operationId}` | 仅服务身份与项目 owner 可用，无请求体。原键返回 `200 {state}`，state 为 `held`、`denied` 或 `released`。取得门禁与 Run 入队互斥。释放后同键不可重取。已实现。                       |
| `GET /v1/projects/{projectId}/deletion`                                    | 仅服务身份与项目 owner 可用。返回 `200 {runCount,diffCount,blockers}`，阻断码限 `project_importing` 和 `project_busy`。                                                             |
| `DELETE /v1/projects/{projectId}`                                          | 无正文，服务身份、owner 和单一 `Idempotency-Key` 校验。在执行服务原子检查未结束任务并冻结新写入。清理中 `202 {state:"deleting"}`，清理完无正文 `204`。同 owner 按原键重试。已实现。 |

执行项目删除键为个人端 API 持久化的 UUID v4。已受理后改用其他键返回 `409 idempotency_conflict`。账号正在清理时，新操作返回 `409 owner_closed`，已有回执仍可回读至账号清理完成。导入和未终结 Run（含取消中、待核对）分别返回 `409 project_importing` 和 `409 project_busy`。

## 错误语义与兼容

失败为 JSON `{error:{code,message,issues?}}`。`message` 用于显示，客户端按 HTTP 状态和 `code` 决策。上游响应和签名地址不得进入用户可见诊断。

| 状态                    | 语义                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`                   | 无效 JSON、输入或 Origin。空间输入现用 `invalid_space_input`。                                                                                                                                                                                                                                                   |
| `401`                   | 登录无效或过期。                                                                                                                                                                                                                                                                                                 |
| `404 not_found`         | 资源不存在、账号无权访问、资源归属关系不匹配或文件尚不可读。                                                                                                                                                                                                                                                     |
| `409`                   | 当前状态冲突、路径冲突、提交键已用于不同内容、成果尚未发布或空间不足。空间现用 `space_conflict` 和 `space_quota`，执行 HTTP 入口当前将任务冲突统一映射为 `conflict`。目标可区分 `project_busy`、`project_importing`、`upload_pending`、`execution_already_bound`、`idempotency_conflict` 和 `diff_unavailable`。 |
| `413`                   | `file_limit`、导入大小或预览大小限制。                                                                                                                                                                                                                                                                           |
| `429 tenant_queue_full` | 当前账号的任务队列满。客户端提示稍后提交。                                                                                                                                                                                                                                                                       |
| `500 / 502 / 504`       | 入口或依赖异常、执行服务超时。可能已经提交的操作按原键重试或查询状态。                                                                                                                                                                                                                                           |

公开 Task 入口追加独立路径，沿用同源认证及既有错误分类。旧项目入口仅访问旧项目集合，旧项目详情、Run 地址和补丁仍可访问。

目标版本通过追加路径、字段或可选请求头扩展。已有路径、任务状态、旧执行项目与历史补丁继续可访问。扩展错误码时，保留原 HTTP 分类。空间功能关闭时，旧任务入口可单独运行。

## 相关文档

- [Web 产品需求](../10-requirements/WEB-REQUIREMENTS.md)
- [Web 系统设计](../30-designs/WEB-DESIGN.md)
- [个人端项目文件与存储设计](../30-designs/WEB-DESIGN.md#项目文件与存储)
