# Starts the Voice Agent Console in the background if it is not already running.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist\server.js*" }

if ($existing) {
    "console already running (pid $($existing.ProcessId))"
    exit 0
}

# Let the server load .env or use its loopback defaults; do not override an
# operator's existing listener and peer settings or enable debug logging.

Start-Process -FilePath $node -ArgumentList "dist\server.js" `
    -WorkingDirectory $root `
    -RedirectStandardOutput "$root\logs\stdout.log" `
    -RedirectStandardError "$root\logs\stderr.log" `
    -WindowStyle Hidden

Start-Sleep -Seconds 5
$port = if ($env:PORT) { $env:PORT } else {
    # Match the server's dotenv-based PORT when it is not exported in the shell.
    $envFile = if ($env:VAC_ENV_FILE) { $env:VAC_ENV_FILE } else { Join-Path $root ".env" }
    $portLine = if (Test-Path $envFile) {
        Get-Content $envFile | Select-String -Pattern '^\s*(?:export\s+)?PORT\s*=\s*["'']?([0-9]+)["'']?\s*(?:#.*)?$' | Select-Object -Last 1
    }
    if ($portLine) { $portLine.Matches[0].Groups[1].Value } else { "533" }
}
try {
    $h = Invoke-RestMethod "http://127.0.0.1:${port}/api/health" -TimeoutSec 5
    "console started on port $port; health ok=$($h.ok) auth=$($h.authEnabled)"
}
catch {
    "console start FAILED: $($_.Exception.Message)"
    Get-Content "$root\logs\stderr.log" -ErrorAction SilentlyContinue | Select-Object -Last 20
    exit 1
}
