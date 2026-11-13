# Web 单轮任务找回与交付恢复 RUNBOOK

## 状态与执行者契约

2026-11-13，待 MASTER 安排独立审核。绑定 checkout `/Volumes/storage/workspace/bento-a`，调查基线 `1803ad643fde18a470ae6d08cb4d891b94e285c2`。当前阶段只交付草稿。任务分支名由 MASTER 在审核后派发。草稿路径受仓库 ignore 规则约束，获准开工后单独提交时用 `git add -f -- docs/30-designs/RUNBOOK-WEB-RUN-REOPEN.md`。T0 由作者完成，WORKER 获准后按 T1–T4 顺序执行。每步通过后按 [WORKER Skill](../../.agents/skills/bento-runbook-worker/SKILL.md) 移除该步并提交，最后一步删除本文件。B 独占 10.51 的隔离回滚。本任务仅使用本地 fixture。共享 Readiness 时 B 先合入，本任务随后在 B 已合入的基线上复验并更新对应两行。

PASS 须同时满足命令退出码 0、相关用例实际运行和列出的断言。STOP 时保留现场，向 MASTER 报告最后通过的步骤和提交、文件与符号、最小复现、脱敏实际输出和继续所需决定。临时浏览器上下文和 fixture 随测试结束关闭，Playwright 管理本地子进程。本任务没有需要回滚的持久状态。若端口被占用或 Chromium 不可用，停止并报告，不复用外部服务。

## 目标与证据

从工作台的独立「任务」入口选中执行项目，用状态和关键字找到已受理的 Run，进入稳定地址读取原要求、最新状态、摘要及当前 Run 的可交付补丁。临时读取失败可在原地址恢复。重新登录可由同一入口查找原账号记录。

