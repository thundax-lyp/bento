# Bento 任务入口

任务入口提供 Bento Web 的 HTTP API。浏览器使用 [独立 Web 前端](../../apps/web/README.md)完成登录、项目导入、任务提交和 diff 下载。开发时由 Vite 转发 `/api`。部署时，同域反向代理提供前端静态文件，并将 `/api/*` 转发给任务入口。

模拟模式的启动命令、测试账号及端口见前端说明。模拟后端提供普通任务和 `mock:empty`、`mock:failed`、`mock:review`。重启模拟进程会清空记录。

真实模式需要兼容 v1 接口的执行服务。任务入口监听回环地址，在服务端使用独立 bearer 和登录会话绑定的 ownerId 调用执行服务。反向代理保留浏览器 Origin 请求头，`BENTO_ONE_ORIGIN` 配置为浏览器访问前端的完整 origin。登录会话有效期 24 小时，重启任务入口后需要重新登录。

在 Git 忽略的本地目录配置任务入口，限制账号配置和环境文件仅供部署用户读取。账号文件是 JSON 数组，每个成员包含 `account`、固定且唯一的不透明 `ownerId`，以及小写十六进制 `inviteSha256`。为每个账号生成独立的 32 字节随机邀请码，以 base64url 编码后发给受邀用户，文件内只存该字符串的 SHA-256。保留原 ownerId 才能继续访问执行服务上的历史记录。

| 环境变量                   | 用途                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `BENTO_ONE_MODE=http`      | 启用执行服务的真实 HTTP 接口                                            |
| `BENTO_ONE_PORT`           | 任务入口的本地监听端口，默认 4101                                       |
| `BENTO_ONE_ORIGIN`         | 浏览器访问前端的完整 origin。独立前端开发示例为 `http://127.0.0.1:4185` |
| `BENTO_ONE_ACCOUNTS_FILE`  | 受邀账号 JSON 文件路径，真实模式必填                                    |
| `BENTO_ONE_TWO_URL`        | 执行服务的 origin，真实模式必填                                         |
| `BENTO_ONE_TWO_BEARER`     | 执行服务的独立服务 bearer，真实模式必填                                 |
| `BENTO_ONE_TWO_TIMEOUT_MS` | 任务入口调用执行服务的超时，默认 10000 毫秒                             |

现有部署继续使用表中的环境变量名。例如可以用本地环境文件启动。

```sh
node --env-file=runtime/task-entry.env src/task-entry/main.ts
```

关闭页面再打开时，任务列表会从服务端重新加载。提交结果暂未确认时，浏览器只存账号及项目范围内的提交键与描述摘要。用原任务描述重试会沿用该键。空 diff 可以预览状态并下载为空文件。

## HTTP 服务生命周期

任务入口使用 `@deepseek-ai/dsh-host-webserver@0.2.1-rc.4` 监听回环地址和分发路由，继续使用上文的反向代理和 Web API 配置。请求头和完整请求的接收期限均为 30 秒，Node 每 500 毫秒检查一次，超时返回 `408`。该版本未公开监听超时配置，任务入口在启动时重启 Node 的连接超时检查。升级 Node 或 WebServer 时，用未发完的请求头和请求体复验。

收到 `SIGINT` 或 `SIGTERM` 后，任务入口停止接收新连接。已连接的客户端仍受接收期限约束。任务入口等待已进入处理器的请求结束，再释放 WebServer。

## 账号和云端空间

邀请记录可设置 `registrationRequired: true`。新账号在前端用邀请码注册并设置密码，旧账号可继续使用邀请码。配置了账号文件时，注册和注销记录默认保存在 `<账号文件>.sqlite`，可用 `BENTO_ONE_CREDENTIALS_DB` 指定权限受限的持久路径。保留原 ownerId 和数据库。

配置以下参数后，独立前端的 Workspace 会显示云端空间。需要固定的账号文件。

| 配置                      | 用途                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `BENTO_SPACE_DB`          | 空间 SQLite 文件。由单个任务入口实例独占。                                         |
| `BENTO_SPACE_S3_ENDPOINT` | 浏览器和任务入口均可访问的 S3 兼容服务 origin。非回环部署使用 HTTPS 和独立主机名。 |
| `BENTO_SPACE_S3_BUCKET`   | 专用私有桶，使用 path-style 请求，关闭对象版本和对象锁。                           |
| `AWS_REGION`              | 签名区域，默认 `us-east-1`。                                                       |
| AWS SDK 凭证链            | 在任务入口运行环境提供受限凭证。                                                   |

账号空间为 10 GB，单文件最大 4 GB。私有桶须支持带 SHA-256 校验的 S3 Multipart Upload、分块查询、条件完成、终止上传和私有对象读写。CORS 允许前端 origin 的 `PUT` 和 `x-amz-checksum-sha256` 请求头。中断后重新选择原文件可续传。

注销后停止接受新任务，等已受理任务终结再清理。真实 OpenShell 宿主需要提供幂等的工作区删除，见 [宿主部署说明](../../docs/deployments/openshell-dsh.md)。
