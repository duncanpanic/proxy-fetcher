#!/usr/bin/env bash
set -euo pipefail

SUB_URL="https://node.lorcan.top/free-nodes.yaml"
MIHOMO_DIR="/etc/mihomo"
BIN="/usr/local/bin/mihomo"
MIHOMO_VERSION="v1.19.32" # 如果需更新核心，修改这里的版本号

mkdir -p "$MIHOMO_DIR"

export SUB_URL MIHOMO_SECRET="${MIHOMO_SECRET:-$(openssl rand -hex 16)}"
envsubst < config.yaml > "$MIHOMO_DIR/config.yaml"

if [[ ! -x $BIN ]]; then
  echo "下载 mihomo 核心 (${MIHOMO_VERSION})..."
  curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-amd64-${MIHOMO_VERSION}.gz" \
    | gzip -d > "$BIN"
  chmod +x "$BIN"
fi

cat > /etc/systemd/system/mihomo.service <<'SERVICE_EOF'
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
systemctl enable --now mihomo
systemctl status mihomo --no-pager -l

echo ""
echo "✅ 部署完成"
echo "   订阅链接: $SUB_URL"
echo "   面板地址: http://127.0.0.1:9090"
echo "   REST API 密钥: $MIHOMO_SECRET"
echo "   实时日志: journalctl -u mihomo -f"