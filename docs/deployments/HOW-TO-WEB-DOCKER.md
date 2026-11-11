# 用 Docker 部署 Bento Web

一个容器内由 NGINX 在 `8080` 提供构建后的 Web 页面，并把同域 `/api/*` 转发给 `127.0.0.1:4102` 的 Go API 入口。Go 转发业务请求到 `127.0.0.1:4101` 的 task-entry，并在独立的回环端口 `4103` 提供 MySQL 账号仓储。浏览器只访问 NGINX。前端路由直接访问或刷新时由 NGINX 返回 SPA 入口。镜像以非 root 用户运行，健康检查请求首页、API 和 Go 的数据库探针，停服时先让 NGINX 排空连接，再停止 task-entry 和 Go。

任务执行服务、OpenShell、Temporal、模型和 S3 兼容存储使用各自的现有部署。镜像中的 task-entry 通过运行时配置访问执行服务；大文件从浏览器直接传到 S3。S3 服务需要允许前端 origin 的 CORS 请求。 [执行服务与 OpenShell 部署](./openshell-dsh.md) · [task-entry 配置](../../apps/workspace/api/README.md)

## 本机预览

在仓库根目录构建镜像并启动模拟模式。

```sh
docker build -t bento-web:local .
docker run --rm --stop-timeout 60 \
  -p 127.0.0.1:8080:8080 \
  -e BENTO_ONE_MODE=mock \
  -e BENTO_ONE_ORIGIN=http://127.0.0.1:8080 \
  bento-web:local
```

打开 <http://127.0.0.1:8080>。模拟账号和验证流程见 [独立前端说明](../../apps/workspace/web/README.md)。

## 配置真实环境

在本地受控目录准备 `runtime/accounts.json` 和 `runtime/web.env`。账号文件按 [task-entry 配置](../../apps/workspace/api/README.md)创建。让容器内的 `node` 用户（UID 1000）可以只读访问账号文件。Compose 把它挂载到 `/run/bento/accounts.json`。MySQL 8.4 服务通过 Compose 私有网络提供账号存储，数据保存在 `bento-mysql-data` 卷。空间 SQLite 保存在 `bento-web-data` 卷的 `/data`。

