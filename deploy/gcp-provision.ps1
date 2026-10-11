# ReviewQR -> Google Cloud: create the project and the machine it runs on.
#
#   .\deploy\gcp-provision.ps1 -Project reviewqr-prod -Hostname reviewqr.duckdns.org
#
# Run it from the project root. It creates, in order:
#   1. a GCP project, linked to your billing account
#   2. the Compute Engine API
#   3. a static external IP (so the hostname never has to be repointed)
#   4. a firewall rule opening 80 and 443 to that one machine
#   5. an e2-micro VM running Debian 12, which installs Docker on first boot
#
# It does not install the app: `gcp-deploy.ps1` does that, and is also what you
# run to ship an update. This script is safe to run again - anything that
# already exists is reused.
#
# Cost: an e2-micro in us-central1, us-west1 or us-east1 is covered by GCP's
# Always Free tier, so $0/month within its limits (one instance, 30GB standard
# disk, 1GB of North America egress). Any other region is roughly $7-9/month.

[CmdletBinding()]
param(
  # Must be globally unique across all of GCP, 6-30 characters, lowercase.
  [Parameter(Mandatory = $true)][string]$Project,
  # The hostname customers will reach, e.g. reviewqr.duckdns.org. It is baked
  # into every QR code, so settle it before printing anything.
  [Parameter(Mandatory = $true)][string]$Hostname,
  # us-central1, us-west1 and us-east1 are the free-tier regions.
  [string]$Region = 'us-central1',
  [string]$Zone = 'us-central1-a',
  [string]$VmName = 'reviewqr',
  # Kept for compatibility; the Caddyfile no longer takes an ACME email.
  [string]$AcmeEmail = '',
  # The public repo the VM pulls from. It clones this on first boot, and every
  # deploy after that is a fetch on the machine itself.
  [string]$RepoUrl = 'https://github.com/bharatydv/reviewqr.git'
)

# gcloud writes progress to stderr, which Windows PowerShell would otherwise
# turn into a terminating error. Exit codes are the signal here.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!! $m" -ForegroundColor Yellow }
function Die($m) { Warn $m; exit 1 }

if (-not (Test-Path './compose.yaml')) {
  Die 'Run this from the project root (the folder holding compose.yaml and server.js).'
}
$gcloud = (Get-Command gcloud -ErrorAction SilentlyContinue)
if (-not $gcloud) { Die 'The Google Cloud SDK is not installed: https://cloud.google.com/sdk/docs/install' }

# ------------------------------------------------------------ 0. who are we

$account = (& gcloud config get-value account 2>$null | Out-String).Trim()
if (-not $account -or $account -eq '(unset)') {
  Die 'No gcloud account is active. Run `gcloud auth login` first.'
}
Say "acting as $account"
Write-Host "    If that is the wrong account: gcloud auth login" -ForegroundColor DarkGray

# ------------------------------------------------------------- 1. project

$projectExists = $false
& gcloud projects describe $Project --format='value(projectId)' 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $projectExists = $true }

if ($projectExists) {
  Say "project $Project already exists, reusing it"
} else {
  Say "creating project $Project"
  & gcloud projects create $Project --name='ReviewQR' --set-as-default
  if ($LASTEXITCODE -ne 0) {
    Die "Could not create $Project. Project ids are globally unique, so try another, e.g. $Project-1."
  }
}
& gcloud config set project $Project | Out-Null

# --------------------------------------------------------- 2. billing link

$linked = (& gcloud billing projects describe $Project --format='value(billingEnabled)' 2>$null | Out-String).Trim()
if ($linked -eq 'True') {
  Say 'billing is already linked'
} else {
  $accounts = (& gcloud billing accounts list --filter='open=true' --format='value(name)' 2>$null | Out-String).Trim()
  if (-not $accounts) {
    Warn 'No open billing account was found on this login.'
    Write-Host '  A VM needs one even inside the Always Free tier - Google will not charge'
    Write-Host '  you for an e2-micro in a free-tier region, but it needs a card on file.'
    Write-Host '  Create one at https://console.cloud.google.com/billing, then run this again.'
    exit 1
  }
  $billing = ($accounts -split "`r?`n")[0].Trim()
  Say "linking billing account $billing"
  & gcloud billing projects link $Project --billing-account=$billing
  if ($LASTEXITCODE -ne 0) { Die 'Could not link the billing account. Link it in the console and run this again.' }
}

# ------------------------------------------------------------ 3. the API

Say 'enabling the Compute Engine API (this takes a minute the first time)'
& gcloud services enable compute.googleapis.com --project=$Project
if ($LASTEXITCODE -ne 0) { Die 'Could not enable the Compute Engine API.' }

# ------------------------------------------------------------ 4. static IP

