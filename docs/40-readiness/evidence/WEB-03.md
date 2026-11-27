# WEB-03 空间额度与文件生命周期验收证据

[返回 Readiness](../CURRENT-READINESS.md)。

## 空间额度与删除验证

上传候选、用量基线和共享测试背景见 [上传规格与验证基线](WEB-02.md#上传规格与验证基线)。

- **WEB-A03**。同账号实存两个 100,000,000 字节对象，HEAD 和 multipart 回读通过，用量到达 200,000,000 已保存、0 预占。额外 1 字节返回 409，删除一个后仅一笔并发预占成功，取消和确认清理后额度可复用，最终输出 `WEB_A03_PASS`。受控时钟 API 5/5，覆盖过期、取消与删除后的存储确认及额度回收。
- **WEB-A04 / WEB-A05**。本地空间 API 18/18（含 A04 六项），使用实际 HTTP、SQLite 和受控存储 fixture，覆盖丢回执、缺块、错大小、同库重开及取消和完成竞态。A05 通过个人 API 与 Orchestrator 双 HTTP 验证活跃 Run 阻塞项目删除，终态后回收及原入口失效。定向 Chromium 9/9 覆盖目录、大小、预览、下载及删除界面。真实 S3 与外部执行联合运行仍待独立验证。
- **WEB-A05 B 独占实栈（2026-11-18）**。候选生产基线 `6b8eefa`，验收夹具 `e7a4cfb`。实际使用严格 TLS Chromium、OIDC、私有 MinIO 与脚本化模型响应驱动的真实 DSH/OpenShell。用 [WEB-A05 配置](../../../apps/workspace/workspace-web/tests/playwright/playwright.web-a05.config.ts) 串行运行 1/1（11.2 分钟）。单文件删除前浏览器下载摘要一致。观察到 deleting 仍记原额度，S3 HEAD 缺失后额度只回收一次，重复 DELETE 为 204。原 Task、Run、结果版本和两份补丁字节一致。
- **WEB-A05 multipart 与项目删除**。仅上传一块 16,777,216 字节，独立 ListParts 确认。取消进入 cleaning 时仍预占 16,777,217 字节，项目 DELETE 返回 409 upload_pending。签名围栏到期后，核对分块及未登记对象缺失、预占归零，随后整项目确认删除。项目、任务、Run、结果及下载入口均返回 404，重复删除返回 204，S3 对象、Session、沙盒和卷均回收。B 本轮环境已撤场，容器、网络、卷与监听回读为空。
- **WEB-A05 验证边界**。同步 A #61 的 `0b2a9a6` 后，逐项确认生产 API、Web、Orchestrator、Worker 和部署入口无差异。共享删除 API 22/22、Chromium 5/5、`pnpm check` 通过。未覆盖 WEB-03-07 逐状态门禁、真实外部模型及真实存储故障注入。清理故障期间保持额度的因果断言沿用本地 WEB-A03/04 回归。
- **撤场**。测试对象和 multipart 均已回收，账号用量归零。已撤下候选 Workspace，现有 A 服务及原开发栈指纹与起点一致。严格 TLS 回读 Web 404 和 S3 403，临时用户、存储授权及验收卷已清理。
- **WEB-03-07**：`node --import ./register-paths.mjs --test apps/workspace/workspace-api/tests/space-deletion-states.test.ts` 13/13通过。个人API→httpBackend→Orchestrator私有HTTP→Store均为生产实现，两份SQLite同库重开；queued/running/recovering/cancelling/needs_review各自对项目/被引用文件DELETE重复返回409 project_busy，冻结输入/持久引用/物理对象/下载与额度不变。preparing/workspace_restored/history_restored/blocked四种retry预留及queued新Run承接分别对账。failed/cancelled/succeeded终态与Store闭合审计fixture后删除放行；父项目仍存在时重复文件DELETE204不重复释放，随后整项目删除及重复DELETE204、原Task/项目/下载404。
