# 用户身份与账号数据库设计

## Purpose And Scope

落实 [Web 受邀认证需求](../10-requirements/WEB-AUTH-REQUIREMENTS.md)。Keycloak 是受邀认证部署的身份服务。Bento 保留业务账号、项目与 Run 归属，以及注销清理状态。

## Responsibilities And Dependencies

- NGINX 将 `/auth`、`/auth/*` 和 `/api/*` 代理到 Go Web 入口，再到 task-entry。其余页面走工作区 SPA。认证页由 task-entry 独立提供。
- Keycloak 托管邀请、注册、邮箱验证、密码、身份会话与认证审计。Bento 仅处理 OIDC 回调，使用授权码、S256 PKCE、state、nonce 和签名校验。回调检查已验证邮箱及配置的组织 alias。
- task-entry 通过回环 Go 账号接口写入 MySQL 8.4。现有密码开发模式保留原有入口。Keycloak 部署使用 OIDC 入口。

## State And Failure Handling

- `web_accounts` 以 `owner_id` 为主键，OIDC 账号由 `(oidc_issuer, oidc_subject)` 唯一约束。Go 分配不透明 `owner_id`，并发重复插入后读回同一绑定。OIDC 账号无需本地密码或邀请码摘要。邮箱作为会话展示值。
- OIDC 事务在 task-entry 内存中保存五分钟，成功回调前单次领取。Bento 会话和 Keycloak 会话各自独立。Bento Cookie 固定有效期 24 小时，使用 HttpOnly、SameSite=Lax，HTTPS 下加 Secure。task-entry 重启后重新登录，MySQL 的绑定与关闭状态保留。
- 每次受保护请求重查本地账号状态。无法完成验证或读取账号时拒绝访问。业务注销要求原会话及同一身份重新认证，MySQL 原子写入关闭和待清理状态，既有清理流程按 `ownerId` 重试。Keycloak 身份保留。

## Security And Observability

生产使用 HTTPS，开发环境的环回 HTTP 通过 SSH 隧道访问远端 IdP。认证事件由 Keycloak 保存与查询。Bento NGINX 访问日志使用 URI 路径，省略回调查询参数。凭据和远端地址保存在部署环境中。

## Acceptance

本机 Docker 和远程 Keycloak 的浏览器验证见 [Web Docker 验收](../40-readiness/WEB-DOCKER-EVIDENCE.md)。部署配置见 [Web Docker 部署](../deployments/HOW-TO-WEB-DOCKER.md#keycloak-受邀认证)。
