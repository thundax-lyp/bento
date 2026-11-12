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

- `projects[]` 的元素为 `{id, name}`。名称去首尾空白后长度为 1–120，禁止控制字符。复用同一创建 ID 时，名称必须一致。
- `Upload = {id, project, path, size, state, expires}`。其中 `project` 为 `spaceId`。文件树由 `state = saved` 的记录按 `path` 生成。路径使用相对路径和 `/`，最长 1024 个 UTF-16 码元。拒绝空段、点段、反斜杠、控制字符、重复路径及文件与目录冲突。
- `quota = 10_000_000_000`，`fileLimit = 4_000_000_000`。可用额度为 `quota - saved - reserved`。`partSize` 由服务器返回，当前为 16 MiB。单文件大小允许为 0。
- `checksums` 按分块编号顺序列出 Base64 编码的 SHA-256，每块一个。分块数为 `ceil(size / partSize)`，空文件提交空数组，无需请求分块签名。同一上传 ID 重试须使用相同项目、路径、大小和摘要清单。
- 浏览器对 `url` 执行 `PUT`，请求头 `x-amz-checksum-sha256` 使用返回的 `checksum`，由浏览器按 Blob 长度生成 `Content-Length`。签名绑定对象键、存储上传会话、编号、长度和摘要。地址最长 10 分钟有效。续传时重新核对原文件并查询 `parts`，只补传缺失的块。合并的分块清单以对象存储回读结果为准。
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
| `GET /api/space/projects/{spaceId}/deletion` | 无   | `200 {fileCount,uploadCount,runCount,diffCount,blockers}`。用于确认提示。                                 |
| `DELETE /api/space/files/{fileId}`           | 无   | `202 {state:"deleting"}` 或无正文 `204`。已实现。                                                         |
| `DELETE /api/space/projects/{spaceId}`       | 无   | `202 {state:"deleting"}` 或 `204` 已完成。                                                                |

- `blockers` 为稳定错误码数组，包含 `project_busy`、`upload_pending` 或 `project_importing`，没有阻塞时为空。其中 `uploadCount` 为尚未清理的上传数，`diffCount` 统计已发布补丁，包括零字节补丁。预检查仅为提示。真正删除时重新检查。
- 删除进入 `deleting` 后停止给待删资源签发新的访问地址。重复同一删除可查询原进度，已完成对原账号返回 `204`。项目删除包含其上传与文件、绑定的执行项目、历史任务和补丁。单个空间文件的删除保留历史任务和补丁。
- 单文件删除仅接受同源、已授权请求。初始化引用返回 `409 project_importing`，有未结束 Run 使用来源时返回 `409 project_busy`。门禁结果未确认返回 `503 file_delete_unconfirmed`，可用原文件 ID 重试。越权、资源不存在和不可删除的上传状态同为 `404 not_found`。
- 空间列表以 `deleting` 显示清理进度，清理期间计入已保存用量。确认对象不可读并释放关联门禁后，记录从空间列表移除，额度只回收一次。原账号用同文件 ID 重试返回 `204`。
- 只有原账号的 `saved` 文件可预览，越权、未保存或不存在统一返回 `404 not_found`。预览地址有效 300 秒。元数据超限返回 `413 preview_too_large`，浏览器也检查实际读取字节。超限或无法严格解码为 UTF-8 时显示原因并保留原附件下载。

## 执行输入与任务 · WEB-04 / WEB-06

### 从空间初始化工作区 · 现有

`POST /api/space/projects/{spaceId}/execution` 接收 `{fileIds: string[]}`，要求 `Idempotency-Key`。数组包含 1–100 个不重复的已保存文件 ID，按集合比较重试输入。首次接受返回 `202 Execution`，同键同输入重试返回 `200 Execution`。使用 `GET /api/space/projects/{spaceId}` 读取初始化结果。

`Execution = {state, projectId?, inputs?, issues?}`。

