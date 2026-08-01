# Money Map - Release Operations

## Versioning

Money Map uses semantic versioning: `MAJOR.MINOR.PATCH`.

- **MAJOR**: an incompatible persisted-data, public API, or core-workflow change.
- **MINOR**: backward-compatible functionality.
- **PATCH**: backward-compatible fixes and visual corrections.

`0.1.0` is the current pre-1.0 baseline. `apps/desktop/src-tauri/tauri.conf.json` is the sole source of truth. Before either publish build, `scripts/sync-tauri-version.ps1` validates that value and synchronizes the required package metadata:

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

The Tauri value is compiled into the executable and is the authoritative runtime version exposed to the application. Run `.\scripts\sync-tauri-version.ps1 -Check` in automation to verify all copies already agree. A future Settings/About view will display it alongside build channel, source revision, build time, and dependency provenance.

## Build channels

| Channel | Command | Output | Data identity |
| --- | --- | --- | --- |
| Development / Sandbox | `.\\scripts\\publish-tauri-dev.ps1` | `artifacts\\windows\\dev\\MoneyMapDev.exe` | `com.caseybackes.moneymap.dev` |
| Production | `.\\scripts\\publish-tauri-prod.ps1` | `artifacts\\windows\\release\\MoneyMap.exe` | `com.caseybackes.moneymap` |

The development executable includes only Sandbox account-connection handlers. The production executable excludes those handlers.

## GitHub release policy

Generated executables, PDBs, local databases, and credentials do not go in Git. Each public application build should be attached to a GitHub Release tagged as `vMAJOR.MINOR.PATCH`, after clean-build and smoke-test evidence is recorded.

## Release checklist

1. Update `version` in `apps/desktop/src-tauri/tauri.conf.json` only, then run `.\scripts\sync-tauri-version.ps1`.
2. Build the intended channel into its fixed artifact directory.
3. Launch the executable from that artifact directory and verify the version/build channel.
4. Check `git status`, confirm artifacts, databases, and credentials are excluded, then commit source and documentation.
5. Create and push an annotated tag `vMAJOR.MINOR.PATCH`.
6. Create the corresponding GitHub Release and upload the verified executable and checksum file.
