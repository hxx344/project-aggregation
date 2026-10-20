# 优化版 SSH 隧道 - 适配高延迟网络
# 改进点：
# - 更频繁的心跳检测（15秒）
# - 更高的容忍度（5次失败 = 75秒）
# - 启用压缩减少带宽
# - 启用 TCP KeepAlive
#
# 用法：.\ssh-tunnel-optimized.ps1 -Target user@host [-SshPort 22] [-LocalPort 3100]
# 也可通过环境变量 PROJECT_AGGREGATION_SSH_TARGET 提供 -Target。

param(
    [string]$Target = $env:PROJECT_AGGREGATION_SSH_TARGET,
    [int]$SshPort = 22,
    [int]$LocalPort = 3100
)

if (-not $Target) {
    Write-Host "请通过 -Target user@host 或环境变量 PROJECT_AGGREGATION_SSH_TARGET 指定服务器。" -ForegroundColor Red
    exit 1
}

$Host.UI.RawUI.WindowTitle = "SSH 隧道 - 工作台"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  SSH 隧道启动脚本（优化版）" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "目标服务器: $Target" -ForegroundColor Yellow
Write-Host "本地端口:   127.0.0.1:$LocalPort" -ForegroundColor Yellow
Write-Host "心跳间隔:   15 秒" -ForegroundColor Yellow
Write-Host "容忍时间:   75 秒（15秒 × 5次）" -ForegroundColor Yellow
Write-Host ""

$reconnectCount = 0

while ($true) {
    if ($reconnectCount -gt 0) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 第 $reconnectCount 次重连..." -ForegroundColor Magenta
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 正在建立 SSH 隧道..." -ForegroundColor Green
    }

    ssh -N -T -p $SshPort `
        -o ServerAliveInterval=15 `
        -o ServerAliveCountMax=5 `
        -o TCPKeepAlive=yes `
        -o Compression=yes `
        -o ExitOnForwardFailure=yes `
        -o ConnectTimeout=10 `
        -L "127.0.0.1:${LocalPort}:127.0.0.1:3100" `
        $Target

    $exitCode = $LASTEXITCODE
    $reconnectCount++

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 连接已断开（退出码: $exitCode），3 秒后重试..." -ForegroundColor Red
    Start-Sleep -Seconds 3
}
