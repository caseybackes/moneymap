[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $repositoryRoot 'apps\desktop\src-tauri'

Push-Location $tauriRoot
try {
    cargo check --no-default-features --features rehearsal --bin money-map-rehearsal
    if ($LASTEXITCODE -ne 0) { throw 'Rehearsal build check failed.' }

    cargo check --no-default-features --features production --bin money-map-desktop
    if ($LASTEXITCODE -ne 0) { throw 'Production build check failed.' }

    cargo check --no-default-features --features sandbox-dev --bin money-map-desktop
    if ($LASTEXITCODE -ne 0) { throw 'Sandbox build check failed.' }
}
finally {
    Pop-Location
}
