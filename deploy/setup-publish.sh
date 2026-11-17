#!/usr/bin/env bash
# Sets up the "Publish" feature of the studio (run as root; install.sh calls it, and it is safe to re-run).
#
# Security model — why it is built this way:
#   * The studio (user "noob") can run AI agents that write code, so it must NEVER hold GitHub write access.
#   * Only a root-owned helper (/usr/local/bin/studio-publish) can push, using deploy keys that only root can read.
#   * The helper and its config live in root-owned places the studio user cannot edit.
#   * sudo lets "noob" run that ONE command and nothing else.
#   * The helper re-runs the safety checks itself, so the UI cannot skip them.
set -euo pipefail
APP_USER=${APP_USER:-noob}
SRC="/home/$APP_USER/claude-agent"
LIB=/usr/local/lib/studio-publish
ETC=/etc/studio

echo "==> publish helper (root-owned)"
install -d -m 755 -o root -g root "$LIB"
install -m 644 -o root -g root "$SRC/studio/publish.js" "$LIB/publish.js"
install -m 644 -o root -g root "$SRC/studio/checks.js" "$LIB/checks.js"
install -m 755 -o root -g root "$SRC/deploy/studio-publish" /usr/local/bin/studio-publish

echo "==> sudo rule (only this one command)"
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/studio-publish\n' "$APP_USER" > /etc/sudoers.d/studio-publish
chmod 440 /etc/sudoers.d/studio-publish
visudo -cf /etc/sudoers.d/studio-publish >/dev/null || { rm -f /etc/sudoers.d/studio-publish; echo "sudoers check failed"; exit 1; }

echo "==> config + deploy keys"
install -d -m 755 -o root -g root "$ETC"
install -d -m 700 -o root -g root "$ETC/keys" /var/lib/studio-publish
for name in noob-main-site stock-trading-bot; do
  [ -f "$ETC/keys/$name" ] || ssh-keygen -q -t ed25519 -N '' -C "noob-studio-$name" -f "$ETC/keys/$name"
done

# Addresses of this server must never end up in a public site: collect them at install time (nothing is hard-coded in the repo).
IPS="$( (hostname -I 2>/dev/null; tailscale ip -4 2>/dev/null) | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u | paste -sd, - || true)"
if [ ! -f "$ETC/publish.json" ]; then
  OWNER_EMAILS="${OWNER_EMAILS:-}" SERVER_IPS="$IPS" ETC="$ETC" node -e '
    const fs = require("fs"), e = process.env;
    const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
    const cfg = {
      workdir: "/var/lib/studio-publish",
      author: { name: "noob_dev Studio", email: "coolboy450@users.noreply.github.com" },
      checks: { allowedEmails: list(e.OWNER_EMAILS), allowedDomains: [], forbidden: [...list(e.SERVER_IPS), ":4321", ":8000"] },
      projects: {
        "noob-main-site": { dir: "/home/noob/projects/noob-main-site", repo: "git@github.com:coolboy450/coolboy450.github.io.git", key: e.ETC + "/keys/noob-main-site", branch: "main", mode: "pages", url: "https://coolboy450.github.io/", owner: "noob" },
        "stock-trading-bot": { dir: "/home/noob/projects/stock-trading-bot", repo: "git@github.com:coolboy450/stock-trading-bot.git", key: e.ETC + "/keys/stock-trading-bot", branch: "main", mode: "branch", owner: "noob" }
      }
    };
    fs.writeFileSync(e.ETC + "/publish.json", JSON.stringify(cfg, null, 2) + "\n");
  '
  chmod 644 "$ETC/publish.json"
  echo "   created $ETC/publish.json"
else
  echo "   kept existing $ETC/publish.json"
fi

# Studio environment (Discord webhook + the link used in notifications). Root-owned: systemd reads it as root.
if [ ! -f "$ETC/studio.env" ]; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  { echo "STUDIO_PUBLISH_CONFIG=$ETC/publish.json"; [ -n "$TS_IP" ] && echo "STUDIO_BASE_URL=http://$TS_IP:4321"; } > "$ETC/studio.env"
  chmod 600 "$ETC/studio.env"
fi

echo
echo "Deploy keys — add each one to its GitHub repo (Settings > Deploy keys, tick 'Allow write access'):"
for name in noob-main-site stock-trading-bot; do echo "--- $name"; cat "$ETC/keys/$name.pub"; done
