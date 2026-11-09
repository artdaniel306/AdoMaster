# deploy-crmappui.ps1
# Usage:
#   C:\Users\DanielLi\Documents\crmapp_AI\.manage\scripts\deploy-crmappui.ps1
#   .\scripts\deploy-crmappui.ps1                 # deploy default version
#   .\scripts\deploy-crmappui.ps1 -Version 0.1.2  # deploy a specific version

param(
    [string]$Version = "0.1.1"
)

# ---- Settings: internal test ----
# $ProjectDir   = "C:\Users\DanielLi\Documents\crmapp_deploy\crmappui_local"
# $PushRegistry = "192.168.1.139:5000"
# $PullRegistry = "localhost:5000"
# $RemoteHost   = "art-admin@192.168.1.139"   # <-- confirm this is the target host
# $AppName      = "crmappui"
# $Network      = "onprem-net"
# $HostPort     = 8098
# $AppPort      = 80
# $EnvR1        = "env-art-test"
# $EnvR2        = "env-art-test"

# ---- Settings: internal prod ----
$ProjectDir   = "C:\Users\DanielLi\Documents\crmapp_deploy\crmappui_local"
$PushRegistry = "192.168.1.232:5000"
$PullRegistry = "localhost:5000"
$RemoteHost   = "admin@192.168.1.232"   # <-- confirm this is the target host
$AppName      = "crmappui"
$Network      = "onprem-net"
$HostPort     = 8098
$AppPort      = 80
$EnvR1        = "env-art-prod"
$EnvR2        = "env-art-prod"

$PushImage = "$PushRegistry/${AppName}:$Version"
$PullImage = "$PullRegistry/${AppName}:$Version"

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "`n==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $Name (exit code $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

function Ensure-DockerRunning {
    # Return immediately if the Docker engine already responds
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }

    $exe = "C:\Users\DanielLi\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe"
    if (-not (Test-Path $exe)) {
        Write-Host "Docker Desktop not found at: $exe" -ForegroundColor Red
        exit 1
    }

    Write-Host "`n==> Starting Docker Desktop..." -ForegroundColor Cyan
    Start-Process $exe

    $timeout = 180
    $elapsed = 0
    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds 5
        $elapsed += 5
        docker info *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Docker is ready ($elapsed s)." -ForegroundColor Green
            return
        }
        Write-Host "  waiting for Docker engine... ($elapsed s)"
    }
    Write-Host "Docker did not start within $timeout seconds." -ForegroundColor Red
    exit 1
}

Write-Host "Deploying $AppName version $Version" -ForegroundColor Green
Ensure-DockerRunning
Set-Location $ProjectDir

Invoke-Step "Build and push $PushImage" {
    docker buildx build --platform linux/arm64 `
        --build-arg ENV_R1=$EnvR1 `
        --build-arg ENV_R2=$EnvR2 `
        -t $PushImage --push .
}

# Pull first, then replace the container, to keep downtime short.
# 'docker rm -f' does not fail if the container doesn't exist yet.
$remoteCmd = @(
    "docker pull $PullImage",
    "(docker rm -f $AppName >/dev/null 2>&1 || true)",
    "docker run -d --name $AppName --network $Network -p ${HostPort}:$AppPort --restart unless-stopped $PullImage",
    "docker ps --filter name=$AppName"
) -join " && "

Invoke-Step "Deploy on $RemoteHost" {
    ssh $RemoteHost $remoteCmd
}

Write-Host "`nDone. $AppName $Version is running on $RemoteHost (port $HostPort)." -ForegroundColor Green