- [WEB 需求](../10-requirements/WEB-REQUIREMENTS.md)「页面与入口」要求任务按项目和状态筛选、搜索并显示摘要和更新时间。现有 `apps/workspace/web/src/pages.tsx::Composer` 的「最近任务」跟随提交草稿所选项目，缺独立入口、状态过滤、关键词和时间。保留该快捷入口。独立完成「任务」入口在当前单轮模型下的可验收行为。
- WEB-06、WEB-A08、WEB-A11、WEB-A13 的原 Run 找回和状态回读。已有 `apps/workspace/web/e2e/task.spec.ts` 的刷新、越权、待核对转成功和取消回读，基线 4 个通过。作者用临时 Playwright route 探针复现：首次详情持续返回 503 时 `apps/workspace/web/src/main.tsx` 的详情 loader 落入通用路由错误页，无重试控件。随后让同一详情成功、diff 首次返回 409，保持页面并让服务端变为 200，3.5 秒内请求仍为一次且无下载。探针已清理。另用原 demo/guest 注册与导入流程验证 T3 的关闭时序，独立启动 8 次本地 Chromium 与 mock，8 次均捕获相同 Run 关闭前后为活跃且关闭期间成功。该探针仅覆盖关闭窗口，已清理。
- WEB-06、WEB-08、WEB-A08、WEB-A13 的单轮结果交付。现有 `apps/workspace/web/src/pages.tsx::RunDetails` 已使用同一地址读取和下载，`apps/workspace/web/src/ui.tsx::DiffPreview` 已支持逐文件、原文降级和空补丁。详情和补丁错误缺显式恢复入口，现有下载和预览仅凭缓存存在性渲染。继续使用 `apps/workspace/web/src/file-diff.ts::splitFileDiff` 的完整解析和原文降级。该文件无需改动。
- [Web 接口](../20-interfaces/WEB-INTERFACE.md#任务与补丁--现有) 固定现有路径、内容类型及 401、404、409 语义。[Web 设计](WEB-DESIGN.md#提交与交付) 指定原地址、单轮基线、轮询、公开摘要与待核对行为。[整体架构](../00-governance/ARCHITECTURE.md) 固定执行状态归 Orchestrator，浏览器只读投影。

## 契约与不变量

- 只读请求依序使用 `GET /api/session` 的 `{account:string}`、`GET /api/projects` 的 `{projects:Project[]}`、所选执行项目的 `GET /api/projects/{projectId}/runs` 的 `{runs:Run[]}`、原 Run 的 `GET /api/projects/{projectId}/runs/{runId}` 和同路径追加 `/diff`。下载追加 `?download=1`。服务端负责 owner 校验和所有 ID、状态、时间与补丁；客户端从项目列表和各 Run 详情消费数据。禁止从本地缓存重建授权，禁止在恢复链路 POST。
- `Project` 的 `id,name,createdAt` 为必需 string，`status` 为 `importing|ready|failed`。`Run` 的 `id,projectId,sessionId,createdAt,updatedAt` 为必需 string，`status` 沿用现有八值，`summary?:string`，详情另有 `prompt?:string`。更新 Web 类型时补齐这些正式必需字段，不给运行时缺字段合成值。摘要、要求、检查数据不存在时不推断。项目与 Run 查询 key 沿用账号、项目和 Run 隔离。运行状态和结果使用服务端原值。
- 工作台任务页读取所选项目列表，切换项目时不显示上一项目缓存。详情路径继续为 `runUrl(projectId,runId)`，路由缺参数仍为 404。详情 401 走既有会话失效流程；404 与越权同样隐藏历史数据和动作。临时读取错误可显示最后确认的详情。取消和交付只使用当前账号、项目、Run 的查询快照，并要求 `run.isSuccess && run.fetchStatus === 'idle' && online`；后台回读中的成功缓存也冻结入口。待核对固定显示「上一次操作结果未确认」，保留服务端摘要，不读取 diff。取消 POST 和写入缓存的现有机制保持。
- 补丁仅在详情满足上述门控且状态为 `succeeded` 时读取。HTTP 200 文本原样预览，空串同样允许下载。409 表示成果尚未发布，允许主动重新读取；网络错误及 5xx 同样允许重新读取。401 和 404 隐藏交付入口。重读期间收起补丁和下载，失败时也收起。只支持当前后端提供的单轮补丁。首轮可验证相对初始文本快照应用，不把第二次独立提交或 fixture 叫作续聊。
- 不涉及 Schema、错误码、接口扩展、幂等键、事务、持久化、日志事件、worker、Temporal、部署变更或旧数据迁移。服务重启后的权威恢复由现有服务承担。浏览器可以重新读取，页面测试不证明服务端重启恢复。

## 逐文件预计范围

按语义改动估计约 535–650 行，含端到端测试，不含文档。审计以实际有效改动为准。

| 文件 | 符号和职责 | 预计代码行 |
| --- | --- | --- |
| `apps/workspace/web/src/pages.tsx` | `Workbench` 导航，新增 `TaskList`，`RunDetails` 与读取状态联动 | 165–195 |
| `apps/workspace/web/src/main.tsx` | 注册任务路由，详情去掉阻断详情挂载的预取，保留参数校验 | 15–25 |
| `apps/workspace/web/src/api.ts` | 补齐 DTO，详情和列表恢复配置，区分读错误 | 25–35 |
| `apps/workspace/web/src/ui.tsx` | 新增 `ReadFailure`、`RunResult`，统一交付门控和可重试状态 | 75–95 |
| `apps/workspace/web/e2e/task.spec.ts` | 分项目找回、两浏览器重连、补丁字节及应用验证、失败与权限回归 | 255–300 |

### T0：确认基线、已知失败与独占资源

前置状态：调查 checkout 位于派工指定 SHA，起始工作树干净。

允许修改：仅本草稿。禁止修改：生产文件、fixture、分支、远端；基线探针为调查临时文件，已移除。

执行：

1. 核对 Node、pnpm、Chromium 及本地默认 fixture。由 Playwright 启动环回的 Web 4320、mock API 4319，固定使用 Chromium。
2. 读回基线 `task.spec.ts`、`RunDetails`、详情 loader 和 `diffQuery`，核对上文探针的请求边界及与生产路径的一致性。执行阶段开始前由 MASTER 确认独立审核结论、草稿提交、B 的 Readiness 合入顺序及 10.51 边界。

验证：

```bash
git rev-parse HEAD
git status --short --branch
pnpm --filter @bento/web check
pnpm --filter @bento/web test:e2e task.spec.ts
```

PASS：作者已核对上述 SHA，基线 Web check 通过（11 个单测），Chromium 4 个任务用例通过，临时探针的两个失败表现均出现。进入执行时工作树干净，草稿已审核且提交，MASTER 确认并行边界。若 B 已合入，T0 命令在新执行基线重跑并核对 Web 入口无变化。

STOP：基线、checkout、审核版本、固定端口、命令结果或共享边界不符，报告具体差异和失败输出。

### T4：完整本地验证、同步设计与 Readiness

前置状态：单轮交付恢复用例已通过，关闭后找回独立重复 8 次已通过，B 已先合入共享 Readiness；若期间基线推进，按 MASTER 派发同步并在同步后执行本步。允许修改：`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`、本文件。禁止修改：接口与需求、B 的证据、部署和白名单。

执行：

1. 更新 WEB-DESIGN 的路由树、「组件功能说明」和「提交与交付」，记录独立任务列表、失败回读、状态及补丁门控、现有单轮基线和待覆盖范围。说明搜索范围为 Run id 与摘要。
2. 完整 Web 验证覆盖 typecheck/lint/format、单测、构建、Chromium 的任务和其他 Web 用例。仅 Web 消费行为变化，API 契约、执行层和部署未变，本地完整验证采用 Web 套件。CI 仍走仓库标准门禁。
3. 按实际执行日期、基线/代码提交、命令和通过结果更新 WEB-06、WEB-08 两行，保留「部分实现」。WEB-06 增记独立任务查找、原 Run 恢复、待核对隐藏补丁和可重读的空/非空交付。WEB-08 增记单轮逐文件、原补丁与下载一致、应用到 fixture 初始快照和空补丁交付。逐项记录：
   - WEB-A08 仅验证本地单账号、原 Run 在关闭期间推进及补丁可应用。远端同环境三个账号、真实模型/OpenShell、真实大文件保存下载及不支持输入的组合验收仍待验证。
   - WEB-A11 仅验证两个浏览器对同一 Run 的状态、原要求和现有摘要快照回读。执行事件、检查去重、追加要求产生独立 Run、原 Session/Workspace 续做和任务隔离仍待相应真实链路。
   - WEB-A13 仅验证单轮文本快照找回、逐文件、补丁应用和零变更/只读结论展示。两轮依赖执行、增量与累计双视图、累计下载、历史版本固定与结构化检查仍待后端契约和验证。
   - WEB-06 的可信运维接手和结案，以及 WEB-08 的结构化检查与累计交付维持原有未覆盖状态。
4. 在删除草稿前用下列命令验证本草稿中的相对路径链接。删除本文件，同次提交 Readiness 与设计。以 `rg` 核查无草稿残留引用，要求原始退出码为 1 且 stdout/stderr 均为空。

验证（删除草稿前）：

```bash
node --input-type=module -e 'import {readFileSync,existsSync} from "node:fs"; import {dirname,resolve} from "node:path"; const p="docs/30-designs/RUNBOOK-WEB-RUN-REOPEN.md"; for(const [,target] of readFileSync(p,"utf8").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)){if(!existsSync(resolve(dirname(p),target))) throw Error(target)}'
```

验证（删除草稿后）：

```bash
pnpm --filter @bento/web check
pnpm --filter @bento/web test:e2e
pnpm exec prettier --check docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md
git diff --check
test ! -e docs/30-designs/RUNBOOK-WEB-RUN-REOPEN.md
sh -c 'status=0; output=$(rg -n "RUNBOOK-WEB-RUN-REOPEN" docs .agents 2>&1) || status=$?; if [ "$status" -ne 1 ] || [ -n "$output" ]; then printf "rg exit=%s\n%s\n" "$status" "$output"; exit 1; fi'
```

PASS：完整 Web 套件通过且无跳过的本任务用例，设计、Readiness、实际证据一致，草稿与引用已移除。STOP：B 尚未合入、出现未验证的产品声明、任何规定命令失败或测试被跳过时，保留步骤并报告具体差异。
