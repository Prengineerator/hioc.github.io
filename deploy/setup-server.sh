#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu 24.04 LTS server (Vultr, Mumbai —
# see docs/HOSTING-MIGRATION-PLAN.md, step 2). Copy this deploy/ folder to the
# server and run it once as root (or with sudo):
#
#   scp -r deploy root@<server-ip>:~/ && ssh root@<server-ip> 'bash ~/deploy/setup-server.sh'
#
# Safe to re-run: every step checks before it changes anything. It does NOT
# install the cron jobs (that happens at cutover, step 6) and does not start
# the app (the first deploy from GitHub Actions does).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
# Whoever ran it: `ubuntu` via sudo on Lightsail, root on Vultr (no other user).
deploy_user="${SUDO_USER:-$(id -un)}"
here="$(dirname "$(readlink -f "$0")")"

# UTC like Vercel: the cron schedules in hioc-cron are written in UTC, and the
# app's IST date handling was built against a UTC server clock.
timedatectl set-timezone UTC

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq docker.io docker-compose-v2 curl ufw unattended-upgrades
systemctl enable --now docker
usermod -aG docker "$deploy_user"

# Security patches install themselves (Ubuntu's default, made explicit here).
# When one needs a reboot (kernel updates), take it at 23:30 UTC = 05:00 IST:
# the cafe is closed and no hioc-cron job is scheduled near it. Docker brings
# the app and caddy back up on its own after the reboot.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52hioc-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "23:30";
EOF

# 2 GB swap: the app sits around 50–300 MB, but report and image-resizing
# bursts can spike, and swap turns a spike into slowness instead of the kernel
# killing the app mid-service.
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Only SSH and web traffic in. (If the provider's own firewall panel is in
# use, open 22/80/443 there too; Lightsail, for one, blocks 443 by default.)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

install -d -o "$deploy_user" -g "$deploy_user" /opt/hioc /opt/hioc/caddy
install -m 644 -o "$deploy_user" -g "$deploy_user" "$here/docker-compose.yml" /opt/hioc/
install -m 644 -o "$deploy_user" -g "$deploy_user" "$here/caddy/Caddyfile" /opt/hioc/caddy/
install -m 755 -o "$deploy_user" -g "$deploy_user" "$here/deploy.sh" "$here/run-cron.sh" /opt/hioc/
install -m 644 -o "$deploy_user" -g "$deploy_user" "$here/hioc-cron" /opt/hioc/
if [ ! -f /opt/hioc/app.env ]; then
  install -m 600 -o "$deploy_user" -g "$deploy_user" /dev/null /opt/hioc/app.env
fi

cat <<EOF

Server ready. Next:
  1. Fill /opt/hioc/app.env with the production env vars (plan, step 3).
  2. Add this server to GitHub Actions and run the "Deploy to server"
     workflow (plan, step 4).
  3. Log out and back in once so '$deploy_user' picks up the docker group.
EOF
