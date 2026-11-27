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
pnpm --filter @bento/workspace-web test:space-integrity
pnpm --filter @bento/workspace-web test:queue-isolation
```

`check` 执行类型检查、Vitest 和 Vite 构建。从仓库根目录运行 `pnpm lint` 和 `pnpm format:check` 执行仓库级检查，Web 的 ESLint 配置同时检查 React Hooks。

- `tests/` 保存 Vitest 单元和组件测试。
- `tests/e2e/` 保存常规浏览器回归。Playwright 自动启动 Vite 和模拟 API，使用 4320 和 4319 端口。
- `tests/acceptance/` 保存空间完整性、队列隔离等专项验收。模拟 API 及其测试位于 [Workspace API 夹具](tests/acceptance/fixtures/workspace-api/)，可通过 `pnpm --filter @bento/workspace-web test:api-fixtures` 单独运行。

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

页面专属子组件放在所属页面目录；同业务共享内容放在对应业务目录，跨业务共享的页面辅助逻辑放在 `pages/shared/`。仓库内部导入必须显式写出 `.ts` 或 `.tsx` 等实际扩展名，跨两级及以上父目录使用已配置的别名，例如 `@workspace-web/`。跨工程使用包的公共入口，生产源码不能引用测试或夹具。根 ESLint 配置检查静态导入、重导出、可静态解析的动态导入及类型导入。

云端空间代码放在 [`src/space/`](src/space/)。`space-list.tsx` 提供空间列表，`cloud-project-route.tsx` 组装项目页，`project-uploads.ts` 和 `project-deletion.ts` 分别维护上传和项目删除状态。

Playwright 配置集中在 `tests/playwright/`。使用 `pnpm test:e2e` 运行默认 Chromium 测试。直接调用 Playwright 时，通过 `--config tests/playwright/<配置文件>` 选择验收入口。