- `state` 为 `uninitialized`、`validating`、`importing`、`ready` 或 `failed`。首次绑定后，`projectId` 为原执行项目 ID。只有 `ready` 可以提交任务。
- `inputs[]` 为固定的 `{fileId,path,size,available}`，`available` 表示来源文件仍可访问。初始化按归属、已保存状态、相对路径、UTF-8、文件数量及合计字节验证。存在进行中或已绑定的初始化时，提交不同输入返回 `409 execution_already_bound`。已明确拒绝且尚未派发导入时，可以更正选择并用新键重试。发现输入超限时返回 `413 execution_input_too_large`。路径及 UTF-8 在后台校验，失败通过 `Execution.state = failed` 和 `issues` 返回。每项为 `{fileId?,path?,code}`。
- 存在未确认的初始化时先查询原记录，避免创建第二个执行项目。后续任务继续使用该执行 Workspace。初始化清单展示上传的来源，任务补丁相对该 Run 开始前的 Workspace 基线。

### 任务与补丁 · 现有

| 方法与路径                                        | 请求                                       | 成功响应                                                                        |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/projects`                               | 无                                         | `200 {projects: Project[]}`                                                     |
| `POST /api/projects`                              | `{name, files: [{path,text}]}`，旧文本导入 | 真实模式 `201 Project`                                                          |
| `GET /api/projects/{projectId}`                   | 无                                         | `200 Project`                                                                   |
| `GET /api/projects/{projectId}/runs`              | 无                                         | `200 {runs: Run[]}`                                                             |
| `POST /api/projects/{projectId}/runs`             | `{prompt}`，带 `Idempotency-Key`           | 真实模式首次 `202 Run`，同键同内容重试 `200 Run`                                |
| `GET /api/projects/{projectId}/runs/{runId}`      | 无                                         | `200 Run`。详情包含 `prompt`。                                                  |
| `GET /api/projects/{projectId}/runs/{runId}/diff` | 可选 `?download=1`                         | `200 text/plain; charset=utf-8`。下载时附带 `Content-Disposition: attachment`。 |

- `Project = {id,name,status,createdAt}`，`status` 为 `importing`、`ready` 或 `failed`。
- `Run = {id,projectId,sessionId,status,createdAt,updatedAt,summary?}`，`status` 为 `queued`、`running`、`recovering`、`needs_review`、`succeeded` 或 `failed`。Web 任务链接绑定执行项目和 Run。原任务描述以详情返回的持久化 `prompt` 为准。
- 提交内容去首尾空白后为 1–8000 个字符。重试键作用域为账号下的执行项目。同键不同内容返回 `409`，同键同内容可在提交响应超时后安全重试。
- 只有 `succeeded` 且补丁已发布时可读取 diff。零字节 diff 是成功结果，未发布返回 `409`。待核对结果由可信部署侧处理。
- 私有执行服务保留现有同构 `/v1/projects` 和 Run 路径。Web 目标使用相同任务路由提交与读取，避免为来自空间的任务建立第二套 Run 接口。

### 私有执行接口与目标扩展

| 方法与路径                                                                 | 契约                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/projects`                                                        | 新增可选 `Idempotency-Key`。启用时按 owner 和提交键绑定输入，首次 `201 Project`，同键同输入重试 `200 Project`，同键异内容 `409`。旧调用保留原行为。已实现。   |
| `GET /v1/projects/{projectId}/runs/{runId}`                                | 只在详情返回已持久化的 `prompt`。任务列表保持现有形态。已实现。                                                                                               |
| `POST / DELETE /v1/projects/{projectId}/file-deletion-holds/{operationId}` | 仅服务身份与项目 owner 可用，无请求体。原键返回 `200 {state}`，state 为 `held`、`denied` 或 `released`。取得门禁与 Run 入队互斥。释放后同键不可重取。已实现。 |
| `DELETE /v1/projects/{projectId}`                                          | 在执行服务原子检查未结束任务并关停新写入。清理中 `202 {state:"deleting"}`，清理完 `204`。同 owner 重试可查询原删除结果。目标接口。                            |

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

目标版本通过追加路径、字段或可选请求头扩展。已有路径、任务状态、旧执行项目与历史补丁继续可访问。扩展错误码时，保留原 HTTP 分类。空间功能关闭时，旧任务入口可单独运行。

## 相关文档

- [Web 产品需求](../10-requirements/WEB-REQUIREMENTS.md)
- [Web 系统设计](../30-designs/WEB-DESIGN.md)
- [个人端项目文件与存储设计](../30-designs/WEB-DESIGN.md#项目文件与存储)
