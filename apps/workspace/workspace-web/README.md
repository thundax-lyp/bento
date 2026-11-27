# Bento Web 前端

独立的 React、TypeScript 和 Vite 工程。使用 React Router 管路由，TanStack Query 管 API 缓存，Tailwind CSS 和 Radix 组件模式构建界面。

从仓库根目录执行 `pnpm install`，然后在两个终端分别运行：

```sh
BENTO_ONE_PORT=4186 BENTO_ONE_ORIGIN=http://127.0.0.1:4185 node --import ./register-paths.mjs apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/start-mock.ts
```

```sh
pnpm --filter @bento/workspace-web dev
```

访问 <http://127.0.0.1:4185>。模拟账号为 `demo` 或 `guest`，先用邀请码 `demo-invite` 注册并设置密码，再用密码登录。在 Workspace 导入一个 UTF-8 文本项目，等项目就绪后从对话页发送任务。任务详情可刷新，并可下载补丁。

Vite 默认将 `/api` 代理到 `http://127.0.0.1:4186`。连接其他后端时，给 Vite 设置 `BENTO_API_TARGET`，并将后端 `BENTO_ONE_ORIGIN` 设为浏览器访问前端的完整 origin。

用 `pnpm --filter @bento/workspace-web build` 生成 `apps/workspace/workspace-web/dist`。部署时由反向代理在同一个 origin 提供静态页面和 API。`/api/*` 转发到 Go Workspace API 并保留 Origin 请求头。前端页面路径回退到 `index.html`。保持 HTTPS 和后端原有 Cookie 配置。整体部署见 [Compose 启动说明](../../../deploy/README.md#启动与检查)。

任务深链接为 `/runs/:runId?project=:projectId`，对应现有的项目级 Run API。首页显示当前选择项目的任务。Workspace 支持现有文本导入，以及配置 S3 后的云端空间。云端空间支持分块上传、续传、下载和选择执行文件。配置见 [Workspace API 说明](../workspace-api/README.md)。

```sh
pnpm --filter @bento/workspace-web check
pnpm --filter @bento/workspace-web exec playwright install chromium
pnpm --filter @bento/workspace-web test:e2e
```

Vitest 单元与组件测试统一放在 `tests/`，与 `src/` 分离；测试通过显式路径导入源码，仍由 TypeScript 和 ESLint 检查。`pnpm test` 发现 `tests/**/*.test.{ts,tsx}`，并排除 `tests/acceptance/`。Playwright 验收与 Node 模拟 API 测试从 `tests/acceptance/` 各自的入口执行。

浏览器测试位于 `e2e/`，自动启动 Vite 和 Bento 的模拟任务入口，使用独立的 4320 和 4319 端口。

页面组件统一置于 `src/pages/`，每个页面组件使用独立目录及显式 `index.tsx` 入口，路由从 `src/pages/index.ts` 导入。

```text
src/pages/
├── auth/
│   ├── login/index.tsx
│   ├── register/index.tsx
│   └── account-settings/index.tsx
├── workbench/index.tsx
├── projects/
│   ├── dashboard/index.tsx
│   ├── workspace/index.tsx
│   └── run-details/index.tsx
├── tasks/
│   ├── list/index.tsx
│   ├── composer/index.tsx
│   ├── details/
│   │   ├── index.tsx
│   │   └── run-result.tsx
│   └── labels.ts
├── shared/online.ts
└── index.ts
```

页面专属子组件放在所属页面目录；同业务共享内容放在对应业务目录，跨业务共享的页面辅助逻辑放在 `pages/shared/`。仓库内部导入必须显式写出 `.ts` 或 `.tsx` 等实际扩展名，跨两级及以上父目录使用仓库根别名 `@/`。根 ESLint 配置检查静态导入、重导出、动态导入及类型导入。
