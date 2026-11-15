# Windows PowerShell 5.1+. No Git, gh, OpenSSH, or external modules required.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-DeploymentConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][string]$AppSlug,
        [Parameter(Mandatory)][string]$DeployHost,
        [Parameter(Mandatory)][int]$DeployPort,
        [Parameter(Mandatory)][string]$HostFingerprint,
        [Parameter(Mandatory)][string]$PublicOrigin,
        [string]$ProductionBranch = 'main',
        [string]$DeployUser = 'personal-deploy'
    )
    if ($Repository -cnotmatch '\A[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9_.-]{1,100}\z' -or
        ($Repository.Split('/')[1] -in @('.', '..'))) { throw 'Repository must be OWNER/NAME.' }
    if ($AppSlug.Length -gt 48 -or $AppSlug -cnotmatch '\A[a-z][a-z0-9]*(?:-[a-z0-9]+)*\z') { throw 'Invalid app slug.' }
    if ($DeployHost.Length -gt 253) { throw 'Invalid deployment host.' }
    foreach ($label in $DeployHost.Split('.')) {
        if ($label -cnotmatch '\A[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\z') { throw 'Host must be a DNS name or IPv4 address, without protocol, user or path.' }
    }
    if ($DeployPort -lt 1 -or $DeployPort -gt 65535) { throw 'Explicit SSH port must be 1..65535.' }
    if ($DeployUser -cne 'personal-deploy') { throw 'The restricted deployment user must be personal-deploy.' }
    if ($HostFingerprint -cnotmatch '\ASHA256:[A-Za-z0-9+/]{43}\z') { throw 'Expected an independently verified, unpadded SHA256 ED25519 fingerprint.' }
    $digest = [Convert]::FromBase64String($HostFingerprint.Substring(7) + '=')
    if ([Convert]::ToBase64String($digest).TrimEnd('=') -cne $HostFingerprint.Substring(7)) { throw 'Noncanonical SHA256 fingerprint.' }
    $origin = $null
    if (-not [Uri]::TryCreate($PublicOrigin, [UriKind]::Absolute, [ref]$origin) -or
        $PublicOrigin -cnotmatch '\Ahttps://[A-Za-z0-9][A-Za-z0-9.:-]*\z' -or
        $origin.Scheme -cne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or
        $origin.AbsolutePath -ne '/') { throw 'PublicOrigin must be an HTTPS origin without trailing slash or path.' }
    # A literal Git ref and literal environment pattern; no glob metacharacters.
    if ($ProductionBranch -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._/-]*\z' -or
        $ProductionBranch -match '\.\.|//|(?:\A|/)\.|\.(?:lock)(?:/|\z)|[./]\z') { throw 'ProductionBranch must be an exact branch name without patterns or invalid Git ref components.' }
    return [ordered]@{
        Repository = $Repository; AppSlug = $AppSlug
        Variables = [ordered]@{
            DEPLOY_HOST = $DeployHost; DEPLOY_PORT = [string]$DeployPort
            DEPLOY_USER = $DeployUser; DEPLOY_HOST_FINGERPRINT = $HostFingerprint
            PUBLIC_ORIGIN = $PublicOrigin; PRODUCTION_BRANCH = $ProductionBranch
        }
    }
}

function Assert-AppIdentity {
    param([string]$Source, [string]$AppSlug)
    $ids = [regex]::Matches($Source, '(?m)^\s*id:\s*[''"]([^''"]+)[''"]\s*,?\s*$')
    $bases = [regex]::Matches($Source, '(?m)^\s*basePath:\s*[''"]([^''"]+)[''"]\s*,?\s*$')
    if ($ids.Count -ne 1 -or $bases.Count -ne 1 -or
        $ids[0].Groups[1].Value -cne $AppSlug -or $bases[0].Groups[1].Value -cne "/apps/$AppSlug/") {
        throw 'config/app.ts must declare exactly the requested literal id and /apps/SLUG/ basePath. No source or database identity is changed by onboarding.'
    }
}

