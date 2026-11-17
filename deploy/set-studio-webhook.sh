#!/usr/bin/env bash
# Save the Discord webhook URL for studio notifications. Run as root on the server:  sudo bash set-studio-webhook.sh
# The URL is typed at a hidden prompt, so it never appears on screen, in shell history or in chat.
set -euo pipefail
ENV=/etc/studio/studio.env
[ -f "$ENV" ] || { echo "run deploy/setup-publish.sh first"; exit 1; }
read -rsp "Paste the Discord webhook URL (hidden), then press Enter: " URL; echo
case "$URL" in
  https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*) ;;
  *) echo "That does not look like a Discord webhook URL. Nothing saved."; exit 1 ;;
esac
grep -v '^STUDIO_DISCORD_WEBHOOK=' "$ENV" > "$ENV.tmp" || true
printf 'STUDIO_DISCORD_WEBHOOK=%s\n' "$URL" >> "$ENV.tmp"
install -m 600 -o root -g root "$ENV.tmp" "$ENV"; rm -f "$ENV.tmp"
systemctl restart noob-studio
echo "Saved. The studio will post to Discord when a job needs you."