在仓库根目录的受控 `.env` 中设置随机生成的 `BENTO_MYSQL_PASSWORD`（例如通过 `openssl rand -hex 32` 生成），Compose 用同一个值配置 MySQL 的 `bento` 用户和 Go 连接。MySQL 容器健康检查通过后启动 Web，MySQL 端口保持在 Compose 网络内。首次初始化创建数据库和用户；密码轮换需要同步修改数据库账号与部署配置。镜像环境变量说明见 [MySQL 官方镜像](https://hub.docker.com/_/mysql)。

参照以下配置填写 `runtime/web.env`。

```dotenv
BENTO_ONE_MODE=http
BENTO_ONE_ORIGIN=https://bento.example.com
BENTO_ONE_TWO_URL=http://execution-gateway.example.internal:4201
BENTO_ONE_TWO_BEARER=<执行服务凭据>
BENTO_SPACE_DB=/data/space.sqlite
BENTO_SPACE_S3_ENDPOINT=https://storage.example.com
BENTO_SPACE_S3_BUCKET=bento-private
AWS_REGION=us-east-1
```

S3 访问凭据通过运行环境的 AWS 凭证链提供。使用环境变量时，把真实值配置在受控的 `runtime/web.env`。镜像构建上下文只包含源码和部署配置。若本次部署暂未配置云端空间，省略全部三个 `BENTO_SPACE_*` 配置。执行服务地址必须从容器可达。若执行服务只监听宿主机回环地址，需要使用现有内网入口或受控代理。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Compose 默认将容器的 `8080` 发布到宿主机回环。生产由宿主机 HTTPS 入口转发至 `http://127.0.0.1:8080`，保留浏览器的 `Origin`。将 `BENTO_ONE_ORIGIN` 设为用户实际访问的 HTTPS origin，包含非默认端口时也一并填写。更新容器时保留 `bento-web-data`、`bento-mysql-data` 卷和原账号文件。

`docker compose ps` 显示 `healthy` 时，首页已返回 `200`，未登录的 `/api/session` 已返回 `401`，Go 的数据库探针已通过。部署后再检查直接打开任务链接、登录后下载 diff，以及浏览器能否连接 S3 端点。

启动失败时用 `docker compose logs --tail=100 bento-web` 检查容器日志，核对账号文件的读取权限和必需环境变量。停止服务用 `docker compose stop`，恢复原配置后用 `docker compose up -d` 重新启动并检查健康状态。

Go Temporal 调度运行在执行宿主侧，按 [Temporal 接入](HOW-TO-TEMPORAL-DEV.md#接入-bento)独立构建部署。

历史远端构建版本、已验证路径和覆盖范围见 [Web Docker 验收](../40-readiness/WEB-DOCKER-EVIDENCE.md)。

## Keycloak 受邀认证

全新部署可使用现有 Compose 配置及 Keycloak 覆盖文件。该配置由 Bento
提供 `/auth` 登录入口和 `/` 工作区，Keycloak 负责邀请、注册、邮箱验证、设置密码与认证审计。

1. 在 Keycloak Realm 启用 Organizations、邮箱验证及 SMTP，关闭公开注册。建立用于 Bento 准入的组织，保存组织 alias。由管理员通过该组织发邀请，注册邀请使用默认 account client。组织的重定向地址可设为 Bento 的 `/auth`。
2. 创建 confidential OIDC client，开启 Standard Flow 和 S256 PKCE。关闭 Direct Access Grants。添加可选的 `organization` scope，保证 ID Token 包含 `email`、`email_verified` 和组织声明。精确登记 Bento 的 `/api/oidc/callback` 回调和 `/auth` 退出回跳地址。
3. 在受限权限的 `runtime/web.env` 中，设置现有的 `BENTO_ONE_ORIGIN` 及执行服务配置，再设置以下变量。Bento 服务端和用户浏览器均需能访问同一个 issuer。正式环境使用 HTTPS。本机调试可使用环回 HTTP。
4. 以同一个 Compose 项目名启动并验证空数据库初始化。已有部署的账号迁移需单独规划。

| 变量                       | 用途                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `BENTO_OIDC_ISSUER`        | Keycloak Realm 的完整 issuer，例如 `https://id.example.com/realms/bento` |
| `BENTO_OIDC_CLIENT_ID`     | Bento 的 confidential client ID                                          |
| `BENTO_OIDC_CLIENT_SECRET` | 服务端客户端凭据                                                         |
| `BENTO_OIDC_ORGANIZATION`  | 受邀组织的 alias                                                         |

```sh
docker compose -f compose.yaml -f compose.keycloak.yaml up -d --build
```

从 Keycloak 组织发一条测试邀请，确认完成邮箱验证与设置密码后，从 Bento
`/auth` 登录能进入工作区。再次登录应复用 MySQL 中同一个 `owner_id`。
在 Keycloak Realm 的 Events 中启用并查询注册、邮箱验证、凭据更新、登录和退出事件。

Bento 注销会关闭本地账号、撤销业务会话并登记资源清理。完成重新认证后，浏览器也会结束当前 Keycloak SSO 会话。Keycloak 中的身份保留，身份停用或删除由管理员按 Realm 的账号策略处理。

### 远端开发身份环境

[Keycloak 开发 Compose](../../deploy/keycloak/compose.yaml) 定义独立 Keycloak、PostgreSQL、Mailpit、Bento 登录主题和持久卷。将整个 `deploy/keycloak` 目录复制到远端专用目录，在该目录创建权限为 `0600` 的 `.env`，设置 `KEYCLOAK_DB_PASSWORD` 和 `KEYCLOAK_ADMIN_PASSWORD`。使用独立项目名启动：

```sh
docker compose -p bento-keycloak-dev up -d
docker compose -p bento-keycloak-dev ps
```

网络受限的宿主可先导入与宿主架构匹配的镜像，再执行 `up -d --pull never`。Keycloak 管理员用户名为 `bento-dev-admin`。按上节配置 Realm、组织和 Bento 客户端。SMTP 主机为 `mailpit`，端口为 `1025`，使用专用测试发件地址和接收地址。

从开发机将本地 `18491` 和 `18494` 分别转发至宿主回环上的同名端口：

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18491:127.0.0.1:18491 \
  -L 127.0.0.1:18494:127.0.0.1:18494 \
  "$BENTO_DEV_SSH_HOST"
```

Keycloak 管理台走本地 `18491/admin/`，Mailpit 走本地 `18494`。Bento 和浏览器使用同一 issuer。容器化 Bento 需在其网络命名空间内建立可达的转发。重启 Keycloak 使用 `docker compose -p bento-keycloak-dev restart keycloak`，通过发现端点及管理台核对 Realm、客户端和历史审计。保留两个命名卷可保留身份数据和测试邮件。
