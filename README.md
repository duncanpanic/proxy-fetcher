# proxy-fetcher

定时抓取公开免费订阅 → **真实可用性筛选** → 发布两份 mihomo 产物。

```
sources.yaml ──fetch──> 原始节点 ──规范化/去重──> 候选集
                                            │
                            ┌───────────────┴───────────────┐
                            │ 起临时 mihomo 内核             │ 没有内核时
                            │ 经每个节点访问 generate_204    │ 降级 TCP/TLS 握手
                            │ 只留真正拿到 204 的节点        │（宽松，可能放假活）
                            └───────────────┬───────────────┘
                                            │
                          按实测延迟排序 + 截断 + 区域命名
                                            │
        ┌───────────────────────────────────┴────────────────────────────┐
public/free-nodes.yaml                        public/providers/free-nodes.yaml
完整 mihomo 配置（订阅客户端、局域网设备用）     只有 proxies:（服务端 proxy-provider 用）
```

已发布的地址（Cloudflare Pages，每 6 小时刷新一次）：

- 客户端订阅：`https://<你的域名>/free-nodes.yaml`
- 服务端 provider：`https://<你的域名>/providers/free-nodes.yaml`

## 为什么值得这么筛

免费订阅里节点的「存活」分三种：

1. **端口能连上** —— 旧版只测这个，于是大量 worker 域名、CDN 中转、证书错配置的假节点都会通过；
2. **TLS 握手能过** —— 仍然不代表能代理流量，Trojan/WS 类节点经常握手成功但认证失败；
3. **经它真的能访问到 `204`** —— 只有这一条等于「能用」。

现在只有第 3 种节点会被发布。筛选口径由 `PROBE_URL` / `PROBE_EXPECTED` 控制，默认
`https://cp.cloudflare.com/generate_204` 期望 `204`。

> 为什么不用 `www.gstatic.com/generate_204`：这个域名在国内会被解析到 `120.253.253.34`
> 这类国内 CDN 节点，于是在境外节点上测出来的延迟里多了一段「绕回国内再回来」的绕路，
> 真实出口质量反而被掩盖。Cloudflare 是 anycast，从哪个出口走都落到离家最近的那台。
> 想换回去：`PROBE_URL=... node fetch.js`（本机工具用 `-TestUrl`）。

## 重要：探测视角决定一切

「能不能连」这件事没有绝对答案，只有「从哪台机器连」。CI 跑在 GitHub Actions 的
美国/欧洲机房，它判活的节点**只代表机房能连**。实测同一份 120 节点的产物：

| 视角 | 通过 204 判定 | 说明 |
| --- | --- | --- |
| GitHub runner（美国） | 120/120，延迟 4–214 ms | 机房直连海外节点几乎无损耗 |
| 国内家宽本机 | 6/120，可用者 214 ms+ | 大部分节点在你这边已被阻断 |

所以架构是两段式的：

- **CI 只负责抓源**（机房能访问 `raw.githubusercontent.com`，你本机往往不行），
  清洗去重后发布候选池 `public/pool.yaml`（默认最多 3000 个，**不探测**），同内容另出
  `public/pool.json` 给下面那个免 Node 的 Windows 工具用；
- **探测搬到本机**，用你自己的网络筛一遍：Windows 版 `tools\本机测速.bat`（推荐，免装
  Node），或 Node 版 `node select-local.js`。

```powershell
tools\本机测速.bat                          # 双击也行，详见「Windows 本机测速」一节
```

```bash
npm install js-yaml
node select-local.js                       # 默认拉线上 pool.yaml，产物在 ./local/
MIHOMO_BIN=/path/to/mihomo node select-local.js
node select-local.js --pool ./pool.yaml --out ./local
```

产物 `local/nodes.yaml` 是完整配置，客户端直接导入即可，不依赖线上订阅。
本机默认放宽到 `PROBE_TIMEOUT=5000`、`MAX_DELAY=2000`（家宽到境外本来就慢，
沿用机房口径会把能用的节点全切掉）。

`public/free-nodes.yaml` 仍按 CI 视角发布，作为「有总比没有强」的兜底，别拿它的
延迟数字当自己网络的预期。

## 使用

```bash
npm install js-yaml
node fetch.js            # 产出 public/free-nodes.yaml 与 public/providers/free-nodes.yaml
```

服务端部署（渲染 config.yaml、装内核、起 systemd 服务）：

