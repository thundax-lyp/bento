# WEB-07 SDK Exec 结果证据 RUNBOOK

2026-11-17。独立代码候选，审核已通过。基线 `349d09fa24c171aa75d880a0984a18b2264751ff`，分支 `codex/web-07-sdk-outcome`。从 `/Volumes/storage/workspace/bento-a` 执行。T0 审核通过后，只提交本 RUNBOOK，保留未跟踪的 OpenShell 后续稿。每步验收通过后删除该步并提交。STOP 保留现场，回报最后 PASS、具体失败断言与复现命令。

## 目标和边界

[WEB-07/WEB-A12](../10-requirements/WEB-REQUIREMENTS.md) 要求未知副作用阻止重试。[停止与双检查点](./WEB-DESIGN.md) 的现有 SDK retry 门禁继续失败关闭。此切片只建立受信 SDK ingress 的持久结果证据，并证明该证据单独无法开放 retry。#50 的 DSH 检查点校验已在主线。私有卷、实际隔离、部署启用和真实验收分别留给后续。无公开接口、Store 结构、Worker 协议、部署配置或 Readiness 变更。无需 A 实栈租约，也不触碰 B。

正常入口为 `serveExecution → SingleHostExecution.sdkIngress → createSdkIngress → forward`。现有 `Authority.reserveOperation(token,id,input)` 按有效 token 绑定 RUNNING session、generation 与原有 fingerprint，初值 UNKNOWN。 `Authority.observeOperation(session,generation,id,outcome)` 保存终态 SUCCEEDED/FAILED。无新增字段或历史迁移。证据只来自同一上游 mTLS 响应。普通 commandHost 的组装继续不安装可选证据 decoder，现有部署和普通 SDK proxy 路径继续沿用旧行为。

| 基线文件                                              | 行范围                      | LOC |
| ----------------------------------------------------- | --------------------------- | --: |
| `apps/orchestrator/openshell/sdk-ingress.ts`          | 1–267                       | 255 |
| `apps/orchestrator/openshell/worker-gate.ts`          | 20–62                       |  37 |
| `apps/orchestrator/openshell/authority.ts`            | 457–507                     |  47 |
| `apps/orchestrator/openshell/single-host.ts`          | 260–266                     |   7 |
| `apps/orchestrator/execution-service/command-host.ts` | 19–83, 117–145              |  93 |
| `apps/orchestrator/execution-service/service.ts`      | 208–216, 417–427, 1307–1354 |  66 |
| `apps/orchestrator/execution-service/service.test.ts` | 3850–3920, 4171–4259        | 159 |
| 合计                                                  | 7 个代码文件                | 664 |

计数排除空行、纯注释和拟新增测试。用到的既有授权、账本、停止门禁和 HTTP 测试按直接相关段计入。

## T0：锁定独立稿

前置状态：HEAD 为指定基线。允许修改：本文件。禁止修改：原实栈草稿、生产代码与部署。

执行：核对独立审核结论。确认 git 暂存只有本文件后提交审核稿。

验证：

```bash
git rev-parse HEAD
git status --short
pnpm exec prettier --check docs/30-designs/RUNBOOK-WEB-07-SDK-OUTCOME.md
git diff --check
```

PASS：基线、文件范围、审核稿 blob 完全一致。STOP：归属或事实不符。

## T2：锁住 SDK retry 生产门禁

前置状态：可选 SDK decoder、可信 grant 账本和响应验证已提交，36 项 focused 测试及 Orchestrator typecheck 通过。允许修改：`apps/orchestrator/execution-service/service.test.ts` 和本 RUNBOOK。禁止修改：`service.ts::stopAndProve`、正常 HTTP/API、生产 host opt-in、Readiness、私有配置。

执行：

1. 在 `service.test.ts` 新增 `SDK evidence does not enable Task retry without trusted workspace recovery`。复用 `taskRetryTestClient`、`taskRetryTestInput`、`localHost`、Task 停止 barrier 和 `fixtureSdk`。给 host 配置非空 `sdk.decodeExecEvent` 和故意返回肯定结论的 `taskRecovery.retryObservation` spy。Worker fixture 写入后等待取消，使用既有可信退出观察，确保 `takeover` 真实推进该测试的控制账本至新代 READY，拿到正确旧代退出记录。此测试特意不发 SDK 请求，账本为空，模拟最容易误判的条件。
2. 断言取消后原 Task Run 为 needs_review、同 Task 的续写和 retry 均 409，retry reason 为 needs_review，无 stop proof/attempt/restore 调用，且肯定 recovery observation 未被消费。对有无 decoder 两个独立临时状态运行相同断言。SDK 已明确完成仍不能让生产重试抢先打开；代码检查确认唯一 SDK guard 保留，默认启动配置同样没有 opt-in。
3. 执行最终验证后按 WORKER 规则删除本 RUNBOOK 并提交同一步。正式设计仍描述现有 SDK retry 门禁。仅本独立切片进入 PR，保留未跟踪实栈草稿。通过当前 HEAD 的 CI 和 Codex 审查后依 MASTER 的合入顺序交付。

验证：

```bash
pnpm --filter @bento/orchestrator exec node --import ../../register-paths.mjs --experimental-strip-types --test --test-name-pattern='SDK evidence does not enable Task retry' execution-service/service.test.ts
pnpm check
git diff --check
```

PASS：正反 decoder 对照场景均运行，保守门禁成立，全仓检查通过，PR 最终差异限本次代码/测试。STOP：空账本、decoder 或肯定宿主返回独立开放 retry；禁止以私有卷后续工作替代该负控。WEB-07 保持「部分实现」。
