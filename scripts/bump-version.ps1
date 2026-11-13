<#
.SYNOPSIS
    Bump the coomwall version in every file that hard-codes it, in one shot.

.DESCRIPTION
    The version string lives in four places (the app's Cargo manifest,
    package.json, tauri.conf.json, the README badge) plus package-lock.json and
    Cargo.lock. The engine crate (crates/engine) keeps its own version. Editing them by hand is
    tedious and easy to forget. This script updates them all from a single arg.

.PARAMETER Version
    The new semver, e.g. 0.3.1

.EXAMPLE
    ./scripts/bump-version.ps1 0.3.1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # repo root (this script lives in scripts/)

# Windows PowerShell 5.1's Get-Content/Set-Content default to ANSI, which mangles
# non-ASCII (em dashes, arrows) on read/write. Use .NET UTF-8 (no BOM) instead.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text($p)  { [System.IO.File]::ReadAllText($p) }
function Write-Text($p, $s) { [System.IO.File]::WriteAllText($p, $s, $utf8) }

# Each target: file path + the regex whose first capture group is kept and whose
# version token is replaced. {V} is substituted with the new version.
$targets = @(
    @{ Path = 'package.json';                Pattern = '("version"\s*:\s*")\d+\.\d+\.\d+(")';  Repl = '${1}{V}${2}'; First = $true  }
    @{ Path = 'src-tauri/tauri.conf.json';   Pattern = '("version"\s*:\s*")\d+\.\d+\.\d+(")';  Repl = '${1}{V}${2}'; First = $true  }
    @{ Path = 'src-tauri/Cargo.toml';        Pattern = '(?m)^(version\s*=\s*")\d+\.\d+\.\d+(")'; Repl = '${1}{V}${2}'; First = $true }
    @{ Path = 'README.md';                   Pattern = '(version-)\d+\.\d+\.\d+(-c287ff)';     Repl = '${1}{V}${2}'; First = $false }
    @{ Path = 'README.md';                   Pattern = '(alt="Version )\d+\.\d+\.\d+(")';      Repl = '${1}{V}${2}'; First = $false }
    # package-lock.json carries the project version twice (top-level + packages[""]),
    # both immediately after "name": "coomwall". Replace both (First = $false).
    @{ Path = 'package-lock.json';           Pattern = '("name"\s*:\s*"coomwall"\s*,\s*"version"\s*:\s*")\d+\.\d+\.\d+(")'; Repl = '${1}{V}${2}'; First = $false }
)

# Cargo.lock: only the app package, matched by name then version line.
$lockTargets = @('coomwall')

$changed = 0
foreach ($t in $targets) {
    $full = Join-Path $root $t.Path
    if (-not (Test-Path $full)) { Write-Warning "skip (missing): $($t.Path)"; continue }
    $text = Read-Text $full
    $repl = $t.Repl.Replace('{V}', $Version)
    $rx   = [regex]$t.Pattern
    if (-not $rx.IsMatch($text)) { Write-Warning "no version match in $($t.Path) (pattern unchanged?)"; continue }
    $new = if ($t.First) { $rx.Replace($text, $repl, 1) } else { $rx.Replace($text, $repl) }
    if ($new -ne $text) {
        Write-Text $full $new
        Write-Host "  bumped  $($t.Path)" -ForegroundColor Green
        $changed++
    } else {
        Write-Host "  already $Version  $($t.Path)" -ForegroundColor DarkGray
    }
}

# Cargo.lock
$lock = Join-Path $root 'Cargo.lock'
if (Test-Path $lock) {
    $text = Read-Text $lock
    foreach ($name in $lockTargets) {
        $rx = [regex]"(?m)(^name = ""$([regex]::Escape($name))""\r?\nversion = "")\d+\.\d+\.\d+("")"
        $text = $rx.Replace($text, "`${1}$Version`${2}", 1)
    }
    Write-Text $lock $text
    Write-Host "  bumped  Cargo.lock (workspace packages)" -ForegroundColor Green
}

Write-Host "Version set to $Version ($changed file group(s) updated)." -ForegroundColor Cyan
