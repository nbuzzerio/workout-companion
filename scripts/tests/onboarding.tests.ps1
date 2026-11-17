#Requires -Version 5.1
# Offline executable tests, intentionally independent of Pester and GitHub.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'GitHubDeployment.psm1') -Force
$script:passed = 0
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch { if ($_.Exception.Message -notmatch $Pattern) { throw }; return }
    throw "Expected failure: $Pattern"
}
function Test([string]$Name, [scriptblock]$Action) {
    & $Action
    $script:passed++
    Write-Output "PASS $Name"
}
$pin = 'SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0'
$arguments = @{ Repository = 'nbuzzerio/workout-companion'; AppSlug = 'workout'; DeployHost = 'deploy.example.com'; DeployPort = 2222; HostFingerprint = $pin; PublicOrigin = 'https://www.nickbuzzerio.com'; ProductionBranch = 'main' }
$configuration = New-DeploymentConfiguration @arguments
$source = "id: 'workout',`nbasePath: '/apps/workout/',`n"

Test 'entry points require confirmed host and port and expose no key or token argument' {
    $scripts = @((Join-Path (Split-Path $PSScriptRoot -Parent) 'Initialize-GitHubDeployment.ps1'))
    $workout = Join-Path (Split-Path $PSScriptRoot -Parent) 'Initialize-WorkoutDeployment.ps1'
    if (Test-Path -LiteralPath $workout) { $scripts += $workout }
    foreach ($file in $scripts) {
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
        Assert ($errors.Count -eq 0) 'Script parse error'
        foreach ($name in @('DeployHost', 'DeployPort')) {
            $parameter = @($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -ceq $name })
            Assert ($parameter.Count -eq 1 -and $null -eq $parameter[0].DefaultValue) "$name must have no default"
            Assert ($parameter[0].Extent.Text -match 'Parameter\(Mandatory\)') "$name must be mandatory"
        }
        Assert (@($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -match 'Token|Key|Password' }).Count -eq 0) 'Authentication/key argument exposed'
    }
}

