param(
    [string]$Configuration = "Release",
    [string]$RuntimeIdentifier = "linux-x64"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDotnet = Join-Path $projectRoot ".tooling\dotnet\dotnet.exe"
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { "dotnet" }
$output = Join-Path $projectRoot ("artifacts\linux\" + $RuntimeIdentifier)
$project = Join-Path $projectRoot "src\FamilyFinance.App\FamilyFinance.App.csproj"

& $dotnet restore $project --runtime $RuntimeIdentifier --disable-parallel
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $dotnet publish $project `
    --configuration $Configuration `
    --runtime $RuntimeIdentifier `
    --self-contained true `
    --no-restore `
    --maxcpucount:1 `
    --output $output `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugSymbols=false `
    -p:DebugType=None

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Published Family Finance to $output"
