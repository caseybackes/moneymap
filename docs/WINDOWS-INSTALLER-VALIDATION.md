# Windows installer validation

## Purpose

Qualify a versioned Money Map Production installer on a disposable, clean Windows user or VM without touching the maintainer's live Production profile. Keep screenshots and notes out of Git if they contain user names or machine paths; record only categorical results, version, source revision, and artifact hashes in Linear.

## Inputs

- The previous qualified `MoneyMap-<previous-version>-setup.exe`, when testing an upgrade.
- The candidate `MoneyMap-<version>-setup.exe`.
- The candidate `MoneyMap.exe` portable executable.
- The candidate `release-manifest.json`.

Verify both artifact SHA-256 values against the manifest before installation. Use a normal non-administrator Windows user with network access so the embedded WebView2 bootstrapper can obtain the Evergreen runtime if it is absent.

Run `.\scripts\verify-windows-release.ps1` on the build machine before copying these inputs. The current 0.2.0 installer is unsigned; do not distribute it remotely until ID-120 adds and verifies code signing.

## Clean install and persistence

1. Confirm Money Map is absent from Installed apps and the Start Menu.
2. Run the candidate installer without elevation. Confirm the installer reports WebView2 progress or errors visibly if the runtime is missing.
3. Confirm the Money Map Start Menu entry and Installed apps/uninstall entry exist.
4. Launch Money Map, confirm Settings → About & support shows the candidate version and source revision, and allow the encrypted local profile to initialize.
5. Create one disposable manual account and transaction; do not connect a real financial institution for installer validation.
6. Close and reopen Money Map. Confirm the disposable record remains and About reports a readable, current profile schema.

## Upgrade and failed-install rollback

1. Begin from the previous qualified version with the disposable profile above.
2. Run a deliberately interrupted candidate installation in a disposable VM snapshot, then relaunch the previous installation. Record whether Windows restored the prior executable and whether the profile still opens. Revert the VM snapshot after this destructive rehearsal.
3. Run the intact candidate installer. Confirm it upgrades the existing Installed apps entry instead of creating a duplicate.
4. Launch the candidate. Confirm the version/revision changed and the disposable account, transaction, encrypted profile, backup inventory, and pre-restore archives remain available.
5. Attempt to install the previous qualified installer over the candidate and confirm downgrade protection rejects it.

## Uninstall preservation

1. Create an encrypted backup in the candidate version and record only that it exists.
2. Uninstall Money Map from Installed apps.
3. Confirm the Start Menu and Installed apps entries are removed.
4. Confirm the profile database, Windows Credential Manager material, encrypted backups, and pre-restore archives remain. Do not copy their values or paths into Git or Linear.
5. Reinstall the same candidate and confirm the existing disposable profile opens without data loss.

## Release record

Record in ID-122:

- Windows edition/build and whether WebView2 was initially present;
- previous and candidate versions;
- source revision and manifest SHA-256 values;
- pass/fail for clean install, launch, reopen, interrupted-install rollback, upgrade, downgrade rejection, uninstall preservation, and reinstall;
- any categorical blocker without user names, local paths, credentials, or financial values.