function Invoke-GitHubRequest {
    param([Security.SecureString]$Token, [string]$Method, [string]$Path, $Body, [bool]$Allow404 = $false)
    if ($Path -notmatch '\A/(?:repos|user|users|orgs)(?:/|\?|\z)' -or $Path.Contains('://')) { throw 'Invalid GitHub API path.' }
    $pointer = [IntPtr]::Zero
    $headers = @{}
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
        $headers = @{
            Authorization = 'Bearer ' + [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            Accept = 'application/vnd.github+json'
            'X-GitHub-Api-Version' = '2022-11-28'
        }
        $request = @{
            Uri = 'https://api.github.com' + $Path; Method = $Method; Headers = $headers
            UseBasicParsing = $true; MaximumRedirection = 0; TimeoutSec = 30; ErrorAction = 'Stop'
        }
        if ($null -ne $Body) { $request.Body = $Body | ConvertTo-Json -Depth 20 -Compress; $request.ContentType = 'application/json; charset=utf-8' }
        try { $response = Invoke-WebRequest @request }
        catch {
            $status = 0
            $errorResponse = $_.Exception.PSObject.Properties['Response']
            if ($errorResponse -and $errorResponse.Value) { $status = [int]$errorResponse.Value.StatusCode }
            if ($status -eq 404 -and $Allow404) { return @{ Status = 404; Data = $null } }
            # Never echo request headers, response bodies or raw network exceptions.
            throw "GitHub API $Method $Path failed (HTTP $status). Check token permissions, repository access, plan support, rate limits and network. No redirect or fallback authentication is allowed."
        }
        $data = $null
        if ($response.Content) {
            try { $data = $response.Content | ConvertFrom-Json }
            catch { throw "GitHub API $Method $Path returned malformed JSON." }
        }
        return @{ Status = [int]$response.StatusCode; Data = $data }
    }
    finally {
        $headers.Clear()
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
}

function Get-ApiList {
    param([scriptblock]$Api, [string]$Path, [string]$Property)
    $items = @()
    for ($page = 1; $page -le 1000; $page++) {
        # Environment-variable endpoints allow at most 30 items per page.
        $result = & $Api 'GET' "${Path}?per_page=30&page=$page" $null $false
        $batch = @($result.Data.$Property)
        $items += $batch
        if ($batch.Count -lt 30) { return ,$items }
    }
    throw "Pagination limit reached for $Path."
}

function Set-RepositoryVariable {
    param([scriptblock]$Api, [string]$Root, [string]$Name, [string]$Value)
    $current = & $Api 'GET' "$Root/actions/variables/$Name" $null $true
    if ($current.Status -eq 404) {
        $null = & $Api 'POST' "$Root/actions/variables" @{ name = $Name; value = $Value } $false
    }
    elseif ($current.Data.value -cne $Value) {
        $null = & $Api 'PATCH' "$Root/actions/variables/$Name" @{ name = $Name; value = $Value } $false
    }
    $verified = & $Api 'GET' "$Root/actions/variables/$Name" $null $false
    if ($verified.Data.name -cne $Name -or $verified.Data.value -cne $Value) { throw "Variable readback failed: $Name." }
}

function Assert-ExactBranchPolicy {
    param($Environment, [object[]]$Policies, [string]$Branch)
    if (-not $Environment.deployment_branch_policy -or
        $Environment.deployment_branch_policy.protected_branches -ne $false -or
        $Environment.deployment_branch_policy.custom_branch_policies -ne $true -or
        $Policies.Count -ne 1 -or $Policies[0].name -cne $Branch -or $Policies[0].type -cne 'branch') {
        throw 'Production environment must allow exactly the production branch and no tags or wildcard policies.'
    }
}

function Invoke-DeploymentOnboarding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Configuration,
        [Parameter(Mandatory)][scriptblock]$Api,
        [Parameter(Mandatory)][string]$AppConfigSource,
        [switch]$CreateRepository,
        [ValidateSet('private', 'public')][string]$Visibility = 'private',
        [switch]$EnableDeployment
    )
    if ($EnableDeployment -and $CreateRepository) { throw 'Enabling is a separate invocation after setup and owner review; omit CreateRepository.' }
    Assert-AppIdentity $AppConfigSource $Configuration.AppSlug
    $root = '/repos/' + $Configuration.Repository
    $envPath = "$root/environments/production"
    $policyPath = "$envPath/deployment-branch-policies"
    $branch = $Configuration.Variables.PRODUCTION_BRANCH
    $repo = & $Api 'GET' $root $null $true
    if ($repo.Status -eq 404) {
        if (-not $CreateRepository) { throw 'Repository is inaccessible or missing. Check access, or explicitly use CreateRepository for a new repository.' }
        $owner, $name = $Configuration.Repository.Split('/')
        $user = & $Api 'GET' '/user' $null $false
        if ($user.Data.login -ieq $owner) { $createPath = '/user/repos' }
        else {
            $account = & $Api 'GET' "/users/$owner" $null $false
            if ($account.Data.type -cne 'Organization') { throw 'Cannot create a repository for another user.' }
            $createPath = "/orgs/$owner/repos"
        }
        $null = & $Api 'POST' $createPath @{ name = $name; private = ($Visibility -eq 'private'); auto_init = $false } $false
        $repo = & $Api 'GET' $root $null $false
        if ($repo.Data.private -ne ($Visibility -eq 'private')) { throw 'Created repository visibility mismatch.' }
    }
    if ($repo.Data.full_name -ine $Configuration.Repository -or $repo.Data.permissions.admin -ne $true -or
        $repo.Data.archived -ne $false -or $repo.Data.disabled -ne $false) { throw 'Repository identity/admin access verification failed, or repository is archived/disabled.' }
    $repositoryId = $repo.Data.id
    Write-Host "Verified repository: $($repo.Data.full_name) (id $repositoryId)."

    # Reconfiguration always disables first, including reruns of an enabled setup.
    # This is not a cancellation mechanism for jobs that have already started.
    if (-not $EnableDeployment) { Set-RepositoryVariable $Api $root 'ENABLE_DEPLOYMENT' 'false' }
    $environment = & $Api 'GET' $envPath $null $true
    if ($environment.Status -eq 404) {
        if ($EnableDeployment) { throw 'Run disabled setup before enabling: production environment is missing.' }
        $null = & $Api 'PUT' $envPath @{ deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true } } $false
        $environment = & $Api 'GET' $envPath $null $false
    }
    if ($environment.Data.name -cne 'production') { throw 'Production environment identity mismatch.' }
    $originalProtections = @($environment.Data.protection_rules | Where-Object { $_.type -cne 'branch_policy' }) | ConvertTo-Json -Depth 30 -Compress
    if (-not $environment.Data.deployment_branch_policy -or -not $environment.Data.deployment_branch_policy.custom_branch_policies) {
        if ($EnableDeployment) { throw 'Run disabled setup before enabling: exact branch policy is missing.' }
        # GitHub's environment PUT can reset other protection fields. Avoid PUT on
        # existing environments with protections, including protected-branch mode.
        if ($environment.Data.deployment_branch_policy -or
            @($environment.Data.protection_rules | Where-Object { $_.type -cne 'branch_policy' }).Count -gt 0 -or
            $environment.Data.PSObject.Properties['can_admins_bypass']) {
            throw 'Existing environment protections require owner review: select Selected branches and tags in GitHub, retaining all reviewers, timers, bypass and custom rules, then rerun. Protected-branch mode is never weakened automatically.'
        }
        $null = & $Api 'PUT' $envPath @{ deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true } } $false
        $environment = & $Api 'GET' $envPath $null $false
    }
    # Environment variables can override repository values at runtime.
    $environmentVariables = Get-ApiList $Api "$envPath/variables" 'variables'
    $managedNames = @($Configuration.Variables.Keys) + 'ENABLE_DEPLOYMENT'
    foreach ($variable in $environmentVariables) {
        if ($variable.name -in $managedNames) { throw "Remove the conflicting production environment variable $($variable.name) manually; onboarding only manages repository variables." }
    }
    $policies = Get-ApiList $Api $policyPath 'branch_policies'
    if (-not $EnableDeployment) {
        # Delete excess branch/tag rules before adding the exact branch, so a
        # partial failure leaves the environment at least as restrictive.
        $kept = $false
        foreach ($policy in $policies) {
            if ($policy.name -ceq $branch -and $policy.type -ceq 'branch' -and -not $kept) { $kept = $true }
            else { $null = & $Api 'DELETE' "$policyPath/$($policy.id)" $null $false }
        }
        if (-not $kept) { $null = & $Api 'POST' $policyPath @{ name = $branch; type = 'branch' } $false }
        foreach ($name in $Configuration.Variables.Keys) { Set-RepositoryVariable $Api $root $name $Configuration.Variables[$name] }
    }
    # Verify all settings in both modes; enable mode never repairs configuration.
    foreach ($name in $Configuration.Variables.Keys) {
        $result = & $Api 'GET' "$root/actions/variables/$name" $null $false
        if ($result.Data.name -cne $name -or $result.Data.value -cne $Configuration.Variables[$name]) { throw "Repository variable mismatch: $name. Run disabled setup first." }
    }
    $environment = & $Api 'GET' $envPath $null $false
    $policies = Get-ApiList $Api $policyPath 'branch_policies'
    Assert-ExactBranchPolicy $environment.Data $policies $branch
    $protections = @($environment.Data.protection_rules | Where-Object { $_.type -cne 'branch_policy' }) | ConvertTo-Json -Depth 30 -Compress
    if ($protections -cne $originalProtections) { throw 'Unrelated environment protections changed during onboarding. Inspect GitHub settings and verify ENABLE_DEPLOYMENT=false.' }
    $repo = & $Api 'GET' $root $null $false
    if ($repo.Data.id -ne $repositoryId -or $repo.Data.full_name -ine $Configuration.Repository) { throw 'Repository identity changed during onboarding.' }
    if ($EnableDeployment) {
        # Require the source already present on the exact remote branch. An empty
        # newly-created repository may be configured disabled, but never enabled.
        $encodedBranch = [Uri]::EscapeDataString($branch)
        $null = & $Api 'GET' "$root/branches/$encodedBranch" $null $false
        $remoteConfig = & $Api 'GET' "$root/contents/config/app.ts?ref=$encodedBranch" $null $false
        if ($remoteConfig.Data.encoding -cne 'base64') { throw 'Unexpected remote app configuration encoding.' }
        Assert-AppIdentity ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($remoteConfig.Data.content))) $Configuration.AppSlug
        # Compare security-critical remote source to the locally reviewed copy.
        # Merely finding a marker string in an old workflow is insufficient.
        $reviewedRoot = Split-Path $PSScriptRoot -Parent
        foreach ($file in @('.github/workflows/ci-deploy.yml', 'scripts/verify_host_key.py', 'scripts/deployment_policy.py', 'scripts/activate_checked.py')) {
            $remote = & $Api 'GET' "$root/contents/${file}?ref=$encodedBranch" $null $false
            if ($remote.Data.encoding -cne 'base64') { throw "Unexpected remote source encoding: $file." }
            $remoteText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($remote.Data.content)).Replace("`r`n", "`n")
            $localText = [IO.File]::ReadAllText((Join-Path $reviewedRoot $file)).Replace("`r`n", "`n")
            if ($remoteText -cne $localText) { throw "Push the locally reviewed deployment source before enabling: $file differs on the production branch." }
        }
        $enabled = & $Api 'GET' "$root/actions/variables/ENABLE_DEPLOYMENT" $null $false
        if ($enabled.Data.value -cne 'false' -and $enabled.Data.value -cne 'true') { throw 'Run disabled setup before enabling.' }
        try { Set-RepositoryVariable $Api $root 'ENABLE_DEPLOYMENT' 'true' }
        catch {
            # A write can succeed even if its response/readback is lost.
            try {
                $null = & $Api 'PATCH' "$root/actions/variables/ENABLE_DEPLOYMENT" @{ name = 'ENABLE_DEPLOYMENT'; value = 'false' } $false
                Set-RepositoryVariable $Api $root 'ENABLE_DEPLOYMENT' 'false'
            }
            catch { throw 'Enable failed and disabling could not be verified. Immediately set repository ENABLE_DEPLOYMENT=false in GitHub and inspect running jobs.' }
            throw 'Enable failed; ENABLE_DEPLOYMENT=false has been restored and verified.'
        }
    }
    else { Set-RepositoryVariable $Api $root 'ENABLE_DEPLOYMENT' 'false' }
    Write-Host "Environment: production; exact branch: $branch; no tag policies."
    foreach ($name in $Configuration.Variables.Keys) { Write-Host "$name=$($Configuration.Variables[$name])" }
    Write-Host "App URL: $($Configuration.Variables.PUBLIC_ORIGIN)/apps/$($Configuration.AppSlug)/"
    Write-Host "ENABLE_DEPLOYMENT=$($EnableDeployment.IsPresent.ToString().ToLowerInvariant())"
    Write-Host "Manually add DEPLOY_SSH_KEY at https://github.com/$($Configuration.Repository)/settings/environments (production)."
    Write-Host 'No SSH private keys were accessed. No source was uploaded and no deployment was dispatched.'
}

Export-ModuleMember -Function New-DeploymentConfiguration, Assert-AppIdentity, Invoke-GitHubRequest, Invoke-DeploymentOnboarding