function New-Fixture {
    $state = @{
        Repository = [pscustomobject]@{ id = 123; full_name = 'nbuzzerio/workout-companion'; private = $true; permissions = [pscustomobject]@{admin = $true}; archived = $false; disabled = $false }
        Exists = $true; Environment = $null; Variables = @{}; EnvironmentVariables = @()
        Policies = (New-Object Collections.ArrayList); Calls = (New-Object Collections.ArrayList)
        Fail = ''; WrongReadback = ''; RemoteSource = $source
        RemoteWorkflow = [IO.File]::ReadAllText((Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.github/workflows/ci-deploy.yml')); OwnerType = 'Organization'
        ReviewedRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
        WrongRepositoryAfterWrite = $false; CreatedVisibility = $null; FailEnableReadback = $false
    }
    $api = {
        param($method, $path, $body, $allow404)
        $null = $state.Calls.Add([pscustomobject]@{ Method = $method; Path = $path; Body = $body })
        if ("$method $path" -eq $state.Fail) { throw 'Simulated API permission/network failure' }
        $ok = @{ Status = 200; Data = $null }
        $missing = @{ Status = 404; Data = $null }
        $root = '/repos/nbuzzerio/workout-companion'
        $envPath = "$root/environments/production"
        $policies = "$envPath/deployment-branch-policies"
        if ($method -eq 'GET' -and $path -eq '/user') { $ok.Data = [pscustomobject]@{login = 'nbuzzerio'}; return $ok }
        if ($method -eq 'POST' -and ($path -eq '/user/repos' -or $path -eq '/orgs/nbuzzerio/repos')) {
            $state.Exists = $true; $state.Repository.private = $body.private; $state.CreatedVisibility = $body.private; return $ok
        }
        if ($method -eq 'GET' -and $path -eq '/users/nbuzzerio') { $ok.Data = [pscustomobject]@{type = $state.OwnerType}; return $ok }
        if ($path -eq $root -and $method -eq 'GET') {
            if (-not $state.Exists) { return $missing }
            if ($state.WrongRepositoryAfterWrite -and $state.Variables.Count -gt 1) { $state.Repository.id = 999 }
            $ok.Data = $state.Repository; return $ok
        }
        if ($path -eq $envPath -and $method -eq 'GET') {
            if ($null -eq $state.Environment) { return $missing }
            $ok.Data = $state.Environment; return $ok
        }
        if ($path -eq $envPath -and $method -eq 'PUT') {
            if ($null -eq $state.Environment) { $state.Environment = [pscustomobject]@{ name = 'production'; protection_rules = @(); deployment_branch_policy = $body.deployment_branch_policy } }
            else { $state.Environment.deployment_branch_policy = $body.deployment_branch_policy }
            return $ok
        }
        if ($path.StartsWith("$envPath/variables?") -and $method -eq 'GET') {
            $page = [int]($path -replace '.*page=', '')
            $ok.Data = [pscustomobject]@{variables = @($state.EnvironmentVariables | Select-Object -Skip (($page - 1) * 30) -First 30)}; return $ok
        }
        if ($path.StartsWith("$policies`?") -and $method -eq 'GET') {
            # Exercise pagination even when a correct main rule is on a later page.
            $page = [int]($path -replace '.*page=', '')
            $ok.Data = [pscustomobject]@{branch_policies = @($state.Policies | Select-Object -Skip (($page - 1) * 30) -First 30)}
            return $ok
        }
        if ($path -eq $policies -and $method -eq 'POST') {
            $null = $state.Policies.Add([pscustomobject]@{id = 500; name = $body.name; type = $body.type}); return $ok
        }
        if ($path.StartsWith("$policies/") -and $method -eq 'DELETE') {
            $id = [int]($path.Split('/')[-1])
            for ($i = $state.Policies.Count - 1; $i -ge 0; $i--) { if ($state.Policies[$i].id -eq $id) { $state.Policies.RemoveAt($i) } }
            return $ok
        }
        if ($path -eq "$root/actions/variables" -and $method -eq 'POST') { $state.Variables[$body.name] = $body.value; return $ok }
        if ($path.StartsWith("$root/actions/variables/")) {
            $name = $path.Split('/')[-1]
            if ($method -eq 'PATCH') { $state.Variables[$name] = $body.value; return $ok }
            if ($method -eq 'GET') {
                if (-not $state.Variables.ContainsKey($name)) { if ($allow404) { return $missing }; throw 'Missing variable' }
                $value = $state.Variables[$name]
                if ($name -ceq 'ENABLE_DEPLOYMENT' -and $value -ceq 'true' -and $state.FailEnableReadback) { throw 'Simulated lost enable readback' }
                if ($state.WrongReadback -eq $name) { $value = 'wrong' }
                $ok.Data = [pscustomobject]@{name = $name; value = $value}; return $ok
            }
        }
        if ($path -eq "$root/branches/main" -and $method -eq 'GET') { $ok.Data = [pscustomobject]@{name = 'main'}; return $ok }
        if ($path -eq "$root/contents/config/app.ts?ref=main") { $ok.Data = [pscustomobject]@{encoding = 'base64'; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($state.RemoteSource))}; return $ok }
        if ($path -eq "$root/contents/.github/workflows/ci-deploy.yml?ref=main") { $ok.Data = [pscustomobject]@{encoding = 'base64'; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($state.RemoteWorkflow))}; return $ok }
        if ($path -match '/contents/((scripts/(verify_host_key|deployment_policy|activate_checked|release_health)|infra/(deploy_static|storage_guard))\.mjs)\?ref=main$') {
            $text = [IO.File]::ReadAllText((Join-Path $state.ReviewedRoot $Matches[1]))
            $ok.Data = [pscustomobject]@{encoding = 'base64'; content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))}; return $ok
        }
        throw "Unexpected API request: $method $path"
    }.GetNewClosure()
    return @{ State = $state; Api = $api }
}
function Setup($Fixture, [switch]$Enable) {
    Invoke-DeploymentOnboarding -Configuration $configuration -Api $Fixture.Api -AppConfigSource $source -EnableDeployment:$Enable 6>$null
}

