# AnyRouter 双端调度与自动保活

同一个页面管理浏览器和 Python 任务，支持两端同时运行。两端共用表单和请求协议，任务分别保存会话、计时、次数和状态。

## 启动

需要 **Node.js 22.13+、Python 3.11+**。Python 端复用项目根目录模块，请保留完整项目目录。

```powershell
cd any
npm.cmd ci
npm.cmd start
```

打开 **http://127.0.0.1:8787/**。也可运行 `./start.ps1`，首次运行会安装构建依赖。

```powershell
# 自定义端口
npm.cmd start -- --port 8790

# 指定 Python 解释器，可填写完整路径
$env:ANYROUTER_PYTHON = 'python'
npm.cmd start
```

## 使用

1. 添加 API Key 和服务地址，完成模型列表鉴权。顶部选择 Python 视图后，Key 管理通过 Python 鉴权；浏览器视图通过浏览器鉴权。
2. 新建任务，选择 **浏览器调度 / Python 调度 / 双端同时调度**，填写模型、提示词、探活参数和通知配置。
3. 自动保活默认开启：成功后切换为 **60–90 秒**随机请求间隔；可自定义范围，上下限相等时使用固定间隔。关闭自动保活则首次成功后结束。
4. 任务中心支持 **全部 / 浏览器 / Python** 筛选。切换只改变显示范围；支持单任务暂停、继续、立即请求、取消和删除，以及批量暂停、取消、删除。

双端会创建两个独立任务，分别请求上游、分别计费。暂停其中一端不影响另一端。

| 行为 | 浏览器调度 | Python 调度 |
| --- | --- | --- |
| 模型请求位置 | 当前浏览器 | 本地 Python 进程 |
| 关闭或刷新页面 | 停止，刷新后恢复为暂停 | 继续运行，重新打开页面后可管理 |
| 服务重启 | 需要手动继续浏览器任务 | 恢复启用任务；暂停和终态保持 |
| API 跨域限制 | 目标服务需要允许 CORS | Python 直接请求 API |
| 任务保存 | 当前地址的 localStorage | data/python-tasks.sqlite |

## 调度规则

- GPT 的 `response.created` / `response.in_progress`、Claude 的 `message_start` 为成功。
- 探活每轮并发 1–16 个请求；首个成功者停止本轮其他请求，继续读取成功流。
- 保活每次只发一个请求，复用任务会话。失败后恢复探活，每次成功重置探活预算。
- “每轮探活上限”限制首次成功或恢复成功之前的请求次数；累计请求和成功次数单独统计，持续保活不因累计次数达到该值而停止。
- 无效 Key、模型错误和额度不足停止任务；临时错误按探活间隔和 `Retry-After` 重试。
- 成功流中断保留成功记录；开启保活时按保活间隔继续，关闭时结束。
- Python 默认最多同时执行 8 个任务轮次，每个轮次的探活并发由表单控制。

## 数据与通知

Key、浏览器任务、默认设置和主题保存在浏览器 localStorage。更换浏览器、主机名或端口会使用另一份浏览器数据。仅加载当前格式的任务，旧格式任务需重新创建。

Python 任务保存独立连接快照。Windows 使用当前用户的 DPAPI 保护任务数据；Linux/macOS 使用权限受限的本地文件。状态接口不返回模型 Key、Bot Token 或 SendKey。

两端共用 Node 通知队列 `data/notifications.sqlite`。Telegram 填写 Chat ID 和 Bot Token；Server 酱填写 SendKey，支持 SCT / sctp，可填写以 `|` 分隔的标签。每个任务选择一种通知方式，另一种的凭据留空。

首次成功或失败后恢复成功时提交通知，默认冷却 300 秒。关闭页面后已提交的通知仍可投递，需要保持服务运行。临时错误最多重试 5 次，投递结束后清除队列记录中的 Bot Token、Chat ID 和 SendKey。

`data/`、`.local/`、`dist/` 和依赖目录均被 Git 忽略。

## Docker 与性能

完整部署步骤见 [Docker / 1Panel](../DEPLOY.md)。直接拉取 `ghcr.io/cutelyrose/codex_keepalive_v20:latest`，映射端口并填写站点地址和管理密码，即可通过服务器 IP 访问。项目根目录提供 Compose 和环境变量示例；保留 SQLite，单副本运行，数据使用命名卷。

[性能对比](PERFORMANCE.md)：32 个任务的普通列表从约 1.66 MB 减为 26 KB，数据库连接复用、TLS 上下文共享、流事件合并和任务卡片局部更新均已实现。

## 验证

```powershell
npm.cmd run check
npm.cmd test
```

测试使用本机模拟 API 和通知服务，覆盖请求协议、SSE、双端并行、保活恢复、暂停取消、Python 重启恢复、Telegram / Server 酱、访问认证及写入合并，不调用真实模型或发送真实通知。

接口与实现见 [TECHNICAL.md](TECHNICAL.md)。
