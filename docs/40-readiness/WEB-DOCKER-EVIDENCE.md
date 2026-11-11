# Bento Web Docker 验收

## 验证范围

2026-11-10，以独立前端提交 `d78dbb8` 和同批 Web Docker 部署改动为基线。在远端 Docker 宿主使用缓存的 `node:24.19.0-bookworm-slim` 构建单镜像，以 `BENTO_ONE_MODE=mock` 启动。部署命令见 [Web Docker 部署](../deployments/HOW-TO-WEB-DOCKER.md)。

## 已验证

- `docker compose config --quiet` 通过。容器从 NGINX 提供前端首页，直接访问任务路由返回 SPA，缺失静态文件返回 `404`。
- 未登录的 `/api/session` 返回 `401`。通过 NGINX 同域登录成功，跨源登录请求被拒绝。
- 使用登录会话创建项目、提交模拟任务并下载 diff。下载返回 `200` 和附件响应头，内容包含预期修改。
- `docker stop -t 60` 后容器以状态码 `0` 退出。临时容器和镜像已清理。

## 未覆盖

远端访问 Docker Hub 受限，本次镜像使用 Node 24 覆盖构建参数。Dockerfile 默认的 Node 22 基础镜像未在该宿主完成整镜像构建。本次只验收 Docker 装配和模拟任务，真实模式的 HTTPS 入口、S3 上传和 OpenShell 执行未在这个镜像内复验。

## Go 入口和 MySQL 本地复验

2026-11-11，使用本机 MySQL 8.4.9、Go API 入口与 task-entry 模拟执行后端完成账号链路。验证并发注册仅一个请求成功，注销后旧会话失效，重启后新密码与注销状态仍生效。另验证错误 Origin 被拒绝，以及 Go API 入口无法访问回环账号路由。

Compose CLI 的 `config --quiet` 通过。渲染配置确认 Web 等待 MySQL 健康检查，两个服务使用同一应用账号密码，MySQL 使用命名卷且端口留在 Compose 网络。该次复验在本机进程中运行 MySQL 和 Web API。Docker 镜像构建、容器联合运行和真实 OpenShell 后端仍待复验。

## Keycloak 受邀登录与 MySQL 绑定（2026-11-11）

Chromium 从 Bento `/` 进入独立 `/auth`，使用本地 Docker 中的 Keycloak 26.8.2、Mailpit 和 MySQL 8.4。Bento 使用当前 Go 账号仓储、task-entry 和带 Keycloak 开关的 Web 构建产物。随后用仓库 Dockerfile 构建 Bento 镜像，经过容器内 NGINX、Go 和 task-entry 重跑浏览器验收。验证容器用本地 VM 的 host 网络访问测试 IdP 和 MySQL。Compose 覆盖配置通过合并检查。执行后端为 mock。

- Keycloak 发出组织邀请。浏览器验证无邀请链接的公开注册被拒绝，并完成受邀注册、邮箱验证和密码设置。首次 Bento 登录前 MySQL 尚无该绑定。
- 首次 OIDC 登录写入 MySQL `(issuer, sub)` 对应的 `owner_id`。并行重复登录以及重启 task-entry 后重新登录均复用该 ID。Docker 验收另确认邮箱已验证的非组织成员仍得不到会话或 MySQL 绑定。
- 工作区退出回到 `/auth`，原会话失效。Bento 注销要求使用原身份重新认证，MySQL 保留账号关闭状态。
- Keycloak Admin REST API 返回注册、邮箱验证、凭据更新、登录和退出事件。

本轮使用本地 SMTP 和 mock 执行，生产邮件投递、真实执行资源清理以及 Keycloak 管理端主动踢人后撤销 Bento 会话未覆盖。

## 远端 Keycloak 开发环境（2026-11-11）

在 OpenShell 所在的开发宿主上使用独立 Docker Compose 项目部署 Keycloak 26.8.2、PostgreSQL 17 和 Mailpit 1.27.10。开发机通过 SSH 隧道连接远端 IdP 和测试邮箱。Bento 工作区、MySQL 8.4 和 mock 执行后端在开发机运行。

Chromium 通过邀请邮件完成注册、验证邮箱和设置密码。公开注册被拒绝。首次登录在本机 MySQL 创建绑定，并行重复登录复用原 `ownerId`。已验证邮箱的非组织成员无法获得会话或绑定。退出和注销重新认证通过。Keycloak Admin REST API 查到注册、邮箱验证、凭据更新、登录和退出事件。重启 Keycloak 后读回 Realm、Bento 客户端和注册审计。

验证范围为开发测试认证链路。生产邮件投递、生产 HTTPS、跨实例业务会话和真实执行资源清理仍待独立验收。[部署复现](../deployments/HOW-TO-WEB-DOCKER.md#远端开发身份环境)

## 工程目录迁移复验（2026-11-11）

PR #17 的提交 `8075d34` 通过 `pnpm check` 与 `pnpm --filter @bento/web test:e2e`。三条 Chromium 用例覆盖本地模拟后端的登录与任务提交、可信核对后的 diff，以及受邀账号注销后拒绝再次登录。迁移后的 Dockerfile 使用 `VITE_BENTO_KEYCLOAK_AUTH=1` 构建成功。这次复验覆盖新源码路径和镜像构建，Keycloak 联合链路以上述专项证据为准。
