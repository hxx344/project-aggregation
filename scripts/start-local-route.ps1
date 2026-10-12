param(
    [Parameter(Mandatory = $true)][string]$Server,
    [ValidateRange(1, 65535)][int]$SshPort = 22
)

$ErrorActionPreference = 'Stop'
$targetAddress = $null
if ($Server -notmatch '^[0-9a-fA-F:.]+$' -or
    ($Server -notmatch ':' -and $Server -notmatch '^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$') -or
    -not [System.Net.IPAddress]::TryParse($Server, [ref]$targetAddress)) {
    throw '-Server must be an IPv4 or IPv6 address without a zone identifier.'
}
# Normalize the literal before passing it to Node's stricter address validator.
$Server = $targetAddress.ToString()
$node = Get-Command node.exe -ErrorAction Stop
$nodeVersion = (& $node.Source --version).TrimStart('v')
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'24.15.0') {
    throw 'Node.js 24.15.0 or newer is required.'
}

$listeners = @(Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    try {
        $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:3101/route' -Method Get -TimeoutSec 15 -Headers @{ Origin = 'http://hub.localhost:3100' }
        $existingAddress = $null
        $sameAddress = [System.Net.IPAddress]::TryParse([string]$existing.server, [ref]$existingAddress) -and $targetAddress.Equals($existingAddress)
        if ($existing.service -eq 'project-aggregation-local-route' -and $existing.schema -eq 1 -and $sameAddress -and $existing.sshPort -eq $SshPort) {
            Write-Host "Local route helper is already running for ${Server}:${SshPort}."
            exit 0
        }
    } catch { }
    throw 'Port 3101 is occupied by another service or a helper with different configuration. No process was stopped.'
}

& $node.Source (Join-Path $PSScriptRoot 'local-route-helper.mjs') --server $Server --ssh-port $SshPort
exit $LASTEXITCODE
