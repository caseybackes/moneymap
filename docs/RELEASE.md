# Money Map - Release Operations

## Versioning

Money Map uses semantic versioning: `MAJOR.MINOR.PATCH`.

- **MAJOR**: an incompatible persisted-data, public API, or core-workflow change.
- **MINOR**: backward-compatible functionality.
- **PATCH**: backward-compatible fixes and visual corrections.

`0.2.0` is the current pre-1.0 family-beta packaging baseline. `apps/desktop/src-tauri/tauri.conf.json` is the sole source of truth. Before either publish build, `scripts/sync-tauri-version.ps1` validates that value and synchronizes the required package metadata:

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

The Tauri value is compiled into the executable and is the authoritative runtime version exposed to the application. Run `.\scripts\sync-tauri-version.ps1 -Check` in automation to verify all copies already agree. Settings/About displays it alongside build channel, source revision, build time, runtime provenance, and local schema state. The Production publisher resolves the source revision before compilation so an artifact can be tied to its exact commit.

## Build channels

| Channel | Command | Output | Data identity |
| --- | --- | --- | --- |
| Development / Sandbox | `.\\scripts\\publish-tauri-dev.ps1` | `artifacts\\windows\\dev\\MoneyMapDev.exe` | `com.caseybackes.moneymap.dev` |
| Production | `.\\scripts\\publish-tauri-prod.ps1` | `artifacts\\windows\\release\\MoneyMap.exe`, `MoneyMap-<version>-setup.exe`, and `release-manifest.json` | `com.caseybackes.moneymap` |

The development executable includes only Sandbox account-connection handlers. The production executable excludes those handlers.

Linux uses the same application source but has no packaging or runtime-validation workflow yet. That work is intentionally deferred and tracked in [BACKLOG.md](BACKLOG.md#linux-delivery-deferred).

## GitHub release policy

Generated executables, PDBs, local databases, and credentials do not go in Git. Each public application build should be attached to a GitHub Release tagged as `vMAJOR.MINOR.PATCH`, after clean-build and smoke-test evidence is recorded.

Run `node .\scripts\verify-public-release.mjs` before every push and publish. The gate scans the complete reachable Git history and visible working tree for forbidden financial exports, databases, credentials, private-key material, generated artifacts, and unexplained blobs over 5 MiB. It reports finding classes and paths without printing matched values. It also requires each tracked financial fixture to declare itself synthetic and carry a verified SHA-256 manifest.

The Production NSIS installer is current-user scoped and does not require administrator access for the Money Map installation. It keeps the stable Production application identifier across upgrades, creates normal Start Menu and uninstall entries, blocks downgrades, and embeds Microsoft's WebView2 bootstrapper so a missing runtime can be installed with visible status. The installer and uninstaller own application files only; profile databases, Windows Credential Manager records, backups, and pre-restore archives remain outside the installation directory and are preserved.

Every Production publish emits `release-manifest.json` with the semantic version, exact source revision, build epoch, artifact byte sizes, and SHA-256 hashes. Use [WINDOWS-INSTALLER-VALIDATION.md](WINDOWS-INSTALLER-VALIDATION.md) to qualify a build on a clean Windows environment before family distribution.

Production publishing requires a clean Git worktree and an unlocked destination `MoneyMap.exe`; this prevents a new artifact from claiming the wrong source revision and prevents overwriting an executable that is running. After publishing, run `.\scripts\verify-windows-release.ps1` to recompute every recorded hash and verify the executable version. Installer signing remains part of the signed-update work and is required before remote family distribution.

For isolated build validation while the current portable Production app is running, pass a separate ignored artifact directory with `-ReleaseDirectory`; the default remains `artifacts\windows\release`.

Install the repository-managed pre-push hook once per clone:

```powershell
git config core.hooksPath .githooks
```

GitHub runs the same checked-in scanner against a full-history checkout. The Production publisher invokes it before compiling a release artifact.

## Release checklist

1. Run `node .\scripts\verify-public-release.mjs`; stop on any finding and inspect it without copying a matched value into discussion or CI logs.
2. Update `version` in `apps/desktop/src-tauri/tauri.conf.json` only, then run `.\scripts\sync-tauri-version.ps1`.
3. Build the intended channel into its fixed artifact directory.
4. Launch the executable from that artifact directory and verify the version/build channel.
5. Check `git status`, confirm artifacts, databases, and credentials are excluded, then commit source and documentation.
6. Create and push an annotated tag `vMAJOR.MINOR.PATCH`.
7. Create the corresponding GitHub Release and upload the verified executable and checksum file.
