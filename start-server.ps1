$ErrorActionPreference = "SilentlyContinue"
$ProjectDir = "C:\Projects\LocalCouncil"
$LogDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Set-Location $ProjectDir

while ($true) {
  $today = Get-Date -Format "yyyy-MM-dd"
  $LogFile = Join-Path $LogDir "server-$today.log"
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Value "$stamp [launcher] starting node server.js" -Encoding utf8

  & cmd /c "node server.js >> `"$LogFile`" 2>&1"
  $exitCode = $LASTEXITCODE

  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Value "$stamp [launcher] node exited with code $exitCode, restarting in 3s" -Encoding utf8
  Start-Sleep -Seconds 3
}
