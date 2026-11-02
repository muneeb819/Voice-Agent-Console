# Prints the current public URL and service status.
$root = "F:\Voice-Agent-Console"

$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist\server.js*" }
$cf = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue

"console : " + $(if ($node) { "running (pid $($node.ProcessId))" } else { "STOPPED" })
"tunnel  : " + $(if ($cf) { "running (pid $($cf.ProcessId))" } else { "STOPPED" })

$txt = (Get-Content "$root\logs\cloudflared.err.log" -Raw -ErrorAction SilentlyContinue) +
       (Get-Content "$root\logs\cloudflared.log" -Raw -ErrorAction SilentlyContinue)
if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
    "public  : $($Matches[0])"
}
else {
    "public  : (no URL found in logs)"
}

try {
    $h = Invoke-RestMethod "http://127.0.0.1:3000/api/health" -TimeoutSec 5
    "health  : ok=$($h.ok) auth=$($h.authEnabled) storage=$($h.storage)"
}
catch {
    "health  : unreachable"
}
