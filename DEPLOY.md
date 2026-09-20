# Docker / 1Panel 部署

镜像：`ghcr.io/cutelyrose/codex_keepalive_v20:latest`，支持 Linux amd64 / arm64。保留 SQLite，运行一个副本，通过服务器 IP 和端口访问。

## 1. 登录镜像仓库

当前 GitHub 仓库为私有仓库。首次拉取前，在 1Panel「容器 → 镜像仓库」添加：

| 项目 | 值 |
| --- | --- |
| 仓库地址 | `ghcr.io` |
| 用户名 | 有权访问仓库的 GitHub 用户名 |
| 密码 | 该用户的 GitHub Personal Access Token (classic)，包含 `read:packages` 权限 |

命令行可使用 `docker login ghcr.io -u <GitHub用户名>`，在密码提示中粘贴上述 Token。

## 2. 在 1Panel 创建容器

拉取镜像后创建容器，填写：

| 项目 | 值 |
| --- | --- |
| 镜像 | `ghcr.io/cutelyrose/codex_keepalive_v20:latest` |
| 端口 | 宿主机 `8787` → 容器 `8787/TCP` |
| 持久化 | 新建命名卷，挂载到 `/app/any/data` |
| 重启策略 | `unless-stopped` |
| 副本数 | `1` |

只需设置两个环境变量，替换实际服务器 IP 和密码：

```dotenv
ANYROUTER_ORIGIN=http://实际服务器IP:8787
ANYROUTER_PASSWORD=替换为随机管理密码
```

在 1Panel 的环境变量表单中直接填写值，不要额外加引号。镜像已监听 `0.0.0.0:8787`，无需修改容器内部端口。

放行宿主机对应端口后，打开 `http://实际服务器IP:8787`，用户名为 `admin`。若改用宿主机端口 `9000`，端口映射填 `9000:8787`，`ANYROUTER_ORIGIN` 同时改为 `http://实际服务器IP:9000`。地址必须与浏览器访问地址一致，不带路径；403 时先检查该配置。

## 3. 使用 Compose 部署

也可以只下载仓库根目录的 `compose.yaml` 和 `.env.example` 到服务器同一目录，将 `.env.example` 复制为 `.env` 后填写：

```dotenv
ANYROUTER_ORIGIN=http://实际服务器IP:8787
ANYROUTER_PASSWORD='替换为随机管理密码'
ANYROUTER_HTTP_PORT=8787
```

`.env` 中用单引号包围密码可以保留 `$` 等字符。完成镜像仓库登录后，在该目录执行：

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=50
```

1Panel 容器编排也可导入同一份 Compose。数据写入命名卷 `anyrouter_data`；更新、重建和普通 `docker compose down` 会保留数据。不要使用 `down -v`。

## 4. 运行与通知

```sh
curl -fsS http://127.0.0.1:8787/api/health
```

健康接口无需登录，只返回 Node / Python 调度可用状态。页面、任务和配置使用管理密码认证。

在设置或新建任务的「成功通知」中选择一种配置：

- **Server 酱**：填写 SendKey，支持 `SCT…`（Turbo）和 `sctp…`（Server 酱 3）；标签可填 `服务器报警|图片`，Telegram 凭据留空。
- **Telegram**：填写 Chat ID 和 Bot Token，Server 酱 SendKey 留空。

浏览器、Python 两端共用通知队列。首次成功或故障恢复后通知，持续保活成功不重复推送，冷却 300 秒；临时失败最多投递 5 次，重启继续未完成通知。`sent` 表示通知平台接口已确认受理。

创建任务可选浏览器、Python 或双端。关闭页面后需要继续运行的任务使用 Python；双端分别请求上游并独立计数。

## 5. 更新、备份与恢复

更新镜像：

```sh
docker compose pull
docker compose up -d
```

1Panel 直接创建的容器可重新拉取 `latest` 并重建，保留原数据卷和环境变量。每次发布也提供完整 Git 提交 SHA 标签；需要固定版本时，在 `.env` 设置 `ANYROUTER_IMAGE=ghcr.io/cutelyrose/codex_keepalive_v20:<完整提交SHA>`。

保持同一 Compose 项目名和数据卷。重启后恢复启用任务，暂停和终态保持。SQLite 使用 WAL，备份前停止容器，再复制整个数据目录：

```sh
docker compose stop
install -d -m 700 backup
docker compose cp anyrouter:/app/any/data ./backup/
docker compose start
```

恢复时先停止容器，执行 `docker compose cp ./backup/data/. anyrouter:/app/any/data/`，通过 1Panel 将数据目录属主设为 `1000:1000`、目录权限 `700`、数据库权限 `600`，再启动。备份包含任务连接凭据，应保存在受限目录。

Windows 本地 Python 数据受当前用户 DPAPI 保护，不能直接复制到 Linux 容器；在部署站点重新添加 Key 和任务。浏览器 localStorage 随浏览器和站点地址区分，首次访问服务器站点需要重新配置浏览器任务。

## 镜像发布与配置

推送 `main` 或手动运行 [Docker 工作流](https://github.com/CutelyRose/codex_keepalive_v20/actions/workflows/docker.yml) 会执行类型检查和集成测试，构建并推送 amd64 / arm64 镜像。工作流实际启动 amd64 容器，检查认证、非 root 用户及 SQLite 重启恢复，全部通过后才更新 `latest`。

镜像以 UID/GID `1000:1000` 运行；Compose 使用只读根文件系统、独立数据卷和日志大小限制。只运行 **一个副本**，多个实例会重复调度同一任务。健康检查失败显示 unhealthy；Docker 重启策略处理进程退出，不会仅因 unhealthy 状态自动重启。

| 环境变量 | 用途 |
| --- | --- |
| ANYROUTER_ORIGIN | 浏览器访问地址，容器部署必填 |
| ANYROUTER_PASSWORD | 管理密码，容器部署必填 |
| ANYROUTER_HTTP_PORT | Compose 的宿主机端口，默认 8787 |
| ANYROUTER_IMAGE | Compose 拉取的镜像，默认本仓库 latest |
| ANYROUTER_HOST | 服务监听地址，镜像已设为 0.0.0.0 |
| ANYROUTER_PORT | 服务内部监听端口，镜像已设为 8787 |
| ANYROUTER_DATA_DIR | 数据目录，镜像已设为 /app/any/data |
| ANYROUTER_PYTHON | 本地运行时指定 Python 解释器，镜像使用 python3 |
