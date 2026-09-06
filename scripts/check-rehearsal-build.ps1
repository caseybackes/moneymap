[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repositoryRoot 'apps\desktop\src-tauri'

& node (Join-Path $PSScriptRoot 'validate-upgrade-rehearsal-fixture.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Rehearsal fixture validation failed.' }
& node (Join-Path $PSScriptRoot 'verify-upgrade-rehearsal.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Rehearsal isolation validation failed.' }

Push-Location $tauriRoot
try {
    cargo test --no-default-features --features rehearsal --bin money-map-rehearsal
    if ($LASTEXITCODE -ne 0) { throw 'Rehearsal test suite failed.' }
    cargo build --no-default-features --features rehearsal --bin money-map-rehearsal
    if ($LASTEXITCODE -ne 0) { throw 'Rehearsal build failed.' }
    & node (Join-Path $PSScriptRoot 'verify-upgrade-rehearsal.mjs') (Join-Path $tauriRoot 'target\debug\money-map-rehearsal.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Rehearsal binary isolation validation failed.' }

    cargo check --no-default-features --features production --bin money-map-desktop
    if ($LASTEXITCODE -ne 0) { throw 'Production build check failed.' }

    cargo check --no-default-features --features sandbox-dev --bin money-map-desktop
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox build check failed.' }

    cargo check --no-default-features --bin money-map-desktop 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'Desktop build unexpectedly accepted zero flavors.' }
    cargo check --no-default-features --features production,sandbox-dev --bin money-map-desktop 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'Desktop build unexpectedly accepted multiple flavors.' }
    cargo check --no-default-features --features production,rehearsal --bin money-map-desktop 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'Production build unexpectedly accepted rehearsal.' }
}
finally {
    Pop-Location
}
