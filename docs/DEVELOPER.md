# Money Map — Developer Guide

## Repository map

```text
apps/desktop/                 React renderer and Rust/Tauri desktop command layer
services/plaid-broker/        Cloudflare Worker for Plaid connection credentials
services/tradestation-broker/ Cloudflare Worker for TradeStation OAuth credentials
scripts/                      Fixed-output build and version tools
docs/                         Requirements, backlog, release, and test records
```

The desktop command layer owns SQLCipher access and retrieves its per-install database key from the operating-system credential store. The React renderer never receives the key or opens the database directly.

## Desktop development

```powershell
cd apps/desktop
npm install
npm run build
npm run tauri dev
```

Use the bundled Node runtime if the system Node installation is unavailable or too old:

```powershell
$node24 = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node24 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' run build
```

Build fixed development and release artifacts with:

```powershell
.\scripts\publish-tauri-dev.ps1
.\scripts\publish-tauri-prod.ps1
```

Do not create timestamped artifact folders. The development executable is always replaced at `artifacts\windows\dev\MoneyMapDev.exe`; the production executable is always replaced at `artifacts\windows\release\MoneyMap.exe`.

## Current boundaries

- Financial records are local-first and encrypted with SQLCipher.
- Provider credentials never enter the desktop database as plaintext. Purpose-specific Cloudflare Workers retain only encrypted provider tokens necessary for synchronization.
- Development and production are separate builds and deployments. Development is Sandbox-only; production must contain no Sandbox credentials, routes, reset tools, or labeling.
- Money is persisted as integer cents. Do not introduce JavaScript floating point at a persistence boundary.
- Do not commit databases, provider tokens, generated artifacts, `.wrangler/`, `node_modules`, or `.tooling` content.

## Native finance capabilities

Agent-facing finance reads live in the Rust `finance_tools` module and remain independent of Tauri or MCP transport details. The first slice provides a versioned capability registry, actor/scope authorization, bounded transaction and schedule searches, and evidence-producing recurring detection. Tauri commands are thin adapters over those functions.

These commands use an existing-profile-only SQLCipher opener. It refuses a missing database or credential, opens with `SQLITE_OPEN_READ_ONLY`, enables `PRAGMA query_only`, and never creates directories, databases, keys, or migrations. The older renderer commands still use the migration-capable application connection until they are deliberately moved behind the same application-service boundary.

The proposed contracts, threat model, and MCP adapter decision are under [`docs/ai-tools/`](ai-tools/). MCP remains a later optional stdio adapter over the native registry; it does not own financial domain logic.

Schedule mutations use schema migration 11 and the persisted lifecycle described in [`docs/ai-tools/PROPOSAL-LIFECYCLE.md`](ai-tools/PROPOSAL-LIFECYCLE.md). Keep confirmation out of agent-facing registries: only the native user-confirmation adapter may mint the two-minute artifact bound to the profile, proposal version, and effect digest. Execution must remain one immediate transaction covering precondition checks, schedule mutation, artifact consumption, audit, and idempotent outcome.

The delivered native recurring-bill path and its versioned synthetic fixture are documented in [`docs/ai-tools/RECURRING-BILL-VERTICAL-SLICE.md`](ai-tools/RECURRING-BILL-VERTICAL-SLICE.md). Verify the fixture manifest from the repository root with `node .\scripts\verify-recurring-bill-fixture.mjs`. The native path has no model, MCP, memory, Plaid, Worker, or Production-profile dependency.

## Tests

From `apps/desktop/src-tauri`:

```powershell
cargo test --features sandbox-dev
```

From `services/plaid-broker`:

```powershell
npm test
```

These tests use only local fixtures and do not open Plaid Link or consume a provider connection slot.

## Documentation map

- [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md): confirmed behavior and product constraints.
- [BACKLOG.md](BACKLOG.md): planned work and accepted design decisions.
- [RELEASE.md](RELEASE.md): versioning and release operations.
- [TESTING.md](TESTING.md): current regression matrix.
- [../services/tradestation-broker/README.md](../services/tradestation-broker/README.md): TradeStation OAuth broker setup and security model.

## TradeStation Dev/SIM OAuth

The Dev build can initiate TradeStation SIM authorization from **Investments** or **Settings**. It talks only to the separately deployed `money-map-tradestation-sim-broker` Worker and its dedicated D1 database; it must never reuse the production broker. The external setup key is entered once and held by Windows Credential Manager. It is never written to the local database or source tree. Money Map reserves `localhost:31022` for one callback for up to ten minutes, sends the authorization code to the dedicated Worker, and saves only the resulting broker connection key in Windows Credential Manager. The Worker keeps the provider client secret and encrypted refresh token. This authorizes a connection only; portfolio synchronization remains future work.
