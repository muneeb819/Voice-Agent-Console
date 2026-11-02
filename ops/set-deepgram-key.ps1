# Securely set the Deepgram API key in .env.
#
#   powershell -ExecutionPolicy Bypass -File F:\Voice-Agent-Console\ops\set-deepgram-key.ps1
#
# Prompts for the key without echoing it to the screen or the transcript,
# writes it to .env, locks the file down, and restarts the console.
#
# Do not pass the key as an argument. Do not paste it into a chat.

$ErrorActionPreference = "Stop"
$root = "F:\Voice-Agent-Console"
$envPath = Join-Path $root ".env"

if (-not (Test-Path -LiteralPath $envPath)) {
    throw "Missing $envPath"
}

Write-Host "Paste the NEW Deepgram API key at the prompt (input is hidden)."
Write-Host "Rotate the old key first at https://console.deepgram.com/"
Write-Host ""

$secure = Read-Host -AsSecureString "Deepgram API key"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$key = $key.Trim()
if ($key.Length -lt 20) {
    throw "Key looks too short ($($key.Length) chars). Nothing written."
}
if ($key -match '\s') {
    throw "Key contains whitespace. Nothing written."
}

$lines = Get-Content -LiteralPath $envPath
if ($lines -match '^DEEPGRAM_API_KEY=') {
    $lines = $lines -replace '^DEEPGRAM_API_KEY=.*', "DEEPGRAM_API_KEY=$key"
}
else {
    $lines += "DEEPGRAM_API_KEY=$key"
}
Set-Content -LiteralPath $envPath -Value $lines -Encoding ASCII

& icacls $envPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" "Administrators:(F)" | Out-Null

# Clear the in-memory copy.
$key = $null
[GC]::Collect()

Write-Host "Key stored in $envPath (not displayed)."

Write-Host "==> Restarting console"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist\server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2
& powershell -NoProfile -ExecutionPolicy Bypass -File "$root\ops\start-console.ps1"
