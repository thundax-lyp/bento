# Bento One 任务入口

使用仓库要求的 Node.js 版本，从仓库根目录运行。

```sh
BENTO_ONE_MODE=mock node src/task-entry/main.ts
```

打开 <http://127.0.0.1:4101>。模拟账号为 `demo` 或 `guest`，邀请码为 `demo-invite`。导入一份小型 UTF-8 文本快照，等项目就绪后提交任务。普通任务为第一个文件生成模拟 diff，`mock:empty` 产生空 diff，`mock:failed` 模拟失败，`mock:review` 从恢复进入待核对。模拟记录保存在 One 进程内，关闭浏览器后仍可通过原账号查看，重启模拟进程会清空记录。

真实模式使用相同页面，需要单独运行兼容 v1 接口的 Two 执行服务。浏览器只访问 One，由 One 在服务端使用独立 bearer 和登录会话绑定的 ownerId 调用 Two。项目、任务、状态和成果以 Two 的记录为准。One 监听回环地址，通过本机 HTTPS 反向代理提供非回环访问时，代理需保留浏览器的 Origin 头。登录会话有效期 24 小时，重启 One 后需要重新登录。

在 Git 忽略的本地目录配置 One，限制账号配置和环境文件仅供部署用户读取。账号文件是 JSON 数组，每个成员包含 `account`、固定且唯一的不透明 `ownerId`，以及小写十六进制 `inviteSha256`。为每个账号生成独立的 32 字节随机邀请码，以 base64url 编码后发给受邀用户，文件内只存该字符串的 SHA-256。保留原 ownerId 才能继续访问 Two 上的历史记录。

| 环境变量                   | 用途                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `BENTO_ONE_MODE=http`      | 启用 Two 的真实 HTTP 接口                                                          |
| `BENTO_ONE_PORT`           | One 的本地监听端口，默认 4101                                                      |
| `BENTO_ONE_ORIGIN`         | 浏览器访问 One 的完整 origin，本地默认为 `http://127.0.0.1:4101`（端口随配置变化） |
| `BENTO_ONE_ACCOUNTS_FILE`  | 受邀账号 JSON 文件路径，真实模式必填                                               |
| `BENTO_ONE_TWO_URL`        | Two 的服务 origin，真实模式必填                                                    |
| `BENTO_ONE_TWO_BEARER`     | Two 的独立服务 bearer，真实模式必填                                                |
| `BENTO_ONE_TWO_TIMEOUT_MS` | One 调用 Two 的超时，默认 10000 毫秒                                               |

例如使用本地环境文件启动。

```sh
node --env-file=runtime/one.env src/task-entry/main.ts
```

关闭页面再打开时，任务列表会从服务端重新加载。提交结果暂未确认时，浏览器只存账号及项目范围内的提交键与描述摘要。用原任务描述重试会沿用该键。空 diff 可以预览状态并下载为空文件。
