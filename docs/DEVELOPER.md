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

## React/Tauri migration

The replacement desktop client is at `apps/desktop`. It is a React renderer with a Rust/Tauri local command layer. The command layer owns SQLCipher access and retrieves its per-install database key from the operating system credential store; the renderer cannot access the key or database file directly.

```powershell
cd apps/desktop
npm install
npm run build

# In a shell where Rust/Cargo and Strawberry Perl are on PATH.
npm run tauri dev
```

The existing Avalonia application remains the released behavioral reference until the React/Tauri client reaches feature parity. Do not migrate real-user data automatically during this stage.

### Current React/Tauri capabilities

- SQLCipher local database at the Tauri app-local data directory; the database key is held in the OS credential store.
- Dashboard, account cards, manual balance adjustments, ledger create/edit/delete/filter/pagination, calendar popover/swipe navigation, scheduled record/skip/edit, and numerical scenario modeling.
- Sandbox Plaid Link only. The Cloudflare broker encrypts the Plaid access token and the desktop database stores a per-connection broker key inside SQLCipher. Do not test a real bank connection until the Sandbox Link flow has been manually verified and its review/disconnect lifecycle is complete.

### Required Sandbox Link validation

Run this against the canonical development executable before any production or Trial Item is considered:

1. In **Accounts**, choose **Connect Sandbox account** and complete the official Plaid Link window with a Sandbox institution.
2. Confirm the returned account cards and transactions appear once; an older First Platypus fixture import must be adopted rather than duplicated.
3. Use **Sync connected accounts** and confirm it completes without losing local manual entries.
4. Confirm the connected institution is listed in Accounts, then use **Disconnect** and verify the local transaction history remains while future sync is unavailable.
5. Restart the app and confirm the encrypted local database opens normally. This demonstrates that the desktop connection key survives only in the local encrypted store.

Record the result in the project log before requesting or using a real-bank connection.

Use the bundled current Node runtime when the system Node version is too old for the Tauri/Wrangler toolchain:

```powershell
$node24 = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node24 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run build

# Build and replace the one canonical React/Tauri dev executable.
.\scripts\publish-tauri-dev.ps1
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

The React/Tauri dev executable is always replaced in `artifacts\windows\dev\FamilyFinance.exe`. Do not create timestamped or per-build artifact folders.

## Local data and constraints

- The Avalonia database remains at `%LOCALAPPDATA%\FamilyFinance\family-finance.db`; the React/Tauri database is a separate encrypted `family-finance-v2.db` in its app-local data directory. It is intentionally not migrated automatically.
- Financial data is local-first. Connected-account credentials are isolated in purpose-specific Cloudflare brokers: Plaid for bank aggregation and TradeStation for the direct read-only brokerage connection. Each broker stores only encrypted provider tokens and never holds the local database.
- The React/Tauri app represents money as integer cents. Avoid JavaScript floating-point values at persistence boundaries.
- Never put database files, tokens, generated release artifacts, or `.tooling` content into source control. These paths are ignored.
- Current release validation has not proven first-run database initialization under an isolated Windows user profile; see R-007 in [PROJECT-LOG.md](PROJECT-LOG.md).

## Documentation map

- [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md): confirmed behavior and unresolved product decisions.
- [ARCHITECTURE.md](ARCHITECTURE.md): boundaries and accepted architecture decisions.
- [MILESTONES.md](MILESTONES.md): acceptance criteria and delivery status.
- [PROJECT-LOG.md](PROJECT-LOG.md): verification history, risks, and technical debt.
- [RELEASE.md](RELEASE.md): development/release artifact commands and verification boundaries.
- [../services/tradestation-broker/README.md](../services/tradestation-broker/README.md): TradeStation OAuth broker security model and operator setup.

### TradeStation Dev/SIM OAuth

The Dev build can initiate a TradeStation SIM authorization from **Investments** or **Settings**. It talks only to the separately deployed `money-map-tradestation-sim-broker` Worker and its dedicated D1 database; it must never reuse the production broker. The `EXTERNAL_SETUP_KEY` is entered once and held by Windows Credential Manager; it is never written to the local database or source tree. Money Map reserves `localhost:31022` for one callback for up to ten minutes, sends the authorization code to the dedicated Worker, and saves only the resulting broker connection key in Windows Credential Manager. The Worker keeps the provider client secret and encrypted refresh token. This authorizes a connection only; no portfolio synchronization endpoint exists yet.

## Worktree norms

- Keep product, architecture, milestone, and project-log documentation aligned with implementation evidence.
- Treat existing changes as owned unless your task clearly covers them. Do not reset, clean, or delete broad paths to obtain a build.
- Use `build-dev.ps1` for ordinary local work. Release publishing writes to fixed artifact paths; build formal release artifacts from a fresh or versioned workspace, or inspect the output directory for stale files before distribution.
- Do not rely on a running executable as proof of a newly built artifact. Record the exact artifact path used for launch verification.
- Run the serialized test command for changes that affect persistence, financial calculations, or desktop workflows. Record actual test/build/launch evidence in the relevant milestone and project log.