$ipName = "$VmName-ip"
$address = (& gcloud compute addresses describe $ipName --region=$Region --project=$Project --format='value(address)' 2>$null | Out-String).Trim()
if ($address) {
  Say "reusing static IP $address"
} else {
  Say "reserving a static IP in $Region"
  & gcloud compute addresses create $ipName --region=$Region --project=$Project
  if ($LASTEXITCODE -ne 0) { Die 'Could not reserve a static IP.' }
  $address = (& gcloud compute addresses describe $ipName --region=$Region --project=$Project --format='value(address)' | Out-String).Trim()
}
# A reserved address is free while it is attached to a running instance, and
# billed by the hour while it is not - so do not stop the VM for long.

# ------------------------------------------------------------ 5. firewall

$ruleName = "$VmName-allow-web"
& gcloud compute firewall-rules describe $ruleName --project=$Project 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Say "firewall rule $ruleName already exists"
} else {
  Say 'opening 80 and 443, to this machine only'
  # Scoped by target tag, so it opens nothing else in the project. SSH comes
  # in over Google's IAP range rather than a public port.
  & gcloud compute firewall-rules create $ruleName `
    --project=$Project `
    --allow=tcp:80,tcp:443 `
    --target-tags="$VmName" `
    --source-ranges=0.0.0.0/0 `
    --description='HTTP and HTTPS for ReviewQR (Caddy terminates TLS)'
  if ($LASTEXITCODE -ne 0) { Die 'Could not create the firewall rule.' }
}

# ------------------------------------------------------------------ 6. VM

& gcloud compute instances describe $VmName --zone=$Zone --project=$Project 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Say "VM $VmName already exists, leaving it alone"
} else {
  # enable-oslogin lets Cloud Build's service account ssh in through IAM
  # instead of anyone managing SSH keys; repo-url tells the first boot what to
  # clone.
  Say "creating the $VmName VM (e2-micro, Debian 12) in $Zone"
  & gcloud compute instances create $VmName `
    --project=$Project `
    --zone=$Zone `
    --machine-type=e2-micro `
    --image-family=debian-12 `
    --image-project=debian-cloud `
    --boot-disk-size=30GB `
    --boot-disk-type=pd-standard `
    --tags="$VmName" `
    --address=$address `
    --metadata-from-file=startup-script=deploy/gcp-startup.sh `
    --metadata="repo-url=$RepoUrl,enable-oslogin=TRUE" `
    --labels=app=reviewqr
  if ($LASTEXITCODE -ne 0) { Die 'Could not create the VM.' }
}

# ------------------------------------------------------- 7. the .env to ship

# Written locally, copied up by gcp-deploy.ps1, and never committed: .gitignore
# already covers .env.
if (Test-Path './.env.production') {
  Say '.env.production already exists, keeping it (and the ADMIN_TOKEN in it)'
} else {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $adminToken = [Convert]::ToBase64String($bytes)
  Say 'writing .env.production with a freshly generated ADMIN_TOKEN'
  $lines = @(
    '# Generated by deploy/gcp-provision.ps1. Copied to the VM by gcp-deploy.ps1.',
    '# Real secrets live here and nowhere else; .gitignore covers it.',
    'NODE_ENV=production',
    "BASE_URL=https://$Hostname",
    "SITE_ADDRESS=$Hostname",
    "ADMIN_TOKEN=$adminToken",
    'TRUST_PROXY=1',
    'DB_PATH=/data/reviewqr.db',
    'MAX_VISIBLE_REVIEWS=6',
    '',
    '# Fill these in when you have them, then run deploy/gcp-deploy.ps1 again.',
    '# Both the AI drafts and the Google prompt can also be switched off per',
    '# business in the admin console.',
    'ANTHROPIC_API_KEY=',
    'ANTHROPIC_MODEL=claude-opus-5-5',
    'GOOGLE_CLIENT_ID=',
    'SMTP_HOST=',
    'SMTP_PORT=587',
    'SMTP_USER=',
    'SMTP_PASS=',
    'MAIL_FROM="ReviewQR <no-reply@example.com>"'
  )
  $noBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText((Join-Path $PWD '.env.production'), ($lines -join "`n") + "`n", $noBom)
}

# --------------------------------------------------------------- what next

Write-Host ''
Say 'the machine is up'
Write-Host ''
Write-Host "  project    : $Project"
Write-Host "  VM         : $VmName in $Zone (e2-micro, Debian 12)"
Write-Host "  IP address : $address"
Write-Host "  hostname   : $Hostname"
Write-Host ''
Write-Host '  NEXT, point the hostname at that IP:' -ForegroundColor Yellow
if ($Hostname -like '*.duckdns.org') {
  $sub = $Hostname -replace '\.duckdns\.org$', ''
  Write-Host "    1. open https://www.duckdns.org and sign in"
  Write-Host "    2. add the subdomain:  $sub"
  Write-Host "    3. put $address in its 'current ip' box and press update"
} else {
  Write-Host "    add a DNS A record:  $Hostname  ->  $address"
}
Write-Host ''
Write-Host '  THEN install the app (Docker needs a few minutes to finish first):'
Write-Host "    .\deploy\gcp-deploy.ps1 -Project $Project -Zone $Zone"
Write-Host ''