Test 'Workout configuration and strict validation' {
    Assert ($configuration.Variables.DEPLOY_PORT -ceq '2222') 'Port mismatch'
    Assert ($configuration.Variables.DEPLOY_HOST_FINGERPRINT -ceq $pin) 'Pin mismatch'
    foreach ($field in @('Repository', 'AppSlug', 'DeployHost', 'DeployPort', 'HostFingerprint', 'PublicOrigin', 'ProductionBranch', 'DeployUser')) {
        $bad = $arguments.Clone()
        $bad[$field] = switch ($field) {
            Repository { '../wrong' }; AppSlug { 'Workout' }; DeployHost { 'host;whoami' }; DeployPort { 0 }
            HostFingerprint { 'SHA256:invalid' }; PublicOrigin { 'https://www.nickbuzzerio.com/path' }; ProductionBranch { 'release/*' }; DeployUser { 'root' }
        }
        Assert-Throws { New-DeploymentConfiguration @bad } '.'
    }
    foreach ($branch in @('main ', 'MAIN*', 'release/[ab]', '.hidden', 'foo//bar', 'foo..bar', 'foo.lock', 'foo/', 'foo.')) {
        $bad = $arguments.Clone(); $bad.ProductionBranch = $branch
        Assert-Throws { New-DeploymentConfiguration @bad } 'ProductionBranch'
    }
    $good = $arguments.Clone(); $good.ProductionBranch = 'release/production'
    Assert ((New-DeploymentConfiguration @good).Variables.PRODUCTION_BRANCH -ceq 'release/production') 'Slash branch rejected'
    Assert-Throws { Assert-AppIdentity $source 'other' } 'config/app.ts'
}

Test 'disabled setup and idempotent rerun create no duplicates or extra mutations' {
    $f = New-Fixture
    Setup $f
    Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'false') 'Setup enabled deployment'
    Assert ($f.State.Variables.Count -eq 7) 'Missing variables'
    Assert ($f.State.Policies.Count -eq 1) 'Missing policy'
    Assert ($f.State.Policies[0].type -ceq 'branch') 'Wrong policy type'
    $before = $f.State.Calls.Count
    Setup $f
    $writes = @($f.State.Calls | Select-Object -Skip $before | Where-Object { $_.Method -cne 'GET' })
    Assert ($writes.Count -eq 0) 'Idempotent rerun performed writes'
    Assert (@($f.State.Calls | Where-Object { $_.Path -match 'secrets|dispatches' }).Count -eq 0) 'Touched secrets or dispatched a workflow'
}

Test 'setup rerun explicitly disables a formerly enabled configuration first' {
    $f = New-Fixture; Setup $f; Setup $f -Enable
    Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'true') 'Explicit opt-in failed'
    $before = $f.State.Calls.Count; Setup $f
    $writes = @($f.State.Calls | Select-Object -Skip $before | Where-Object { $_.Method -cne 'GET' })
    Assert ($writes[0].Body.name -ceq 'ENABLE_DEPLOYMENT' -and $writes[0].Body.value -ceq 'false') 'Disable was not first'
}

Test 'existing environment reviewers timers and custom protections remain byte-equivalent' {
    $f = New-Fixture; Setup $f
    $f.State.Environment.protection_rules = @([pscustomobject]@{type='required_reviewers'; prevent_self_review=$true; reviewers=@(@{type='User'; reviewer=@{id=7}})}, [pscustomobject]@{type='wait_timer'; wait_timer=30}, [pscustomobject]@{type='custom'; id=77})
    $before = $f.State.Environment | ConvertTo-Json -Depth 20 -Compress
    $f.State.Variables.UNRELATED = 'keep'
    Setup $f
    Assert (($f.State.Environment | ConvertTo-Json -Depth 20 -Compress) -ceq $before) 'Changed unrelated protections'
    Assert ($f.State.Variables.UNRELATED -ceq 'keep') 'Changed unrelated variable'
    Assert (@($f.State.Calls | Where-Object { $_.Method -eq 'PUT' }).Count -eq 1) 'Rewrote existing environment'
}

