#!/usr/bin/env bash
# mihomo 服务端一键部署：渲染配置 -> 装/更新内核 -> 起 systemd 服务
#
# 用法：
#   sudo ./deploy.sh
#   sudo SUB_URL="https://你的域名/providers/free-nodes.yaml" MIHOMO_SECRET=xxxx ./deploy.sh
set -euo pipefail

GITHUB_USER="duncanpanic"
REPO_NAME="proxy-fetcher"
# 默认订阅地址 = GitHub Pages 上的 provider 产物（只有 proxies:，服务端最合适）
SUB_URL="${SUB_URL:-https://${GITHUB_USER,,}.github.io/${REPO_NAME}/providers/free-nodes.yaml}"

MIHOMO_DIR="/etc/mihomo"
BIN="/usr/local/bin/mihomo"
MIHOMO_VERSION="${MIHOMO_VERSION:-v1.19.32}" # 如需更新内核，改这里或 export 覆盖

if [[ ${EUID} -ne 0 ]]; then
  echo "请用 root / sudo 运行" >&2
  exit 1
fi

if [[ ! -f config.yaml ]]; then
  echo "找不到 config.yaml，请在仓库目录内执行" >&2
  exit 1
fi

# 内核架构：老脚本写死 amd64，arm 机器上会直接跑不起来
case "$(uname -m)" in
  x86_64 | amd64) ARCH="amd64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  armv7l | armv7) ARCH="armv7" ;;
  *)
    echo "不支持的架构: $(uname -m)" >&2
    exit 1
    ;;
esac

# envsubst 来自 gettext，极小系统可能没装
if ! command -v envsubst >/dev/null 2>&1; then
  echo "安装 envsubst (gettext-base)..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y gettext-base
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y gettext
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache gettext
  fi
fi

mkdir -p "$MIHOMO_DIR/providers"

if [[ ! -x $BIN ]]; then
  echo "下载 mihomo 内核 (${MIHOMO_VERSION}, ${ARCH})..."
  curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-${ARCH}-${MIHOMO_VERSION}.gz" \
    | gzip -d >"$BIN"
  chmod +x "$BIN"
fi

# 密钥：有环境变量就用它，否则随机生成。config.yaml 里只写 ${MIHOMO_SECRET}，
# 因为 envsubst 不认 ${VAR:-默认值} 语法（旧版就是这么把密钥写成字面量的）
export SUB_URL
export MIHOMO_SECRET="${MIHOMO_SECRET:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

# 只替换这两个变量，避免配置里的注释/其他 ${} 被误伤
envsubst '${SUB_URL} ${MIHOMO_SECRET}' <config.yaml >"$MIHOMO_DIR/config.yaml"

echo "校验配置..."
"$BIN" -t -d "$MIHOMO_DIR" -f "$MIHOMO_DIR/config.yaml"

cat >/etc/systemd/system/mihomo.service <<'SERVICE_EOF'
[Unit]
Description=Mihomo Proxy Core
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable mihomo >/dev/null 2>&1 || true
systemctl restart mihomo
sleep 2
systemctl status mihomo --no-pager -l || true

echo ""
echo "✅ 部署完成"
echo "   订阅地址: $SUB_URL"
echo "   面板地址: http://<服务器IP>:9090"
echo "   REST API 密钥: $MIHOMO_SECRET"
echo "   实时日志: journalctl -u mihomo -f"
echo "   节点列表: curl -H 'Authorization: Bearer $MIHOMO_SECRET' http://127.0.0.1:9090/providers/proxies"
