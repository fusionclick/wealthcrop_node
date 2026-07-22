#!/usr/bin/env bash
# Chalao:  sudo bash deploy/install-autoupdate.sh
#
# Watchtower kyun nahi: containrrr/watchtower ki aakhri release 2023 ki hai aur wo
# Docker API 1.25 bolta hai — Docker 29 ka minimum 1.44 hai, to wo har poll par
# fail hota rehta hai. Yehi kaam docker CLI khud kar leta hai.
set -euo pipefail

DIR=/home/ubuntu/wealthcrop_node

cd "$DIR"
# watchtower compose file mein nahi hai, is liye naam se hatana padta hai
docker ps -aq --filter name=watchtower | xargs -r docker rm -f

cat >/usr/local/bin/wc-image-update <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$DIR"

BEFORE=\$(docker compose images -q | sort)
docker compose pull -q
docker compose up -d --remove-orphans
AFTER=\$(docker compose images -q | sort)

if [ "\$BEFORE" != "\$AFTER" ]; then
  echo "updated"
  docker image prune -f >/dev/null
fi
EOF
chmod +x /usr/local/bin/wc-image-update

cat >/etc/systemd/system/wc-image-update.service <<'EOF'
[Unit]
Description=Naya image aaya to container update karo
[Service]
Type=oneshot
ExecStart=/usr/local/bin/wc-image-update
EOF

cat >/etc/systemd/system/wc-image-update.timer <<'EOF'
[Unit]
Description=Har minute naya image check karo
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now wc-image-update.timer

echo "== abhi ek dafa chala kar dekhte hain =="
/usr/local/bin/wc-image-update
echo "done. logs: journalctl -u wc-image-update -f"
