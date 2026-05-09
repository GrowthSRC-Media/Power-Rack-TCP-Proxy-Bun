# Install ProxyManager as a Windows service via NSSM.
# Requires nssm.exe on PATH (https://nssm.cc/). Run as Administrator.

$ErrorActionPreference = "Stop"

$ServiceName = "ProxyManager"
$BunPath     = (Get-Command bun.exe).Source
$AppDir      = "C:\Docker-service-compose\Reddis"
$Entry       = "$AppDir\src\manager.ts"
$LogDir      = "C:\Docker-service-compose\docker-service\logs"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

nssm install $ServiceName $BunPath "run `"$Entry`""
nssm set $ServiceName AppDirectory $AppDir
nssm set $ServiceName AppStdout "$LogDir\nssm.out.log"
nssm set $ServiceName AppStderr "$LogDir\nssm.err.log"
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 2000
nssm set $ServiceName Start SERVICE_AUTO_START

Write-Host "Installed. Start with: nssm start $ServiceName"
