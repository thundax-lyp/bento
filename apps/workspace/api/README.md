# Bento 任务入口

任务入口处理 Bento Web 的业务 HTTP API 与会话认证。Docker 部署由 Go 提供 API 入口和 MySQL 账号仓储。浏览器使用 [独立 Web 前端](../web/README.md)完成登录、项目导入、任务提交和 diff 下载。开发时由 Vite 转发 `/api`。[Compose 中的 Web 服务](../../../deploy/README.md#启动与检查)由 NGINX 同域提供前端静态文件，并将 `/api/*` 转发到容器内 `127.0.0.1:4102` 的 Go 入口，再转发至 `4101` 的 task-entry。

模拟模式的启动命令、测试账号及端口见前端说明。模拟后端提供普通任务和 `mock:empty`、`mock:failed`、`mock:review`。重启模拟进程会清空记录。

真实模式需要兼容 v1 接口的执行服务。真实模式要求 Go 的 MySQL 账号仓储。任务入口监听回环地址，在服务端使用独立 bearer 和登录会话绑定的 ownerId 调用执行服务。反向代理保留浏览器 Origin 请求头，`BENTO_ONE_ORIGIN` 配置为浏览器访问前端的完整 origin。登录会话有效期 24 小时，重启任务入口后需要重新登录。

在 Git 忽略的本地目录配置任务入口，限制账号配置和环境文件仅供部署用户读取。账号文件是 JSON 数组，每个成员包含 `account`、固定且唯一的不透明 `ownerId`，以及小写十六进制 `inviteSha256`。为每个账号生成独立的 32 字节随机邀请码，以 base64url 编码后发给受邀用户，文件内只存该字符串的 SHA-256。保留原 ownerId 才能继续访问执行服务上的历史记录。

| 环境变量                   | 用途                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `BENTO_ONE_MODE=http`      | 启用执行服务的真实 HTTP 接口                                            |
| `BENTO_ONE_PORT`           | 任务入口的本地监听端口，默认 4101                                       |
| `BENTO_ONE_ORIGIN`         | 浏览器访问前端的完整 origin。独立前端开发示例为 `http://127.0.0.1:4185` |
| `BENTO_ONE_ACCOUNTS_FILE`  | Go 首次导入受邀账号使用的 JSON 文件路径                                 |
| `BENTO_ONE_TWO_URL`        | 执行服务的 origin，真实模式必填                                         |
| `BENTO_ONE_TWO_BEARER`     | 执行服务的独立服务 bearer，真实模式必填                                 |
| `BENTO_ONE_TWO_TIMEOUT_MS` | 任务入口调用执行服务的超时，默认 10000 毫秒                             |

本地直接启动任务入口时，可以用环境文件配置。真实模式需同时启动 Go 入口与 MySQL。

```sh
mkdir -p debug-workspace
node --env-file=debug-workspace/task-entry.env apps/workspace/api/main.ts
```

关闭页面再打开时，任务列表会从服务端重新加载。提交结果暂未确认时，浏览器只存账号及项目范围内的提交键与描述摘要。用原任务描述重试会沿用该键。空 diff 可以预览状态并下载为空文件。

## HTTP 服务生命周期

任务入口使用 `@deepseek-ai/dsh-host-webserver@0.2.1-rc.4` 监听回环地址和分发路由，继续使用上文的反向代理和 Web API 配置。请求头和完整请求的接收期限均为 30 秒，Node 每 500 毫秒检查一次，超时返回 `408`。该版本未公开监听超时配置，任务入口在启动时重启 Node 的连接超时检查。升级 Node 或 WebServer 时，用未发完的请求头和请求体复验。

收到 `SIGINT` 或 `SIGTERM` 后，任务入口停止接收新连接。已连接的客户端仍受接收期限约束。任务入口等待已进入处理器的请求结束，再释放 WebServer。

## 账号和云端空间

受邀账号在前端用邀请码注册并设置密码，注册后用密码登录。Docker Compose 中，邀请账号、注册凭据和注销状态保存在 MySQL，Go 从邀请文件初始化尚不存在的账号。

配置以下参数后，独立前端的 Workspace 会显示云端空间。需要 MySQL 账号仓储。

| 配置                      | 用途                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `BENTO_SPACE_DB`          | 空间 SQLite 文件。由单个任务入口实例独占。                                         |
| `BENTO_SPACE_S3_ENDPOINT` | 浏览器和任务入口均可访问的 S3 兼容服务 origin。非回环部署使用 HTTPS 和独立主机名。 |
| `BENTO_SPACE_S3_BUCKET`   | 专用私有桶，使用 path-style 请求，关闭对象版本和对象锁。                           |
| `AWS_REGION`              | 签名区域，默认 `us-east-1`。                                                       |
| AWS SDK 凭证链            | 在任务入口运行环境提供受限凭证。                                                   |

账号空间为 10 GB，单文件最大 4 GB。私有桶须支持带 SHA-256 校验的 S3 Multipart Upload、分块查询、条件完成、终止上传和私有对象读写。CORS 允许前端 origin 的 `PUT` 和 `x-amz-checksum-sha256` 请求头。中断后重新选择原文件可续传。

注销后停止接受新任务，等已受理任务终结再清理。真实 OpenShell 宿主需要提供幂等的工作区删除，见 [宿主部署说明](../../../deploy/README.md#openshell-执行宿主)。

## Go 账号仓储配置

Compose 同步设置 `BENTO_MYSQL_HOST=mysql:3306`、`BENTO_MYSQL_USER=bento`、`BENTO_MYSQL_DATABASE=bento` 与 `BENTO_MYSQL_PASSWORD`。Go 使用这些变量连接 MySQL，task-entry 在设置了 `BENTO_MYSQL_HOST` 时通过 `127.0.0.1:4103/internal/*` 访问 Go 账号仓储。此接口与对外 API 使用不同监听端口。MySQL 不可用时认证与账号清理请求失败并保留持久清理记录。

生产 Web 容器需要同时运行 Go 与 task-entry。直接运行 Node 的模拟开发使用进程内模拟账号。项目、Run 和执行授权继续通过既有执行服务协议访问。

## Keycloak 登录

设置 `BENTO_OIDC_ISSUER` 后，任务入口用 OIDC 授权码与 S256 PKCE 接受 Keycloak 身份。服务器验证 state、nonce、签名及 Token 声明。只有邮箱已验证且属于配置组织的身份才能取得 Bento 会话。Go 账号仓储在 MySQL 以 `(oidc_issuer, oidc_subject)` 唯一绑定 `owner_id`，并发回调读取同一个绑定。邮箱用于展示。

`/auth` 独立提供认证界面，OIDC 回调使用 `/api/oidc/callback`。此模式关闭任务入口的密码登录、注册和密码确认注销端点。普通退出使用 OIDC RP-Initiated Logout。业务注销要求用原身份重新认证，随后按现有机制关闭账号并清理资源。登录会话及未完成的 OIDC 事务随 task-entry 重启失效，身份绑定和关闭状态保留。部署配置见 [部署配置](../../../deploy/README.md#准备配置)。
