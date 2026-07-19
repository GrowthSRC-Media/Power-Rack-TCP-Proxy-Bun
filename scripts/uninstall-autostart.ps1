# Remove TCP Proxy Manager scheduled task
# Run as Administrator

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$TaskName = "TCP-Proxy-Manager"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Scheduled task '$TaskName' removed."
} else {
    Write-Host "No scheduled task '$TaskName' found."
}
