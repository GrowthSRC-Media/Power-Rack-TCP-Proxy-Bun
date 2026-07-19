# Install TCP Proxy Manager as a Windows Scheduled Task (auto-start at logon)
# Run as Administrator

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$TaskName   = "TCP-Proxy-Manager"
$RepoRoot   = Split-Path (Split-Path $PSScriptRoot)
$ScriptPath = Join-Path $RepoRoot "start-manager.ps1"

if (-not (Test-Path $ScriptPath)) {
    Write-Error "start-manager.ps1 not found at: $ScriptPath"
    exit 1
}

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task '$TaskName'"
}

$Action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Auto-start TCP Proxy Manager at user logon" | Out-Null

Write-Host "Scheduled task '$TaskName' installed successfully."
Write-Host "  - Triggers at logon for user: $env:USERNAME"
Write-Host "  - To test now:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  - To remove:     .\uninstall-autostart.ps1"
