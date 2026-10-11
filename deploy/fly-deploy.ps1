# ReviewQR -> Fly.io, from nothing to a live https URL.
#
#   .\deploy\fly-deploy.ps1 -App reviewqr-blue-door -Region ams
#
# Run it from the project root. It is safe to run again: an app or volume that
# already exists is left alone, and a re-run is just a redeploy.
#
# What it does:
#   1. checks flyctl is installed and you are logged in
#   2. creates the app and a 1GB volume for the SQLite file
#   3. points fly.toml at your app name and its https hostname
#   4. generates an ADMIN_TOKEN and stores it as a Fly secret
#   5. deploys, then waits for /healthz to answer
#
# Keys for the optional integrations (Anthropic, Google, SMTP) are set
# afterwards with `fly secrets set` - the script prints the exact commands.

[CmdletBinding()]
param(
  # Globally unique; it becomes https://<App>.fly.dev
  [Parameter(Mandatory = $true)][string]$App,
  # ams=Amsterdam, iad=Virginia, lhr=London, bom=Mumbai, syd=Sydney, ...
  # Pick the one nearest your customers: `fly platform regions` lists them all.
  [string]$Region = 'ams',
  [int]$VolumeSizeGb = 1,
  # Skip the deploy and only do the setup, if you want to look things over.
  [switch]$NoDeploy
)

# Not 'Stop': flyctl writes to stderr on ordinary failures, and Windows
# PowerShell turns that into a terminating NativeCommandError. Every flyctl
# call below is checked by its exit code instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Say($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Warn($message) { Write-Host "!!! $message" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. flyctl

$fly = (Get-Command flyctl -ErrorAction SilentlyContinue)
if (-not $fly) { $fly = (Get-Command fly -ErrorAction SilentlyContinue) }
if (-not $fly) {
  # winget and the fly.io installer both add themselves to PATH, which an
  # already-open terminal has not picked up, so look where they install to.
  $known = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Fly-io.flyctl_Microsoft.Winget.Source_8wekyb3d8bbwe\flyctl.exe",
    "$env:USERPROFILE\.fly\bin\flyctl.exe"
  )
  foreach ($candidate in $known) {
    if (Test-Path $candidate) { $fly = Get-Command $candidate; break }
  }
}
if (-not $fly) {
  Warn 'flyctl is not installed. Install it, open a new terminal, and run this script again:'
  Write-Host '    pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"'
  Write-Host '  or, with winget:'
  Write-Host '    winget install --id Fly-io.flyctl'
  exit 1
}
$flyExe = $fly.Source
Say "using $flyExe"

# stderr goes to $null here only: flyctl's own "no access token" line is
# replaced by the friendlier message below. Other calls keep their stderr.
$whoami = (& $flyExe auth whoami 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Warn 'You are not signed in to Fly. Run this, then run the script again:'
  Write-Host '    fly auth login'
  Write-Host '  A new Fly organization gets a short trial and then needs a card;'
  Write-Host '  this app runs at roughly $4/month as configured. See the README.'
  exit 1
}
Say "signed in as $whoami"

if (-not (Test-Path './fly.toml')) {
  Warn 'Run this from the project root (the folder holding fly.toml and server.js).'
  exit 1
}

$hostName = "$App.fly.dev"
$baseUrl = "https://$hostName"

# ------------------------------------------------------- 2. app and volume

$appList = (& $flyExe apps list | Out-String)
if ($LASTEXITCODE -ne 0) {
  Warn 'Could not reach Fly to list your apps. Check your connection and try again.'
  exit 1
}
$existing = $appList -match "(?m)^\s*$([regex]::Escape($App))\s"
if ($existing) {
  Say "app $App already exists, reusing it"
} else {
  Say "creating app $App"
  & $flyExe apps create $App
  if ($LASTEXITCODE -ne 0) {
    Warn "Could not create $App. The name may be taken - try another one."
    exit 1
  }
}