```bash
sudo ./deploy.sh
# 或指定订阅地址与密钥
sudo SUB_URL="https://你的域名/providers/free-nodes.yaml" MIHOMO_SECRET=xxxx ./deploy.sh
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MIHOMO_BIN` | 自动在 `PATH` 找 `mihomo` | 探测用内核路径；给了路径但文件不存在时自动降级 |
| `PROBE_URL` | `https://cp.cloudflare.com/generate_204` | 探测目标 |
| `PROBE_EXPECTED` | `204` | 期望状态码，不匹配即判死 |
| `PROBE_TIMEOUT` | `3000` | 单节点超时（毫秒） |
| `MAX_DELAY` | `800` | 超过该延迟的节点直接丢弃；`0` 表示不限制 |
| `MAX_NODES` | `100` | 最终发布节点数上限（排序后截断） |
| `PROBE_DEADLINE` | `240000` | 降级探测的总预算，防止 CI 超时 |
| `PROBE_CONCURRENCY` | `24` | 降级探测并发 |
| `POOL_LIMIT` | `3000` | 候选池最多发布多少个未探测节点 |
| `PROBE_LIMIT` | `1200` | CI 侧最多探测多少个（等距抽样，覆盖各个源） |
| `ALLOW_PLAINTEXT` | 关 | 设为 `1` 才发布 socks5/http 明文代理 |
| `FETCH_TIMEOUT` | `15000` | 单个源抓取超时 |
| `SOURCES_FILE` | `sources.yaml` | 源清单路径 |
| `SUB_URL` / `MIHOMO_SECRET` | 见 `deploy.sh` | 仅服务端渲染 `config.yaml` 时使用 |

## Windows 本机测速（免 Node / npm）

CI 的探测视角是 GitHub runner（美国/欧洲机房），它能连上的节点，国内家宽往往只有个位数。
所以要拿到「自己网络下真的能用」的节点，得在本机跑一遍探测。这个工具只用 Windows 自带的
PowerShell 5.1，不装 Node、不装任何依赖：

```bat
tools\本机测速.bat
```

双击即可。它会：读候选池（CI 每 6 小时产出的 `public/pool.json`）→ 下载 mihomo 内核到
`tools\bin`（首次约 22MB）→ 起一个临时内核，用**逐节点真实 HTTP 请求**测速 → 排序截断 →
产出可直接导入客户端的 `local\nodes.yaml` 和 `local\report.txt`。

带参数的写法：

```powershell
powershell -ExecutionPolicy Bypass -File tools\local-probe.ps1 `
  -Pool https://node.lorcan.top/pool.json -MaxDelay 1500 -Top 30 -Concurrency 32
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Pool` | `https://node.lorcan.top/pool.json` | 候选池：http(s) 地址或本地文件路径 |
| `-Out` | `local` | 产物目录 |
| `-MaxDelay` | `2000` | 延迟阈值（毫秒），超过即丢弃 |
| `-Timeout` | `5000` | 单节点超时（毫秒） |
| `-Top` | `60` | 最多保留多少个节点 |
| `-Concurrency` | `32` | 并发探测数 |
| `-TestUrl` | `https://cp.cloudflare.com/generate_204` | 探测目标 |
| `-ExpectedStatus` | `204` | 期望状态码 |
| `-Force` | — | 强制重新下载内核 |
| `-AllowPlaintext` | — | 允许 socks5/http 明文代理（默认剔除） |
| `-Rounds` | `2` | 复测轮次：>1 时对候选再测一遍，只留两轮都通的（`1` 关闭） |

产物 `local\nodes.yaml` 是一份完整配置（含 DNS、`节点选择`/`自动选择` 两组），在客户端里
「配置 → 导入本地文件」选中它就能用。跑完会调 `mihomo -t` 自校验，校验不过会直接报错。

> 想用 Node 跑同一件事（例如配合 `MAX_DELAY` 环境变量、写进脚本）：`node select-local.js`，
> 产物在 `local/nodes.yaml`、`local/provider.yaml`。

## 测试

```bash
node test/logic.test.js      # 规范化/去重/排序/产出契约
node test/pipeline.test.js    # 用 file:// 假源 + 注入探测器跑完整流水线
```

## 源与格式

`sources.yaml` 里现在有 19 个源，混着三种发布格式，抓取时自动识别，不需要配 `type`：

1. **clash yaml** —— 带 `proxies:` 的配置，或直接是一个节点数组；
2. **分享链接列表** —— 每行一条 `ss://` / `vmess://` / `vless://` / `trojan://` /
   `hysteria2://` / `tuic://`（解析在 `fetch.js` 的 `parseUriList()`，包括 vmess 的
   base64-JSON 老格式、ss 的 SIP002 与 `base64(method:pass@host:port)` 两种写法、
   `ws-opts`/`grpc-opts`/`reality-opts` 等传输层参数）；
3. **base64 套壳** —— 上面两种整体再 base64 一次（机场订阅最常见）。

一份源的实际产出：`anaer/Sub` 约 1600 个、`Auto_proxy` 约 550 个、`NoMoreWalls` 约 430 个，
全部源合计约 4000 个原始节点，去重清洗后进候选池（`POOL_LIMIT`，默认 3000）。

## 维护

- 新增源：编辑 `sources.yaml`，`enabled: false` 可临时停用。
- 服务端调闸门：`config.yaml` 里 `proxy-providers.free-nodes.health-check`
  （`expected-status: 204` + `lazy: false` 是「非 204 即淘汰」和「未使用也体检」的关键）。
- 调分组策略：`proxy-groups` 里 `filter` 用节点名里的区域码匹配（形如 `🇺🇸US-001·120ms`）。
