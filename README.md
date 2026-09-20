# AnyRouter 双端调度与自动保活

同一页面管理浏览器和 Python 任务，支持双端同时调度、成功后自动保活、ShowDoc / Telegram / Server 酱通知，数据使用 SQLite。Python 任务在关闭页面后继续运行。探活次数与单轮并发不设固定最大值，按填写的正整数执行。

## 1Panel 部署

镜像：`ghcr.io/cutelyrose/codex_keepalive_v20:latest`（Linux amd64 / arm64）。

当前仓库私有：先在 1Panel 添加镜像仓库 `ghcr.io`，使用有访问权限的 GitHub 用户名及含 `read:packages` 权限的 Personal Access Token (classic) 登录。

拉取镜像、创建一个容器，映射端口 `8787:8787`，将命名卷挂载到 `/app/any/data`，设置重启策略 `unless-stopped`，填写：

```dotenv
ANYROUTER_ORIGIN=http://实际服务器IP:8787
ANYROUTER_PASSWORD=替换为随机管理密码
```

放行端口后访问上述地址，以 `admin` 登录。完整配置、Compose、更新与备份见 [部署说明](DEPLOY.md)。

## 开发与文档

- [网页使用与本地启动](any/README.md)
- [双端调度实现](any/TECHNICAL.md)
- [性能优化及实测](any/PERFORMANCE.md)
- [原终端版使用说明](使用说明.md)

推送 `main` 自动触发 [Docker 工作流](https://github.com/CutelyRose/codex_keepalive_v20/actions/workflows/docker.yml)。测试和容器重启验证通过后，发布 `latest` 及完整提交 SHA 标签。
