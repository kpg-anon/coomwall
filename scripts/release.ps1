<#
.SYNOPSIS
    One-command release: bump -> build -> commit -> push -> tag -> GitHub Release.

.DESCRIPTION
    The full publish runbook, automated (the same as comfysort's). Steps:
      1. Guard: refuse to run unless the git identity is the kpg-anon noreply
         (never commit with a personal email).
      2. Bump the version everywhere (scripts/bump-version.ps1).
      3. Build the signed Tauri bundles (unless -SkipBuild) and write the
         updater manifest latest.json, whose notes are this version's
         CHANGELOG.md section: that is what the in-app update notice shows.
      4. Commit all changes (no Co-Authored-By, no footers).
      5. Tag vX.Y.Z and push the branch and the tag.
      6. Create a GitHub Release with the installers and latest.json attached.

    The updater signing key (.tauri-updater.key) and its passphrase
    (.tauri-updater.pass) live in the repo root, gitignored. Back them up
    together: without them no later build can update existing installs.

    The in-app updater fetches
    https://github.com/kpg-anon/coomwall/releases/latest/download/latest.json,
    which only resolves while the repository is public.

.PARAMETER Version
    New semver, e.g. 1.0.1

.PARAMETER Notes
    Release notes body. Defaults to the version's CHANGELOG.md section.

.PARAMETER SkipBuild
    Commit/tag/push the source only, no installers.

.PARAMETER DryRun
    Print each step without changing files, git or GitHub.

.EXAMPLE
    ./scripts/release.ps1 1.0.1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [string]$Notes,
    [switch]$SkipBuild,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$repo = 'kpg-anon/coomwall'
$tag = "v$Version"
$ExpectedIdentityEmail = '128227694+kpg-anon@users.noreply.github.com'
$ExpectedIdentityName  = 'kpg-anon'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Run($cmd) {
    Write-Host "    $cmd" -ForegroundColor DarkGray
    if (-not $DryRun) { Invoke-Expression $cmd; if ($LASTEXITCODE) { throw "command failed ($LASTEXITCODE): $cmd" } }
}

# This version's section of CHANGELOG.md (between "## [x.y.z]" and the next "## ").
function Get-ChangelogNotes($version) {
    $cl = Join-Path $root 'CHANGELOG.md'
    if (-not (Test-Path $cl)) { return $null }
    $lines = [System.IO.File]::ReadAllLines($cl)   # UTF-8; 5.1 Get-Content would mangle em dashes
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^##\s*\[$([regex]::Escape($version))\]") { $start = $i + 1; break }
    }
    if ($start -lt 0) { return $null }
    $body = @()
    for ($i = $start; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^##\s') { break }
        $body += $lines[$i]
    }
    return ($body -join "`n").Trim()
}

# 1. Identity guard.
Step "Verifying commit identity"
$email = (git config user.email).Trim()
$name  = (git config user.name).Trim()
if ($email -ne $ExpectedIdentityEmail) {
    throw "Refusing to release: git user.email is '$email', expected '$ExpectedIdentityEmail'."
}
if ($name -ne $ExpectedIdentityName) {
    throw "Refusing to release: git user.name is '$name', expected '$ExpectedIdentityName'."
}
Write-Host "    OK: $name <$email>" -ForegroundColor Green
if (git tag --list $tag) { throw "Tag $tag already exists. Delete it first if it was never pushed: git tag -d $tag" }

# 2. Bump.
Step "Bumping version to $Version"
if ($DryRun) { Write-Host "    (dry-run) ./scripts/bump-version.ps1 $Version" -ForegroundColor DarkGray }
else { & (Join-Path $PSScriptRoot 'bump-version.ps1') $Version }

if (-not $Notes) {
    $clNotes = Get-ChangelogNotes $Version
    if ($clNotes) {
        $Notes = "$clNotes`n`n---`nFull changelog: https://github.com/$repo/blob/main/CHANGELOG.md"
    } else {
        Write-Warning "No CHANGELOG.md section for $Version; using a placeholder note."
        $Notes = "coomwall $tag"
    }
}

