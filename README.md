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
`https://www.gstatic.com/generate_204` 期望 `204`。

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
| `PROBE_URL` | `https://www.gstatic.com/generate_204` | 探测目标 |
| `PROBE_EXPECTED` | `204` | 期望状态码，不匹配即判死 |
| `PROBE_TIMEOUT` | `3000` | 单节点超时（毫秒） |
| `MAX_DELAY` | `800` | 超过该延迟的节点直接丢弃；`0` 表示不限制 |
| `MAX_NODES` | `100` | 最终发布节点数上限（排序后截断） |
| `PROBE_DEADLINE` | `240000` | 降级探测的总预算，防止 CI 超时 |
| `PROBE_CONCURRENCY` | `24` | 降级探测并发 |
| `FETCH_TIMEOUT` | `15000` | 单个源抓取超时 |
| `SOURCES_FILE` | `sources.yaml` | 源清单路径 |
| `SUB_URL` / `MIHOMO_SECRET` | 见 `deploy.sh` | 仅服务端渲染 `config.yaml` 时使用 |

## 测试

```bash
node test/logic.test.js      # 规范化/去重/排序/产出契约
node test/pipeline.test.js    # 用 file:// 假源 + 注入探测器跑完整流水线
```

## 维护

- 新增源：编辑 `sources.yaml`，`enabled: false` 可临时停用。
- 服务端调闸门：`config.yaml` 里 `proxy-providers.free-nodes.health-check`
  （`expected-status: 204` + `lazy: false` 是「非 204 即淘汰」和「未使用也体检」的关键）。
- 调分组策略：`proxy-groups` 里 `filter` 用节点名里的区域码匹配（形如 `🇺🇸US-001·120ms`）。
