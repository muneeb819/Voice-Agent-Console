# Starts the Cloudflare quick tunnel if it is not already running.
# NOTE: a quick tunnel gets a NEW random hostname every time it restarts.
$root = "F:\Voice-Agent-Console"
$cf = "$root\tools\cloudflared.exe"
$log = "$root\logs\cloudflared.err.log"

New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null

$existing = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue
if ($existing) {
    "tunnel already running (pid $($existing.ProcessId))"
    exit 0
}

Start-Process -FilePath $cf `
    -ArgumentList "tunnel", "--url", "http://115.186.137.240:533", "--no-autoupdate" `
    -RedirectStandardOutput "$root\logs\cloudflared.log" `
    -RedirectStandardError $log `
    -WindowStyle Hidden

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $txt = (Get-Content $log -Raw -ErrorAction SilentlyContinue) + (Get-Content "$root\logs\cloudflared.log" -Raw -ErrorAction SilentlyContinue)
    if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        "public url: $($Matches[0])"
        exit 0
    }
}

"tunnel did not report a URL; see $log"
exit 1
