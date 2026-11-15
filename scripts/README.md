# scripts

Release scripts (Windows PowerShell 5.1). Run them from the repo root.

| Script | What it does |
| --- | --- |
| `bump-version.ps1 X.Y.Z` | Sets the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the README badge. |
| `release.ps1 X.Y.Z` | Checks, bumps, builds, signs, commits, tags, pushes and creates the GitHub release. `-DryRun` prints the steps without changing anything. `-SkipBuild` releases the source only. |

## Every change that users will see

1. Write it under `## [Unreleased]` in `CHANGELOG.md` in the same commit as the code, under `### Added`, `### Changed` or `### Fixed`.
2. Use plain sentences for users, not commit messages. This text is what the update notice in the app shows.

## Releasing

```powershell
./scripts/release.ps1 1.0.1 -DryRun   # check first
./scripts/release.ps1 1.0.1
```

Pick the number by the size of the change, not by its kind:

- patch (`1.0.1`): fixes, and small additions such as one new setting or option;
- minor (`1.1.0`): a larger feature or a set of changes, such as a new mode or a new panel;
- major (`2.0.0`): breaking changes, such as a settings format that older versions cannot read.

`release.ps1` stops before it changes anything when:

- the git identity is not `kpg-anon <128227694+kpg-anon@users.noreply.github.com>`;
- the tag `vX.Y.Z` already exists;
- `X.Y.Z` is not newer than the version in `package.json`;
- `CHANGELOG.md` has no `## [X.Y.Z]` section and nothing under `## [Unreleased]` (unless `-Notes` is given).

When the entries are still under `[Unreleased]`, the script moves them into a new `## [X.Y.Z] — <today>` section and leaves `[Unreleased]` empty. That section goes into `latest.json` as `notes`. The installed app reads that file on launch, and `UpdateNotice.svelte` shows the notes as the changelog in the update prompt. The same text is the GitHub release body.

Do not run `release.ps1` with a `*>` redirect: under PowerShell 5.1 redirected stderr from `npx` becomes a fatal error.

## Updater signing key

`.tauri-updater.key` and `.tauri-updater.pass` in the repo root (gitignored) sign the updater files. Back them up together. Without them no later build can update existing installs. The public key is in `src-tauri/tauri.conf.json`.
