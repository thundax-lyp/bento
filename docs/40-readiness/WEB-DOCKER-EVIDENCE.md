# Bento Web Docker 验收

## 验证范围

2026-11-10，以独立前端提交 `d78dbb8` 和同批 Web Docker 部署改动为基线。在远端 Docker 宿主使用缓存的 `node:24.19.0-bookworm-slim` 构建单镜像，以 `BENTO_ONE_MODE=mock` 启动。部署命令见 [Web Docker 部署](../deployments/HOW-TO-WEB-DOCKER.md)。

## 已验证

- `docker compose config --quiet` 通过。容器从 NGINX 提供前端首页，直接访问任务路由返回 SPA，缺失静态文件返回 `404`。
- 未登录的 `/api/session` 返回 `401`。通过 NGINX 同域登录成功，跨源登录请求被拒绝。
- 使用登录会话创建项目、提交模拟任务并下载 diff。下载返回 `200` 和附件响应头，内容包含预期修改。
- `docker stop -t 60` 后容器以状态码 `0` 退出。临时容器和镜像已清理。

## 未覆盖

远端访问 Docker Hub 受限，本次镜像使用 Node 24 覆盖构建参数。Dockerfile 默认的 Node 22 基础镜像未在该宿主完成整镜像构建。本次只验收 Docker 装配和模拟任务，真实模式的 HTTPS 入口、S3 上传和 OpenShell 执行未在这个镜像内复验。
