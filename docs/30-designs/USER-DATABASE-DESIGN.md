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

## 附录：早期本地鉴权模型草案

以下模型保留为历史设计参考。Redis 会话、Go 验证外部凭据和本地多方式账号表属于草案；本轮部署与验收采用上文的 Keycloak 设计。

### 目的与范围

Bento 使用 MySQL 8.4/InnoDB 持久化 Web 用户、用户配置、鉴权方式和凭据。Web 登录会话存于 Redis，由 TTL 管理。Go 控制层负责这些数据的写入与鉴权决策。Web API 从已验证的登录会话取得 `ownerId`，以该身份访问项目与 Run。

本文定义新部署的目标结构。从空库初始化，同一部署重启后继续使用已提交的数据。当前实现将账号、邀请码摘要、密码摘要和注销标记放在 `web_accounts`，登录会话和密码尝试计数在 task-entry 内存中。下文为待实现的目标设计。首批交付受邀注册、密码登录、退出、用户配置和注销。

目标模型覆盖密码、短信及 GitHub、Google、微信登录，支持显式绑定、多因素认证、可信设备、账户恢复和安全审计。项目与 Run 的归属、执行授权、DSH Session 及 OpenShell 沙盒按平台架构处理。Web 登录会话仅用于用户访问 Web API。 [平台架构](../research/architecture.md) · [现有 Web 接口与部署配置](../../apps/workspace/api/README.md)

### 鉴权边界

