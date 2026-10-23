# Nus Local Edition: one-step setup on Windows 10/11.
#
# Run it from setup-windows.bat (double-click), or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup.ps1 [-Mode installer|source]
#
#   1. checks Node.js (installs the LTS with winget if it is missing)
#   2. installs the app's packages (npm ci)
#   3. downloads the local speech engine: whisper.cpp + the English model
#   4. -Mode installer (default): builds dist\Nus-Setup.exe and runs it
#      -Mode source: no installer; puts a "Nus Local" shortcut on the Desktop
#      and in the Start menu that runs this folder directly
#      If the installer build fails (usually Windows refusing symlinks without
#      Developer Mode), it falls back to the source shortcut on its own.
#   5. checks that LM Studio's server answers, and starts it with `lms` if it can
#
# Safe to run again after every `git pull`.

param(
  [ValidateSet('installer', 'source', 'ask')]
  [string]$Mode = 'ask'
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Repo

function Say($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "   XX  $text" -ForegroundColor Red }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Node-Major {
  try { $v = (& node --version) 2>$null } catch { return 0 }
  if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  return 0
}

Write-Host ''
Write-Host '  Nus Local Edition setup  (AI: LM Studio on this PC, voice: whisper.cpp on this PC)' -ForegroundColor White
Write-Host "  Folder: $Repo"

# ---- 1. Node.js -------------------------------------------------------------
Say 'Checking Node.js'
if ((Node-Major) -lt 18) {
  Warn 'Node.js 18 or newer is not installed.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '   Installing Node.js LTS with winget (a Windows prompt may ask to allow it)...'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
  }
  if ((Node-Major) -lt 18) {
    Fail 'Node.js is still missing. Install the LTS from https://nodejs.org (Windows Installer, .msi),'
    Fail 'then close this window and run setup-windows.bat again.'
    exit 1
  }
}
Ok ("Node.js " + (& node --version))

# ---- 2. Packages --------------------------------------------------------------
Say 'Installing the app packages (first time takes a few minutes; Electron is ~100 MB)'
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Warn 'npm ci failed; trying npm install instead.'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'Could not install the packages. Check your internet connection and run this again.'; exit 1 }
}
Ok 'Packages installed'

# ---- 3. Local voice -------------------------------------------------------------
Say 'Downloading the local speech engine (whisper.cpp + English model, ~60 MB, once)'
& npm run setup:voice
if ($LASTEXITCODE -ne 0) {
  Warn 'Voice setup did not finish. Everything except speaking to Nus works; run "npm run setup:voice" later to add it.'
} else {
  Ok 'Local voice ready'
}

# ---- 4. Installer or shortcut -------------------------------------------------------
function New-SourceShortcuts {
  $electron = Join-Path $Repo 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) { Fail "Electron is missing at $electron. Run this setup again."; return $false }
  # The same data folder the installed app uses, so switching between the two keeps your semester.
  $dataDir = Join-Path $env:APPDATA 'Nus'
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nus Local.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Nus Local.lnk')
  )
  foreach ($lnkPath in $targets) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $electron
    $lnk.Arguments = "`"$Repo`" --data-dir=`"$dataDir`""
    $lnk.WorkingDirectory = $Repo
    $lnk.IconLocation = (Join-Path $Repo 'build\icon.ico')
    $lnk.Description = 'Nus Local Edition (LM Studio)'
    $lnk.Save()
  }
  Ok 'Shortcut "Nus Local" added to the Desktop and the Start menu'
  return $true
}

if ($Mode -eq 'ask') {
  Write-Host ''
  Write-Host '   How do you want to run Nus?' -ForegroundColor White
  Write-Host '     [1] Build an installer (Nus-Setup.exe) and install it   (recommended)'
  Write-Host '     [2] Run straight from this folder with a Desktop shortcut (no installer)'
  $choice = Read-Host '   Type 1 or 2 and press Enter'
  if ($choice -eq '2') { $Mode = 'source' } else { $Mode = 'installer' }
}

