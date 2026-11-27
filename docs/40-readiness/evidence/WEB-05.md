# WEB-05 执行环境验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## 场景补充证据

- **WEB-05 需求汇总**。2026-11-17，B 独占 Compose、Chromium 与 OpenShell 实机（Web 候选 `484dcc7`）1/1 通过。真实邀请、关页找回、原址重准备、两次上传、健康后轮换、冻结快照、续写与独立读取均通过。五次 Run 各一次派发和结果回执，凭据扫描零匹配。应用及浏览器已停，STS 已撤销。两条历史待核对 Run 及证据保留。本轮 `7d4eb12` 本地 HTTP/SQLite/Chromium 6/6 补齐 WEB-05-04。多账号并发与换宿主恢复另按 WEB-06 验收。
- **WEB-05-04 提交响应丢失**。2026-11-19，`7d4eb12`，本地真实 HTTP/SQLite/Chromium；`pnpm --filter @bento/workspace-web exec playwright test -c playwright.task-submission.config.ts` 6/6。blank/snapshot 页面创建→上游 202 后 abort→同键 200 同 Task；inputs/inputDigest/environmentVersion 不变，prepare/execute/Run/user_message/receipt 各 1，snapshot 变源后 sourceReads 仍 1；同库重开同回执。身份/Worker/对象读取为 fixture，未复验外部模型/OpenShell/S3，实栈证据沿用 #52。
