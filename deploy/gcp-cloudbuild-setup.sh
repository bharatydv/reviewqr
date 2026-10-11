#!/bin/bash
# Make `git push` deploy. Run from the project root, in Git Bash:
#
#   bash deploy/gcp-cloudbuild-setup.sh --project reviewqr-prod
#
# Cloud Build needs two things to deploy to the VM, and this sets up both:
#
#   1. a service account of its own - new projects can no longer use the
#      legacy Cloud Build account - with just enough access: read the build
#      logs, see the instance, and ssh in as a sudoer via OS Login
#   2. a trigger on pushes to main, running cloudbuild.yaml
#
# Connecting the GitHub repository itself is an OAuth install, so it has to be
# done once in the browser. The script checks whether that is already done and
# tells you what to click if not.

set -euo pipefail

PROJECT=""
REGION="us-central1"
ZONE="us-central1-a"
VM="reviewqr"
REPO_OWNER="bharatydv"
REPO_NAME="reviewqr"
BRANCH="main"
SA_NAME="reviewqr-deployer"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --zone)    ZONE="$2"; shift 2 ;;
    --vm)      VM="$2"; shift 2 ;;
    --owner)   REPO_OWNER="$2"; shift 2 ;;
    --repo)    REPO_NAME="$2"; shift 2 ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '==> %s\n' "$1"; }
warn() { printf '!!! %s\n' "$1" >&2; }
die()  { warn "$1"; exit 1; }

[ -n "$PROJECT" ] || die 'Which project? Pass --project <id>.'
[ -f ./cloudbuild.yaml ] || die 'Run this from the project root (the folder holding cloudbuild.yaml).'

SA_EMAIL="$SA_NAME@$PROJECT.iam.gserviceaccount.com"

# --------------------------------------------------------------- 1. the APIs

say 'enabling the Cloud Build, IAM and OS Login APIs'
gcloud services enable cloudbuild.googleapis.com iam.googleapis.com oslogin.googleapis.com \
  --project="$PROJECT" || die 'Could not enable the APIs.'

# ---------------------------------------------------- 2. the service account

if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  say "service account $SA_NAME already exists"
else
  say "creating the service account $SA_NAME"
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name='ReviewQR deployer' \
    --description='Runs the Cloud Build deploy and sshes to the VM' \
    || die 'Could not create the service account.'
fi

# Only what a deploy actually needs. Notably not compute.instanceAdmin: this
# account can log in to the machine, not create or delete machines.
say 'granting it the roles the deploy needs'
for role in \
  roles/logging.logWriter \
  roles/compute.viewer \
  roles/compute.osAdminLogin
do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null || die "Could not grant $role."
  printf '    %s\n' "$role"
done

# ---------------------------------------------------- 3. the GitHub connection

say 'checking whether the GitHub repository is connected to Cloud Build'
connected=0
if gcloud builds triggers list --project="$PROJECT" --format='value(name)' >/dev/null 2>&1; then
  # A 1st-gen GitHub connection shows up as a linked repository here.
  if gcloud alpha builds repositories list --project="$PROJECT" --region="$REGION" \
       --connection=- --format='value(name)' >/dev/null 2>&1; then
    connected=1
  fi
fi

cat <<EOF

  If the next step fails saying the repository is not connected, connect it
  once in the browser - it is an OAuth install, so it cannot be scripted:

    1. open https://console.cloud.google.com/cloud-build/triggers?project=$PROJECT
    2. click "Connect repository"
    3. choose GitHub (Cloud Build GitHub App), authorise it
    4. pick $REPO_OWNER/$REPO_NAME, tick the consent box, click "Connect"
    5. when it offers to create a trigger, click "Done" instead - this script
       creates it with the right service account

  Then run this script again.

EOF

# ------------------------------------------------------------- 4. the trigger

TRIGGER_NAME="reviewqr-deploy-$BRANCH"
if gcloud builds triggers describe "$TRIGGER_NAME" --project="$PROJECT" --region=global >/dev/null 2>&1; then
  say "trigger $TRIGGER_NAME already exists, leaving it alone"
else
  say "creating the trigger $TRIGGER_NAME on pushes to $BRANCH"
  gcloud builds triggers create github \
    --project="$PROJECT" \
    --region=global \
    --name="$TRIGGER_NAME" \
    --repo-owner="$REPO_OWNER" \
    --repo-name="$REPO_NAME" \
    --branch-pattern="^$BRANCH\$" \
    --build-config=cloudbuild.yaml \
    --service-account="projects/$PROJECT/serviceAccounts/$SA_EMAIL" \
    --substitutions="_VM=$VM,_ZONE=$ZONE" \
    --description='Test, then move the ReviewQR VM to the pushed commit' \
    || die 'Could not create the trigger. If it says the repository is not connected, follow the four steps above.'
fi

# ------------------------------------------------------------------ 5. try it

cat <<EOF

==> set up

  Trigger : $TRIGGER_NAME (pushes to $BRANCH)
  Runs as : $SA_EMAIL
  Deploys : $VM in $ZONE

  Deploying is now just:

    git push

  Watch a build:
    https://console.cloud.google.com/cloud-build/builds?project=$PROJECT

  Or run one now without pushing anything:
    gcloud builds triggers run $TRIGGER_NAME --project=$PROJECT --region=global --branch=$BRANCH

EOF
