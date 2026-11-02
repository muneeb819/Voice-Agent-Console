# Starts the Voice Agent Console if it is not already running.
$root = "F:\Voice-Agent-Console"
$node = "C:\Program Files\nodejs\node.exe"

New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null

$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist\server.js*" }

if ($existing) {
    "console already running (pid $($existing.ProcessId))"
    exit 0
}

$env:HOST = "115.186.137.240"
$env:PORT = "533"
$env:BRIDGE_BIND_HOST = "115.186.137.240"

Start-Process -FilePath $node -ArgumentList "dist\server.js" `
    -WorkingDirectory $root `
    -RedirectStandardOutput "$root\logs\stdout.log" `
    -RedirectStandardError "$root\logs\stderr.log" `
    -WindowStyle Hidden

Start-Sleep -Seconds 5
try {
    try {
        $h = Invoke-RestMethod "http://115.186.137.240:533/api/health" -TimeoutSec 3
    } catch {
        $h = Invoke-RestMethod "http://localhost:533/api/health" -TimeoutSec 5
    }
    "console started on port 533; health ok=$($h.ok) auth=$($h.authEnabled)"
}
catch {
    "console start FAILED: $($_.Exception.Message)"
    Get-Content "$root\logs\stderr.log" -ErrorAction SilentlyContinue | Select-Object -Last 20
    exit 1
}
