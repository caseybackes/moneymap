# Family Finance — Product Requirements

## Product intent

Money Map is an installed, local-first desktop application for one person to model and track their finances across many accounts. It targets Windows 10 first and must remain portable to Linux. It is not a web application.

## Confirmed requirements

### Navigation and views

- The application opens on a dashboard.
- An icon-only sidebar navigates between views.
- Calendar and Ledger are separate views.
- The Calendar shows daily income and spending subtotals.
- Calendar values update when relevant transactions or schedules change.
- Selecting a Calendar date shows that date's transactions in a light-dismiss detail flyout; selecting another date switches the detail context.

### Accounts and ledger

- One person can track many accounts, including checking, savings, retirement, investment, tax, and user-defined account types.
- The ledger is the detailed, authoritative transaction record.
- Manual entry is the initial transaction-ingestion path.
- A transaction records date, account, description/payee, amount, category, and optional notes.
- Users can delete a ledger transaction only after explicit confirmation. Deletion must not leave broken schedule, balance-adjustment, or audit relationships.
- Ledger header and transaction rows use aligned full-width table geometry so transaction fields remain scannable.
- Ledger supports non-mutating combined filters for description/payee, category including uncategorized entries, signed amount range, and inclusive date range.
- Each account has an opening balance and a calculated balance derived from its transactions.
- Users can manually update an account balance. The update must retain the entered balance, timestamp, note/reason, and resulting adjustment for auditability.
- A manual balance update creates an explicit adjustment transaction in the authoritative ledger. It records the target entered balance, calculated pre-adjustment balance, adjustment amount, timestamp, and user reason/note.
- A balance adjustment uses the account's ledger balance as of its selected adjustment date and is locked from editing in the Ledger UI as an audit entry.

### Categories and AI assistance

- Users maintain preferred categories.
- An LLM may normalize payee/description data and suggest categories.
- AI suggestions require user approval before changing financial records.
- A manual transaction may remain uncategorized pending user review or an AI suggestion; when a category is selected, it must refer to a user-maintained category.

### Scheduled transactions

- Users can create future scheduled transactions.
- The app can recognize recurring transactions and suggest a schedule.
- Scheduled transactions contribute to future calendar totals and financial projections.
- User-created schedules support daily, weekly, and monthly recurrence, optional end dates, and skipping individual occurrences.
- Users can edit schedules. Recording an occurrence retains a session-only Added row in the schedule view until the user navigates away.
- Add and Edit transaction dialogs can atomically persist the current transaction and create a repeat schedule; the schedule begins with the next recurrence so the current entry is not duplicated.
- A user can explicitly post one scheduled occurrence into the ledger. The posted occurrence is linked to its schedule and removed from future scheduled totals so it is counted exactly once. The app does not automatically match or post occurrences.
- The app can locally suggest a repeat schedule from clear posted-transaction patterns. It never creates a schedule silently; the user explicitly accepts a suggestion and may set an optional end date.

### Scenarios and analysis

- What-if modeling is a numerical scenario system using structured edits to financial inputs.
- Scenarios recalculate projected calendar totals, ledger entries, and balances.
- Scenarios do not alter the real ledger.
- AI analysis, when present, interprets calculated scenario results; it is not the scenario input interface.
- The initial scenario UI supports structured monthly income, spending, contribution, one-time, and horizon inputs. Its projection remains isolated from the ledger. Calendar/ledger scenario overlays and AI analysis remain future work.
- Financial analysis is the primary product value. Ingestion through manual entry, statement files, or connected accounts exists to build a trustworthy local financial picture for analysis.
- Money Map's long-term planning target is a deep financial copilot: it synthesizes a user's banking, debt, credit, insurance, investments, retirement, taxes, benefits, and stated goals into a small number of materially important planning opportunities.
- The AI planning experience should prepare a decision-ready first-pass plan: what matters, the cross-domain connection, relevant evidence, assumptions, estimated numerical impact where possible, open questions, and the appropriate professional review when needed.
- The product prioritizes meaningful financial strategy over superficial spending prompts. Every suggested action or research question must be tied to the user's financial picture and allow drill-down to its source records.
- The analysis roadmap includes explainable merchant clustering, category proposals, category and cash-flow trends, recurring/outlier detection, and drill-down from every insight to underlying records.
- A later opportunity-analysis layer may assess user-provided account, insurance, and tax information for potential savings or tax-impact questions. It must show evidence, assumptions, uncertainty, and require review; it never makes financial decisions or changes automatically.

### Data and platform constraints

- Financial data is stored locally in an encrypted SQLCipher database.
- Sandbox Plaid Link is permitted for development. It uses an owner-controlled Plaid dashboard account, encrypted broker-side token handling, and encrypted local connection metadata. Real-bank connection remains gated on Sandbox verification, review-before-import, consent, and disconnect behavior.
- Development and production are separate build/deployment environments. Development is Sandbox-only; production cannot contain Sandbox credentials, routes, or reset tools. They use separate Worker deployments and local application data identities.
- Disconnecting an institution removes the linked access token and all imported account/transaction records associated with that institution from the local database. Reconnection imports a fresh current data set.
- The implementation stack is React, Tauri/Rust, SQLCipher, and optional purpose-specific Cloudflare Workers for external connection credential boundaries. Plaid covers supported bank aggregation; TradeStation is a direct, read-only brokerage connector. The legacy Avalonia app remains the behavioral reference during migration.
- The Investment view is the portfolio home for brokerage and retirement account context. Its first direct connector is TradeStation, limited to `ReadAccount` and `MarketData` OAuth scopes; it has no order-placement capability. Principal and other supported retirement providers remain candidates for Plaid Investments after production coverage is verified.
- Money is persisted as integer cents.

## Explicitly out of scope for the foundation

- Bank aggregation, OAuth, and other direct institution connections.
- Statement import; the first ingestion workflow is manual transaction entry.
- An LLM chat interface for constructing financial scenarios.

## Open product decisions

1. Dashboard information hierarchy and interactions beyond being the landing view.
2. Category hierarchy beyond the initial flat preferred-category list.
3. Scenario overlays for calendar, ledger, and scheduled transactions; later AI analysis of a completed numerical scenario.
4. Backup/restore experience and LLM data-sharing/privacy controls.
