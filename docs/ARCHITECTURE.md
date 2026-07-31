# Family Finance — Architecture Baseline

## System boundaries

The desktop application owns local presentation, financial rules, and persistence. The ledger and deterministic calculation engine are authoritative. AI is an optional, isolated assistant that returns proposals for user review; it never writes a transaction directly.

## Proposed project structure

```text
src/
  FamilyFinance.App/       Avalonia desktop executable and view models
  FamilyFinance.Domain/    Ledger, account, schedule, scenario, and calculation rules
  FamilyFinance.Data/      SQLite schema, migrations, repositories, backup support
  FamilyFinance.AI/        AI provider boundary and suggestion contracts
tests/
  FamilyFinance.Domain.Tests/
  FamilyFinance.Data.Tests/
```

## Architectural rules

- UI code does not calculate balances, calendar totals, or scenario outcomes.
- Domain logic uses `decimal` for currency values and is covered by automated tests.
- SQLite is the sole authoritative persistent store. Schema changes are versioned migrations.
- A scenario references base data plus structured overrides and produces derived results without persisting changes to the real ledger.
- Audit-relevant balance updates retain the prior/calculated state, entered target balance, generated adjustment, timestamp, and user note.
- Data access and future AI integrations are replaceable boundaries around the domain model.
- Network access is not required for core use. Any future AI request must have an explicit user-controlled disclosure and approval path.

## Initial data concepts

`Account`, `Transaction`, `Category`, `ScheduledTransaction`, `Scenario`, `ScenarioOverride`, and `BalanceAdjustment` are the initial domain concepts. Their exact relational schema will be established alongside the first persistence milestone.

## Architecture decisions

| ID | Decision | Status | Rationale |
| --- | --- | --- | --- |
| ADR-001 | Windows desktop first, Linux portability preserved | Accepted | Product requirement. |
| ADR-002 | React + Tauri desktop UI | Accepted | Component-based UI replaces the code-behind Avalonia shell while retaining a real Windows/Linux desktop executable. |
| ADR-003 | SQLite local persistence | Accepted | Product-directed local-only data store. |
| ADR-004 | `decimal` for money | Accepted | Prevents binary floating-point rounding errors in financial calculations. |
| ADR-005 | Deterministic scenario engine | Accepted | Modeling results must be reproducible and independently testable. |
| ADR-006 | AI produces reviewable proposals only | Accepted | Preserves ledger integrity and auditability. |
| ADR-007 | Pin `SQLitePCLRaw.lib.e_sqlite3` 2.1.12 directly | Accepted | Explicitly selects a patched SQLite native library version as a dependency-security mitigation. |
| ADR-008 | Allow uncategorized transactions | Accepted | Categories are user preferences and AI suggestions; no confirmed requirement makes a category mandatory at manual entry. A selected category must remain a valid category reference. |
| ADR-009 | Manual balance updates create ledger adjustment transactions | Accepted | Makes each balance correction explicit, traceable, and included in authoritative balance calculations. |
| ADR-010 | Initial schedule rules are daily, weekly, monthly, optional end date, and occurrence skips | Accepted | User-directed first recurrence set for future scheduled transactions. |
| ADR-011 | Reference SQLite native runtime directly from the App project | Accepted | Ensures self-contained publish output includes the required native SQLite library (`e_sqlite3.dll` on Windows and `libe_sqlite3.so` on Linux). |
| ADR-012 | Persist a manually posted transaction and its repeat schedule atomically | Accepted | Prevents partial recurrence setup and ensures the schedule begins after the already-posted occurrence. |
| ADR-013 | Lock balance adjustments in the Ledger UI as as-of-date audit entries | Accepted | Preserves reconciliation evidence in the user workflow and computes adjustment amounts from the ledger state at the selected date. |
| ADR-014 | Apply schema migrations atomically and show startup recovery information | Accepted | Prevents partial migration state and gives the user actionable information if local startup cannot complete. |
| ADR-015 | Tauri local commands own the encrypted database boundary | Accepted | The React renderer never receives a database key or arbitrary SQL capability. SQLCipher protects the database; the random key is stored through the operating system credential store. |

## Deferred decisions

- Encryption-at-rest implementation and credential/key handling.
- Backup format and restore UX.
- AI provider/local-model strategy and data-sharing consent design.
- Self-contained Windows publishing verification; scripts exist, but runtime-specific restore does not complete in the current environment.
- Scenario editor interaction and initial override set; this is deferred and no longer blocks M3.
