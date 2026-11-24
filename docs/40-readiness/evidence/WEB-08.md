# WEB-08 结果审阅与交付验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## 场景补充证据

- **WEB-08 需求汇总**。2026-11-17 B 独占实机（`36ab687`＋私有 Worker）WEB-A13 1/1，三次 Run、同 Session 两次写入、只读与补丁字节对账通过。独立私有标记负例通过，收口 `pnpm check` 与两项 Chromium 回归通过。七服务、两沙箱与传输已停，临时凭据回收；原桶卷及结果保留。B 受控租约保留 `web-a13/full-stack/a13-auth/a13-output.*` 和 `web-a13/orchestrator-state/{business,authority}.sqlite`。 2026-11-19 `38e32ae` 本地分层验收补齐四种检查公开状态，必需子项均通过。
- **WEB-08-04 检查失败或无法执行**。2026-11-19 `38e32ae`：Worker bootstrap/projection 8/8、HTTP focused 2/2、独立 Chromium 1/1。TrustedTaskCheck 注入 pass/fail/skip/unavailable，经白名单投影→HTTP/Store→公开 DTO→页面，四状态/输出逐项一致，非通过不误显通过、not_run.output=null。私有诊断额外字段被 HTTP 拒绝，合成标记不出现在 API/DOM/补丁。pnpm check、Chromium 22/22 通过；不证明任意公开正文通用脱敏或真实工具支持全部 outcome，未跑模型/OpenShell/OIDC/S3。
