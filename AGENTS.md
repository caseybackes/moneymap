# Money Map agent handoff

This file is the compact orientation for agents entering this repository without the long project conversation. The parent `AGENTS.md` in `GeneralStuff` also applies.

## Read first

Use these sources in this order:

1. `docs/PRODUCT-REQUIREMENTS.md` - product behavior and durable decisions.
2. `docs/DEVELOPER.md` - architecture, security boundaries, and commands.
3. `docs/BACKLOG.md` - longer-range roadmap; check it for staleness before implementing.
4. `docs/TESTING.md` - test matrix and environment checks.
5. `docs/RELEASE.md` - versioning and packaging.
6. Linear project **Money Map App** - authoritative source for active work, priority, decisions, and closure evidence.

When local prose and an active Linear issue conflict, inspect the issue history and recent code before choosing a direction. Update the durable source when the decision is settled.

## Product in one paragraph

Money Map is a native desktop personal-finance intelligence application. It is Windows-first, with Linux planned later; it is not a browser application. The app is local-first and keeps financial records in an encrypted SQLCipher database on the user's computer. Plaid provides optional account and transaction synchronization through a minimal Cloudflare Worker broker. Manual accounts and transactions remain supported. The long-term value is numerical modeling and cross-domain financial intelligence across banking, credit, investments, taxes, insurance, and goals; AI should explain and surface analysis grounded in the numbers rather than inventing financial scenarios.

## Repository map

- `apps/desktop/` - shared React UI plus Rust/Tauri desktop command layer.
- `services/plaid-broker/` - Cloudflare Worker for Plaid Link, token custody, and synchronization.
- `services/tradestation-broker/` - separate TradeStation OAuth Worker; portfolio sync is not complete.
- `scripts/` - fixed-output build and version tooling.
- `docs/` - product, developer, testing, release, and backlog documentation.
- `artifacts/windows/dev/` - replace-in-place development executable.
- `artifacts/windows/release/` - replace-in-place production executable.

Do not create timestamped or incrementally named build directories.

## Non-negotiable boundaries

- The Rust/Tauri layer owns SQLCipher access and OS credential storage. Never expose the database key to React.
- Store money as integer cents. Do not persist JavaScript floating-point currency values.
- Provider secrets and access tokens must not be stored as plaintext in the local database or committed to Git.
- Development and production are separate compiled environments:
  - dev is Sandbox-only and uses `com.caseybackes.moneymap.dev`;
  - prod uses `com.caseybackes.moneymap` and must reject Sandbox routes, credentials, reset tools, Link tokens, and labeling.
- Keep one shared UI and command implementation wherever possible; use explicit compile-time/environment boundaries for Sandbox-only behavior.
- Each person uses an independent local installation and local profile. Do not design a shared household login or conflate Windows users with joint bank accounts.
- Disconnecting or excluding an institution/account should remove its accounts and transactions from app views and local analysis. Plaid can restore provider data after reconnection; warn when related manual records will also be deleted.
- Do not commit databases, credentials, generated executables, `node_modules`, `.wrangler`, `.tooling`, or `.tooling-home`.

## UX direction

- Prefer dense, concise financial surfaces over oversized controls, empty cards, and large form-like layouts.
- Use compact inline icon actions, disclosure rows, and overflow menus for secondary actions. Obvious icons do not need verbose browser tooltips.
- Reserve primary navigation for first-class workflows. Categories are configuration/context, not a first-class page.
- Dashboard content should be modular, widget-based, and visualization-led. Charts and analysis belong above supporting transaction/account lists.
- Avoid unnecessary vertical growth and dead grid space. Favor responsive grids, bounded widgets, concise rows, and deliberate "show more" behavior.
- Navigation stays fixed while content scrolls. The document scrollbar belongs at the actual right edge of the window at every resized width.
- Popovers must close on outside click. Calendar day details should anchor consistently directly below the selected date.
- Any network or synchronization operation needs visible progress; never freeze the UI or leave a click apparently unanswered.
- Use user-facing language such as "Connect new account" and "As of," not provider/developer terminology such as "Open Plaid Link" or "Last refreshed."

## Build and test

From `apps/desktop`:

```powershell
npm install
npm run build
npm run tauri dev
```

Fixed-output Windows builds from the repository root:

```powershell
.\scripts\publish-tauri-dev.ps1
.\scripts\publish-tauri-prod.ps1
```

Expected executables:

- `artifacts\windows\dev\MoneyMapDev.exe`
- `artifacts\windows\release\MoneyMap.exe`

Relevant verification:

```powershell
Set-Location apps\desktop\src-tauri
cargo test --features sandbox-dev
cargo check --quiet
cargo check --quiet --features sandbox-dev

Set-Location ..\..\..\services\plaid-broker
npm test
```

Use the bundled Node fallback documented in `docs/DEVELOPER.md` if the system Node installation is unsuitable.

## Worktree safety

Assume the worktree can contain intentional user or agent changes. Before editing:

1. Run `git status --short`.
2. Inspect overlapping diffs.
3. Preserve unrelated work.
4. Do not reset, discard, bulk-format, or commit everything blindly.
5. Use `apply_patch` for source edits.

Build artifacts are disposable; local production financial data is not. Never wipe a production database unless the user explicitly identifies the exact data and authorizes deletion.

## Current planning snapshot

- Linear is authoritative for current task state; do not encode a transient dirty-worktree snapshot in this file.
- **ID-12** remains the parent for Production backup, recovery, revocation, reset, and integrated safety work. Its children must be implemented and verified individually before closure.
- **ID-11** remains the account-scoped Plaid validation and Production-promotion task. Local implementation does not substitute for its packaged-Dev and existing-Production verification steps.
- **ID-81** is the analytical-dashboard foundation. A balance-history primitive alone does not satisfy its two-chart outcome or complete its verification matrix.
- **ID-91** remains the broader finance-chat architecture task. The native recurring-bill slice is complete; MCP, model, memory, and skill layers are deferred.
- `rustfmt` was unavailable in the current Rust toolchain. Do not install or broadly reformat merely to hide that gap.

## Working style

- Diagnose from code, logs, persisted state, and provider behavior before patching.
- Look beyond the visible symptom for lifecycle, ordering, idempotency, and environment-boundary failures.
- Keep Linear updated with outcome, evidence, deferrals, and negative knowledge when work changes state.
- Implement and validate in dev first, then deliberately carry applicable shared changes into production without Sandbox residue.