$volumes = (& $flyExe volumes list --app $App | Out-String)
if ($volumes -match 'reviewqr_data') {
  Say 'volume reviewqr_data already exists, reusing it'
} else {
  Say "creating a ${VolumeSizeGb}GB volume in $Region for the SQLite file"
  # One volume, because SQLite has one writer. See the note in fly.toml.
  & $flyExe volumes create reviewqr_data --app $App --region $Region --size $VolumeSizeGb --yes
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

# ------------------------------------------------- 3. fly.toml for this app

Say "pointing fly.toml at $App ($baseUrl)"
$toml = Get-Content './fly.toml' -Raw
$toml = $toml -replace "(?m)^app = '.*'$", "app = '$App'"
$toml = $toml -replace "(?m)^primary_region = '.*'$", "primary_region = '$Region'"
$toml = $toml -replace "(?m)^(\s*)BASE_URL = '.*'$", "`$1BASE_URL = '$baseUrl'"
# Written without a BOM on purpose: Windows PowerShell's `Set-Content -Encoding
# utf8` prepends one, and a BOM before the first comment makes the file invalid
# TOML.
$noBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Resolve-Path './fly.toml'), $toml, $noBom)

# ------------------------------------------------------------ 4. the secret

$secrets = (& $flyExe secrets list --app $App | Out-String)
if ($secrets -match 'ADMIN_TOKEN') {
  Say 'ADMIN_TOKEN is already set; leaving it as it is'
  $adminToken = $null
} else {
  # 32 random bytes, base64 - well past the 16 characters production demands.
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $adminToken = [Convert]::ToBase64String($bytes)
  Say 'generating an ADMIN_TOKEN and storing it as a Fly secret'
  # --stage keeps it from restarting an app that has not been deployed yet.
  & $flyExe secrets set "ADMIN_TOKEN=$adminToken" --app $App --stage
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

if ($NoDeploy) {
  Say 'setup done, skipping the deploy as asked (-NoDeploy)'
  exit 0
}

# ------------------------------------------------------------- 5. deploy

Say 'deploying (Fly builds the image on its own builder, so Docker is not needed here)'
& $flyExe deploy --app $App --ha=false
if ($LASTEXITCODE -ne 0) {
  Warn "The deploy failed. ``fly logs --app $App`` usually says why."
  exit 1
}

Say 'waiting for /healthz'
$ok = $false
foreach ($attempt in 1..20) {
  try {
    $response = Invoke-WebRequest -Uri "$baseUrl/healthz" -TimeoutSec 5 -UseBasicParsing
    if ($response.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    Start-Sleep -Seconds 3
  }
}

Write-Host ''
if ($ok) {
  Say 'live'
} else {
  Warn "Deployed, but $baseUrl/healthz did not answer yet. Give it a minute, then check `fly logs --app $App`."
}

Write-Host ''
Write-Host "  customer page : $baseUrl/b/blue-door-cafe"
Write-Host "  admin console : $baseUrl/admin"
Write-Host "  QR code (SVG) : $baseUrl/api/b/blue-door-cafe/qr.svg?download=1"
if ($adminToken) {
  Write-Host ''
  Write-Host '  Admin password (shown once - save it in your password manager now):'
  Write-Host "    $adminToken"
  Write-Host '  Fly keeps it as a secret; it cannot be read back. To replace it:'
  Write-Host "    fly secrets set ADMIN_TOKEN=... --app $App"
  Write-Host '  Note that rotating it invalidates any login codes in flight.'
}
Write-Host ''
Write-Host '  Optional integrations, whenever you have the keys:'
Write-Host "    fly secrets set ANTHROPIC_API_KEY=sk-ant-... --app $App"
Write-Host "    fly secrets set GOOGLE_CLIENT_ID=....apps.googleusercontent.com --app $App"
Write-Host "    fly secrets set SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... 'MAIL_FROM=Reviews <reviews@example.com>' --app $App"
Write-Host '  Each one restarts the app, which takes a few seconds. Both the AI'
Write-Host '  drafts and the Google prompt can then be switched off per business'
Write-Host '  in the admin console.'
Write-Host ''
