# 个人端认证前端独立构建

状态为待独立审核。建立日期为 2026-11-13。工作目录为 `/Volumes/storage/workspace/bento-b`，远端为 `thundax-lyp/bento`，起草基线为 `e2df225840dc9c7c065891788cc0587e9279b26e`。预定分支为 `codex/workspace-auth-build`。当前阶段只起草。RUNBOOK 路径命中既有 `.gitignore`，审核通过且取得单独提交指令后，仅用 `git add -f -- docs/30-designs/RUNBOOK-WORKSPACE-AUTH-BUILD.md` 暂存该临时文件。MASTER 指定获审 SHA、实施分支和开工指令后，按 [Worker Skill](../../.agents/skills/bento-runbook-worker/SKILL.md) 执行。

## 目标与边界

- 落实[独立应用入口验收 1](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#acceptance-criteria)中的个人端认证构建，按[边界设计](./APPLICATION-BOUNDARIES-DESIGN.md)将认证前端作为独立构建单元。个人端 API 继续持有会话与授权，参见[平台架构](../00-governance/ARCHITECTURE.md#应用与编排的目标职责)。
- 完整链路为 `@bento/workspace-auth build` → `apps/workspace/auth/dist/{login.html,account.html,style.css}` → task-entry 初始化 OIDC 时读取三项产物 → NGINX `/auth` → Go 反代 → TypeScript `taskEntryServer` → `keycloakAuth` 按业务会话返回页面。Compose 将同一产物路径放入镜像。渲染分支使用 API 当前会话状态，HTML 无脚本和模板替换。
- 范围包括独立构建、真实入口接线、打包、回归和正式文档。排除管理端、Go 承接个人端 API、Keycloak Realm 或主题配置、业务 Web 构建改造、认证或会话语义变化、存储迁移、真实执行资源清理验收。
- 当前断点见 [Readiness](../40-readiness/CURRENT-READINESS.md)。`apps/workspace/auth/auth-page.ts` 导出 `authPage(signedIn)` 和 `authStyles`，被 `apps/workspace/api/oidc.ts` 直接导入。Compose 复制源文件。Go 的 `apps/workspace/api/go/oidc.go` 另有 `loginHTML`、`loginCSS`、`loginPage` 和 `(*keycloak).routes` 的两个页面处理器。生产 `apps/workspace/api/go/main.go:run` 只注册反代、账号仓储和健康检查，未注册 Go OIDC。保留 Go OIDC 协议代码，移除其未接线的页面实现。
- `deploy/workspace/nginx.conf` 的 `/auth` regex 和 `/api/` 前缀代理至 4102，`apps/workspace/api/go/main.go:run` 代理至 4101，`deploy/workspace/start.sh` 启动 NGINX、Go 和 `node apps/workspace/api/main.ts`。三个路由和启动脚本均原样使用。CI 当前构建镜像并做 API import 检查。新增运行检查覆盖容器实际入口。

## 不变量与追踪

| 正式依据 | 生产符号与数据 | 对应验收 |
| --- | --- | --- |
| 应用边界验收 1、独立构建设计 | `apps/workspace/auth/build.mjs` 生成 UTF-8 `login.html`、`account.html`、`style.css`，由 `keycloakAuth` 初始化一次读取，OIDC 启用且任一文件缺失时启动失败 | T1 构建，T2 源码入口加载，T4 镜像运行，T6 Readiness |
| [Web 认证接口](../20-interfaces/WEB-INTERFACE.md)、[Web 设计](./WEB-DESIGN.md) WEB-01 | `apps/workspace/api/oidc.ts:keycloakAuth` 对 `GET /auth` 使用 `auth.account`，仅 401 走访客页，`GET /auth/style.css` 直接返回 CSS。保留原状态、响应头及路由。登录链接 `GET /api/oidc/start`，账号页返回 `/`、POST logout、POST close，确认表单字段 `confirmed=yes` | T2、T4 比较产物与 HTTP 字节，检查 CSP、Referrer-Policy、Cache-Control、nosniff、Content-Type 和表单 |
| 同上，OIDC 回调、退出和注销 | `apps/workspace/api/server.ts:taskEntryServer` 保留 POST Origin 检查及 OIDC 路由。事务仍由 API 生成随机 cookie、state、nonce、PKCE verifier 和到期值（300 秒），关闭事务绑定原会话。回调验证 token 与组织、验证邮箱，成功由 `sessionAuth.startSession` 签发 24 小时会话。HTTP 使用 `bento_oidc`、`bento_one`，HTTPS 原有 `__Host-` 前缀及 Secure，均 HttpOnly、Path=/、OIDC 模式 SameSite=Lax。退出撤销会话后 303 至 provider end-session，回跳 `/auth`。注销要求 `prompt=login`、`max_age=0`、原会话和相同 subject，通过 `closeVerified` 关闭账号 | T2、T4 检查登录、错误 state、退出、确认门禁、同主体再认证和旧会话拒绝 |
| 同上，身份归属与重启 | `apps/workspace/api/account-store.ts:mysqlAccounts` 按 `issuer,subject,account` 三个必填字符串提交绑定，Go `accounts.linkIdentity` 持久化 issuer/subject → ownerId，返回 `{account:string,ownerId:string,closed:boolean}`，Go wire 另含 `inviteSha256:string`，OIDC 绑定时为空字符串。关闭仍由 Go 原子更新账号状态和清理标记。会话及 OIDC 事务留在进程内存，重启失效，账号绑定和关闭状态仍在 MySQL | T4 使用一次性真实 MySQL，重启 Web 入口后拒绝旧 cookie/事务，重新登录同一身份并核对绑定，注销后重启仍拒绝登录 |

输入与输出仅增加三个构建文件。无新公开字段、数据写入、Schema、事件、投影、幂等键、账本或重放策略。浏览器不会获得任何身份、会话或凭据数据作为页面插值。

## 并行顺序与停止规则

- bento-a 的 WEB-03 项目整体删除先合入，本任务后合入。共享接入面为 `apps/workspace/api/server.ts:taskEntryServer` 的路由/Origin/会话入口，本任务在 `oidc.ts:keycloakAuth` 替换页面读取，并在 `main.ts` 的启动错误出口增加构建产物缺失诊断。保留 `server.ts`、`main.ts` 的路由、配置和服务初始化顺序。聚合检查共享 `package.json:scripts.check:workspace`、`apps/workspace/api/package.json:scripts.check`、`.github/workflows/checks.yml` 和 Playwright；保留 WEB-03 增加的检查及测试。Readiness 本任务只改独立应用入口行和 WEB-01 行，合并时保留 WEB-03 行和新证据。共享发布登记 `public-files.json` 按条目合并。起草时 bento-a 与本基线相同，其新增用例文件名尚无证据。
- WEB-03 合入后，使用普通 merge 纳入最新 `origin/main`。重新跑 T5 全量命令并等待 T4 镜像 smoke 通过。T5 已删除时固定运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm --filter @bento/web test:e2e`，推送后回读同一 PR 当前 HEAD 的三个检查及镜像 smoke 日志。在 `git diff e2df225840dc9c7c065891788cc0587e9279b26e..origin/main --name-only` 中列出 WEB-03 新增或修改的 `apps/workspace/api/*.test.ts` 和 `apps/workspace/web/e2e/*.spec.ts`，分别核对 Node TAP、Chromium 报告确有执行。复验项目删除的同源与 owner 拒绝、Run/导入门禁、重试、清理完成后的额度回收与浏览器确认，具体断言以已合入测试为准。报告缺失覆盖给 MASTER，由 MASTER 固定复验命令后再合入。
- Docker 本地仅运行本任务前缀资源，无宿主端口、真实数据或外部卷。Playwright 原配置占用宿主回环 4319/4320，且可能复用监听器。每次运行 Chromium 前须持有 MASTER 分配给本 checkout 的有效窗口。先执行下列端口探测，再在同一窗口运行 Chromium，预计超出窗口即报 MASTER 排期。仅有空闲探测不能代替窗口授权。勿停止他人进程。Docker 碰到宿主独占资源时同样 STOP。
- 每步 PASS 后按 Worker Skill 删已完成步骤、调整前置状态、单独提交并回读 SHA 与文件清单。所有未列文件均禁止编辑。验证出错保留工作树，清理本任务的临时进程、容器和网络。禁止改数据、扩大范围、放宽断言或借用他人环境。报告最后 PASS 的 SHA、触发条件、文件及符号、命令、脱敏输出与所需决定。

端口探测。

```bash
(
    if probe="$(lsof -nP -iTCP:4319 -iTCP:4320 -sTCP:LISTEN 2>&1)"; then
        printf '%s\n' "$probe" >&2
        exit 1
    else
        probe_status=$?
    fi
    if [ "$probe_status" -ne 1 ] || [ -n "$probe" ]; then
        printf 'lsof exit=%s, output=%s\n' "$probe_status" "$probe" >&2
        exit 1
    fi
) || exit 1
```

失败恢复适用于 T4 新增 smoke 和其他当前 HEAD 检查：

- 确认 PR HEAD、Checks run 的 `headSha` 和本地提交一致。用 `gh run view` 的 `--json headSha,jobs,attempt,conclusion` 与 `--log-failed` 回读本次证据。只有 Actions runner 无法分配、runner 丢失或 GitHub 明确标注系统故障，且日志没有实现断言失败时，才对同一 run 执行一次 `gh run rerun "$auth_checks_run" -R thundax-lyp/bento --failed`，其中 `auth_checks_run` 为该已核对的 run ID。用 `gh run watch "$auth_checks_run" -R thundax-lyp/bento --exit-status` 等待，回读 attempt 增 1 且 HEAD 一致。若 runner 再失败、重试权限不足、结论模糊或当前 HEAD 已变化，停止并报告。
- 代码、构建、配置或断言失败时暂停当前交付阶段，保留同一个 PR，报告实际检查、HEAD、失败步骤和脱敏日志。由原作者修订 RUNBOOK 剩余步骤，列出唯一修复、文件及重验范围，独立复审给出 Executable 且 MASTER 重新下达执行指令后再改实现。把修复提交推送同一 Draft PR，按新 HEAD 重新执行本地聚合、Chromium 与全部远端检查。禁止恢复已完成步骤的旧计划、跳过检查、另开 PR 或使用基线结果替代。
- 门禁缺失、用例跳过、PR 授权缺失或无法回读同 HEAD 日志均 STOP，报告检查名、SHA 与触发条件。

### T0：核验基线、执行授权和验证环境

前置状态：在指定 checkout。起草验证可在 main 执行，实施需获审分支和 MASTER 指令。

允许修改：仅本 RUNBOOK 草稿，1 文件。

禁止修改：源码、Git 索引、分支、现有资源。

执行：核对远端、基线、工作树及独立审核版本。先取得 MASTER 分配的 Chromium 窗口。探测只有退出 1 且 stdout/stderr 为空时通过，退出 0 或其他结果均 STOP。仅通过后才运行 Chromium。实施前确认使用本文指定的 GitHub Draft PR runner 完成 Docker 门禁。起草实测见本步末尾。

验证：

```bash
git status --short --branch
git remote get-url origin
git rev-parse HEAD origin/main
git ls-remote origin refs/heads/main
pnpm install --frozen-lockfile --offline
pnpm check
node --test apps/workspace/api/*.test.ts
pnpm --filter @bento/web test:e2e
gh run view 43193646474 -R thundax-lyp/bento --json jobs
```

PASS：基线与远端匹配，工作树归属明确，本地检查、API 测试、Chromium 全通过。基线 GitHub 镜像 job 成功，且 MASTER 确认授权、审核版本、分支、并行顺序及同一 Draft PR 的镜像验证时点。已提交 RUNBOOK 时用其父提交与指定基线比较。

STOP：版本、基线、测试、资源或授权不满足即回报。2026-11-13 起草实测 Node 22.23.2、pnpm 12.15.0、Go 1.25.3（darwin/arm64），本地与远端 main 均为指定 SHA，初始 Git 工作树干净。离线冻结安装、`pnpm check`、5 项 Workspace API Node 测试（含 4 项 WEB-03 相邻断言）、7 项 Chromium 通过。Docker CLI 指向已失效的 Docker.app 路径，当前无可用本地 engine。实施 T0 仍待审核和开工指令。

GitHub Actions 环境核验：`gh run view 43193646474 -R thundax-lyp/bento --json jobs` 显示指定基线的 `Deployment image builds`、`Repository checks` 和 `Web Chromium E2E` 成功。现有镜像 job 在 Ubuntu runner 使用 Docker Compose 构建三个服务镜像，并对 Workspace API 模块做 import smoke。workflow 触发条件是 PR 目标 `main` 或 `codex/**`、以及 push `main`，无 `workflow_dispatch`，单独 push 实施分支不能触发。T4 保留三个 job 的名称与检查，添加真实入口 smoke。可在同一个 Draft PR 上以 GitHub runner 完成等量验证，具体取证顺序见 T5。

### T1：建立无运行依赖的独立认证构建

前置状态：实施 T0 通过。基线仍存在 `apps/workspace/auth/auth-page.ts`。

允许修改（10 文件，含 RUNBOOK）：`apps/workspace/auth/{package.json,build.mjs,login.html,account.html,style.css}`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.gitignore`、`public-files.json`。

禁止修改：API、Docker、现有 `auth-page.ts` 和其他发布白名单条目。

执行：

1. 新建 package，`name` 为 `@bento/workspace-auth`，`private: true`，`type: "module"`，`scripts.build: "node build.mjs"`，无依赖。将路径加入 pnpm workspace。运行 `pnpm install --lockfile-only --offline`，只接受第二段 lockfile 的 importer 新增 `apps/workspace/auth: {}`。若生成其他差异则 STOP。
2. 从 `auth-page.ts` 取两种渲染输出为独立 HTML。保留全部原文、title、lang、viewport、class、样式链接、链接和 form 属性。CSS 取 `authStyles` 内容。允许 Prettier 调整空白。新建 `build.mjs`，从 `node:fs/promises` 导入 `mkdir`、`copyFile`，并写入 `import { URL } from 'node:url';`，按 `import.meta.url` 定位本包，创建 `dist/`，依次复制三个同名文件，失败向上传递并退出非零。无 bundle、浏览器 JS 或外部包。每次构建覆盖三个输出。
3. 在根 `.gitignore` 最后新增 `/apps/workspace/auth/dist/`。在 `public-files.json` 的 `files` 增加五个 auth 构建输入，保留旧实现条目直到实际删除。三个 dist 文件只在各自 checkout 与 Docker 构建层生成，允许留在本 checkout 供后续验证。构建中途失败可原地重跑并覆盖三文件。禁止暂存 dist，禁止清除其他工程产物。
4. 只对新增文件、workspace 配置与发布清单执行 Prettier，lockfile 由 pnpm 管理。

验证：

```bash
pnpm install --frozen-lockfile --offline
pnpm --filter @bento/workspace-auth build
for file in login.html account.html style.css; do
    cmp "apps/workspace/auth/$file" "apps/workspace/auth/dist/$file" || exit 1
done
pnpm exec eslint apps/workspace/auth/build.mjs
git check-ignore -v apps/workspace/auth/dist/{login.html,account.html,style.css}
git diff --check
```

PASS：`build.mjs` 的 ESLint 检查退出 0，三个文件逐字节相等，三项均由新增的精确 ignore 规则命中。清单中没有依赖，lockfile 仅增加空 importer，公开白名单包含五个源输入和零个 dist 文件。

STOP：构建需要新依赖、输出错位或 lockfile 有其他变化。保留现有源码供 T2 切换。

### T2：把 OIDC 页面绑定到构建产物并锁定协议回归

前置状态：三项认证产物可构建。现有 OIDC 事务、会话和路由仍与基线一致。

允许修改（9 文件，含 RUNBOOK）：`apps/workspace/api/main.ts`、`public-files.json`、`apps/workspace/api/oidc.ts`、`apps/workspace/api/oidc.test.ts`、`apps/workspace/api/oidc-fixture.ts`、`package.json`、`deploy/compose.yaml`、`.dockerignore`。

禁止修改：`server.ts`、Go、部署路由和启动脚本、业务接口、OIDC 会话及公开 HTTP 错误语义。

执行：

1. 将 `oidc.ts` 的源模块 import 替换为 `import { readFile } from 'node:fs/promises';`。在 `keycloakAuth` 的设置校验之后、discovery 之前，`await Promise.all` 从三个固定 `new URL('../auth/dist/<实际文件名>', import.meta.url)` 以 `'utf8'` 读取 `loginHtml,accountHtml,styleCss`。只捕获读取失败，抛出 `new WorkspaceAuthArtifactsError('Workspace auth build artifacts are unavailable', { cause })`，在 `oidc.ts` 导出 `class WorkspaceAuthArtifactsError extends Error {}`。页面返回 `signedIn ? accountHtml : loginHtml`，样式返回 `styleCss`。生产入口已有 `main → keycloakAuth` 初始化，关闭 OIDC 时不读取产物。`main.ts` 的既有 OIDC import 同时引入该类。把顶层 `catch` 改为 `catch (error)`，在原有 `console.error` 之前增加分支，仅 `error instanceof WorkspaceAuthArtifactsError` 时打印固定行 `Workspace auth build artifacts are unavailable`，不打印 cause、文件路径或凭据。保留原通用日志和 `process.exitCode = 1`。缺产物的真实入口负例由 T4 验证。
2. 在根 `check:workspace` 现有命令前串联 `pnpm --filter @bento/workspace-auth build &&`。不改其他根脚本。根 `package.json.files` 紧跟 `"apps/workspace/auth"` 增加 `"!apps/workspace/auth/dist"`，保证含本地产物时的 npm 包也排除 dist。在 `public-files.json` 登记 `oidc.test.ts` 和 `oidc-fixture.ts`。
3. 新建共享 fixture `apps/workspace/api/oidc-fixture.ts`，导出 `async function startOidcFixture()`，返回 `{ issuer, authorization, setCode, tokenRequests, close }`。其中 issuer 是字符串，authorization(url) 保存该授权 URL 的 challenge、nonce 和 state，setCode(code, subject, invited) 记录一次授权对应的主体与准入值，tokenRequests() 返回累计 token 请求次数，close() 返回 Promise。fixture 使用固定 `client_id=bento-auth-fixture`、`client_secret=fixture-only`、组织 `bento-fixture`。authorize、token、JWKS、end-session 路径分别为 `/authorize`、`/token`、`/jwks`、`/end-session`。用 `node:http` 在回环动态端口启动本地 issuer，fixture 的 discovery 提供 issuer、authorize、token、jwks_uri、end_session_endpoint、`response_types_supported: ['code']`、`subject_types_supported: ['public']`、`id_token_signing_alg_values_supported: ['RS256']`、`token_endpoint_auth_methods_supported: ['client_secret_basic']` 和 S256。用 `node:crypto` 生成 RSA-2048 签名密钥和公开 JWK，`kid` 固定为 `fixture`，JWT 头为 `{alg:'RS256',kid:'fixture'}`。token 响应为 `{access_token:'fixture',token_type:'Bearer',id_token}`，JWT claims 为 `iss,sub,aud,iat,exp,auth_time,nonce,email,email_verified,organization`，时钟用当前 Unix 秒，`auth_time=iat`，`exp=iat+60`。从 authorize URL 取 nonce、challenge，用 token 请求的 verifier 验证 SHA-256 base64url 等于 challenge。JWT `aud` 为固定 client_id，`email` 为 `fixture@example.test`，`email_verified` 为 true，准入的 `organization` 为 `["bento-fixture"]`，拒绝为 `[]`。每次 code 配置绑定当次授权数据，只成功消费一次。未知 code、缺失或错误 verifier 返回 400 `{"error":"invalid_grant"}`。重放断言以 token 请求计数核对，错误回调不增加 token 请求次数。
4. 新建 Node suite `apps/workspace/api/oidc.test.ts`。用 `mockAccounts` 初始化一个 owner，再以展开对象新增 `bindOidc`，返回该 `{account,ownerId,closed}` 快照。调用真实 `sessionAuth(store,false,true)`、`keycloakAuth`、`taskEntryServer` 与 `mockBackend()`。应用监听用 `port: 0`，配置固定回环公开 origin `http://127.0.0.1:8080`，使用返回的监听地址发请求，手动保留 redirect、Origin 和 cookie。测试初始化失败时及测试结束时均关闭 issuer 与 task-entry。
5. 断言一个完整顺序：匿名 HTML/CSS 与构建字节相同，登录表单链接和响应头正确，旧密码入口 404。开始登录得到 303 和有效事务 cookie，错误 state 401，正确回调 303 至 `/`，重放 401，未受邀身份 401。已登录页等于账号产物且含两个 POST form。跨源 close/logout 400，原 cookie 仍可用。合法退出 303 并撤销旧 cookie，Location 带 `id_token_hint` 和原 `post_logout_redirect_uri`。重新登录后，缺少确认的 close 401。确认后带 `prompt=login,max_age=0`，不同 subject 回调 401 且原会话仍可用。新建关闭事务并用原主体返回，断言账号被标记关闭、两个 cookie 被清除、旧会话 401、关闭后再次登录 401。匿名与登录后 HTML 均断言 `Content-Type: text/html; charset=utf-8`、`Referrer-Policy: same-origin` 和 CSP `default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' <fixture issuer 的 URL origin>`，最后一项替换为实际 origin。CSS 断言 `Content-Type: text/css; charset=utf-8`、`Referrer-Policy: no-referrer` 和无 space 配置时 `server.ts` 的通用 CSP `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`。三种响应均断言 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。
6. 在 Compose 的 `FROM dependencies AS auth-build` 中逐一 COPY auth 的 package.json、build.mjs 和三个源资源到 `/app/apps/workspace/auth/`，运行 `pnpm --filter @bento/workspace-auth build`，不安装依赖。runtime 用 `COPY --from=auth-build /app/apps/workspace/auth/dist/ ./apps/workspace/auth/dist/` 取代旧 TS 源 COPY。`.dockerignore` 放行上述五个输入文件，并在 API `*.ts` 白名单之后排除 `apps/workspace/api/oidc-fixture.ts` 与 `apps/workspace/api/oidc.test.ts`。镜像编译与真实入口验证在 T4/T5 的当前 HEAD Actions job 回读。

验证：

```bash
pnpm --filter @bento/workspace-auth build
node --test apps/workspace/api/oidc.test.ts
pnpm --filter @bento/workspace-api typecheck
pnpm exec prettier --check apps/workspace/api/main.ts apps/workspace/api/oidc.ts apps/workspace/api/oidc.test.ts apps/workspace/api/oidc-fixture.ts package.json public-files.json deploy/compose.yaml
git diff --check
```

PASS：focused suite 执行成功，无跳过。登录页和账号设置必须分别等于不同产物的字节，测试不得通过直接调用私有 handler 绕过 HTTP 入口。

STOP：HTTP 断言失败、需修改任何现有协议分支或无法装载 fixture 时报告。修复限本步文件。

### T3：移除两套旧页面实现

前置状态：TypeScript 已从构建产物响应，T2 回归通过。

允许修改（9 文件，含 RUNBOOK）：`public-files.json`、`apps/workspace/auth/auth-page.ts`、`apps/workspace/api/go/{oidc.go,auth.html,auth.css}`、`apps/workspace/api/tsconfig.json`、`deploy/compose.yaml`、`.dockerignore`。

禁止修改：Go OIDC 协议逻辑，`go/main.go`，Go 会话和账号仓储。

执行：

1. 删除旧 `auth-page.ts`。把 API tsconfig 的 `include` 改为 `["*.ts"]`。
2. 删除 Go OIDC 的两个 embed 声明、`loginPage` 初始化、`_ "embed"` 与 `"html/template"` import，以及 `(*keycloak).routes` 的两个 `GET /auth` 页面注册块。保留 `io` 及其对注销表单的读取。删除 Go 的 `auth.html` 与 `auth.css`，用 gofmt 整理 `oidc.go`。
3. 从 `.dockerignore` 删除两个 Go HTML/CSS 的例外，Compose 的 `go-build` COPY 仅复制 `*.go`。删除 `.dockerignore` 旧 auth-page 例外。保留 T2 构建产物 COPY。同步删除 `public-files.json` 中的三个旧页面条目。

验证：

```bash
(cd apps/workspace/api/go && go test ./... && go vet ./...)
pnpm --filter @bento/workspace-auth build
node --test apps/workspace/api/oidc.test.ts
! rg -n 'auth-page\.ts|go/auth\.(html|css)|loginPage|loginCSS|loginHTML' apps deploy .dockerignore
git diff --check
```

PASS：Go 测试、vet 和 OIDC 回归通过，源码和部署入口无旧文件引用。发布清单已删除旧页面条目。README 由 T6 同步。

STOP：发现 Go 运行入口注册了旧页面，或需修改 Go OIDC 其他处理逻辑。

### T4：在现有镜像 job 验证完整运行入口

前置状态：Compose runtime 复制认证构建产物。Go 反代和真实启动脚本保留。

允许修改（7 文件，含 RUNBOOK）：`public-files.json`、`.github/workflows/checks.yml`、`deploy/workspace/auth-smoke.mjs`、`deploy/workspace/auth-smoke.sh`、`.gitignore`、`apps/workspace/api/package.json`。

禁止修改：现有 job 名称、构建范围、镜像 import 断言、Required checks、发布工作流、Realm 和生产配置。

执行：

1. 在 `.gitignore` 中逐项放行两个新 smoke 文件，并在 `public-files.json` 登记这两个路径。在 API `scripts.check` 的 `pnpm typecheck` 与 `cd go` 之间串联 `node --test ./*.test.ts`，保留分支中已有检查，避免重复执行同一 glob。根聚合检查已先构建 auth。在现有 `images` job 的 API import smoke 后增加 `bash deploy/workspace/auth-smoke.sh` 步骤。脚本使用 `set -euo pipefail`，从仓库根运行。前缀为 `bento-auth-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}`。创建同名前缀 Docker 网络与 `-mysql` 容器，使用 `mysql:8.4`、tmpfs `/var/lib/mysql`、`MYSQL_DATABASE=bento`、`MYSQL_USER=bento`、`MYSQL_PASSWORD=fixture-only`、`MYSQL_RANDOM_ROOT_PASSWORD=yes`。检查输出只打印连接状态。轮询最多 90 秒，每秒执行一次 `docker exec` 内的 TCP `SELECT 1`。首次连接失败时继续，超时退出非零。用 EXIT trap 删除本脚本成功创建的容器和网络。创建前遇同名资源即退出，清理不得删除他人资源。
2. 在该网络执行 `docker run --rm`，名称为前缀加 `-web`，使用现有 `bento-web:local`，不发布宿主端口。不改 entrypoint 文件。用 `--entrypoint node` 运行只读 bind mount 的 `deploy/workspace/auth-smoke.mjs`，另将 `apps/workspace/api/oidc-fixture.ts` 只读挂载到同一临时目录，脚本通过显式 `./oidc-fixture.ts` import 夹具。镜像名后的参数固定为 `/tmp/bento-auth-smoke/auth-smoke.mjs`，两个源文件分别挂载到该目录下的同名路径。传入 `BENTO_MYSQL_HOST=<本次 -mysql 容器名>:3306`、数据库用户、密码及库名。容器内断言源 HTML、CSS、build.mjs 和旧 auth-page 未复制，三个 dist 文件存在。
3. Node smoke 在同一容器启动 T2 issuer fixture，用 `spawn('/usr/bin/tini',['--','/usr/local/bin/bento-web'],...)` 启动镜像原入口。子进程环境由当前环境加 `BENTO_ONE_MODE=mock`、`BENTO_AUTH_MODE=keycloak`、`BENTO_ONE_ORIGIN=http://127.0.0.1:8080`、fixture issuer、client ID、secret 和组织组成。从 `node:child_process`、`node:process`、`node:assert/strict`、`node:fs/promises`、`node:timers/promises` 显式导入所需 API。若读取 stdout/stderr 的 Buffer，从 `node:buffer` 显式导入。全部 HTTP 请求使用 `globalThis.fetch`，不增加 ESLint globals 或 disable 注释。请求 NGINX 8080 端口，`redirect: 'manual'`。最多轮询 30 秒，要求 `GET /` 200、`GET /api/session` 401、`GET /auth` 200，任一子进程提前退出即失败。测试退出时 SIGTERM 并等待 tini 结束，再关闭 issuer。重启场景调用同一启动函数并保留 MySQL 容器。
4. 对 HTTP 链逐项断言：匿名、登录后页面与 CSS 等于镜像内对应产物，Content-Type 及 T2 中页面响应头一致。错误 state 401，正确授权码回调 303 后 session 200，重放 401。正常退出 303 至 fixture 的 end-session，携带原 id token 和回跳路径，退出前的 cookie 不能读 session。再次登录，创建一个未完成事务后重启入口，旧 session 和未完成事务均 401。每次正确 OIDC 回调均先用新 cookie 调用 `GET /api/session` 并核对返回 `{account: "fixture@example.test"}`，随后才对容器内 `http://127.0.0.1:4103/internal/accounts/oidc` 发 `POST`，以 `Content-Type: application/json` 发送同一个已签名 token 中的 `{issuer: iss, subject: sub, account: email}`。此接口是幂等绑定，可能创建账号，禁止在首个成功回调前调用。断言 200、返回 account 等于登录邮箱、closed 为 false、ownerId 为 48 位小写十六进制，并用 `GET /internal/accounts/by-owner/{ownerId}` 核对同一 ownerId 存在。重启后同一身份重新登录并重复读回，断言 ownerId 与首次一致。错误 Origin close 返回 400，正确确认 close 请求带 `prompt=login,max_age=0`，用原 subject 完成回调，旧 session 401。再重启，回调同一身份仍为 401。以首次获得的 ownerId 发送 `GET http://127.0.0.1:4103/internal/accounts/by-owner/{ownerId}`，断言 200、相同 ownerId 且 closed 为 true。测试最后仅打印断言摘要，不打印 cookie、密码或 JWT。
5. 在正例容器退出后以同一隔离网络再启动一个同镜像 `-missing` 容器。以 tmpfs 覆盖 `/app/apps/workspace/auth/dist`，使用同一 Node smoke 和 `--missing-artifacts` 模式。该模式只启动 fixture 与真实入口，分别捕获 stdout/stderr，断言 30 秒内原入口以非零数字退出码退出、无退出信号，且 stderr 包含 T2 固定诊断完整行 `Workspace auth build artifacts are unavailable`。通用启动报错或超时不满足此断言。正例仍检查三个产物。保留 CI 的 Compose config、三个服务镜像构建、API import 和 Orchestrator patch smoke。新步骤跟随相同 PR job 执行。

验证：

```bash
bash -n deploy/workspace/auth-smoke.sh
node --check deploy/workspace/auth-smoke.mjs
pnpm exec eslint deploy/workspace/auth-smoke.mjs
pnpm exec prettier --check .github/workflows/checks.yml deploy/workspace/auth-smoke.mjs apps/workspace/api/package.json public-files.json
git diff --check
```

PASS：本步产物的静态检查通过并单独提交。镜像运行断言必须在 T5 回读同一 Draft PR HEAD 后方可记入验收证据。

STOP：运行脚本需要宿主固定端口、外部服务凭据、现有卷、额外 CI 权限或更改门禁。回报脚本位置、错误和所需决定。

### T5：执行固定回归并回读同一 Draft PR 的镜像验证

前置状态：T4 提交存在，MASTER 的开工指令授权按本步创建同一个交付用 Draft PR。WEB-03 可以仍在途，此时本步的验证只能证明当前分支，合并前须按并行顺序复跑。

允许修改（1 文件）：RUNBOOK。

禁止修改：浏览器业务用例、既有检查名称、镜像和账号实现。

执行：取得 MASTER 分配的 Chromium 窗口，按公共端口探测命令检查后跑本地命令。推送 T4 的已提交 HEAD，按 PR 模板创建或恢复唯一 Draft PR，base 为 main、head 为 codex/workspace-auth-build，标题为 `Build(task-entry): 独立构建个人端认证前端`。远端验证通过后，在 RUNBOOK 的 T6 前置状态记录已通过的 SHA 与 Actions run 链接，删除 T5 并提交。每次推送后将检查对应到新 HEAD。

验证：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @bento/web test:e2e
git diff --check
gh pr checks --watch --fail-fast
gh pr view --json headRefOid,isDraft,statusCheckRollup
```

PASS：本地 API 全部 TAP、Go test/vet、Web 类型检查/测试/构建、lint、format 和 Chromium 通过。当前 Draft PR HEAD 的 `Deployment image builds` 成功，逐步回读 Actions 日志确认三个镜像、现有两个 runtime smoke 与新增真实入口 smoke 均执行并通过，同时 `Repository checks` 和 `Web Chromium E2E` 通过。发现并发导致 SHA 更换时重新核对。完成后记录证据链接与提交。

STOP：按并行顺序与停止规则中的 CI 失败恢复处理。

### T6：同步发布文件、正式文档与验收证据

前置状态：T5 的真实镜像验证通过。实际准备合并前须纳入已合入的 WEB-03 并复验。

允许修改（7 文件，含 RUNBOOK）：`README.md`、`apps/workspace/api/README.md`、`deploy/README.md`、`docs/00-governance/ARCHITECTURE.md`、`docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`。

禁止修改：公开契约语义、WEB-03 Readiness 行、npm 打包目录和远端门禁。

执行：

1. README auth 链接指向 package.json，并列独立构建命令。API README 真实模式的直接启动命令之前加 `pnpm --filter @bento/workspace-auth build`，说明启用 OIDC 时必需三项输出。mock 启动命令可原样使用。部署 README 说明 Compose 的 auth-build 产物、生产入口以及镜像中缺失产物时重建镜像的恢复方式。架构当前实现接线去掉 auth 待实现陈述，补上个人端 API 读取独立认证构建产物。边界设计的独立构建职责下增加一段现行链路，记录产物相对路径和 TS 持有会话、Go 反代。保留其他未完成范围。
2. 确认前序步骤已同步 `public-files.json`。在从暂存树导出的临时目录重新构建 auth 后执行 npm dry-run，验收带构建产物的工作目录也能排除 dist。
3. Readiness 仅更新独立应用入口与 WEB-01。记录验证日期、已通过检查的 T4 实现 SHA、Actions 链接、环境、实际断言及通过结果。保留已有 WEB-01 真实 Keycloak 历史证据。当前新验证的身份提供方是签名 OIDC fixture，MySQL 和容器入口是真实运行，真实 Keycloak/HTTPS、真实 S3/OpenShell 清理、管理端和 Go API 迁移均保留为未覆盖。独立应用入口整项继续为部分实现。
4. 删除 RUNBOOK 前逐个核对本步 Markdown 相对链接可解析，锚点与现有标题对应。删除 RUNBOOK。按允许文件清单暂存本步差异后核对无残留链接，并从暂存树核对发布，再提交。本地提交后按下文的最终 PR 门禁交付。

验证：

```bash
pnpm check
git diff --cached --check
! rg -n 'RUNBOOK-WORKSPACE-AUTH-BUILD' README.md docs .agents
(
    set -e
    pack_dir="$(mktemp -d)"
    trap 'rm -rf -- "$pack_dir"' EXIT
    git checkout-index --all --prefix="$pack_dir/"
    cd "$pack_dir"
    node apps/workspace/auth/build.mjs
    npm pack --dry-run --json | node --input-type=module -e '
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        const files = JSON.parse(readFileSync(0, "utf8"))[0].files.map(x => x.path);
        for (const name of ["package.json","build.mjs","login.html","account.html","style.css"]) {
            assert(files.includes("apps/workspace/auth/" + name));
        }
        assert(!files.some(x => x.includes("/dist/") || x.endsWith("/auth-page.ts") || /\/go\/auth\.(html|css)$/.test(x)));
    '
)
```

PASS：命令全通过，Readiness 引用已经验证的实施提交及运行链接，临时手册和引用从暂存树删除，已回读本地收口提交 SHA。

STOP：发行包出现构建残留、存在新旧路径冲突、文档或断言不一致，或需要改写 WEB-03 的交付记录。

## 最终 PR 门禁

T6 本地收口通过后才产生最终提交。推送到同一 Draft PR，按 Worker Skill 在本地验证通过且已触发的必需检查无失败时转 Ready。回读该 HEAD 的三个 CI job、镜像 smoke 和明确 Codex 结论。合并前同步 WEB-03 和最新 main，复验并行顺序约定的断言，并对同步后的 HEAD 重验远端门禁。实际远端门禁按 [PR 规则](../00-governance/PR-RULES.md#main-branch-protection)回读。检查失败沿用并行顺序与停止规则中的 CI 失败恢复及独立复审规则，复审范围通过本聊天中的修订步骤固定。所有门禁通过后用普通 merge，回读合并提交，快进同步并清理确认已合入的任务分支。
