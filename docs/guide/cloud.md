# 云服务器部署（中国区）

面向中国大陆用户提供托管 worker 时，网络环境是第一约束。本页给出两条经过取舍的路线。

## 路线选择

| | 路线 A：大陆节点（推荐，体验最好） | 路线 B：香港/新加坡节点（最快上线） |
|---|---|---|
| 延迟 | 最低 | 可接受（+30-60ms） |
| 域名备案 | **必须 ICP 备案**（2-4 周） | 免备案 |
| 厂商 | 阿里云 ECS / 腾讯云 CVM / 轻量 | 同厂商港区或 Hetzner 等 |
| 适合 | 正式运营 | 备案期间过渡、快速验证 |

::: warning 不要给中国区用户用 Cloudflare Tunnel
免费版 Cloudflare 在大陆无节点，流量绕行美西，体验很差。大陆用户请用「服务器 + Caddy 自动 HTTPS」直连。
:::

### 路线 B 在大陆的真实可用性

香港 IP 可被大陆用户直连（自己的域名 + HTTPS，不涉及翻墙，域名解析到境外 IP 也无需备案），且 worker 的流量模型对跨境友好：转写/切片是异步任务，TTS、字幕、词典都是小请求，对延迟不敏感。但**质量取决于线路**：

| 选择 | 大陆体验 |
|---|---|
| **腾讯云 / 阿里云香港轻量（推荐）** | 回程走自家优化线路：广深 10-30ms、华东 30-50ms、北方 50-80ms，稳定 |
| 欧美系 VPS 的"香港/新加坡" | 普通国际 BGP，晚高峰丢包抖动明显，不要用于面向大陆的服务 |

已知短板：

1. **跨境上传带宽是瓶颈**——用户上传 50MB 播客去转写可能要 1-3 分钟（大陆内几十秒）；异步任务可接受
2. 晚高峰（20-23 点）跨境链路普遍变慢，重度用户能感知
3. 极小概率 IP 被污染，换云厂商弹性 IP 即恢复

下单前用厂商产品页的各区域测速 IP 先 ping 一下。香港轻量带宽一般 30Mbps 峰值，起步够用。香港节点装 Docker、拉 ghcr 镜像都**不需要**下文的镜像代理，比大陆节点省事。

**结论**：腾讯/阿里香港节点对几十个大陆用户是够格的正式方案，不只是过渡；规模上来或用户反馈上传慢时再启动备案切路线 A——届时只改 DNS 指向，服务配置零改动。

## 机型建议

- 起步：**8 vCPU / 16GB**（small 模型约 3-4 路并发转写），磁盘 40GB
- 带宽：切片/音频下发吃流量，选**按量计费、峰值 100Mbps**，别用 1-5Mbps 固定带宽
- 价格随促销波动大，以官网现价为准；轻量应用服务器通常比同规格 ECS/CVM 便宜

## 部署步骤

### 1. 装 Docker（国内镜像源）

```bash
# Ubuntu 24.04 / Debian 12
curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
```

### 2. 拉取 worker 镜像

ghcr.io 在大陆直连常超时，可用镜像代理或本地构建：

```bash
# 方式一：镜像代理（例：南京大学镜像站）
docker pull ghcr.nju.edu.cn/clareyu-zzz/elp-worker:latest
docker tag ghcr.nju.edu.cn/clareyu-zzz/elp-worker:latest ghcr.io/clareyu-zzz/elp-worker:latest

# 方式二：本地构建（仓库自带 Dockerfile，pip 走清华源）
git clone https://gitee.com/<你的镜像仓>/Obsidian-Lexora.git || git clone https://github.com/ClareYu-ZZZ/Obsidian-Lexora.git
cd Obsidian-Lexora/services/worker
docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple -t ghcr.io/clareyu-zzz/elp-worker:latest .
```

### 3. 配置并启动

```bash
mkdir -p /opt/lexora && cd /opt/lexora
# 取仓库里的 services/worker/docker-compose.yml，environment 配置为：
```

```yaml
environment:
  - LEXORA_TOKEN=<openssl rand -hex 24，站长管理 token>
  - LEXORA_ACCEPT_LICENSE_KEYS=1   # 托管模式：验用户的 Pro license key
  - LEXORA_PAIRING_WINDOW=0        # 公网必关配对
  - LEXORA_WHISPER_THREADS=8       # = vCPU
  # 2c4G 轻量机型推荐（英文内容为主）：distil 蒸馏模型 ≈ 2 倍速、精度几乎不降
  # - LEXORA_WHISPER_MODEL=distil-small.en   # 仅英文！中文媒体转写请保持 small
  # - LEXORA_WHISPER_THREADS=2
  # - LEXORA_MAX_TRANSCRIBE=1        # 转写互斥（默认 1），排队任务状态为 queued
  # - LEXORA_LICENSED_DAILY_JOBS=10
  # - LEXORA_REVOKED=refund@user.com   # 吊销名单
cpus: 8
ports:
  - "127.0.0.1:8321:8321"          # 只监听本机，入口交给 Caddy
```

```bash
docker compose up -d
```

### 4. Caddy 自动 HTTPS

```bash
apt install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
worker.你的域名.com {
  reverse_proxy 127.0.0.1:8321
}
EOF
systemctl reload caddy
# DNS：worker.你的域名.com → A 记录指服务器 IP
# 防火墙只放 80/443；路线 A 域名需已完成 ICP 备案
```

### 5. 验收

```bash
curl -s -H "Authorization: Bearer <一把有效的 Pro key>" \
  https://worker.你的域名.com/v1/capabilities
# 预期 features：transcribe/tts/clip = true；ytaudio/subtitle = false（托管不提供 YouTube）
```

用户侧配置：Lexora 设置 → 伴侣服务 → 地址填 `https://worker.你的域名.com`，访问 token 填**自己的 Pro license key**。

## 顺带托管文档站

github.io 在大陆访问不稳定，可以用同一台服务器伺服本文档：

```bash
cd /opt && git clone https://github.com/ClareYu-ZZZ/Obsidian-Lexora.git
cd Obsidian-Lexora && npm ci && npx vitepress build docs
# Caddyfile 追加：
# docs.你的域名.com {
#   root * /opt/Obsidian-Lexora/docs/.vitepress/dist
#   file_server
# }
```

更新文档时 `git pull && npx vitepress build docs` 即可。

## 日常运维

- 升级 worker：`docker compose pull && docker compose up -d`（大陆节点记得走镜像代理）
- 看负载：`docker stats elp-worker`；转写排队说明该加核或调低日配额
- 吊销某用户：environment 加 `LEXORA_REVOKED=邮箱` → `docker compose up -d`
- 站长自己的 YouTube 功能留在家中 NAS worker（云厂商 IP 易触发 YouTube 风控），插件里你连 NAS、用户连云端，互不影响
