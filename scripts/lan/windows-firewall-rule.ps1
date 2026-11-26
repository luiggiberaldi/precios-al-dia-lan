<#
.SYNOPSIS
Abre los puertos de Windows Firewall necesarios para Precios al Día LAN en redes privadas.
.DESCRIPTION
Permite tráfico entrante TCP 47800 (servidor HTTP + SSE) y UDP 47801 (descubrimiento automático)
únicamente en el perfil de red Privada para que otras PCs y teléfonos en el Wi-Fi/cable del local
puedan conectarse a la Caja Principal.
#>
param(
    [int]$HttpPort = 47800,
    [int]$DiscoveryPort = 47801
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Error "Ejecuta PowerShell como Administrador para crear las reglas de firewall."
    exit 1
}

$rules = @(
    @{ Name = "PreciosAlDiaLAN-HTTP-TCP"; Protocol = "TCP"; Port = $HttpPort; Desc = "Precios al Dia LAN HTTP y SSE" },
    @{ Name = "PreciosAlDiaLAN-Discovery-UDP"; Protocol = "UDP"; Port = $DiscoveryPort; Desc = "Precios al Dia LAN descubrimiento UDP" }
)

foreach ($r in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-NetFirewallRule -DisplayName $r.Name
    }
    New-NetFirewallRule `
        -DisplayName $r.Name `
        -Description $r.Desc `
        -Direction Inbound `
        -Action Allow `
        -Protocol $r.Protocol `
        -LocalPort $r.Port `
        -RemoteAddress LocalSubnet `
        -Profile Any | Out-Null
    Write-Host "[OK] Regla creada: $($r.Name) ($($r.Protocol) $($r.Port) · Solo red local)"
}

Write-Host ""
Write-Host "Listo. Las cajas adicionales y el Modo Supervisor móvil ya pueden conectarse por red local."
