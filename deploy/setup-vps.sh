#!/usr/bin/env bash
# One-time VPS setup for VI Iraq (Ubuntu/Debian). Safe to re-run: every step checks before acting.
#   Node 22 + Postgres (local) + the app as a systemd service + nginx reverse proxy on port 80.
#   Hardening: SSH key-only on port 2222 + fail2ban, automatic security updates, website ports open to Cloudflare
#   only (CLOUDFLARE_ONLY=false while the DNS records are "DNS only"), uploads in a permanent folder.
# Usage (as root on the VPS):  bash setup-vps.sh
set -euo pipefail

APP_DIR=/opt/vi-iraq
APP_USER=viiraq
REPO=https://github.com/ibrahebo-arch/chatbot.git
DB_NAME=vi_iraq
DB_USER=vi_iraq
PORT=3000
DOMAIN=vi-iraq.com
STORAGE_DIR=/var/lib/vi-iraq/storage
CLOUDFLARE_ONLY=${CLOUDFLARE_ONLY:-true}
SSH_PORT=2222   # port 22 is closed: almost all SSH bots only try 22

export DEBIAN_FRONTEND=noninteractive
log() { printf '\n== %s\n' "$*"; }

log "Base packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg nginx postgresql ufw certbot python3-certbot-nginx fail2ban unattended-upgrades >/dev/null

log "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

log "App user and code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  # git runs as the app user: the checkout belongs to it (root would hit "dubious ownership")
  sudo -u "$APP_USER" -H git -C "$APP_DIR" fetch -q --depth 1 origin main
  sudo -u "$APP_USER" -H git -C "$APP_DIR" reset -q --hard origin/main
else
  git clone -q --depth 1 "$REPO" "$APP_DIR"
fi
mkdir -p "$APP_DIR/orders" "$APP_DIR/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

log "Postgres database"
systemctl enable --now postgresql >/dev/null
PW_FILE=/root/.vi-iraq-db-password
[ -f "$PW_FILE" ] || { openssl rand -hex 24 > "$PW_FILE"; chmod 600 "$PW_FILE"; }
DB_PW=$(cat "$PW_FILE")
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PW'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE DATABASE $DB_NAME OWNER $DB_USER"

