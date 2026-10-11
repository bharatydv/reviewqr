#!/bin/bash
# Ship ReviewQR to the GCP VM that gcp-provision.ps1 created, and ship every
# update the same way. Run it from the project root, in Git Bash:
#
#   bash deploy/gcp-deploy.sh --project reviewqr-prod
#
# Steps:
#   1. wait for the VM's first-boot script to finish installing Docker
#   2. pack the files the app needs (no node_modules, no local database)
#   3. send them to the VM, with .env.production becoming .env there
#   4. docker compose up -d --build, building the image on the VM
#   5. check https://<hostname>/healthz
#
# The SQLite database and Caddy's certificates live on Docker volumes, so they
# survive every redeploy. Run this as often as you like.

set -euo pipefail

PROJECT=""
ZONE="us-central1-a"
VM="reviewqr"
RESTART_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --zone)    ZONE="$2"; shift 2 ;;
    --vm)      VM="$2"; shift 2 ;;
    # Skip the rebuild and only restart, when all you changed was .env.
    --restart-only) RESTART_ONLY=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '==> %s\n' "$1"; }
warn() { printf '!!! %s\n' "$1" >&2; }
die()  { warn "$1"; exit 1; }

[ -n "$PROJECT" ] || die 'Which project? Pass --project <id> (the one gcp-provision.ps1 created).'
[ -f ./compose.yaml ] || die 'Run this from the project root (the folder holding compose.yaml and server.js).'
[ -f ./.env.production ] || die 'No .env.production here. Run deploy/gcp-provision.ps1 first; it generates one.'
command -v gcloud >/dev/null 2>&1 || die 'The Google Cloud SDK is not on PATH.'

# Plain SSH: a new project's default network comes with default-allow-ssh, and
# GCP uses keys rather than passwords. To close port 22 instead, add a firewall
# rule for the IAP range 35.235.240.0/20 and add --tunnel-through-iap below.
remote() {
  gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --command="$1"
}

# ------------------------------------------- 1. wait for the host to be ready

say 'checking whether the VM has finished installing Docker'
ready=0
for attempt in $(seq 1 30); do
  if remote 'test -f /var/lib/reviewqr-host-ready && echo READY' 2>/dev/null | grep -q READY; then
    ready=1
    break
  fi
  if [ "$attempt" = 1 ]; then
    echo '    not yet: the first boot installs Docker, which takes 2-4 minutes.'
    echo '    waiting (ctrl-c is safe, nothing is half-applied)'
  fi
  printf '    .\n'
  sleep 15
done
[ "$ready" = 1 ] || {
  warn 'The VM never reported ready. Read the first-boot log with:'
  echo "    gcloud compute ssh $VM --project=$PROJECT --zone=$ZONE --command='sudo journalctl -u google-startup-scripts --no-pager | tail -40'"
  exit 1
}
say 'Docker is installed'

# ----------------------------------------------------------- 2. pack the app

# One tarball rather than a directory copy: it is a single scp, it preserves
# the layout exactly, and it avoids Windows path quirks in recursive copies.
# Everything the VM needs to build and run the image, and nothing else - no
# node_modules (npm ci rebuilds them), no data/ (the live database is on a
# Docker volume), and .env.production is renamed to .env on the way in.
# Kept in the project directory and referred to by a relative path on
# purpose: this runs in Git Bash but gcloud is a Windows program, and a
# /tmp/... path would reach it unconverted. .gitignore covers the file.
TARBALL="reviewqr-deploy.tar.gz"
trap 'rm -f "$TARBALL"' EXIT

say 'packing the app'
tar czf "$TARBALL" \
  --transform='s|^\./\.env\.production$|./.env|' \
  ./Dockerfile ./.dockerignore ./compose.yaml \
  ./package.json ./package-lock.json \
  ./server.js ./db.js ./test.js \
  ./lib ./public ./deploy/Caddyfile \
  ./.env.production

say 'sending it to the VM'
gcloud compute scp "$TARBALL" "$VM:reviewqr.tar.gz" --project="$PROJECT" --zone="$ZONE" \
  || die 'Copying the archive to the VM failed.'

# ----------------------------------------------------------- 3. unpack it

# Unpacked into a fresh directory, which then replaces the old one, so a file
# removed from the project does not linger on the server. The named Docker
# volumes holding the database and the certificates are untouched.
say 'installing it on the VM'
remote 'set -e
  rm -rf ~/reviewqr-next && mkdir -p ~/reviewqr-next
  tar xzf ~/reviewqr.tar.gz -C ~/reviewqr-next
  rm -f ~/reviewqr.tar.gz
  sudo mkdir -p /opt/reviewqr
  sudo rsync -a --delete ~/reviewqr-next/ /opt/reviewqr/
  sudo chmod 600 /opt/reviewqr/.env
  sudo chown -R root:root /opt/reviewqr
  rm -rf ~/reviewqr-next' \
  || die 'Could not install the files on the VM.'

# ----------------------------------------------------------- 4. start it

if [ "$RESTART_ONLY" = 1 ]; then
  say 'restarting the containers (--restart-only, so no rebuild)'
  remote 'cd /opt/reviewqr && sudo docker compose up -d'
else
  say 'building the image on the VM and starting it (the first build takes 2-3 minutes)'
  remote 'cd /opt/reviewqr && sudo docker compose up -d --build && sudo docker image prune -f'
fi || {
  warn 'The containers did not come up. Logs:'
  echo "    gcloud compute ssh $VM --project=$PROJECT --zone=$ZONE --command='cd /opt/reviewqr && sudo docker compose logs --tail=60'"
  exit 1
}

remote 'cd /opt/reviewqr && sudo docker compose ps'

# ----------------------------------------------------------- 5. is it live

SITE="$(sed -n 's/^SITE_ADDRESS=//p' ./.env.production | head -1 | tr -d '\r')"
BASE="$(sed -n 's/^BASE_URL=//p' ./.env.production | head -1 | tr -d '\r')"

echo
if [ -n "$SITE" ]; then
  say "checking https://$SITE/healthz"
  live=0
  for _ in $(seq 1 12); do
    if curl -fsS --max-time 8 "https://$SITE/healthz" >/dev/null 2>&1; then
      live=1
      break
    fi
    sleep 5
  done
  if [ "$live" = 1 ]; then
    say 'live'
    echo
    echo "  customer page : $BASE/b/blue-door-cafe"
    echo "  admin console : $BASE/admin"
    echo "  QR code (SVG) : $BASE/api/b/blue-door-cafe/qr.svg?download=1"
    echo
    echo '  The admin password is the ADMIN_TOKEN line in .env.production.'
  else
    warn "The containers are up, but https://$SITE did not answer. Almost always one of:"
    echo "    - DNS: $SITE is not pointing at the VM's IP yet. Check: nslookup $SITE"
    echo "    - Caddy is still getting its certificate, which it cannot do until DNS"
    echo '      resolves. Give it a minute, then read the log:'
    echo "    gcloud compute ssh $VM --project=$PROJECT --zone=$ZONE --command='cd /opt/reviewqr && sudo docker compose logs caddy --tail=40'"
  fi
fi
echo
