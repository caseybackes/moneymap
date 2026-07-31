# Family Finance — Developer Guide

## Solution map

```text
FamilyFinance.sln
src/
  FamilyFinance.App/       Avalonia desktop UI and local application startup
  FamilyFinance.Domain/    Money, ledger, schedules, projections, and deterministic rules
  FamilyFinance.Data/      SQLite schema, migrations, and repositories
  FamilyFinance.AI/        Provider-neutral suggestion contracts only
tests/
  FamilyFinance.Domain.Tests/  Domain, persistence, and Avalonia headless workflow tests
scripts/
  build-dev.ps1            Framework-dependent local Debug build
  publish-windows.ps1      Self-contained Windows publish (win-x64)
  publish-linux.ps1        Self-contained Linux cross-publish (linux-x64)
docs/                      Product, architecture, milestones, release, and project records
```

## Local development commands

The repository pins the SDK in `global.json`; `.tooling\dotnet\dotnet.exe` is used when available.

```powershell
# Build a normal local Debug executable.
.\scripts\build-dev.ps1

# Run the full serialized test suite.
.\.tooling\dotnet\dotnet.exe test FamilyFinance.sln --configuration Release --no-restore --maxcpucount:1

# Publish the self-contained Windows release artifact.
.\scripts\publish-windows.ps1

# Cross-publish the self-contained Linux artifact.
.\scripts\publish-linux.ps1
```

If `.tooling\dotnet\dotnet.exe` is absent, use a compatible `dotnet` SDK on `PATH`.

Development output is framework-dependent at `src\FamilyFinance.App\bin\Debug\net10.0\FamilyFinance.exe`. The canonical Windows release output is `artifacts\windows\win-x64\FamilyFinance.exe`; Linux output is `artifacts\linux\linux-x64`.

## Local data and constraints

- The application database is local SQLite at `%LOCALAPPDATA%\FamilyFinance\family-finance.db`.
- Financial data is local-first. There is no current bank connection, import path, telemetry, cloud storage, or AI provider call.
- Use `decimal` for money. The ledger and deterministic Domain calculations are authoritative.
- Never put database files, tokens, generated release artifacts, or `.tooling` content into source control. These paths are ignored.
- Current release validation has not proven first-run database initialization under an isolated Windows user profile; see R-007 in [PROJECT-LOG.md](PROJECT-LOG.md).

## Documentation map

- [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md): confirmed behavior and unresolved product decisions.
- [ARCHITECTURE.md](ARCHITECTURE.md): boundaries and accepted architecture decisions.
- [MILESTONES.md](MILESTONES.md): acceptance criteria and delivery status.
- [PROJECT-LOG.md](PROJECT-LOG.md): verification history, risks, and technical debt.
- [RELEASE.md](RELEASE.md): development/release artifact commands and verification boundaries.

## Worktree norms

- Keep product, architecture, milestone, and project-log documentation aligned with implementation evidence.
- Treat existing changes as owned unless your task clearly covers them. Do not reset, clean, or delete broad paths to obtain a build.
- Use `build-dev.ps1` for ordinary local work. Release publishing writes to fixed artifact paths; build formal release artifacts from a fresh or versioned workspace, or inspect the output directory for stale files before distribution.
- Do not rely on a running executable as proof of a newly built artifact. Record the exact artifact path used for launch verification.
- Run the serialized test command for changes that affect persistence, financial calculations, or desktop workflows. Record actual test/build/launch evidence in the relevant milestone and project log.
