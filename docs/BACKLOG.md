# Money Map — Product and UX Backlog

This is a decision and implementation queue. Items are intentionally recorded before a build pass; no item is an authorization to change behavior without its stated decision being made.

## Current UI pass

- [ ] **First-launch dashboard action** — When there are no accounts, the Dashboard `Accounts & cards` widget shows the same compact `Connect new account` card used on the Accounts view. In the dev build, it opens Sandbox Link; production opens the production connection flow when that flow is enabled.
- [ ] **First-run onboarding** — Add a brief, dismissible first-run sequence after the first-launch dashboard is useful on its own. It should explain local encrypted storage, connecting an account versus manual entry, and where to find the ledger/calendar. It must never block normal use or require a financial connection.
- [ ] **Sticky navigation rail** — Keep navigation available while a dashboard or long account list scrolls. The rail stays fixed within the app window and the content pane scrolls independently.
- [ ] **Initial window geometry** — Increase the default desktop window size and define a practical minimum size so the dashboard and account grid do not begin constrained.
- [ ] **Calendar day detail** — Restore an anchored, light-dismiss popover next to the selected day cell. Preserve a consistent popup width and truncate long descriptions; selecting another date replaces it and clicking elsewhere closes it.
- [ ] **Schedule editor layout** — Replace the tall form treatment with a compact dialog: Starts and Ends on one row; Amount and Repeats on one row; retain an accessible single-column layout at narrow widths.
- [ ] **First-party confirmations** — Replace browser-native confirmation prompts (currently headed `tauri.localhost says:`) with an app-styled confirmation dialog. Apply this consistently to disconnect and destructive actions.
- [ ] **Account-card disclosure** — Clicking an account card should reveal its detail/options panel. Keep `Update balance` out of the default card surface and show it only in that selected state.
- [ ] **Navigation visual direction** — Decide between a refined fixed side rail and top tabs before restructuring navigation. Adopt a coherent free icon set with clear labels/tooltips; candidate implementation source: Lucide (MIT).
- [ ] **Settings and About** — Add a Settings route with persisted user preferences, initially font-size selection and an About/build-information panel. Build information shows product version, build channel (`Dev` or `Production`), build timestamp/commit where available, desktop/runtime versions, and key dependency versions relevant to support.

## Product decisions needed

- [x] **Disconnect visibility and retention** — Disconnecting an institution removes all of its imported accounts and transaction data from the local database and therefore from every app view. Reconnecting retrieves a fresh copy from Plaid. A future implementation must explicitly resolve any user-created data attached to an imported account before deletion.
- [ ] **Dashboard range widget** — The period controls work, but the period-summary card has excess whitespace. Revisit when analytics widgets are available, adding compact context such as category trend, cash-flow delta, or a period comparison rather than filler.
- [x] **App name** — **Money Map** is the product name. Rename visible application, documentation, and broker branding without changing the established local-data identifier until an explicit data-migration plan is in place.

## Plaid reliability and data integrity (build deferred)

- [ ] **Duplicate-Link prevention** — For one independent local profile per installation, use Link's selected-account metadata plus institution ID to identify an already-linked selected account set *before* public-token exchange. On a match, sync/render the existing connection and report `Already connected`; do not create a second Item.
- [ ] **Database backstop** — Persist institution ID and a deterministic selected-account fingerprint in the encrypted local database, with uniqueness enforced atomically. Keep current per-connection transaction idempotency; do not introduce unsafe global transaction-ID deduplication.
- [ ] **Connection cleanup semantics** — Normal disconnect removes one connection's imported local accounts and transactions. A developer reset may clear all Sandbox data. Its availability must be restricted to the dev build.
- [ ] **Test matrix** — Cover repeat Link, two distinct institutions with identical Sandbox fixtures, repeated sync/startup, disconnect deletion, selected cleanup, and concurrency/race failure.

## Environment boundary (decision and implementation design)

- [ ] **Two deployments, two app configurations** — Dev uses a Sandbox-only Worker deployment, Sandbox credentials, development bundle identifier/data directory, and a visible `Development / Sandbox` marker. Production uses a separate Worker deployment, production-only credentials, production bundle identifier/data directory, and has no Sandbox bootstrap/reset route compiled into the app. This is build configuration, not a runtime toggle.
- [ ] **No credential crossover** — A production build rejects Sandbox endpoints and Sandbox Link tokens; a dev build has no production broker URL or production secret path. CI/build validation fails if environments are crossed.

## Release identity and versioning

- [ ] **Semantic versioning** — Use `MAJOR.MINOR.PATCH` from `0.1.0` onward. Increase MAJOR only for incompatible persisted-data, API, or user-workflow changes; MINOR for backward-compatible features; PATCH for backward-compatible fixes and visual corrections.
- [ ] **Version provenance** — Generate a build-info record at publish time. It carries the semantic version, channel, build UTC timestamp, source commit, Rust/Tauri/React/Node versions, and a dependency-lockfile fingerprint. Surface it read-only in Settings/About and include it in diagnostics without exposing secrets or financial data.
- [ ] **Settings storage** — Persist user preferences in the local encrypted application database or a dedicated local settings store under the application-data directory. User settings are runtime data, never source files.

## Analytics as the primary product value

Data connection and manual entry are ingestion paths. The product's central value is a trustworthy analysis layer over the user's complete financial picture.

- [ ] Cluster merchant/payee variants and show explainable category proposals that learn from explicit user corrections.
- [ ] Show category spending, income, cash flow, and trends over selectable time ranges with drill-down to the underlying transactions.
- [ ] Detect recurring payments, unusual changes, and emerging spend patterns with evidence and user approval before any record changes.
- [ ] Keep what-if modeling numerical and structured; provide AI interpretation only after the scenario calculation is complete.
- [ ] Later: offer evidence-backed financial opportunity analysis across user-provided account, insurance, and tax information: possible savings, coverage gaps, and tax-impact questions. Present assumptions, confidence, and caveats; require user review and never perform an action automatically.
- [ ] Define the privacy/consent model before any external AI receives financial data. Preserve local-first operation when no provider is configured.
