#Requires -Version 5.1
<#
.SYNOPSIS
Configure GitHub deployment with deployment disabled; enabling is a separate run.
.DESCRIPTION
Prompts for a short-lived GitHub token using a masked SecureString. Never accepts
an SSH private key. Uses only built-in Windows PowerShell and GitHub REST APIs.
See docs/github-onboarding.md for token permissions and exact commands.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$AppSlug,
    [Parameter(Mandatory)][string]$DeployHost,
    [Parameter(Mandatory)][int]$DeployPort,
    [Parameter(Mandatory)][string]$HostFingerprint,
    [Parameter(Mandatory)][string]$PublicOrigin,
    [string]$ProductionBranch = 'main',
    [string]$DeployUser = 'personal-deploy',
    [switch]$CreateRepository,
    [ValidateSet('private', 'public')][string]$Visibility = 'private',
    [switch]$EnableDeployment,
    [string]$AppDirectory = (Split-Path $PSScriptRoot -Parent)
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'GitHubDeployment.psm1') -Force
$token = $null
$oldTls = [Net.ServicePointManager]::SecurityProtocol
try {
    $configuration = New-DeploymentConfiguration -Repository $Repository -AppSlug $AppSlug -DeployHost $DeployHost -DeployPort $DeployPort -HostFingerprint $HostFingerprint -PublicOrigin $PublicOrigin -ProductionBranch $ProductionBranch -DeployUser $DeployUser
    $source = [IO.File]::ReadAllText((Join-Path $AppDirectory 'config/app.ts'))
    Assert-AppIdentity $source $AppSlug
    if ($EnableDeployment -and $CreateRepository) { throw 'Enabling requires a separate invocation after setup; omit CreateRepository.' }
    Write-Host "Target: https://github.com/$Repository; app: $AppSlug; production branch: $ProductionBranch."
    Write-Host 'Use a short-lived GitHub API token. Do not enter an SSH private key.'
    $token = Read-Host 'GitHub API token (masked, this process only)' -AsSecureString
    if ($token.Length -eq 0) { throw 'A temporary GitHub API token is required.' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $api = { param($method, $path, $body, $allow404) Invoke-GitHubRequest -Token $token -Method $method -Path $path -Body $body -Allow404 $allow404 }.GetNewClosure()
    Invoke-DeploymentOnboarding -Configuration $configuration -Api $api -AppConfigSource $source -CreateRepository:$CreateRepository -Visibility $Visibility -EnableDeployment:$EnableDeployment
}
catch { Write-Error -Message $_.Exception.Message -ErrorAction Continue; exit 1 }
finally {
    if ($null -ne $token) { $token.Dispose(); $token = $null }
    $api = $null
    [Net.ServicePointManager]::SecurityProtocol = $oldTls
}
exit 0