Convivium 由可信 adapter 注入 `CallerBinding`。其 DSH 入口从实际 Agent Session 查询持久化 ownership，同时核对身份、角色、生命周期和能力状态。当前 Captain 使用单 Host 的本地身份，Web 多用户登录由 Bento 自己定义。 [Convivium Meeting Interface](https://github.com/thundax-lyp/convivium/blob/8d0ba848/docs/20-interfaces/MEETING-INTERFACE.md) · [Convivium caller resolver](https://github.com/thundax-lyp/convivium/blob/8d0ba848/plugin/src/dsh/caller-resolver.ts)

Bento 沿用服务端解析调用者身份的原则。Go 校验 Cookie 对应的会话、鉴权方式和用户状态，构造内部调用上下文 `{ ownerId, sessionId }`。浏览器可提交目标资源 ID，服务端用 `ownerId` 与资源 ID 联合查询。执行服务仍独立校验资源归属。请求中的 owner、身份头和角色字段均无法赋予权限。服务间 bearer 由部署配置提供，执行授权由执行宿主按 Run 及执行代次签发。

### MySQL 表结构

使用 UTC `DATETIME(6)` 记录业务时间。除标明可空的字段外，列均为 `NOT NULL`。各表的 `user_id` 均为 `VARBINARY(128)`，外键引用 `users.id`。业务写入显式控制注销与清理顺序。

| 表                          | 字段                                                                                                                                                                                                                                                                | 主键、索引与约束                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                     | `id VARBINARY(128)`、`account VARBINARY(128)`、`status ENUM('invited','active','closed')`、`security_epoch BIGINT UNSIGNED DEFAULT 1`、`created_at`、`activated_at`（可空）、`closed_at`（可空）、`purged_at`（可空）                                               | `PK(id)`、`UNIQUE(account)`。`id` 是服务端分配的不透明稳定 ID，对应现有 `ownerId`。账号名保持现有 ASCII 和大小写敏感语义。`security_epoch` 用于全账号撤销。索引 `(status, purged_at, id)` 供清理扫描。仅关闭账号可以记录清理完成时间。 |
| `user_settings`             | `user_id`、`locale VARCHAR(35)`、`time_zone VARCHAR(64)`、`revision BIGINT UNSIGNED`、`updated_at`                                                                                                                                                                  | `PK(user_id)`。每个已激活用户一行。初始值 `zh-CN`、`UTC`、`1`，Go 校验支持的语言和 IANA 时区。                                                                                                                                         |
| `user_invitations`          | `user_id`、`token_hash BINARY(32)`、`issued_at`、`expires_at`                                                                                                                                                                                                       | `PK(user_id)`、`UNIQUE(token_hash)`。每个待注册用户最多一个有效邀请，重发时替换原记录。过期时间晚于签发时间。                                                                                                                          |
| `auth_methods`              | `code VARBINARY(32)`、`protocol`、`login_enabled BOOLEAN`、`binding_enabled BOOLEAN`                                                                                                                                                                                | `PK(code)`。系统级方式定义。协议和安全策略由 Go 实现，开关控制登录与新绑定。                                                                                                                                                           |
| `auth_providers`            | `id BINARY(16)`、`method_code`、`provider_key`、`issuer`（可空）、`client_id`、`redirect_uri`、`secret_ref`（可空）、`enabled BOOLEAN`                                                                                                                              | `PK(id)`、`UNIQUE(provider_key)`、`UNIQUE(id, method_code)`、`FK(method_code) → auth_methods.code`。同一方式可配置多个应用实例。                                                                                                       |
| `auth_identities`           | `id BINARY(16)`、`user_id`、`method_code`、`provider_id`（可空）、`namespace VARBINARY(255)`、`subject VARBINARY(255)`、`status ENUM('enabled','disabled','revoked')`、`verified_at`、`created_at`、`revoked_at`（可空）、`session_epoch BIGINT UNSIGNED DEFAULT 1` | `PK(id)`、`UNIQUE(id, method_code)`、`UNIQUE(user_id, id)`、索引 `(user_id, status)`。`method_code` 引用方式定义，第三方使用 `FK(provider_id, method_code) → auth_providers(id, method_code)`。绑定唯一性见下文。                      |
| `user_password_credentials` | `identity_id BINARY(16)`、`method_code VARBINARY(32)`、`salt BINARY(16)`、`password_hash BINARY(32)`、`scrypt_n`、`scrypt_r`、`scrypt_p`、`set_at`                                                                                                                  | `PK(identity_id)`、`FK(identity_id, method_code) → auth_identities(id, method_code)`、`CHECK(method_code = 'password')`。首批参数为 `N=32768,r=8,p=3`。                                                                                |
| `auth_factors`              | `id BINARY(16)`、`user_id`、`kind`、`identity_id`（可空）、`status`、`verified_at`、`revoked_at`（可空）                                                                                                                                                            | `PK(id)`、`UNIQUE(id, kind)`、索引 `(user_id, status)`。短信因子通过 `FK(user_id, identity_id) → auth_identities(user_id, id)` 引用已验证手机号。TOTP 与 Passkey 的专用凭据通过因子 ID 及类型绑定。                                    |
| `totp_credentials`          | `factor_id BINARY(16)`、`kind`、`secret_ciphertext`、`key_ref`、`last_accepted_step`（可空）                                                                                                                                                                        | `PK(factor_id)`、类型约束与复合外键指向 TOTP 因子。条件更新 `last_accepted_step` 防止同一时间步重放。                                                                                                                                  |
| `passkey_credentials`       | `factor_id BINARY(16)`、`kind`、`credential_id VARBINARY(1024)`、`public_key`、`sign_count`、`rp_id`                                                                                                                                                                | `PK(factor_id)`、`UNIQUE(credential_id)`、类型约束与复合外键指向 Passkey 因子。                                                                                                                                                        |
| `auth_recovery_codes`       | `id BINARY(16)`、`user_id`、`code_hash BINARY(32)`、`issued_at`、`consumed_at`（可空）                                                                                                                                                                              | `PK(id)`、`UNIQUE(user_id, code_hash)`。用条件更新原子消费，重新生成时撤销上一批未使用的码。                                                                                                                                           |
| `auth_devices`              | `id BINARY(16)`、`user_id`、`display_name`、`first_seen_at`、`last_seen_at`、`revoked_at`（可空）                                                                                                                                                                   | `PK(id)`、`UNIQUE(user_id, id)`、索引 `(user_id, revoked_at)`。用于展示和管理已登记设备。                                                                                                                                              |
| `auth_device_trust`         | `id BINARY(16)`、`user_id`、`device_id`、`token_hash BINARY(32)`、`security_epoch`、`granted_at`、`expires_at`、`revoked_at`（可空）                                                                                                                                | `PK(id)`、`UNIQUE(token_hash)`、`FK(user_id, device_id) → auth_devices(user_id, id)`。仅完成策略要求的 MFA 后签发。                                                                                                                    |
| `auth_events`               | `id`、`user_id`（可空）、`operation_id`（可空）、`event_type`、`outcome`、`created_at`、脱敏上下文                                                                                                                                                                  | 追加写，索引 `(user_id, created_at)`。成功绑定、换绑、恢复等身份写操作以 `UNIQUE(operation_id, event_type)` 约束提交结果。同一事务写入身份变更和事件。                                                                                 |

#### 身份绑定与凭据

用户、鉴权方式和鉴权数据分三层。运行时按 `users → auth_identities → 专用凭据` 解析归属，`auth_methods` 和 `auth_providers` 提供系统级配置。外部身份的所有权由提供方响应验证。MFA 因子单独登记，绑定手机号后仍需显式启用短信因子。

`namespace` 和 `subject` 由服务端从验证结果生成。OIDC 使用已验证的 `iss/sub`，GitHub 使用稳定账号 ID，微信按适用的 AppID/OpenID 命名空间，手机号先规范化为 E.164。相同外部身份可跨多个客户端配置返回，唯一键按身份命名空间设计。 [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability)

启用和停用的绑定都保留身份占用。撤销后允许重新绑定，使用生成列对未撤销记录建立唯一键 `(namespace, live_subject)`，撤销时 `live_subject` 为 NULL。密码绑定使用本地账号命名空间，另以生成列约束每个用户只有一个未撤销密码绑定。换绑须在同一事务撤销旧绑定、写入新绑定及审计事实。 [MySQL 唯一索引](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)

#### Redis 认证事务与挑战

认证事务与正式会话有独立的键空间。事务包含操作 ID、目的、发起会话、已确认用户、方式、提供方、过期时间和当前阶段。登录、绑定、换绑、解绑、恢复及重新认证各自使用明确目的。第三方回调从事务恢复绑定目标，登录入口仅查找已验证且启用的绑定。首次注册仍走独立的受邀注册入口。

事务阶段为 `pending → primary_verified → mfa_required / ready → completed`。错误和到期进入终态。OAuth 授权码使用 PKCE，回调验证原事务、提供方与精确配置的回调地址，OIDC 另核对发行方、受众与 nonce。挑战绑定事务、目标身份及所用因子，设 TTL 和尝试上限。Redis 以原子条件更新领取回调、消费挑战和推进状态。密码尝试窗口也用 Redis 限流键管理。 [OAuth 安全最佳实践](https://www.rfc-editor.org/rfc/rfc9700.html)

涉及 MySQL 写入的操作以同一 `operation_id` 提交审计结果。回调重试在核对原事务和调用方归属后查已提交结果。结果未知时先核对提交事实，仍无法确认则要求发起新的认证事务。会话签发只允许成功消费一次 `ready`。Redis 或网络故障导致签发结果未知时，重新认证后才签发新的会话。

#### Redis 登录会话

键为 `bento:web:session:<token SHA-256 十六进制摘要>`，值包含 `sessionId`、`identityId`、已验证因子与认证时间、签发时的 `sessionEpoch` 和 `securityEpoch`。用 Redis `SET NX EX 86400` 原子写入并设置 24 小时固定有效期。Redis 会话实例关闭 RDB 和 AOF 持久化。Go 或 Web 进程重启后可继续使用 Redis 中未过期的会话。Redis 重启或会话键丢失后，用户重新登录。

每次鉴权先查 Redis，再从 MySQL 核对方式与绑定状态、用户状态及两级会话代次。停用方式或替换凭据时，在 MySQL 事务内递增 `session_epoch`。旧会话即使仍在 Redis，或者方式随后重新启用，也会因代次不符而失效。注销通过关闭用户并撤销其身份绑定撤销所有会话。失效记录由 TTL 回收。

#### 用户偏好

`user_settings` 首版定义语言与时区作为用户偏好。配置接口以当前会话用户为目标，更新时用 `revision` 做条件写入，冲突返回 `409`。鉴权、资源归属、配额与系统密钥由各自的服务端记录管理。

### 生命周期与事务

账号状态为 `invited → active → closed`。注册、登录验证与注销的 MySQL 事务锁定同一 `users` 行并重查状态。涉及同一用户的事务先锁用户行，再锁身份绑定，最后访问凭据或因子。Redis 写入在 MySQL 事务之外执行。配置和邀请操作也先锁用户行。

| 操作         | 处理与失败语义                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 签发邀请     | 在事务中创建待注册用户及邀请。邀请码用 32 字节安全随机数生成，数据库存 SHA-256 摘要与有效期。重发只允许待注册用户，并在同一事务替换摘要。                                                                                                                                                                |
| 注册         | 计算密码哈希后开启事务，锁定用户，复查邀请摘要与有效期。创建启用的密码方式、密码凭据和默认配置，激活用户并删除邀请，在同一事务提交。并发请求只有一个能消耗邀请码。                                                                                                                                       |
| 登录         | 在 Redis 中占用密码验证额度，每个账号每 60 秒最多 10 次。事务外计算 scrypt，验证成功后锁定用户及身份绑定，核对状态、凭据及两级会话代次，再结束 MySQL 事务。若带有同用户的有效旧会话，先删除旧 Redis 键，再写入新会话。Redis 确认写入后才返回新 Cookie。并发停用或注销由后续的 MySQL 状态与代次校验拦截。 |
| 校验会话     | 计算 Cookie token 摘要并读取 Redis。查不到会话时返回 `401`。在 MySQL 中校验系统方式、身份绑定与适用的提供方均启用，两级代次一致且用户为 `active`，据此解析 `ownerId`。                                                                                                                                   |
| 退出         | 删除当前 token 对应的 Redis 键，再清除浏览器 Cookie。键已过期或已删除时返回成功，Redis 故障时返回可重试错误。                                                                                                                                                                                            |
| 停用身份绑定 | 锁定用户和该身份绑定，在 MySQL 事务内将绑定设为 `disabled` 并递增会话代次。                                                                                                                                                                                                                              |
| 注销         | 验证当前密码，锁定用户后重新校验当前会话、用户状态及已验证的密码凭据。在 MySQL 事务内关闭用户，撤销其身份绑定、因子和设备信任，删除凭据、恢复码、邀请和配置。保留关闭的身份记录以防账号名或 owner 被复用。                                                                                               |
| 清理与恢复   | Go 在启动和定期扫描时选取 `status = closed AND purged_at IS NULL` 的账号，按 `ownerId` 生成临时清理任务。依赖均确认完成后更新 `users.purged_at`。                                                                                                                                                        |

注销提交后，后续请求的会话校验立即失败。注销前已经通过鉴权的请求由既有在途处理和执行服务的 owner drain 约束。任务受理与 owner drain 的并发顺序由执行服务确定。

清理任务只存在于 Go 进程内。MySQL 保留账号已关闭与资源已清理两个业务事实。清理调用按 `ownerId` 幂等，等待在途工作收敛，并分别确认执行服务和空间资源已清理或不存在。依赖不可用或结果未知时，`purged_at` 保持为空，由后续扫描重试。进程在清理完成与更新 `purged_at` 之间退出时，重新核对依赖后补记完成时间。

#### 多方式登录与恢复

- 第三方绑定、解绑和换绑要求当前会话近期重新认证。提交时重查用户状态和原会话归属，验证新的外部身份，并保护最后一条可用登录路径。邮箱用于资料展示，账号关联以已验证身份键为准。
- 新设备完成主认证后，使用独立已登记因子完成 MFA，再签发业务会话。启用新设备 MFA 策略时，首次受邀注册须在签发业务会话前登记 TOTP 或 Passkey，并领取一次性恢复码。使用短信作主认证时，同一手机号的短信挑战无法满足第二因子要求。
- 可信设备由独立随机令牌证明，数据库保存摘要、期限和撤销状态。设备指纹只作为风险信号。改密、账户恢复或其他全账号撤销操作递增 `users.security_epoch`，旧会话和设备信任失效。
- 同源 Web 使用固定期限 Redis Cookie 会话。Refresh Token 族仅在需要支持独立客户端的长登录时纳入接口设计，届时明确轮换、重放检测及撤销边界。

### 安全与可观测性

- 生产 Cookie 使用 `__Host-` 前缀、`Path=/`、`Secure`、`HttpOnly` 和 `SameSite=Strict`。Cookie 保存 32 字节随机 token 的 Base64URL 编码，Redis 用其 SHA-256 摘要定位会话。修改请求继续校验可信 Origin。
- 凭据由 Go 鉴权层读取和验证。业务 API 只接收已解析的用户身份。Redis 或 MySQL 不可用时返回 `503`，认证和受保护操作拒绝放行。未知账号、无效密码及不可登录状态统一返回登录失败。达到验证限额返回 `429`。
- 记录请求 ID、操作、结果码及可用的内部用户 ID。监控登录拒绝、限流、数据库错误与清理积压。日志省略密码、邀请码、Cookie、摘要和数据库连接凭据。

### 验收

1. 空 MySQL 库初始化成功，邀请只能成功注册一次。并发注册后仅有一条启用的密码方式、一条对应凭据和一份默认配置。凭据类型和方式不匹配时，数据库拒绝写入。
2. 用户配置从 MySQL 读取。应用进程重启后，Redis 中未过期的登录限额仍有效。Go 或 Web 重启时 Redis 会话仍有效。Redis 重启后旧 Cookie 需要重新登录。并发配置写入时，过期 revision 返回 `409`。
3. 越权访问、伪造 owner、无效会话及已退出会话无法读取目标资源。登录成功后使用新 token。
4. 停用方式与登录并发时，该方式签发的会话全部失效。重新启用后，停用前的 Cookie 仍失效。注销与登录并发时，已关闭账号没有可用会话。清理中断后，Go 重启能从已注销且尚未标记清理完成的账号重建任务，确认清理后写入 `purged_at`。
5. MySQL 或 Redis 故障时鉴权拒绝放行，注册和注销事务失败时各表保持一致。MySQL、Redis、Go 和实际 Web API 的联合验收通过后再更新部署说明。
6. 两个用户并发绑定同一外部身份时仅一方成功。重复回调可读回已提交结果，无法跨账号引用凭据或因子。
7. 新设备完成主认证后仍须完成 MFA。撤销因子、设备信任或执行账号恢复后，旧凭据和会话按对应策略失效。
