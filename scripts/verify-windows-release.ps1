[CmdletBinding()]
param(
    [string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $repositoryRoot 'artifacts\windows\release' }
$manifestPath = Join-Path $ReleaseDirectory 'release-manifest.json'
$configPath = Join-Path $repositoryRoot 'apps\desktop\src-tauri\tauri.conf.json'

if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Release manifest is missing: $manifestPath" }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$revision = (& git -C $repositoryRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the source revision.' }
if ($manifest.formatVersion -ne 1) { throw "Unsupported release manifest format: $($manifest.formatVersion)" }
if ($manifest.applicationVersion -ne $config.version) { throw 'Release manifest version does not match the Tauri configuration.' }
if ($manifest.sourceRevision -ne $revision) { throw 'Release manifest revision does not match the current commit.' }

$expectedNames = @('MoneyMap.exe', "MoneyMap-$($config.version)-setup.exe")
$actualNames = @($manifest.artifacts | ForEach-Object { [string]$_.name })
$actualNameKey = ($actualNames | Sort-Object) -join "`n"
$expectedNameKey = ($expectedNames | Sort-Object) -join "`n"
if ($actualNameKey -ne $expectedNameKey) {
    throw "Release manifest must contain exactly: $($expectedNames -join ', ')"
}
foreach ($record in $manifest.artifacts) {
    $artifactPath = Join-Path $ReleaseDirectory ([string]$record.name)
    if (-not (Test-Path -LiteralPath $artifactPath)) { throw "Release artifact is missing: $($record.name)" }
    $item = Get-Item -LiteralPath $artifactPath
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
    if ($item.Length -ne [long]$record.sizeBytes) { throw "Release artifact size mismatch: $($record.name)" }
    if ($hash -ne [string]$record.sha256) { throw "Release artifact SHA-256 mismatch: $($record.name)" }
}

$portableVersion = (Get-Item -LiteralPath (Join-Path $ReleaseDirectory 'MoneyMap.exe')).VersionInfo.ProductVersion
if ($portableVersion -ne $config.version) { throw "Portable executable version mismatch: $portableVersion" }

Write-Host "Verified Money Map $($manifest.applicationVersion) Windows artifacts at revision $($manifest.sourceRevision)."
foreach ($record in $manifest.artifacts) {
    Write-Host "$($record.name) $($record.sha256)"
}
