# 用 Docker 部署 Bento Web

一个容器内由 NGINX 在 `8080` 提供构建后的 Web 页面，并把同域 `/api/*` 转发给只监听 `127.0.0.1:4101` 的 task-entry。浏览器只访问 NGINX。前端路由直接访问或刷新时由 NGINX 返回 SPA 入口。镜像以非 root 用户运行，健康检查同时请求首页和 API，停服时先让 NGINX 排空连接，再停止 task-entry。

任务执行服务、OpenShell、Temporal、模型和 S3 兼容存储使用各自的现有部署。镜像中的 task-entry 通过运行时配置访问执行服务；大文件从浏览器直接传到 S3。S3 服务需要允许前端 origin 的 CORS 请求。 [执行服务与 OpenShell 部署](./openshell-dsh.md) · [task-entry 配置](../../apps/workspace/api/README.md)

## 本机预览

在仓库根目录构建镜像并启动模拟模式。

```sh
docker build -t bento-web:local .
docker run --rm --stop-timeout 60 \
  -p 127.0.0.1:8080:8080 \
  -e BENTO_ONE_MODE=mock \
  -e BENTO_ONE_ORIGIN=http://127.0.0.1:8080 \
  bento-web:local
```

打开 <http://127.0.0.1:8080>。模拟账号和验证流程见 [独立前端说明](../../apps/workspace/web/README.md)。

## 配置真实环境

在本地受控目录准备 `runtime/accounts.json` 和 `runtime/web.env`。账号文件按 [task-entry 配置](../../apps/workspace/api/README.md)创建。让容器内的 `node` 用户（UID 1000）可以只读访问账号文件。Compose 把它挂载到 `/run/bento/accounts.json`，并将凭据及空间数据库放到命名卷的 `/data`。

参照以下配置填写 `runtime/web.env`。

```dotenv
BENTO_ONE_MODE=http
BENTO_ONE_ORIGIN=https://bento.example.com
BENTO_ONE_TWO_URL=http://execution-gateway.example.internal:4201
BENTO_ONE_TWO_BEARER=<执行服务凭据>
BENTO_SPACE_DB=/data/space.sqlite
BENTO_SPACE_S3_ENDPOINT=https://storage.example.com
BENTO_SPACE_S3_BUCKET=bento-private
AWS_REGION=us-east-1
```

S3 访问凭据通过运行环境的 AWS 凭证链提供。使用环境变量时，把真实值配置在受控的 `runtime/web.env`。镜像构建上下文只包含源码和部署配置。若本次部署暂未配置云端空间，省略全部三个 `BENTO_SPACE_*` 配置。执行服务地址必须从容器可达。若执行服务只监听宿主机回环地址，需要使用现有内网入口或受控代理。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Compose 默认将容器的 `8080` 发布到宿主机回环。生产由宿主机 HTTPS 入口转发至 `http://127.0.0.1:8080`，保留浏览器的 `Origin`。将 `BENTO_ONE_ORIGIN` 设为用户实际访问的 HTTPS origin，包含非默认端口时也一并填写。更新容器时保留 `bento-web-data` 卷和原账号文件。

`docker compose ps` 显示 `healthy` 时，首页已返回 `200`，未登录的 `/api/session` 已返回 `401`。部署后再检查直接打开任务链接、登录后下载 diff，以及浏览器能否连接 S3 端点。

启动失败时用 `docker compose logs --tail=100 bento-web` 检查容器日志，核对账号文件的读取权限和必需环境变量。停止服务用 `docker compose stop`，恢复原配置后用 `docker compose up -d` 重新启动并检查健康状态。

远端构建版本、已验证路径和覆盖范围见 [Web Docker 验收](../40-readiness/WEB-DOCKER-EVIDENCE.md)。
