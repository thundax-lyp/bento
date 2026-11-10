# Bento Web 前端

独立的 React、TypeScript 和 Vite 工程。使用 React Router 管路由，TanStack Query 管 API 缓存，Tailwind CSS 和 Radix 组件模式构建界面。

从仓库根目录执行 `pnpm install`，然后在两个终端分别运行：

```sh
BENTO_ONE_MODE=mock BENTO_ONE_PORT=4186 BENTO_ONE_ORIGIN=http://127.0.0.1:4185 node src/task-entry/main.ts
```

```sh
pnpm --filter @bento/web dev
```

访问 <http://127.0.0.1:4185>。模拟账号为 `demo` 或 `guest`，邀请码为 `demo-invite`。在 Workspace 导入一个 UTF-8 文本项目，等项目就绪后从对话页发送任务。任务详情可刷新，并可下载补丁。

Vite 默认将 `/api` 代理到 `http://127.0.0.1:4186`。连接其他后端时，给 Vite 设置 `BENTO_API_TARGET`，并将后端 `BENTO_ONE_ORIGIN` 设为浏览器访问前端的完整 origin。

用 `pnpm --filter @bento/web build` 生成 `apps/web/dist`。部署时由反向代理在同一个 origin 提供静态页面和 API。`/api/*` 转发到 Bento task-entry 并保留 Origin 请求头。前端页面路径回退到 `index.html`。保持 HTTPS 和后端原有 Cookie 配置。单镜像部署见 [Docker 和 NGINX 部署](../../docs/deployments/HOW-TO-WEB-DOCKER.md)。

任务深链接为 `/runs/:runId?project=:projectId`，对应现有的项目级 Run API。首页显示当前选择项目的任务。Workspace 支持现有文本导入，以及配置 S3 后的云端空间。云端空间支持分块上传、续传、下载和选择执行文件。配置见 [task-entry 说明](../../src/task-entry/README.md)。

```sh
pnpm --filter @bento/web check
pnpm --filter @bento/web exec playwright install chromium
pnpm --filter @bento/web test:e2e
```

浏览器测试自动启动 Vite 和 Bento 的模拟任务入口，使用独立的 4320 和 4319 端口。
