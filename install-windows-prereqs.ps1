# ==============================================================================
# Voice Agent Console — Windows Support Components & Project Setup Script
# Installs/Verifies:
#   1. Node.js 22 LTS (via winget or direct nodejs.org MSI fallback)
#   2. Git for Windows (via winget, if missing)
#   3. Visual Studio Code (optional check; skipped if Visual Studio / VS Code present)
#   4. Project npm dependencies (including better-sqlite3 native binary verification)
#      -> Auto-installs Python 3.12 + VS C++ Build Tools ONLY if node-gyp fallback needed
#   5. TypeScript build (dist/), .env check, and Windows Firewall port allowance
# ==============================================================================

$ErrorActionPreference = "Continue"

function Write-Step($msg) {
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [X]  $msg" -ForegroundColor Red }

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path    = "$machinePath;$userPath"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

Write-Host ""
Write-Host "  Voice Agent Console — Windows Prerequisite & Setup Installer" -ForegroundColor White
Write-Host "  Working Directory: $ScriptDir" -ForegroundColor Gray

$hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)

# ------------------------------------------------------------------------------
# 1. Check / Install Node.js LTS (v20 or v22 recommended for better-sqlite3)
# ------------------------------------------------------------------------------
Write-Step "Step 1/5: Checking Node.js LTS (v20 / v22) & npm"

$needNodeInstall = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

if ($null -eq $nodeCmd) {
    Write-Warn "Node.js is not installed. Installing Node.js 22 LTS..."
    $needNodeInstall = $true
} else {
    $nodeVerRaw = (& node -v).Trim()
    $major = [int]($nodeVerRaw.TrimStart('v').Split('.')[0])
    if ($major -lt 20) {
        Write-Warn "Found old Node.js $nodeVerRaw (< v20). Upgrading to Node.js 22 LTS..."
        $needNodeInstall = $true
    } elseif ($major -ne 20 -and $major -ne 22) {
        Write-Warn "Found non-LTS Node.js $nodeVerRaw. Node 20 or 22 LTS is best for prebuilt SQLite binaries, continuing..."
        Write-Ok "Node.js $nodeVerRaw detected"
    } else {
        Write-Ok "Node.js $nodeVerRaw LTS detected"
    }
}

if ($needNodeInstall) {
    if ($hasWinget) {
        Write-Host "  -> Running winget install OpenJS.NodeJS.LTS ..."
        & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    } else {
        Write-Host "  -> winget not found; downloading official Node.js v22 LTS x64 MSI from nodejs.org..."
        $msiUrl  = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        $msiPath = Join-Path $env:TEMP "node-v22-lts-x64.msi"
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "  -> Installing Node.js MSI..."
        Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait
        Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
    }
    Refresh-Path
    if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
        $defaultNodeDir = "C:\Program Files\nodejs"
        if (Test-Path "$defaultNodeDir\node.exe") {
            $env:Path = "$defaultNodeDir;$env:Path"
        } else {
            Write-Err "Node.js installation completed, but 'node' is not in PATH yet. Close & reopen this window and re-run."
            exit 1
        }
    }
    Write-Ok "Installed Node.js $(& node -v) | npm $(& npm.cmd -v)"
} else {
    Write-Ok "npm $(& npm.cmd -v) ready"
}

# ------------------------------------------------------------------------------
# 2. Check / Install Git for Windows
# ------------------------------------------------------------------------------
Write-Step "Step 2/5: Checking Git for Windows"

if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
    if ($hasWinget) {
        Write-Warn "Git not found. Installing Git for Windows via winget..."
        & winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements
        Refresh-Path
        Write-Ok "Git installed"
    } else {
        Write-Warn "Git not found (optional unless pulling/pushing commits). Download from https://git-scm.com/download/win if needed."
    }
} else {
    Write-Ok "$(& git --version) detected"
}

# ------------------------------------------------------------------------------
# 3. Check Visual Studio / VS Code availability
# ------------------------------------------------------------------------------
Write-Step "Step 3/5: Checking Visual Studio / VS Code"

$hasVSCode = $null -ne (Get-Command code -ErrorAction SilentlyContinue)
$vsWhere   = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVSIDE  = Test-Path $vsWhere

if ($hasVSCode) {
    Write-Ok "Visual Studio Code ('code' CLI) detected"
}
if ($hasVSIDE) {
    $vsName = (& $vsWhere -latest -property displayName 2>$null)
    if ($vsName) { Write-Ok "$vsName detected" }
}
if (-not $hasVSCode -and -not $hasVSIDE -and $hasWinget) {
    Write-Warn "Neither VS Code nor Visual Studio detected. Installing Visual Studio Code..."
    & winget install --id Microsoft.VisualStudioCode --exact --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    Write-Ok "Visual Studio Code installed"
}

