# WEB-01 账号和访问控制验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## WEB-01 实栈证据

2026-11-17，候选 `76ea4de85fd09f4e81ea6f03da516d8e90bd9814` 在 A 独占 Compose、Chromium、Keycloak/MySQL、Temporal/OpenShell 与 HTTPS 私有 MinIO 上验收。受控结果 `bento-web01-evidence/results.md` 的 SHA-256 为 `a29888cdf0edeba1303ab24c794dcb8b9414c1939066f9eaf1c30f771dc4a33c`。

- A/B/C 真实组织邀请、邮件验证和 OIDC 回跳通过；未验证和非成员被拒，关闭公开注册，Keycloak 重启后主体和认证审计一致。注销回跳实测要求 ID token 包含 `auth_time`，已在 Workspace 客户端补充内置映射。部署要求见[身份配置](../../../deploy/README.md)。
- 三个 owner 通过真实 HTTPS 上传嵌套项目并读取自己的预览、Task 与补丁。三组跨租户项目、文件和传输请求与不存在资源一致，补丁下载另有两条跨租户对照。B/C 经服务重启及重新登录仍能回读原项目、文件和补丁。私有 S3 拒绝匿名对象请求和错误键、分块号、方法；原签名到期返回 403。
- A 错身份注销返回 401，正确身份回跳 303，两个旧会话和新签发请求均为 401，已提交 Run 在注销后继续完成。另一 Run 经可信退出与错代拒绝后结案，随后清理 A 的 Task、Run、diff、S3 对象和工作区，保留最小审计、IdP 主体及 MySQL 关闭标记。独立 D 对照在注销后、签发期内重启，原 multipart 保留且可继续使用原签名；到期后自动清理。
- 模型续轮单独验证两次 HTTP 200、同 ID 工具、公开检查和持久 Session。正式浏览器用非模型 fixture 产生 SDK 补丁。未覆盖 WEB-A10 完整多账号并发验收。现有 Chromium 回归 20 项通过。正式服务已撤下，原 A 环境健康，旧 `needs_review` 指纹一致。
