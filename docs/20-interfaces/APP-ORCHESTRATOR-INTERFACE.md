# 应用 API 与 Orchestrator

个人端 API 使用 `BENTO_SERVICE_BEARER` 调用原有内部接口，账号由 API 从本端会话解析，并通过 `X-Bento-Owner-Id` 传给 Orchestrator。管理端 API 使用独立的 `BENTO_ADMIN_SERVICE_BEARER`，通过 `X-Bento-Admin-Subject` 传递已验证的管理 Realm OIDC subject。浏览器只访问各自的应用 API。

## 管理端诊断

- `POST /v1/admin/workspaces/{workspace}/diagnostic-runs` 接受单个 UUIDv4 `Idempotency-Key`。服务端使用固定诊断指令提交 Run，返回 `202` 和 Run 视图。重试同一 Workspace 和键返回 `200` 及原 Run。
- `GET /v1/admin/workspaces/{workspace}/diagnostic-runs/{run}` 独立回读该 Workspace 的管理端诊断 Run，返回 `200` 和 Run 视图。不存在、归属不匹配或普通 Run 返回 `404`。
- 首版 Workspace ID 对应现有执行项目 ID。两端部署管理配置使用 `BENTO_ADMIN_WORKSPACE_GRANTS` JSON 数组，每项含 `subject`、`owner` 和 `workspace`。每个 subject 与 Workspace 组合须唯一。两端按服务端授权配置核对范围，Orchestrator 使用授权条目的 owner 和项目 ID 查权威记录。管理 API 凭据仅能提交和读取诊断。
- 未识别凭据返回 `401 unauthorized`。个人端凭据调用管理命名空间返回 `403 caller_denied`。管理端凭据请求未授予的方法或路由返回 `403 operation_denied`。Workspace 未授权返回 `403 workspace_scope_denied`。拒绝发生在写入 Run 和签发执行授权之前。
- 诊断使用现有项目 Run 执行链路和并发限制。固定指令要求报告是否能列出 Workspace，并要求不改文件。指令由既有执行器处理，使用该 Run 的执行权限。

切换 Go 权威账本时保留路由、身份及错误语义、Run 归属校验和幂等行为。回读改由接管后的权威来源提供。
