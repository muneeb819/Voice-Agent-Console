# Prints the current public client demo URL and service status.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist\server.js*" }
$cf = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue

"console : " + $(if ($node) { "running (pid $($node[0].ProcessId))" } else { "STOPPED" })
"tunnel  : " + $(if ($cf) { "running (pid $($cf[0].ProcessId))" } else { "STOPPED" })

$pubUrl = $null
foreach ($mp in 20241..20249) {
    try {
        $qt = Invoke-RestMethod -Uri "http://localhost:$mp/quicktunnel" -TimeoutSec 1 -ErrorAction Stop
        if ($qt -and $qt.hostname -and ($qt.hostname -match '\.trycloudflare\.com$')) {
            $pubUrl = "https://" + ($qt.hostname -replace '^https?://', '').TrimEnd('/')
            break
        }
    } catch {}
}

if (-not $pubUrl) {
    $txt = (Get-Content "$root\logs\public-demo-url.txt" -Raw -ErrorAction SilentlyContinue) +
           (Get-Content "$root\logs\cloudflared.err.log" -Raw -ErrorAction SilentlyContinue) +
           (Get-Content "$root\logs\cloudflared.log" -Raw -ErrorAction SilentlyContinue)
    if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $pubUrl = $Matches[0]
    }
}

if ($pubUrl) {
    "public  : $pubUrl/login"
} else {
    "public  : (no active tunnel URL detected — run 'npm run demo' or .\ops\start-tunnel.ps1)"
}

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
    "health  : ok=$($h.ok) auth=$($h.authEnabled) storage=$($h.storage)"
}
catch {
    "health  : unreachable"
}
