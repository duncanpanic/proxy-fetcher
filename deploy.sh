#!/usr/bin/env bash
# deploy.sh — Linux mihomo systemd 一键部署
# 用法: sudo bash deploy.sh
set -euo pipefail

# === 配置区 ============================================
SUB_URL="https://node.lorcan.top/free-nodes.yaml"
MIHOMO_DIR="/etc/mihomo"
BIN="/usr/local/bin/mihomo"
# ========================================================

mkdir -p "$MIHOMO_DIR"

# 渲染配置
export SUB_URL MIHOMO_SECRET="${MIHOMO_SECRET:-$(openssl rand -hex 16)}"
envsubst < config.yaml > "$MIHOMO_DIR/config.yaml"

# 安装 mihomo 核心 (没有才装)
if [[ ! -x $BIN ]]; then
  echo "下载 mihomo 核心..."
  curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/latest/download/mihomo-linux-amd64-v1.18.0.gz" \
    | gzip -d > "$BIN"
  chmod +x "$BIN"
fi

# 安装 systemd 服务
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

# 验证
systemctl status mihomo --no-pager -l
echo ""
echo "✅ 部署完成"
echo "   订阅链接: $SUB_URL"
echo "   面板地址: http://127.0.0.1:9090"
echo "   REST API 密钥: $MIHOMO_SECRET"
echo "   实时日志: journalctl -u mihomo -f"