$launched = $false
if ($Mode -eq 'installer') {
  Say 'Building the installer (2-5 minutes)'
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  # electron-builder directly: "npm run dist -- --publish never" can lose the
  # "--" through npm's PowerShell shim.
  & node (Join-Path $Repo 'node_modules\electron-builder\cli.js') --win --config electron-builder.config.js --publish never
  $setup = Join-Path $Repo 'dist\Nus-Setup.exe'
  if ($LASTEXITCODE -eq 0 -and (Test-Path $setup)) {
    Ok "Built $setup (and dist\Nus-Portable.exe)"
    Write-Host '   Starting the installer. Windows SmartScreen may say "Windows protected your PC":'
    Write-Host '   click "More info", then "Run anyway". It installs for your user only, no admin needed.'
    Start-Process -FilePath $setup
    $launched = $true
  } else {
    Warn 'The installer build failed. The usual cause is Windows refusing to create symbolic links while'
    Warn 'electron-builder unpacks its signing tools. Fix: Settings > Update & Security > For developers >'
    Warn 'Developer Mode ON (or run this from an Administrator terminal), then run setup again.'
    Warn 'Meanwhile, setting Nus up to run straight from this folder instead.'
    $Mode = 'source'
  }
}
if ($Mode -eq 'source') {
  Say 'Creating the Nus Local shortcut'
  if (New-SourceShortcuts) {
    $electron = Join-Path $Repo 'node_modules\electron\dist\electron.exe'
    Start-Process -FilePath $electron -ArgumentList "`"$Repo`"", "--data-dir=`"$(Join-Path $env:APPDATA 'Nus')`"" -WorkingDirectory $Repo
    $launched = $true
  }
}

# ---- 5. LM Studio -------------------------------------------------------------------
Say 'Checking LM Studio'
$lms = $null
$lmsCandidates = @((Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'), (Join-Path $env:USERPROFILE '.cache\lm-studio\bin\lms.exe'))
foreach ($c in $lmsCandidates) { if (Test-Path $c) { $lms = $c; break } }
if (-not $lms) { $cmd = Get-Command lms -ErrorAction SilentlyContinue; if ($cmd) { $lms = $cmd.Source } }

function Get-LmModels {
  try { return Invoke-RestMethod -Uri 'http://127.0.0.1:1234/api/v0/models' -TimeoutSec 4 } catch { return $null }
}
$models = Get-LmModels
if (-not $models -and $lms) {
  Write-Host '   The LM Studio server is not running; starting it with lms...'
  try { & $lms server start | Out-Host } catch { }
  Start-Sleep -Seconds 3
  $models = Get-LmModels
}
if ($models) {
  $loaded = @($models.data | Where-Object { $_.state -eq 'loaded' -and $_.type -ne 'embeddings' })
  if ($loaded.Count -gt 0) {
    foreach ($m in $loaded) {
      $sees = ''; if ($m.type -eq 'vlm') { $sees = ', can see the screen' }
      $ctx = ''; if ($m.loaded_context_length) { $ctx = ", context $($m.loaded_context_length)" }
      Ok "LM Studio is running with $($m.id)$ctx$sees"
      if ($m.loaded_context_length -and [int]$m.loaded_context_length -lt 8192) { Warn 'That context is small. Reload the model with Context Length 16384 so long syllabi fit.' }
    }
  } else {
    Warn 'LM Studio is running but no model is loaded. In LM Studio: Developer tab > Select a model to load > Gemma 4 12B.'
  }
} else {
  Warn 'LM Studio is not answering at http://127.0.0.1:1234.'
  Warn 'Open LM Studio > Developer tab (the green terminal icon) > switch "Status: Stopped" to Running, and load Gemma 4 12B.'
}

Write-Host ''
if ($launched) { Write-Host '  Done. In Nus open Settings > Local AI and press "Test chat" and "Test vision".' -ForegroundColor Green }
Write-Host '  Full guide: INSTALL-WINDOWS.md in this folder.'
Write-Host ''
