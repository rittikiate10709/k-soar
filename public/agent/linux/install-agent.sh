#!/bin/sh
# Smart Topology NOC - ติดตั้ง Agent บน Linux (systemd)
#   sudo sh install-agent.sh --server https://noc.hospital.local:3000 --key stk_xxxxxxxx [--interval 60] [--insecure]
#   sudo sh install-agent.sh --uninstall
set -e
SERVER=""; KEY=""; INTERVAL=60; INSECURE=false; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --insecure) INSECURE=true; shift;;
    --uninstall) UNINSTALL=1; shift;;
    *) echo "ไม่รู้จัก argument: $1"; exit 1;;
  esac
done
[ "$(id -u)" = "0" ] || { echo "กรุณารันด้วย sudo / root"; exit 1; }
BIN=/usr/local/bin/smart-topology-agent

if [ "$UNINSTALL" = "1" ]; then
  systemctl disable --now smart-topology-agent.timer 2>/dev/null || true
  rm -f /etc/systemd/system/smart-topology-agent.service /etc/systemd/system/smart-topology-agent.timer "$BIN" /etc/smart-topology-agent.json
  rm -rf /var/lib/smart-topology-agent
  systemctl daemon-reload
  echo "ถอนการติดตั้ง Smart Topology agent แล้ว"; exit 0
fi

[ -n "$SERVER" ] && [ -n "$KEY" ] || { echo "ใช้: sudo sh install-agent.sh --server https://noc:3000 --key stk_xxxxxxxx"; exit 1; }
command -v python3 >/dev/null || { echo "ต้องมี python3 (dnf install python3 / apt install python3)"; exit 1; }
SERVER=$(echo "$SERVER" | sed 's#/*$##')

DIR=$(cd "$(dirname "$0")" && pwd)
if [ -f "$DIR/smart-topology-agent.py" ]; then
  install -m 0755 "$DIR/smart-topology-agent.py" "$BIN"
else
  CURL_K=""; [ "$INSECURE" = "true" ] && CURL_K="-k"
  curl -fsSL $CURL_K "$SERVER/agent/linux/smart-topology-agent.py" -o "$BIN"; chmod 0755 "$BIN"
fi

umask 077
cat > /etc/smart-topology-agent.json <<EOF
{"server": "$SERVER", "key": "$KEY", "insecure": $INSECURE, "software": true, "intervalMinutes": $INTERVAL}
EOF
chmod 600 /etc/smart-topology-agent.json

cat > /etc/systemd/system/smart-topology-agent.service <<'EOF'
[Unit]
Description=Smart Topology inventory agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env python3 /usr/local/bin/smart-topology-agent
Nice=10
EOF
cat > /etc/systemd/system/smart-topology-agent.timer <<EOF
[Unit]
Description=Run Smart Topology inventory agent every $INTERVAL minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL}min
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
EOF
command -v dmidecode >/dev/null || echo "แนะนำ: ติดตั้ง dmidecode เพื่ออ่านรายละเอียด RAM (dnf install dmidecode / apt install dmidecode)"
command -v lspci >/dev/null || echo "แนะนำ: ติดตั้ง pciutils เพื่ออ่านการ์ดจอ"
systemctl daemon-reload
systemctl enable --now smart-topology-agent.timer
echo "ส่งรายงานครั้งแรก..."
if systemctl start smart-topology-agent.service; then tail -n 2 /var/log/smart-topology-agent.log 2>/dev/null; echo "ติดตั้งเรียบร้อย — ส่งรายงานทุก $INTERVAL นาที"; else echo "ติดตั้งแล้ว แต่ส่งรายงานครั้งแรกไม่สำเร็จ: journalctl -u smart-topology-agent"; fi