Test 'protected-branch mode and unrestricted protected environments fail without rewriting protections' {
    foreach ($policy in @(@{protected_branches=$true; custom_branch_policies=$false}, $null)) {
        $f = New-Fixture
        $f.State.Environment = [pscustomobject]@{ name='production'; deployment_branch_policy=$policy; protection_rules=@([pscustomobject]@{type='wait_timer'; wait_timer=30}) }
        Assert-Throws { Setup $f } 'Existing environment protections'
        Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'false') 'Failure did not leave disabled'
        Assert (@($f.State.Calls | Where-Object { $_.Method -eq 'PUT' }).Count -eq 0) 'Rewrote protections'
    }
}

Test 'excess branch and tag policies removed including pagination and duplicate main rule' {
    $f = New-Fixture; Setup $f; $f.State.Policies.Clear()
    for ($i = 0; $i -lt 101; $i++) { $null = $f.State.Policies.Add([pscustomobject]@{id=$i; name='release/*'; type='branch'}) }
    $null = $f.State.Policies.Add([pscustomobject]@{id=102; name='main'; type='tag'})
    $null = $f.State.Policies.Add([pscustomobject]@{id=103; name='main'; type='branch'})
    $null = $f.State.Policies.Add([pscustomobject]@{id=104; name='main'; type='branch'})
    Setup $f
    Assert ($f.State.Policies.Count -eq 1 -and $f.State.Policies[0].id -eq 103) 'Policies not exact or duplicated'
}

Test 'environment variable shadowing rejected with no unrelated variable deletion' {
    $f = New-Fixture; Setup $f
    $f.State.EnvironmentVariables = @(1..30 | ForEach-Object { [pscustomobject]@{name="UNRELATED_$_"; value='keep'} }) + @([pscustomobject]@{name='PUBLIC_ORIGIN'; value='https://wrong.example'})
    Assert-Throws { Setup $f } 'conflicting production environment variable'
    Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'false') 'Enabled on error'
}

Test 'lost enable readback restores and verifies disabled flag' {
    $f = New-Fixture; Setup $f; $f.State.FailEnableReadback = $true
    Assert-Throws { Setup $f -Enable } 'false has been restored and verified'
    Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'false') 'Lost readback left enabled'
}

Test 'missing repository requires explicit creation; public and private creation are supported' {
    $f = New-Fixture; $f.State.Exists = $false
    Assert-Throws { Setup $f } 'inaccessible or missing'
    foreach ($visibility in @('public', 'private')) {
        $f = New-Fixture; $f.State.Exists = $false
        Invoke-DeploymentOnboarding -Configuration $configuration -Api $f.Api -AppConfigSource $source -CreateRepository -Visibility $visibility 6>$null
        Assert ($f.State.CreatedVisibility -eq ($visibility -eq 'private')) 'Wrong created visibility'
        $before = @($f.State.Calls | Where-Object { $_.Path -eq '/user/repos' }).Count
        Invoke-DeploymentOnboarding -Configuration $configuration -Api $f.Api -AppConfigSource $source -CreateRepository -Visibility $visibility 6>$null
        Assert (@($f.State.Calls | Where-Object { $_.Path -eq '/user/repos' }).Count -eq $before) 'Duplicate repo creation'
    }
}

Test 'wrong repository lack of admin and local app mismatch fail before writes' {
    foreach ($case in @('identity', 'permissions', 'source')) {
        $f = New-Fixture
        if ($case -eq 'identity') { $f.State.Repository.full_name = 'other/wrong' }
        if ($case -eq 'permissions') { $f.State.Repository.permissions.admin = $false }
        $candidateSource = $source
        if ($case -eq 'source') { $candidateSource = "id: 'wrong',`nbasePath: '/apps/wrong/',`n" }
        Assert-Throws { Invoke-DeploymentOnboarding -Configuration $configuration -Api $f.Api -AppConfigSource $candidateSource 6>$null } 'verification|config/app.ts'
        Assert (@($f.State.Calls | Where-Object { $_.Method -cne 'GET' }).Count -eq 0) 'Wrote before identity verification'
    }
}

Test 'API errors and readback mismatch fail closed leaving setup disabled' {
    foreach ($case in @('error', 'readback', 'identity')) {
        $f = New-Fixture
        if ($case -eq 'error') { $f.State.Fail = 'POST /repos/nbuzzerio/workout-companion/environments/production/deployment-branch-policies' }
        if ($case -eq 'readback') { $f.State.WrongReadback = 'DEPLOY_HOST' }
        if ($case -eq 'identity') { $f.State.WrongRepositoryAfterWrite = $true }
        Assert-Throws { Setup $f } 'failure|readback|identity'
        Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'false') 'Failure enabled deployment'
    }
}

