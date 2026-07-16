# auto-firewall-events.ps1
# Reconciles Windows Firewall inbound rules against two sources of truth:
#   1. Bun TCP proxy services.json (enabled listeners)
#   2. Docker Desktop running containers (host-published ports)
#
# All rules managed by this script are tagged with the $RulePrefix so they
# can be safely enumerated, removed, and rebuilt without touching unrelated
# firewall rules.
#
# Intended use: host sits behind a DMZ where *every* inbound port is routed
# in from the router. Any new Dokploy / compose service with a published
# port should become reachable without manual firewall surgery.
#
# Run elevated (Administrator). Idempotent — safe to loop forever.
#
# Security note: this opens the firewall for EVERY published port automatically.
# Do not deploy internal services (databases, admin panels) with host port
# publishing unless you intend them to be internet-facing. Prefer container-only
# ports (no `ports:` block in compose) for anything not meant for the public.

param(
    [int]$IntervalSeconds = 30,
    [string]$ServicesJson = "C:\Docker-service-compose\TCP-Proxy\services.json",
    [string]$RulePrefix = "AutoProxy-",
    [string]$LogFile = "C:\Docker-service-compose\TCP-Proxy\logs\auto-firewall.log"
)

$ErrorActionPreference = "Continue"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    $line = "$ts [$Level] $Message"
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -ErrorAction Stop } catch { }
}

function Get-DesiredPorts {
    $desired = @{}

    # Source 1 — Bun TCP proxy manifest
    if (Test-Path $ServicesJson) {
        try {
            $svcs = Get-Content $ServicesJson -Raw | ConvertFrom-Json
            foreach ($s in $svcs) {
                if ($s.enabled -and $s.protocol -eq "tcp") {
                    $desired[[int]$s.listenPort] = "bun:$($s.name)"
                }
            }
        } catch {
            Write-Log "Failed to parse services.json: $_" "WARN"
        }
    }

    # Source 2 — Docker Desktop published host ports
    try {
        $dockerOut = docker ps --format '{{.Names}}|{{.Ports}}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $dockerOut) {
            foreach ($line in $dockerOut) {
                $parts = $line -split '\|', 2
                if ($parts.Count -lt 2) { continue }
                $name = $parts[0]
                $portsField = $parts[1]
                # Match "0.0.0.0:<hostPort>->" patterns (IPv4 published only)
                foreach ($m in [regex]::Matches($portsField, '0\.0\.0\.0:(\d+)->')) {
                    $hp = [int]$m.Groups[1].Value
                    if (-not $desired.ContainsKey($hp)) {
                        $desired[$hp] = "docker:$name"
                    }
                }
            }
        }
    } catch {
        Write-Log "Docker enumeration failed: $_" "WARN"
    }

    return $desired
}

function Sync-FirewallRules {
    $desired = Get-DesiredPorts
    $desiredPorts = @($desired.Keys)

    # Enumerate existing auto-managed rules
    $existing = Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue
    $existingPorts = @{}
    foreach ($r in $existing) {
        $suffix = $r.DisplayName.Substring($RulePrefix.Length)
        $port = 0
        if ([int]::TryParse($suffix, [ref]$port)) {
            $existingPorts[$port] = $r
        }
    }

    # Remove stale: rules whose port is no longer desired
    foreach ($p in $existingPorts.Keys) {
        if ($desiredPorts -notcontains $p) {
            try {
                Remove-NetFirewallRule -DisplayName "$RulePrefix$p" -ErrorAction Stop
                Write-Log "Removed rule for port $p (no longer published)"
            } catch {
                Write-Log "Failed to remove rule for port ${p}: $_" "WARN"
            }
        }
    }

    # Add missing: desired ports that don't yet have a rule
    foreach ($p in $desiredPorts) {
        if (-not $existingPorts.ContainsKey($p)) {
            $source = $desired[$p]
            try {
                New-NetFirewallRule `
                    -DisplayName "$RulePrefix$p" `
                    -Description "Auto-managed by auto-firewall-events.ps1 — source: $source" `
                    -Direction Inbound `
                    -Protocol TCP `
                    -LocalPort $p `
                    -Action Allow `
                    -Profile Any `
                    -ErrorAction Stop | Out-Null
                Write-Log "Added rule for port $p ($source)"
            } catch {
                Write-Log "Failed to add rule for port ${p}: $_" "WARN"
            }
        }
    }
}

function Test-IsAdministrator {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    Write-Log "Script must be run as Administrator. Relaunching elevated..." "WARN"
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$PSCommandPath
    exit
}

# Ensure log directory exists
$logDir = Split-Path $LogFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

Write-Log "auto-firewall-events starting — interval=${IntervalSeconds}s prefix='$RulePrefix'"

while ($true) {
    try {
        Sync-FirewallRules
    } catch {
        Write-Log "Sync failed: $_" "ERROR"
    }
    Start-Sleep -Seconds $IntervalSeconds
}
