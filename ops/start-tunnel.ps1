# Starts the Cloudflare HTTPS client demo tunnel in the background (IPv4-safe on Windows).
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cf = Join-Path $root "tools\cloudflared.exe"
$log = Join-Path $root "logs\cloudflared.err.log"
$outLog = Join-Path $root "logs\cloudflared.log"
$urlFile = Join-Path $root "logs\public-demo-url.txt"

New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root "tools") | Out-Null

if (-not (Test-Path $cf)) {
    Write-Host "Downloading official cloudflared.exe into $cf ..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cf
}

function Get-QuickTunnelUrl {
    foreach ($mp in 20241..20249) {
        try {
            $qt = Invoke-RestMethod -Uri "http://localhost:$mp/quicktunnel" -TimeoutSec 1 -ErrorAction Stop
            if ($qt -and $qt.hostname) {
                $h = ($qt.hostname -replace '^https?://', '').TrimEnd('/')
                if ($h -match '\.trycloudflare\.com$') {
                    return "https://$h"
                }
            }
        } catch {}
    }
    return $null
}

$existing = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue
if ($existing) {
    $liveUrl = Get-QuickTunnelUrl
    if (-not $liveUrl -and (Test-Path $urlFile)) {
        $liveUrl = (Get-Content $urlFile -Raw).Trim()
    }
    Write-Host "Tunnel already running (PID $($existing[0].ProcessId))" -ForegroundColor Cyan
    if ($liveUrl) {
        Set-Content -Path $urlFile -Value $liveUrl -Encoding UTF8
        Write-Host "SHARE THIS CLIENT LOGIN LINK: $liveUrl/login" -ForegroundColor Green
    }
    exit 0
}

Remove-Item $log, $outLog, $urlFile -Force -ErrorAction SilentlyContinue

# Resolve active non-loopback IPv4 LAN address so cloudflared never hits IPv6 [::1] 502 on Windows
$lanIp = (
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notlike "169.254.*" -and
        $_.IPAddress -notlike "172.*" -and
        $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -First 1 -ExpandProperty IPAddress
)
$upstreamHost = if ($lanIp) { $lanIp } else { "localhost" }
$upstreamUrl = "http://${upstreamHost}:533"

Start-Process -FilePath $cf `
    -ArgumentList "tunnel", "--protocol", "http2", "--url", $upstreamUrl, "--no-autoupdate" `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $log `
    -WindowStyle Hidden

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $pubUrl = Get-QuickTunnelUrl
    if (-not $pubUrl) {
        $txt = (Get-Content $log -Raw -ErrorAction SilentlyContinue) + (Get-Content $outLog -Raw -ErrorAction SilentlyContinue)
        if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
            $pubUrl = $Matches[0]
        }
    }
    if ($pubUrl) {
        Set-Content -Path $urlFile -Value $pubUrl -Encoding UTF8
        Write-Host "CLIENT DEMO IS LIVE -> $pubUrl/login" -ForegroundColor Green
        exit 0
    }
}

Write-Host "Tunnel did not report a URL yet; check $log" -ForegroundColor Red
exit 1