# 3. Build.
$bundles = @()
if ($SkipBuild) {
    Step "Skipping build (-SkipBuild)"
} else {
    Step "Building release bundles (npx tauri build)"
    $keyPath = Join-Path $root '.tauri-updater.key'
    $passPath = Join-Path $root '.tauri-updater.pass'
    if (-not (Test-Path $keyPath)) { throw "Updater signing key not found at $keyPath." }
    if (-not (Test-Path $passPath)) { throw "Updater key passphrase not found at $passPath." }
    # Non-empty on purpose: PowerShell 5.1 drops empty env vars for child
    # processes, and the bundler would then ask for the password interactively.
    $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText($keyPath)
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.IO.File]::ReadAllText($passPath)
    # tauri-build wants WebView2Loader.dll in target/release before the first build makes it
    $dll = Join-Path $root 'target/release/WebView2Loader.dll'
    if (-not (Test-Path $dll)) {
        $dev = Join-Path $root 'target/debug/WebView2Loader.dll'
        if (Test-Path $dev) { New-Item -ItemType Directory -Force (Split-Path $dll) | Out-Null; Copy-Item $dev $dll }
        else { throw "WebView2Loader.dll missing: run 'npm run tauri dev' once, then try again." }
    }
    Run 'npx tauri build'
    $bundleDir = Join-Path $root 'target/release/bundle'
    $bundles = @(Get-ChildItem -Path $bundleDir -Recurse -Include "*_$($Version)_*.msi", "*_$($Version)_*-setup.exe" -ErrorAction SilentlyContinue)
    if (-not $DryRun -and $bundles.Count -eq 0) { throw "No installers found in $bundleDir for version $Version." }

    # latest.json: points the in-app updater at the signed NSIS installer.
    if (-not $DryRun) {
        $setup = $bundles | Where-Object { $_.Name -like '*-setup.exe' } | Select-Object -First 1
        if (-not $setup) { throw "No NSIS -setup.exe found to build the updater manifest." }
        $sigPath = "$($setup.FullName).sig"
        if (-not (Test-Path $sigPath)) { throw "Updater signature missing: $sigPath (needs createUpdaterArtifacts + signing key)." }
        $manifest = [ordered]@{
            version   = $Version
            notes     = $Notes
            pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            platforms = [ordered]@{
                'windows-x86_64' = [ordered]@{
                    signature = ([System.IO.File]::ReadAllText($sigPath)).Trim()
                    url       = "https://github.com/$repo/releases/download/$tag/$($setup.Name)"
                }
            }
        }
        $latest = Join-Path $root 'target/release/latest.json'
        [System.IO.File]::WriteAllText($latest, ($manifest | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
        $bundles += Get-Item $latest
    }
    $bundles | ForEach-Object { Write-Host "    asset: $($_.FullName)" -ForegroundColor Green }
}

# 4. Commit (plain authorship).
Step "Committing"
Run 'git add -A'
$dirty = git status --porcelain
if ($dirty -or $DryRun) { Run "git commit -m `"release: $tag`"" } else { Write-Host "    nothing to commit" -ForegroundColor DarkGray }

# 5. Tag + push.
Step "Tagging $tag and pushing"
Run "git tag $tag"
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Run "git push origin $branch"
Run "git push origin $tag"

# 6. GitHub Release.
Step "Creating GitHub Release $tag"
$notesFile = Join-Path $env:TEMP "coomwall-$tag-notes.md"
[System.IO.File]::WriteAllText($notesFile, $Notes, (New-Object System.Text.UTF8Encoding($false)))
$assetArgs = ($bundles | ForEach-Object { '"' + $_.FullName + '"' }) -join ' '
Run "gh release create $tag $assetArgs --repo $repo --title `"coomwall $tag`" --notes-file `"$notesFile`""

Write-Host "`nReleased $tag." -ForegroundColor Cyan
Write-Host "  https://github.com/$repo/releases/tag/$tag"
