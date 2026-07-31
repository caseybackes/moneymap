# Family Finance — Release Operations

## Scope

These commands produce self-contained, single-file executable artifacts. They do not create an installer, upload a release, or change user financial data.

## Windows distribution artifact

From the repository root on Windows:

```powershell
.\scripts\publish-windows.ps1
```

This targets `win-x64` and writes `FamilyFinance.exe` to `artifacts\windows\win-x64`. The executable is self-contained and does not require a separately installed .NET runtime for an end user.

The publish script uses a fixed output directory and does not delete it. For a formal distribution build, run it in a fresh or versioned workspace so the artifact directory contains only the intended release output.

The publish scripts set `DebugSymbols=false` and `DebugType=None`. A reused fixed output directory can still contain a `.pdb` left by an earlier run, so verify the directory is fresh or inspect it before distributing an artifact.

Verified release hygiene — 2026-07-31: after inspection, stale generated `libHarfBuzzSharp.pdb` and `libSkiaSharp.pdb` files were removed from the canonical Windows artifact directory. `artifacts\windows\win-x64` now contains only `FamilyFinance.exe` (103,944,846 bytes).

## Development build

For a normal local Debug build, run:

```powershell
.\scripts\build-dev.ps1
```

This produces the framework-dependent development executable at `src\FamilyFinance.App\bin\Debug\net10.0\FamilyFinance.exe`. It is not the distribution artifact.

## Linux build artifact

From the repository root on a machine with PowerShell and the required .NET SDK:

```powershell
.\scripts\publish-linux.ps1
```

This targets `linux-x64` and writes a self-contained artifact to `artifacts\linux\linux-x64`. A successful publish establishes Linux build viability. It does not establish Linux runtime support until the artifact is launched successfully on a Linux host.

## Verified state — 2026-07-31

- The original Windows self-contained artifact crashed with a missing native SQLite `e_sqlite3` library. It is not valid release evidence.
- The corrected Windows `win-x64` artifact includes `e_sqlite3.dll` and passed a five-second launch check with no matching .NET Runtime error.
- The corrected Linux `linux-x64` artifact includes `libe_sqlite3.so` and published successfully on the Windows build host.
- The canonical Windows `artifacts\windows\win-x64\FamilyFinance.exe` was republished after daily recurrence verification and passed a five-second launch check; serialized Release tests pass 55/55.
- Temporary `win-x64-next*` verification directories were removed. The canonical Windows release location is `artifacts\windows\win-x64`; the analogous Linux location is `artifacts\linux\linux-x64`.
- Ledger-deletion verification republished the canonical Windows artifact in place; it passed a five-second launch check and serialized Release tests pass 59/59.
- Financial-workflow UI refinement verification republished the canonical Windows artifact in place; it passed a five-second launch check and serialized Release tests pass 63/63.
- Ledger-filtering verification republished the canonical Windows artifact in place; it passed a five-second launch check and serialized Release tests pass 64/64.
- Linux runtime smoke testing remains pending a Linux environment.
- Clean-profile `LocalApplicationData` database initialization is not yet verified; the temporary `LOCALAPPDATA` override used for the attempted check was not honored by .NET.
