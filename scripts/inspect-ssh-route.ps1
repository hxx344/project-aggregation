param(
    [Parameter(Mandatory = $true)][string]$Server,
    [ValidateRange(1, 65535)][int]$SshPort = 22
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Unknown([string]$Reason) {
    @{ reason = $Reason } | ConvertTo-Json -Compress
    exit 0
}

try {
    $targetAddress = $null
    if ($Server -notmatch '^[0-9a-fA-F:.]+$' -or
        ($Server -notmatch ':' -and $Server -notmatch '^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$') -or
        -not [System.Net.IPAddress]::TryParse($Server, [ref]$targetAddress)) {
        Write-Unknown 'target-mismatch'
    }
    # A single TCP snapshot avoids two expensive CIM scans and keeps listener and
    # peer selection tied to the same observation.
    $allConnections = @(Get-NetTCPConnection -ErrorAction Stop)
    $listeners = @($allConnections | Where-Object { $_.LocalPort -eq 3100 -and $_.State.ToString() -eq 'Listen' })
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { Write-Unknown 'ssh-not-found' }
    $sshProcess = Get-Process -Id $owners[0] -ErrorAction Stop
    if ($sshProcess.ProcessName -ne 'ssh' -or [System.IO.Path]::GetFileName($sshProcess.Path) -ne 'ssh.exe') {
        Write-Unknown 'ssh-not-found'
    }
    # The forwarding socket accepts browser connections on 3100. Every other live
    # socket owned by this SSH process must resolve to the single configured peer.
    $connections = @($allConnections | Where-Object {
        $_.OwningProcess -eq $owners[0] -and $_.LocalPort -ne 3100 -and $_.RemotePort -gt 0 -and
        $_.State.ToString() -notin @('Listen', 'Bound', 'Closed', 'DeleteTCB', 'TimeWait')
    })
    if ($connections.Count -eq 0) { Write-Unknown 'ssh-not-found' }
    if ($connections.Count -ne 1) { Write-Unknown 'multiple-connections' }
    $connection = $connections[0]
    if ($connection.State.ToString() -ne 'Established' -or
        -not ([System.Net.IPAddress]::Parse($connection.RemoteAddress)).Equals($targetAddress) -or
        $connection.RemotePort -ne $SshPort) { Write-Unknown 'target-mismatch' }
    $routeResults = @(Find-NetRoute -RemoteIPAddress $Server -ErrorAction Stop)
    $sourceRoutes = @($routeResults | Where-Object { $null -ne $_.IPAddress })
    if ($sourceRoutes.Count -ne 1) { Write-Unknown 'source-mismatch' }
    $sourceRoute = $sourceRoutes[0]
    if (-not ([System.Net.IPAddress]::Parse($sourceRoute.IPAddress)).Equals([System.Net.IPAddress]::Parse($connection.LocalAddress))) {
        Write-Unknown 'source-mismatch'
    }
    $adapters = @(Get-NetAdapter -InterfaceIndex $sourceRoute.InterfaceIndex -IncludeHidden -ErrorAction Stop)
    if ($adapters.Count -ne 1) { Write-Unknown 'non-physical-interface' }
    $adapter = $adapters[0]
    if ($adapter.HardwareInterface -ne $true -or $adapter.Virtual -ne $false -or $adapter.Status.ToString() -ne 'Up') {
        Write-Unknown 'non-physical-interface'
    }
    $pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object {
        [System.IO.Path]::GetFileName($_)
    } | Where-Object { $_ -cmatch '^(verge-mihomo-sidecar-[\w.-]+|mihomo)$' } | Sort-Object -Unique)
    @{
        tunnel = @{
            processName = 'ssh.exe'; listenerOwners = $owners.Count; connectionCount = $connections.Count
            server = $connection.RemoteAddress; sshPort = [int]$connection.RemotePort
            sourceAddress = $connection.LocalAddress; state = $connection.State.ToString()
        }
        route = @{
            sourceAddress = $sourceRoute.IPAddress; interfaceAlias = $adapter.Name
            hardwareInterface = [bool]$adapter.HardwareInterface; virtual = [bool]$adapter.Virtual
            status = $adapter.Status.ToString()
        }
        pipes = @($pipes)
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    Write-Unknown 'probe-failed'
}
