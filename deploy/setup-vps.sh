#!/usr/bin/env bash
# One-time VPS setup for VI Iraq (Ubuntu/Debian). Safe to re-run: every step checks before acting.
#   Node 22 + Postgres (local) + the app as a systemd service + nginx reverse proxy on port 80.
# Usage (as root on the VPS):  bash setup-vps.sh
set -euo pipefail

APP_DIR=/opt/vi-iraq
APP_USER=viiraq
REPO=https://github.com/ibrahebo-arch/chatbot.git
DB_NAME=vi_iraq
DB_USER=vi_iraq
PORT=3000
DOMAIN=vi-iraq.com

export DEBIAN_FRONTEND=noninteractive
log() { printf '\n== %s\n' "$*"; }

log "Base packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg nginx postgresql ufw certbot python3-certbot-nginx >/dev/null

log "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

log "App user and code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin main && git -C "$APP_DIR" reset -q --hard origin/main
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

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vi-iraq >/dev/null
systemctl restart vi-iraq

log "nginx reverse proxy (port 80 -> $PORT)"
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
ln -sf /etc/nginx/sites-available/vi-iraq /etc/nginx/sites-enabled/vi-iraq
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx

log "Firewall (SSH + HTTP + HTTPS)"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

log "HTTPS"
# certbot can only succeed once the domain's DNS points at this server
SERVER_IP=$(curl -fsS4 https://api.ipify.org || true)
if [ -n "$SERVER_IP" ] && getent ahostsv4 "www.$DOMAIN" | grep -q "$SERVER_IP" && getent ahostsv4 "$DOMAIN" | grep -q "$SERVER_IP"; then
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
