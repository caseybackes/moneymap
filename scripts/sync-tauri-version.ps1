[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tauriConfigPath = Join-Path $repositoryRoot 'apps\desktop\src-tauri\tauri.conf.json'
$packagePath = Join-Path $repositoryRoot 'apps\desktop\package.json'
$packageLockPath = Join-Path $repositoryRoot 'apps\desktop\package-lock.json'
$cargoPath = Join-Path $repositoryRoot 'apps\desktop\src-tauri\Cargo.toml'

function Read-Text([string]$Path) {
    return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Replace-VersionMatches([string]$Path, [string]$Pattern, [int]$Count, [string]$Version) {
    $text = Read-Text $Path
    $matches = [regex]::Matches($text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($matches.Count -ne $Count) {
        throw "Expected $Count version declaration(s) in $Path but found $($matches.Count)."
    }

    $updated = $text
    for ($index = $matches.Count - 1; $index -ge 0; $index--) {
        $match = $matches[$index]
        $replacement = $match.Groups[1].Value + $Version + $match.Groups[2].Value
        $updated = $updated.Substring(0, $match.Index) + $replacement + $updated.Substring($match.Index + $match.Length)
    }

    if ($updated -ne $text) {
        if ($Check) { throw "$Path is not synchronized to Tauri version $Version." }
        Write-Text $Path $updated
        Write-Host "Synchronized $Path to $Version"
    }
}

if (-not (Test-Path -LiteralPath $tauriConfigPath)) { throw "Missing Tauri configuration: $tauriConfigPath" }
$tauriConfig = Read-Text $tauriConfigPath | ConvertFrom-Json
$version = [string]$tauriConfig.version
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
    throw "Tauri version '$version' is not valid semantic versioning."
}

# Tauri is the single version authority. The following copies exist only because
# npm and Cargo require package metadata for their own toolchains.
Replace-VersionMatches $packagePath '(?s)\A(\{\s*"name"\s*:\s*"money-map-desktop".*?"version"\s*:\s*")[^"]+(")' 1 $version
Replace-VersionMatches $packageLockPath '(?s)\A(\{\s*"name"\s*:\s*"money-map-desktop".*?"version"\s*:\s*")[^"]+(")' 1 $version
Replace-VersionMatches $packageLockPath '(?s)("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"money-map-desktop".*?"version"\s*:\s*")[^"]+(")' 1 $version
Replace-VersionMatches $cargoPath '(?m)^(version\s*=\s*")[^"]+("\s*)$' 1 $version

Write-Host "Tauri version $version is the active Money Map version."
