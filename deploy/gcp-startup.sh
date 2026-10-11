#!/bin/bash
# Runs once, as root, the first time the GCP VM boots. It only prepares the
# machine - Docker, swap, a firewall - and does not install ReviewQR itself;
# gcp-deploy.ps1 copies the app up afterwards and can be run again for updates.
#
# Progress: sudo journalctl -u google-startup-scripts -f
# Finished: /var/lib/reviewqr-host-ready exists

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if [ -f /var/lib/reviewqr-host-ready ]; then
  echo "host already prepared, nothing to do"
  exit 0
fi

echo "=== swap ==="
# An e2-micro has 1GB of memory, and `docker compose build` plus npm is the
# one moment that wants more. 2GB of swap costs nothing and avoids an OOM
# kill mid-build on a machine that is otherwise comfortable.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Swap here is insurance, not working memory: only reach for it under real
  # pressure, so the app keeps running out of RAM.
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-reviewqr.conf
fi

echo "=== packages ==="
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync unattended-upgrades

echo "=== docker, from Docker's own apt repository ==="
# The signed repository rather than a piped install script, so apt verifies
# what it installs and upgrades come in with the rest of the system.
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
arch="$(dpkg --print-architecture)"
echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $codename stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

echo "=== unattended security upgrades ==="
# The VM is exposed on 80 and 443, so let Debian patch itself.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "=== restart the app after a reboot ==="
# compose already has restart: unless-stopped, which Docker honours on boot
# once the daemon starts. This only makes sure the daemon starts.
systemctl is-enabled docker

touch /var/lib/reviewqr-host-ready
echo "=== host ready ==="
