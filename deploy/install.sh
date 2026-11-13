#!/usr/bin/env bash
# Install / update noob_dev Studio on an Ubuntu server (run as root):
#   curl -fsSL https://raw.githubusercontent.com/coolboy450/claude-agent/main/deploy/install.sh | bash
# Safe to re-run: it updates the code and restarts the service.
set -euo pipefail

APP_USER=noob
REPO=https://github.com/coolboy450/claude-agent.git
BRANCH=${BRANCH:-main}
PORT=4321

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq curl git ca-certificates ufw >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Claude Code CLI"
npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
claude --version

echo "==> swap (1G, helps small droplets)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> user $APP_USER + code"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
sudo -u "$APP_USER" -H bash -c "
  set -e
  cd ~
  [ -d claude-agent/.git ] || git clone -q $REPO
  git -C claude-agent fetch -q origin
  git -C claude-agent checkout -q $BRANCH
  git -C claude-agent reset -q --hard origin/$BRANCH
  mkdir -p ~/.claude/agents ~/.claude/noob_dev ~/projects
  cp claude-agent/agents/*.md ~/.claude/agents/
  cp claude-agent/noob_dev/brand-guide.md ~/.claude/noob_dev/
"

echo "==> Tailscale"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null

echo "==> firewall: SSH open, studio only over Tailscale"
ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 to any port "$PORT" proto tcp >/dev/null
ufw --force default deny incoming >/dev/null
ufw --force enable >/dev/null

echo "==> service"
install -m 644 "/home/$APP_USER/claude-agent/deploy/noob-studio.service" /etc/systemd/system/noob-studio.service
systemctl daemon-reload
systemctl enable -q noob-studio
systemctl restart noob-studio
sleep 2
systemctl --no-pager --lines=5 status noob-studio | head -12

cat <<EOF

Done. Still needed (once):
  1) tailscale up                         # log in to your Tailscale account
  2) sudo -u $APP_USER -H claude auth login  # log in to Claude (choose your subscription)
Then open  http://<tailscale-ip>:$PORT  from a device on your tailnet.
EOF
