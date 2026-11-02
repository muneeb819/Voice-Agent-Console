# Starts the Cloudflare HTTPS client demo tunnel in the background.
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

$existing = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue
if ($existing) {
    "tunnel already running (pid $($existing.ProcessId))"
    if (Test-Path $urlFile) { "public url: $(Get-Content $urlFile -Raw)" }
    exit 0
}

Remove-Item $log, $outLog, $urlFile -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $cf `
    -ArgumentList "tunnel", "--protocol", "http2", "--url", "http://localhost:533", "--no-autoupdate" `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $log `
    -WindowStyle Hidden

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $txt = (Get-Content $log -Raw -ErrorAction SilentlyContinue) + (Get-Content $outLog -Raw -ErrorAction SilentlyContinue)
    if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $pubUrl = $Matches[0]
        Set-Content -Path $urlFile -Value $pubUrl -Encoding UTF8
        "public client demo url: $pubUrl"
        exit 0
    }
}

"tunnel did not report a URL; see $log"
exit 1