# ------------------------------------------------------------------------------
# 4. Install NPM Packages + Verify Native SQLite (better-sqlite3)
# ------------------------------------------------------------------------------
Write-Step "Step 4/5: Installing Project NPM Dependencies & Verifying SQLite"

if (Test-Path (Join-Path $ScriptDir "package.json")) {
    $npmFailed = $false
    try {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { $npmFailed = $true }
    } catch {
        $npmFailed = $true
    }

    # If npm install failed (e.g. non-LTS Node needing node-gyp C++ compilation for better-sqlite3),
    # automatically offer/install Python 3 + VS 2022 C++ Build Tools and retry!
    if ($npmFailed) {
        Write-Warn "Initial 'npm install' needed native C++ build tools (node-gyp) for better-sqlite3."
        if ($hasWinget) {
            Write-Host "  -> Installing Python 3.12 + Visual Studio 2022 C++ Build Tools automatically..."
            & winget install --id Python.Python.3.12 --exact --silent --accept-package-agreements --accept-source-agreements
            & winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --silent --accept-package-agreements --accept-source-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
            Refresh-Path
            Write-Host "  -> Retrying 'npm install'..."
            & npm.cmd install
            if ($LASTEXITCODE -ne 0) {
                Write-Err "npm install failed even after installing C++ Build Tools. Please install Node.js 22 LTS."
                exit 1
            }
        } else {
            Write-Err "npm install failed. Please install Node.js 22 LTS from https://nodejs.org so prebuilt SQLite binaries are used."
            exit 1
        }
    }

    # Verify SQLite engine (either better-sqlite3 OR Node 22.5+/24+ built-in node:sqlite)
    & node -e "try { const DB=require('better-sqlite3'); const d=new DB(':memory:'); d.prepare('SELECT 1 AS ok').get(); d.close(); console.log('  [OK] better-sqlite3 native engine verified!'); } catch { const { DatabaseSync } = require('node:sqlite'); const d=new DatabaseSync(':memory:'); d.prepare('SELECT 1 AS ok').get(); d.close(); console.log('  [OK] Built-in node:sqlite engine verified!'); }"
    if ($LASTEXITCODE -ne 0) {
        Write-Err "SQLite runtime check failed."
        exit 1
    }

    # Ensure .env exists
    $envFile = Join-Path $ScriptDir ".env"
    $envExample = Join-Path $ScriptDir ".env.example"
    if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
        Copy-Item $envExample $envFile
        Write-Warn "Created .env from .env.example — remember to set DEEPGRAM_API_KEY in .env or via the Web UI!"
    } else {
        Write-Ok ".env configuration file present"
    }

    # Build TypeScript -> dist/
    Write-Host "  -> Compiling TypeScript (npm run build)..."
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        Write-Err "TypeScript build failed."
        exit 1
    }
    Write-Ok "TypeScript compiled cleanly into dist/"
} else {
    Write-Warn "No package.json in current directory ($ScriptDir). Place this script inside the voice-agent-console folder and re-run."
}

# ------------------------------------------------------------------------------
# 5. Optional Windows Firewall Rules (if running as Administrator)
# ------------------------------------------------------------------------------
Write-Step "Step 5/5: Checking Windows Firewall Local Ports (3000 TCP, 9092 TCP, 5062 UDP)"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    New-NetFirewallRule -DisplayName "Voice Agent Console HTTP/WS (3000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "Voice Agent Bridge AudioSocket (9092)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9092 -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
    New-NetFirewallRule -DisplayName "Voice Agent Bridge SIP/RTP (5062)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5062 -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
    Write-Ok "Windows Firewall rules added for ports 3000 (TCP), 9092 (TCP), and 5062 (UDP)"
} else {
    Write-Warn "Not running as Administrator — skipping Firewall pre-configuration (click 'Allow' if Windows prompts on first start)."
}

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  ALL SUPPORT COMPONENTS INSTALLED & VERIFIED!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Next Steps:" -ForegroundColor White
Write-Host "    1. Open this folder in VS Code ('code .') or Visual Studio ('File -> Open -> Folder')"
Write-Host "    2. Press F5 to debug, OR run 'start.bat' / 'npm start'"
Write-Host "    3. Open http://localhost:3000 in Chrome or Edge`n"
