# Bento Workspace API

Go 模块提供 Workspace 的认证、项目及 Run、Task 和文件空间 API。Compose 运行一个 `bento-web-api` 进程，NGINX 将 `/auth` 和 `/api/*` 转发到容器内 `127.0.0.1:4102`。Go 直接访问 MySQL 账号仓储，通过既有 v1 协议调用 Orchestrator，并使用 SQLite 和 S3 持久化文件空间状态。浏览器直传 S3。

在 Git 忽略的本地目录配置任务入口，限制账号配置和环境文件仅供部署用户读取。账号文件是 JSON 数组，每个成员包含 `account`、固定且唯一的不透明 `ownerId`，以及小写十六进制 `inviteSha256`。为每个账号生成独立的 32 字节随机邀请码，以 base64url 编码后发给受邀用户，文件内只存该字符串的 SHA-256。保留原 ownerId 才能继续访问执行服务上的历史记录。

| 环境变量                   | 用途                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `BENTO_ONE_ORIGIN`         | 浏览器访问前端的完整 origin。独立前端开发示例为 `http://127.0.0.1:4185` |
| `BENTO_ONE_ACCOUNTS_FILE`  | Go 首次导入受邀账号使用的 JSON 文件路径                                 |
| `BENTO_ONE_TWO_URL`        | 执行服务的 origin，必填                                                 |
| `BENTO_ONE_TWO_BEARER`     | 执行服务的独立服务 bearer，必填                                         |
| `BENTO_ONE_TWO_TIMEOUT_MS` | Workspace API 调用执行服务的超时，默认 10000 毫秒                       |

本地开发可按[前端说明](../workspace-web/README.md)启动浏览器模拟服务。连接真实 MySQL 和 Orchestrator 时，在仓库根目录配置环境后启动 Go API。OIDC 模式先构建认证静态文件。

```sh
pnpm --filter @bento/workspace-auth build
go -C apps/workspace/workspace-api build -o /tmp/bento-web-api ./src
/tmp/bento-web-api
```

## 源码结构

| 路径                         | 职责                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `src/main.go`                | 组装依赖、启动 HTTP 服务和管理关闭                    |
| `src/internal/api/`          | 注册项目、Run 和 Task 路由，协调账号清理              |
| `src/internal/auth/`         | MySQL 账号仓储、Session、密码和 OIDC                  |
| `src/internal/orchestrator/` | Orchestrator 私有 HTTP 客户端和协议编解码             |
| `src/internal/space/`        | SQLite、S3、文件锁、上传、项目初始化与删除、快照 Task |
| `src/internal/httpx/`        | 请求解析、响应头和错误格式                            |

SQLite 在服务启动时初始化。上传和清理共用进程内文件锁，后台任务凭持久化提交键重试。包内测试随对应 Go 包维护。

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

账号空间为 200 MB（200,000,000 字节），单文件最大 100 MB（100,000,000 字节）。私有桶须支持带 SHA-256 校验的 S3 Multipart Upload、分块查询、条件完成、终止上传和私有对象读写。CORS 允许前端 origin 通过 `GET` 读取文本预览，通过 `PUT` 上传分块并发送 `x-amz-checksum-sha256` 请求头。中断后重新选择原文件可续传。

注销后停止接受新任务，等已受理任务终结再清理。真实 OpenShell 宿主需要提供幂等的工作区删除，见 [宿主部署说明](../../../deploy/README.md#openshell-执行宿主)。

## Go 账号仓储配置

Compose 设置 `BENTO_MYSQL_HOST=mysql:3306`、`BENTO_MYSQL_USER=bento`、`BENTO_MYSQL_DATABASE=bento` 和 `BENTO_MYSQL_PASSWORD`。Go 读取这些变量并直接连接 MySQL。注销先停止接收该账号的新写入，再对账快照提交回执并协调 Orchestrator 清理，最后清理账号的空间对象和元数据。未完成的清理记录持久保留并由后台重试。

## Keycloak 登录

设置 `BENTO_OIDC_ISSUER` 后，任务入口用 OIDC 授权码与 S256 PKCE 接受 Keycloak 身份。服务器验证 state、nonce、签名及 Token 声明。只有邮箱已验证且属于配置组织的身份才能取得 Bento 会话。Go 账号仓储在 MySQL 以 `(oidc_issuer, oidc_subject)` 唯一绑定 `owner_id`，并发回调读取同一个绑定。邮箱用于展示。

`/auth` 独立提供认证界面，OIDC 回调使用 `/api/oidc/callback`。此模式关闭任务入口的密码登录、注册和密码确认注销端点。普通退出使用 OIDC RP-Initiated Logout。业务注销要求用原身份重新认证，随后按现有机制关闭账号并清理资源。登录会话及未完成的 OIDC 事务随 Go API 重启失效，身份绑定和关闭状态保留。部署配置见 [部署配置](../../../deploy/README.md#准备配置)。

## 测试

运行 `pnpm check:workspace-api` 执行 Go 测试和 `go vet`。容器回归由 `deploy/workspace/auth-smoke.sh` 执行，覆盖 OIDC 生命周期、项目空间、上传与删除、快照 Task、账号清理和进程拓扑。浏览器模拟服务和相关测试位于 [Workspace Web 验收目录](../workspace-web/acceptance/fixtures/workspace-api/)。
