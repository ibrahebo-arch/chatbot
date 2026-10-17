#!/usr/bin/env bash
# Nightly backup of VI Iraq on the VPS: database, customer files, settings.
# Installed as /root/backup-vi-iraq.sh and run by root's cron at 03:30. Keeps 14 days.
# The code itself is on GitHub, so it is not copied here.
set -euo pipefail
umask 077
DEST=/var/backups/vi-iraq
KEEP_DAYS=14
STAMP=$(date +%Y-%m-%d_%H%M)
DIR="$DEST/$STAMP"
mkdir -p "$DIR"

# database (custom format: restore with pg_restore -d vi_iraq --clean)
sudo -u postgres pg_dump -Fc vi_iraq > "$DIR/vi_iraq.dump"
# customer uploads, free-trial results, voice recordings
tar -czf "$DIR/storage.tar.gz" -C /var/lib/vi-iraq storage
# settings (contains secrets: this folder is root-only)
cp /opt/vi-iraq/.env "$DIR/env"
tar -czf "$DIR/server-config.tar.gz" /etc/nginx/sites-available /etc/systemd/system/vi-iraq.service /root/setup-vps.sh 2>/dev/null || true
sudo -u viiraq git -C /opt/vi-iraq rev-parse HEAD > "$DIR/commit.txt"
(cd "$DIR" && sha256sum * > SHA256SUMS)

ln -sfn "$DIR" "$DEST/latest"
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "backup ok: $DIR ($(du -sh "$DIR" | cut -f1))"
