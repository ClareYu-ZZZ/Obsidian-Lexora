# 伴侣服务（elp-worker）

worker 是可选的自托管服务，承担插件做不了的重活：

- **faster-whisper 转写**：无字幕的播客 / 本地媒体 → 逐句字幕（Pro）
- **ffmpeg 切片**：教程段落的原声 mp3 切片（Pro）
- **YouTube 下载**：720p 视频 / 音轨（Pro）
- **Piper TTS**：本地免费语音合成（免费档可用）

没有 worker 时，文章教程、带字幕的媒体、词库、复习等功能照常工作。

## 一键部署

在 NAS 或任意常开的机器上（需要 Docker）：

```bash
curl -fsSLO https://raw.githubusercontent.com/ClareYu-ZZZ/Obsidian-Lexora/main/services/worker/docker-compose.yml
docker compose up -d
docker compose logs | grep 配对码
```

## 配对

启动后 15 分钟内，在 Obsidian：**Lexora 设置 → 伴侣服务 → 配对…**，输入 `http://<主机IP>:8321` 和日志里的 6 位配对码——地址与访问 token 自动写入，并立即做一次能力检查。

- 窗口过期后 `docker compose restart` 可获取新配对码
- 想固定 token，在 compose 的 environment 里设置 `LEXORA_TOKEN`
- 配对端点可用 `LEXORA_PAIRING_WINDOW=0` 禁用

## 更新与版本

```bash
docker compose pull && docker compose up -d
```

镜像：`ghcr.io/clareyu-zzz/elp-worker`（`latest` / 语义化版本 / `edge`）。

## 安全模型

- 同机（loopback）请求免鉴权；任何局域网请求必须带 Bearer token
- 不要把 8321 端口直接暴露公网；外出访问建议 Tailscale / WireGuard，或反向代理加 TLS
- YouTube 下载依赖浏览器导出的 `cookies.txt`（放到容器 `/app/cookies.txt`），过期需重新导出


## 托管 worker（官方 / 共享部署）

自己没有设备的 Pro 用户可以直连一台开启托管模式的 worker——**鉴权就用 Pro license key**，不需要额外账号或 token：

```yaml
# docker-compose.yml → environment
- LEXORA_TOKEN=<站长管理token>
- LEXORA_ACCEPT_LICENSE_KEYS=1   # 开启托管：验 Pro key（离线 Ed25519 验签）
- LEXORA_PAIRING_WINDOW=0        # 公网必关配对
```

用户侧：Lexora 设置 → 伴侣服务 → 服务地址填托管地址，**访问 token 填自己的 Pro license key**。

规则：

- key 的签名、有效期、吊销名单（`LEXORA_REVOKED`）在 worker 本地校验——**订阅到期，功能与算力同时失效，一本账**
- 转写/切片、TTS 按 key 日限流（`LEXORA_LICENSED_DAILY_JOBS` / `LEXORA_LICENSED_DAILY_TTS`）
- **YouTube 端点始终仅站长可用**：yt-dlp 与站长 cookies 属个人资产，托管服务不提供；YouTube 功能请自托管
- 公网入口建议 Caddy 自动 HTTPS 或 Cloudflare Tunnel（不开入站端口）

::: warning 容量提醒
转写并发≈CPU 核数/2。家用 4 核适合熟人规模；面向付费用户请部署在 8 vCPU 以上的云服务器。
:::


## 运维页面（/admin）

worker v1.4.0 起内置运维面板：浏览器打开 `https://worker.你的域名/admin`，登录弹窗里**用户名随意、密码填管理 token**（`LEXORA_TOKEN`）。

内容（15 秒自动刷新）：

- **系统**：CPU / 内存 / 负载 / 磁盘实时值 + 24 小时曲线（30s 采样）
- **任务监控**：转写 / 切片 / TTS / 字幕的今日与 7 天量、失败数、平均与 P50/P95 耗时，近 20 条任务明细
- **付费用户活跃**：7 天内用 license key 调用过的用户、调用量与最近活跃时间
- **订阅与收入**：`sign.mjs` 每次签发自动写入私钥旁的 `issued.jsonl`；把它挂载到容器 `/data/issued.jsonl`（compose 已留注释）即可看到已签发 / 在期订阅数与累计收入

指标存放在容器内 `~/.cache/elp-worker/metrics.db`（与模型缓存同一个卷），重启不丢。
