# proxy-fetcher

免费节点自动抓取 → 测速筛选 → Cloudflare Pages 托管 → mihomo 订阅

## 架构

```
GitHub Actions (每 6h)
  ├─ 抓取免费节点源 (NODE_SOURCES Secret)
  ├─ subconverter-ng 解析/SNI清洗/测速/排序
  ├─ 生成 free-nodes.yaml
  ├─ 部署到 Cloudflare Pages (node.lorcan.top) ← 主链路
  └─ 部署到 GitHub Pages ← 备链路
```

## 部署订阅

### 1. GitHub 端

1. Fork 此私有仓库，然后：
   - `Settings → Secrets` 添加：
     - `NODE_SOURCES`：每行一个免费节点源 URL
     - `CF_API_TOKEN`：Cloudflare API Token (Pages 编辑权限)
     - `CF_ACCOUNT_ID`：Cloudflare Account ID
   - `Settings → Pages → Connect to Git` 选择本仓库
   - 手动触发一次 Workflow 验证部署成功
   - `Pages → Custom Domains` 添加 `node.lorcan.top`

2. **分享订阅**：把 `https://node.lorcan.top/free-nodes.yaml` 发给你朋友即可。

### 2. Linux 服务器部署 (mihomo systemd)

```bash
git clone https://github.com/你的用户名/proxy-fetcher.git
cd proxy-fetcher
sudo bash deploy.sh
```

部署后：
- 订阅链接：`https://node.lorcan.top/free-nodes.yaml`
- 面板：`http://<服务器IP>:9090`
- 管理：`systemctl start|stop|restart mihomo`
- 日志：`journalctl -u mihomo -f`

### 3. 手机/电脑 (flclash)

直接添加订阅 `https://node.lorcan.top/free-nodes.yaml`，配置同步走坚果云 WebDAV。

## 规则集

使用 CRThu/clash-rules-mrs 编译的二进制 `.mrs` 规则集（jsDelivr 国内极速）：

| 规则集 | 用途 |
|--------|------|
| `direct.mrs` | 国内直连 |
| `proxy.mrs` | 走代理兜底 |
| `telegram.mrs` | Telegram |
| `google.mrs` | Google AI (含 Gemini) |
| `openai.mrs` | OpenAI |
| `anthropic.mrs` | Claude |

## 双链路

| 链路 | URL | 备注 |
|------|-----|------|
| 主 | `https://node.lorcan.top/free-nodes.yaml` | Cloudflare Pages，国内极速 |
| 备 | `https://OWNER.github.io/proxy-fetcher/free-nodes.yaml` | GitHub Pages，备用 |

## 注意事项

- `NODE_SOURCES` Secret 每行一个 URL，不要有多余空行
- 默认过滤 vmess/vless/trojan/ss/hysteria2/tuic，国家 US/JP/SG/HK/TW/DE/NL
- 测速目标 `http://cp.cloudflare.com/generate_204`，最大延迟 3000ms
- 每月 GitHub Actions 120 次构建，远小于私有仓库 2000 分钟限制
