param(
    [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDotnet = Join-Path $projectRoot ".tooling\dotnet\dotnet.exe"
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { "dotnet" }

& $dotnet build (Join-Path $projectRoot "FamilyFinance.sln") --configuration $Configuration --maxcpucount:1

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Development build completed. Run src\FamilyFinance.App\bin\$Configuration\net10.0\FamilyFinance.exe"