Test 'separate opt-in verifies configuration policy remote source and reviewed workflow' {
    $f = New-Fixture
    Assert-Throws { Setup $f -Enable } 'disabled setup'
    Setup $f
    $f.State.Variables.DEPLOY_PORT = '9999'
    Assert-Throws { Setup $f -Enable } 'mismatch'
    $f.State.Variables.DEPLOY_PORT = '2222'; $f.State.Policies[0].type = 'tag'
    Assert-Throws { Setup $f -Enable } 'exactly'
    $f.State.Policies[0].type = 'branch'; $f.State.RemoteSource = 'wrong'
    Assert-Throws { Setup $f -Enable } 'config/app.ts'
    $f.State.RemoteSource = $source; $f.State.RemoteWorkflow = 'old workflow'
    Assert-Throws { Setup $f -Enable } 'reviewed'
    $f.State.RemoteWorkflow = [IO.File]::ReadAllText((Join-Path $f.State.ReviewedRoot '.github/workflows/ci-deploy.yml')); $f.State.Fail = 'GET /repos/nbuzzerio/workout-companion/branches/main'
    Assert-Throws { Setup $f -Enable } 'failure'
    Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'false') 'Failure enabled deployment'
    $f.State.Fail = ''; Setup $f -Enable
    Assert ($f.State.Variables.ENABLE_DEPLOYMENT -ceq 'true') 'Explicit opt-in failed'
    $before = $f.State.Calls.Count; Setup $f -Enable
    Assert (@($f.State.Calls | Select-Object -Skip $before | Where-Object { $_.Method -cne 'GET' }).Count -eq 0) 'Enable rerun not idempotent'
    Assert-Throws { Invoke-DeploymentOnboarding -Configuration $configuration -Api $f.Api -AppConfigSource $source -CreateRepository -EnableDeployment } 'separate'
}

Test 'API transport uses HTTPS TLS-bound target no redirects memory-only auth and sanitized failures' {
    $module = Get-Module GitHubDeployment
    & $module {
        $script:transportFailed = $false
        $script:unexpectedFailure = $false
        function script:Invoke-WebRequest {
            param($Uri, $Method, $Headers, $UseBasicParsing, $MaximumRedirection, $TimeoutSec, $ErrorAction, $Body, $ContentType)
            if ($Uri -cne 'https://api.github.com/user' -or $MaximumRedirection -ne 0 -or $TimeoutSec -ne 30 -or $Headers.Authorization -cne 'Bearer synthetic-api-token') { throw 'Transport contract broken' }
            if ($script:unexpectedFailure) { throw 'Unexpected error with synthetic-api-token' }
            if ($script:transportFailed) { throw (New-Object Net.WebException('SENSITIVE NETWORK DETAIL')) }
            return [pscustomobject]@{StatusCode=200; Content='{"login":"test"}'}
        }
    }
    $token = ConvertTo-SecureString 'synthetic-api-token' -AsPlainText -Force
    try {
        $response = Invoke-GitHubRequest $token 'GET' '/user' $null
        Assert ($response.Data.login -ceq 'test') 'Transport response mismatch'
        & $module { $script:transportFailed = $true }
        Assert-Throws { Invoke-GitHubRequest $token 'GET' '/user' $null } 'GitHub API GET /user failed'
        & $module { $script:unexpectedFailure = $true }
        $message = ''
        try { Invoke-GitHubRequest $token 'GET' '/user' $null } catch { $message = $_.Exception.Message }
        Assert ($message -match 'GitHub API GET /user failed' -and $message -notmatch 'synthetic-api-token') 'Raw exception disclosed sensitive detail'
        Assert-Throws { Invoke-GitHubRequest $token 'GET' 'https://evil.example/user' $null } 'Invalid GitHub API path'
    }
    finally { $token.Dispose() }
}

Write-Output "All onboarding tests passed ($script:passed groups). No network requests or SSH keys used."
