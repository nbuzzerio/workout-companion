#Requires -Version 5.1
<# .SYNOPSIS
Configure Workout Companion with independently verified identity and host pin.
SSH host and port must be explicitly confirmed; neither is inferred from the URL.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DeployHost,
    [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$DeployPort,
    [switch]$EnableDeployment
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Initialize-GitHubDeployment.ps1') `
    -Repository 'nbuzzerio/workout-companion' `
    -AppSlug 'workout' `
    -DeployHost $DeployHost `
    -DeployPort $DeployPort `
    -ProductionBranch 'main' `
    -DeployUser 'personal-deploy' `
    -PublicOrigin 'https://www.nickbuzzerio.com' `
    -HostFingerprint 'SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0' `
    -AppDirectory (Split-Path $PSScriptRoot -Parent) `
    -EnableDeployment:$EnableDeployment
exit $LASTEXITCODE
