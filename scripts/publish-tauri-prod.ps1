[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$versionSync = Join-Path $PSScriptRoot 'sync-tauri-version.ps1'
$desktopRoot = Join-Path $repositoryRoot 'apps\desktop'
$node = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$tauriCli = Join-Path $desktopRoot 'node_modules\@tauri-apps\cli\tauri.js'
$output = Join-Path $repositoryRoot 'artifacts\windows\release'
$binary = Join-Path $desktopRoot 'src-tauri\target\release\family-finance-desktop.exe'

if (-not (Test-Path -LiteralPath $node)) { throw "Current Node runtime was not found: $node" }
if (-not (Test-Path -LiteralPath $tauriCli)) { throw 'Install the desktop dependencies before publishing: npm install (from apps\desktop).' }
& $versionSync

$env:PATH = "C:\Strawberry\perl\bin;C:\Users\Admin\.cargo\bin;$env:PATH"
Push-Location $desktopRoot
try {
    & $node $tauriCli build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $binary)) { throw "Expected Tauri binary was not produced: $binary" }
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $output 'MoneyMap.exe') -Force

$pdb = Join-Path $desktopRoot 'src-tauri\target\release\family_finance_desktop.pdb'
if (Test-Path -LiteralPath $pdb) {
    Copy-Item -LiteralPath $pdb -Destination (Join-Path $output 'MoneyMap.pdb') -Force
}

Write-Host "Published React/Tauri production executable: $(Join-Path $output 'MoneyMap.exe')"
