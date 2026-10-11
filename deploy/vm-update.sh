#!/bin/bash
# Runs ON THE VM, as root, to move the running app to a given commit.
#
#   sudo /opt/reviewqr/deploy/vm-update.sh <git-sha>
#
# This is what the GitHub Actions deploy calls over SSH, and it is also the
# thing to run by hand after an ssh in. The repo is public, so the pull needs
# no credentials and nothing is copied from anybody's laptop.
#
# What it does not touch: /opt/reviewqr/.env (the secrets, which only ever live
# on this machine) and the named Docker volumes holding the SQLite database and
# Caddy's certificates.

set -euo pipefail

REPO_DIR="/opt/reviewqr"
TARGET="${1:-origin/main}"

say() { printf '==> %s\n' "$1"; }
die() { printf '!!! %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die 'Run this with sudo.'
[ -d "$REPO_DIR/.git" ] || die "$REPO_DIR is not a git clone. Was the VM provisioned by gcp-provision.ps1?"
[ -f "$REPO_DIR/.env" ] || die "$REPO_DIR/.env is missing. Send it up with deploy/gcp-set-env.sh first."

cd "$REPO_DIR"

# The deploy runs as root in a directory git may consider owned by someone
# else; this is that directory and no other.
git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true

say "fetching"
git fetch --quiet origin

# A bare sha, a branch, or origin/main. --detach keeps this from leaving the
# clone on a branch that then drifts from what was deployed.
say "checking out $TARGET"
git checkout --quiet --detach "$TARGET" || die "Could not check out $TARGET."
DEPLOYED="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --pretty=%s)"

say "building and starting ($DEPLOYED: $SUBJECT)"
docker compose up -d --build
# Keeps the disk from filling with every previous build's layers.
docker image prune -f >/dev/null

say 'waiting for the app to report healthy'
healthy=0
for _ in $(seq 1 24); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 5
done

docker compose ps

if [ "$healthy" != 1 ]; then
  printf '!!! %s\n' "The app did not become healthy. Recent logs:" >&2
  docker compose logs app --tail=40 >&2
  exit 1
fi

say "deployed $DEPLOYED"
