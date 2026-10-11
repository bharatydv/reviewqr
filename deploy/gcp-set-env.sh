#!/bin/bash
# Put the secrets on the VM. Run from the project root, in Git Bash:
#
#   bash deploy/gcp-set-env.sh --project reviewqr-prod
#
# .env.production goes up as /opt/reviewqr/.env, readable by root only. It is
# never committed (.gitignore covers it) and never passes through GitHub or
# Cloud Build: the deploy pipeline only moves code, so the keys live on this
# one machine and nowhere else.
#
# Run it again whenever you change a key - then deploy, or just restart:
#   gcloud compute ssh reviewqr --project=... --zone=... \
#     --command='cd /opt/reviewqr && sudo docker compose up -d'

set -euo pipefail

PROJECT=""
ZONE="us-central1-a"
VM="reviewqr"
RESTART=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --zone)    ZONE="$2"; shift 2 ;;
    --vm)      VM="$2"; shift 2 ;;
    # Also restart the app, so a changed key takes effect now.
    --restart) RESTART=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '==> %s\n' "$1"; }
die()  { printf '!!! %s\n' "$1" >&2; exit 1; }

[ -n "$PROJECT" ] || die 'Which project? Pass --project <id>.'
[ -f ./.env.production ] || die 'No .env.production here. deploy/gcp-provision.ps1 generates one.'

# A missing or placeholder ADMIN_TOKEN would be refused by the app at startup
# anyway; catching it here saves a confusing container crash loop.
token="$(sed -n 's/^ADMIN_TOKEN=//p' ./.env.production | head -1 | tr -d '\r')"
[ -n "$token" ] || die 'ADMIN_TOKEN is empty in .env.production.'
[ "$token" != 'change-me-please' ] || die 'ADMIN_TOKEN still has the example value in .env.production.'
[ "${#token}" -ge 16 ] || die 'ADMIN_TOKEN must be at least 16 characters in production.'

base="$(sed -n 's/^BASE_URL=//p' ./.env.production | head -1 | tr -d '\r')"
case "$base" in
  https://*) : ;;
  *) die "BASE_URL must be an https:// URL in production; it is currently '$base'." ;;
esac

say "sending .env.production to $VM as /opt/reviewqr/.env"
# Into the home directory first: scp cannot write to /opt without root. A
# relative destination resolves against the home directory.
gcloud compute scp ./.env.production "$VM:reviewqr.env" --project="$PROJECT" --zone="$ZONE" \
  || die 'Copying the file to the VM failed.'

gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --command='set -e
  sudo mkdir -p /opt/reviewqr
  sudo mv ~/reviewqr.env /opt/reviewqr/.env
  sudo chown root:root /opt/reviewqr/.env
  sudo chmod 600 /opt/reviewqr/.env
  echo "in place, root-only:"
  sudo ls -l /opt/reviewqr/.env' \
  || die 'Could not install the file on the VM.'

if [ "$RESTART" = 1 ]; then
  say 'restarting the app so the new values take effect'
  gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
    --command='cd /opt/reviewqr && sudo docker compose up -d'
fi

say 'done'