log ".env"
ENV_FILE="$APP_DIR/.env"
# a freshly uploaded /root/vi-iraq.env replaces the app's .env (DATABASE_URL/PORT are set below)
[ -f /root/vi-iraq.env ] && mv -f /root/vi-iraq.env "$ENV_FILE"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE - upload it to /root/vi-iraq.env first."; exit 1; }
DB_URL="postgresql://$DB_USER:$DB_PW@localhost:5432/$DB_NAME"
set_env() { grep -q "^$1=" "$ENV_FILE" && sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE" || echo "$1=$2" >> "$ENV_FILE"; }
set_env DATABASE_URL "$DB_URL"
set_env PORT "$PORT"
set_env TELEGRAM_POLL ""
# customer uploads: a permanent folder (the default temp folder is wiped on every reboot)
mkdir -p "$STORAGE_DIR"; chown -R "$APP_USER:$APP_USER" "$(dirname "$STORAGE_DIR")"; chmod 700 "$(dirname "$STORAGE_DIR")" "$STORAGE_DIR"
for old in /tmp/vi-iraq-dev-storage/*; do [ -e "$old" ] && cp -an "$old" "$STORAGE_DIR"/ || true; done
set_env STORAGE_DIR "$STORAGE_DIR"
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

log "systemd service"
cat > /etc/systemd/system/vi-iraq.service <<EOF
[Unit]
Description=VI Iraq web app
After=network.target postgresql.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vi-iraq >/dev/null
systemctl restart vi-iraq

log "trained model (studies real footage and trends every 3 hours, report daily; TRAINED_MODEL=0 in .env pauses it)"
cat > /etc/systemd/system/vi-iraq-trained-model.service <<EOF
[Unit]
Description=VI Iraq trained model - one study cycle
After=network.target postgresql.service

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --env-file=$APP_DIR/.env tools/trained-model.js cycle
Nice=10
TimeoutStartSec=3600
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
EOF
cat > /etc/systemd/system/vi-iraq-trained-model.timer <<EOF
[Unit]
Description=VI Iraq trained model every 3 hours

[Timer]
OnCalendar=*-*-* 00/3:20:00
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/vi-iraq-trained-report.service <<EOF
[Unit]
Description=VI Iraq trained model - daily report
After=network.target postgresql.service

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --env-file=$APP_DIR/.env tools/trained-model.js report --hours 24
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
EOF
cat > /etc/systemd/system/vi-iraq-trained-report.timer <<EOF
[Unit]
Description=VI Iraq trained model report every evening

[Timer]
OnCalendar=*-*-* 19:45:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now vi-iraq-trained-model.timer vi-iraq-trained-report.timer >/dev/null

log "nginx reverse proxy (port 80 -> $PORT)"
# once certbot has added HTTPS to the site, leave the config alone (rewriting it drops the 443 block)
if grep -q "managed by Certbot" /etc/nginx/sites-available/vi-iraq 2>/dev/null; then
  echo "HTTPS config present - keeping it."
else
cat > /etc/nginx/sites-available/vi-iraq <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $DOMAIN www.$DOMAIN _;
    client_max_body_size 250m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
fi
ln -sf /etc/nginx/sites-available/vi-iraq /etc/nginx/sites-enabled/vi-iraq
rm -f /etc/nginx/sites-enabled/default

# Cloudflare's address ranges (fallback list if the download fails)
CF_V4=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4 || echo "173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22")
CF_V6=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6 || echo "2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32")
# nginx: no version in headers; the visitor address comes from Cloudflare's CF-Connecting-IP
{
  echo "# managed by setup-vps.sh"
  echo "server_tokens off;"
  for r in $CF_V4 $CF_V6; do echo "set_real_ip_from $r;"; done
  echo "real_ip_header CF-Connecting-IP;"
} > /etc/nginx/conf.d/vi-iraq-hardening.conf
nginx -t -q && systemctl reload nginx

log "Firewall (SSH on $SSH_PORT + website)"
ufw allow "$SSH_PORT/tcp" comment ssh >/dev/null
if [ "$CLOUDFLARE_ONLY" = "true" ]; then
  # the website is only reachable through Cloudflare (no bypassing its protection by calling the IP)
  ufw delete allow 'Nginx Full' >/dev/null 2>&1 || true
  for r in $CF_V4 $CF_V6; do ufw allow proto tcp from "$r" to any port 80,443 comment cloudflare >/dev/null; done
else
  ufw allow 'Nginx Full' >/dev/null
fi
ufw --force enable >/dev/null

log "SSH: key-only login + fail2ban"
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/00-vi-iraq-hardening.conf <<EOF
# managed by setup-vps.sh – keys only, no passwords
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no
EOF
  sshd -t && systemctl reload ssh
else
  echo "No SSH key in /root/.ssh/authorized_keys - keeping password login so you are not locked out."
fi
# SSH listens on $SSH_PORT only (Ubuntu 24.04 starts sshd from ssh.socket, so the port is set there).
# The new port is opened in ufw above before 22 is closed, so a running session is never cut off.
mkdir -p /etc/systemd/system/ssh.socket.d
printf "%s\n" "[Socket]" "ListenStream=" "ListenStream=0.0.0.0:$SSH_PORT" "ListenStream=[::]:$SSH_PORT" > /etc/systemd/system/ssh.socket.d/listen.conf
systemctl daemon-reload
systemctl is-active -q ssh.socket && systemctl restart ssh.socket
ufw delete allow OpenSSH >/dev/null 2>&1 || true
ufw delete allow 22/tcp >/dev/null 2>&1 || true
cat > /etc/fail2ban/jail.d/vi-iraq.local <<EOF
[sshd]
enabled = true
backend = systemd
port = $SSH_PORT
maxretry = 3
findtime = 1h
bantime = 24h

# banned 3 times within a day -> banned for a week
[recidive]
enabled = true
logpath = /var/log/fail2ban.log
banaction = %(banaction_allports)s
findtime = 1d
maxretry = 3
bantime = 1w
EOF
systemctl enable --now fail2ban >/dev/null 2>&1; systemctl restart fail2ban

log "Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<EOF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

log "HTTPS"
# certbot can only succeed once the domain's DNS points at this server
SERVER_IP=$(curl -fsS4 https://api.ipify.org || true)
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "Certificate already present (auto-renews via certbot.timer)."
elif [ -n "$SERVER_IP" ] && getent ahostsv4 "www.$DOMAIN" | grep -q "$SERVER_IP" && getent ahostsv4 "$DOMAIN" | grep -q "$SERVER_IP"; then
  certbot --nginx -n --agree-tos --register-unsafely-without-email --redirect -d "$DOMAIN" -d "www.$DOMAIN" || echo "certbot failed - site stays on HTTP"
else
  echo "DNS for $DOMAIN does not point to $SERVER_IP yet - skipping HTTPS (re-run this script after updating DNS)."
fi

log "Health check"
for i in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1 && { echo "App is up."; break; }
  sleep 1
done
systemctl --no-pager --lines=15 status vi-iraq || true
