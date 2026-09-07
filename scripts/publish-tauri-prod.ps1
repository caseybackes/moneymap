[CmdletBinding()]
param(
    [string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$versionSync = Join-Path $PSScriptRoot 'sync-tauri-version.ps1'
$privacyGate = Join-Path $PSScriptRoot 'verify-public-release.mjs'
$desktopRoot = Join-Path $repositoryRoot 'apps\desktop'
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$tauriCli = Join-Path $desktopRoot 'node_modules\@tauri-apps\cli\tauri.js'
$output = if ($ReleaseDirectory) { $ReleaseDirectory } else { Join-Path $repositoryRoot 'artifacts\windows\release' }
$binary = Join-Path $desktopRoot 'src-tauri\target\release\money-map-desktop.exe'
$tauriConfig = Get-Content -Raw (Join-Path $desktopRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$version = [string]$tauriConfig.version
$bundledInstaller = Join-Path $desktopRoot "src-tauri\target\release\bundle\nsis\Money Map_${version}_x64-setup.exe"
$portableArtifact = Join-Path $output 'MoneyMap.exe'
$installerArtifact = Join-Path $output "MoneyMap-${version}-setup.exe"
$manifestArtifact = Join-Path $output 'release-manifest.json'

if (-not (Test-Path -LiteralPath $node)) { throw "Current Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $tauriCli)) { throw 'Install the desktop dependencies before publishing: npm install (from apps\desktop).' }
& $versionSync -Check
$sourceChanges = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Git worktree before publishing.' }
if ($sourceChanges.Count -gt 0) { throw 'Production publishing requires a clean Git worktree so build provenance identifies the exact source. Commit or remove source changes first.' }
if (Test-Path -LiteralPath $portableArtifact) {
    try {
        $portableLockProbe = [System.IO.File]::Open($portableArtifact, 'Open', 'ReadWrite', 'None')
        $portableLockProbe.Dispose()
    }
    catch {
        throw "Close the running Production MoneyMap.exe before publishing. The existing executable and profile were left unchanged. $($_.Exception.Message)"
    }
}
& $node $privacyGate
if ($LASTEXITCODE -ne 0) { throw "Public-release privacy gate failed with exit code $LASTEXITCODE." }
$env:MONEY_MAP_SOURCE_REVISION = (& git -C $repositoryRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $env:MONEY_MAP_SOURCE_REVISION) { throw 'Could not resolve the source revision for Production build provenance.' }

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$env:PATH = "C:\Strawberry\perl\bin;$cargoBin;$env:PATH"
Push-Location $desktopRoot
try {
    & $node $tauriCli build --bundles nsis --features production -- --no-default-features
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $binary)) { throw "Expected Tauri binary was not produced: $binary" }
if (-not (Test-Path -LiteralPath $bundledInstaller)) { throw "Expected NSIS installer was not produced: $bundledInstaller" }
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath $binary -Destination $portableArtifact -Force
Copy-Item -LiteralPath $bundledInstaller -Destination $installerArtifact -Force

$pdb = Join-Path $desktopRoot 'src-tauri\target\release\money_map_desktop.pdb'
if (Test-Path -LiteralPath $pdb) {
    Copy-Item -LiteralPath $pdb -Destination (Join-Path $output 'MoneyMap.pdb') -Force
}

$artifactRecords = @($portableArtifact, $installerArtifact) | ForEach-Object {
    $item = Get-Item -LiteralPath $_
    [ordered]@{
        name = $item.Name
        sizeBytes = $item.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()
    }
}
$manifest = [ordered]@{
    formatVersion = 1
    applicationVersion = $version
    sourceRevision = $env:MONEY_MAP_SOURCE_REVISION
    buildEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    artifacts = $artifactRecords
}
[System.IO.File]::WriteAllText(
    $manifestArtifact,
    (($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Published Production portable executable: $portableArtifact"
Write-Host "Published current-user NSIS installer: $installerArtifact"
Write-Host "Recorded artifact provenance and SHA-256 hashes: $manifestArtifact"
