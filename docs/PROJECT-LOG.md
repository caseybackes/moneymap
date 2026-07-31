# Family Finance — Project Log

## 2026-07-30 — M0 completed

- The .NET 10 solution foundation was created with App, Domain, Data, and Domain.Tests projects.
- The repository-local .NET SDK is stored in `.tooling`, which is ignored by source control.
- Verification passed: `dotnet test FamilyFinance.sln --configuration Release --no-restore` (1/1) and `dotnet build FamilyFinance.sln --configuration Release --no-restore` (0 warnings, 0 errors; produced `FamilyFinance.dll`).
- Accepted ADR-007: direct pin of `SQLitePCLRaw.lib.e_sqlite3` 2.1.12 to select a patched SQLite native dependency.
- M1 is now active. Its criteria now define the minimum persistence, validation, ordering, calculation, and test expectations for the ledger foundation.

## 2026-07-30 — M1 implementation review

- Verified implementation evidence: Account, Category, and Transaction creation/read; decimal account-balance calculation; SQLite schema and foreign keys; and persistence tests.
- Supplied verification result: Release build completed with 0 warnings/errors and Release tests passed 4/4.
- M1 remains in progress. Editing, domain validation, explicit sign rules, full ledger display context/stable ordering, and their tests are incomplete.
- The Avalonia dashboard shell compiles, but it is currently unconnected to persistence. This is groundwork for M2 and is not evidence that any M2 UI/data acceptance criterion is complete.

## 2026-07-30 — M2 acceptance criteria prepared

- M2 now requires a real persisted-data flow across Ledger and Calendar, including refresh after create/edit, rather than a compiled shell alone.
- Dashboard content remains intentionally unspecified; it must present either a persisted-data state or an honest empty state until its information hierarchy is decided.

## 2026-07-30 — M1 completion audit

- The current implementation and 14/14 passing tests prove transaction editing, domain validation for identifiers/account/date/description/amount, the documented signed-money convention, deterministic ledger ordering, display context, and persistence behavior.
- The category mismatch was pending reconciliation with confirmed product requirements.

## 2026-07-30 — Category-entry decision and M1 completion

- Accepted ADR-008: categories are optional at manual entry. This follows the confirmed model of user-preferred categories with AI category suggestions; neither requirement makes a category mandatory before a transaction can be recorded.
- M1's category criterion now requires referential validity only when a category is selected.
- Re-evaluation against the existing 0-warning Release build and 14/14 Release test result finds every M1 acceptance criterion met. M1 is completed and M2 is active.

## 2026-07-30 — M2 implementation review

- The desktop UI now persists to local application data and provides account setup, manual transaction create/edit, Dashboard, Ledger, Calendar, and accessible icon navigation. Release build and 14/14 regression tests are green.
- Follow-up resolved the code-level issues: notes render in Ledger, the active view refreshes after transaction saves, calculation rules moved to the tested Domain `FinancialSummaries` service, and a Windows launch check passed.
- An Avalonia.Headless test now drives the real MainWindow's Ledger and Calendar controls against temporary persisted data and verifies edited Ledger content and Calendar subtotal rendering. The Release suite passes 17/17.
- The headless test now opens Calendar, drives the owned transaction dialog's actual controls, saves the transaction, observes the active Calendar subtotal, and then verifies Ledger content. M2 is complete.

## 2026-07-30 — M3 decision blockers

- Before M3 can be accepted, select the manual balance-update accounting semantics, initial scenario override types/editor workflow, and the first scheduled-transaction recurrence/end/skip rules. These are product decisions, not implementation substitutions.

## 2026-07-30 — M3 decisions resolved

- Manual balance updates will create explicit, auditable ledger adjustment transactions.
- M3 scheduling supports daily, weekly, and monthly recurrence, optional end dates, and individual occurrence skips.
- Scenario/what-if UI is deferred to M3B and no longer blocks M3. Its structured-input design remains unresolved.

## 2026-07-30 — M3 integration review

- Delivered schedule behavior includes daily/weekly/monthly recurrence, end dates, occurrence skips, local persistence, UI creation, and future Calendar totals. The balance-adjustment UI creates explicit adjustment ledger transactions with required reasons.
- Supplied integration evidence: serialized Release tests pass 28/28 and local `FamilyFinance.exe` remained alive for a two-second launch check.
- M3 remains in progress: the adjustment record does not persist target/pre-adjustment values required for auditability, and scheduled occurrences are not yet included in a balance-projection calculation/view. M3B remains deferred and does not block this work.

## 2026-07-30 — M3 completed

- Adjustment migration and persistence now retain `BalanceBeforeAdjustment` and `TargetBalance`; the domain target factory derives and validates the adjustment amount.
- `AccountBalanceProjector` combines ledger and scheduled occurrences through three months, and Dashboard renders that projected balance.
- Supplied verification result: serialized Release tests pass 29/29 and the local `FamilyFinance.exe` launch check passed. M3 is complete; M3B numerical scenario modeling remains deferred and non-blocking.

## 2026-07-30 — Category management work prepared

- Added M2A as separate confirmed-requirement work: a local Categories view for creating and listing preferred categories, with transaction selection and persistence verification.
- M2 remains complete. M2A may proceed while M3 product decisions remain unresolved.

## 2026-07-30 — M2A completed

- Categories sidebar, local add dialog, persisted list, validation/error display, and transaction-category selection are implemented.
- The Avalonia.Headless category workflow verifies a category created through UI can be selected in the real transaction dialog and persists as the transaction's `CategoryId`.
- Verification passed: `dotnet test FamilyFinance.sln --configuration Release --no-restore --maxcpucount:1` (18/18).

## 2026-07-30 — Publishing verification status

- Windows self-contained publishing scripts were added; initial runtime-specific restore verification did not complete in this environment.
- The normal framework-dependent Windows executable remains build- and launch-verified; this does not verify self-contained publishing.

## 2026-07-31 — M5A operational release prepared

- Added M5A to isolate Windows self-contained executable distribution and Linux build viability from the unresolved import, backup/encryption, and privacy work in M5.
- Existing `publish-windows.ps1` and `publish-linux.ps1` target self-contained single-file `win-x64` and `linux-x64` artifacts in ignored `artifacts/` paths, but neither runtime-specific publish is verified.
- Linux runtime support requires a Linux-host launch smoke test; cross-publishing alone is recorded as build viability rather than runtime proof.

## 2026-07-31 — M5A completed

- Initial self-contained Windows publish evidence was later invalidated by a native SQLite packaging crash; see the correction entry below.
- Self-contained Linux `linux-x64` publish succeeded at `artifacts/linux/linux-x64` on the Windows host. Linux runtime support is not claimed until a Linux-host smoke test runs.
- Release commands and the fixed-artifact-directory precaution are documented in `docs/RELEASE.md`. Formal distribution should use a fresh or versioned workspace; no artifact deletion was performed.

## 2026-07-31 — M5A launch-evidence correction

- The Windows artifact launch check proved process startup only. It did not prove clean-profile local database initialization because .NET ignored the temporary `LOCALAPPDATA` override used by the check.
- The isolated temporary folder may remain; the check did not touch user financial data.

## 2026-07-31 — M5A native SQLite publish correction

- Windows Event Log identified the original published-artifact failure as `DllNotFoundException` for `e_sqlite3`. The package had only been referenced from Data with `PrivateAssets=all`, so its native asset was omitted from self-contained App publish output.
- Added a direct `SQLitePCLRaw.lib.e_sqlite3` App reference (ADR-011), republished `win-x64` with `e_sqlite3.dll`, and republished `linux-x64` with `libe_sqlite3.so`.
- Corrected Windows artifact passed a five-second launch check with no matching .NET Runtime error. Serialized Release tests pass 31/31.

## 2026-07-31 — Integrity, recurrence, and release verification

- Manual transaction creation can atomically persist the current transaction plus a daily/weekly/monthly repeat schedule beginning with the next occurrence; optional end dates are supported.
- Backdated adjustments use the selected-date ledger balance and are locked from editing in the Ledger UI as audit entries. Schema migrations are atomic/recoverable, AccountType is validated, and startup failure opens a recovery window.
- Updated `win-x64` artifact passed a five-second launch check. Serialized Release tests pass 41/41.
- Publish scripts suppress debug-symbol generation, but fixed output directories are not cleaned. Formal release output must come from a fresh/versioned workspace or be inspected for stale `.pdb` files.

## 2026-07-31 — M3C explicit occurrence posting prepared

- Added M3C for an explicit user-selected transition from scheduled occurrence to ledger transaction, with atomic audit linkage and exactly-once calendar/projection accounting.
- M3C deliberately excludes automatic matching and all external data ingestion.

## 2026-07-31 — Recurrence edit and versioned-artifact verification

- Repeat scheduling is available from both Add and Edit transaction dialogs. Editing with repeat atomically persists the edited transaction and creates the future schedule beginning at the next recurrence.
- Serialized Release tests pass 44/44. The default executable was open, so verification used `artifacts/windows/win-x64-next/FamilyFinance.exe`; it passed a five-second launch check.

## 2026-07-31 — M3C posting integration review

- Migration 5 persists a schedule/date-to-posted-ledger-transaction audit link. The explicit Record action atomically creates the ledger entry and consumes the occurrence; duplicate and skip/post conflicts are rejected, and posted occurrences are excluded from Calendar/projection schedules.
- Serialized Release tests pass 48/48. Because the default executable remained open, `artifacts/windows/win-x64-next2/FamilyFinance.exe` passed a five-second launch check.
- M3C remains in progress: the Ledger UI does not yet show the available schedule-origin link for a posted transaction, so its display-context acceptance criterion is not met.

## 2026-07-31 — M3C completed

- Ledger query/render now exposes the posting audit context as `Posted from schedule` with the occurrence date; persistence and UI tests cover it.
- M3C is complete. Serialized Release tests pass 48/48, and `artifacts/windows/win-x64-next3/FamilyFinance.exe` passed a five-second launch check while the default executable remained open.

## 2026-07-31 — M3D recurring-suggestion review

- The local deterministic detector and Dashboard suggestion/acceptance flow are implemented. Explicit acceptance persists a future schedule and removes its matching suggestion; Release tests pass 53/53, with `artifacts/windows/win-x64-next4/FamilyFinance.exe` passing a five-second launch check.
- M3D remains in progress solely for its written UI acceptance coverage: add tests for accepting a suggested schedule with an optional end date and dismissing it with no schedule or ledger mutation.

## 2026-07-31 — M3D completed

- Suggested schedules now have covered acceptance with an optional end date, and dismissal is covered as session-only with no ledger or schedule write.
- M3D is complete. Serialized Release tests pass 54/54, and `artifacts/windows/win-x64-next5/FamilyFinance.exe` passed a five-second launch check while the default executable remained open.

## 2026-07-31 — Canonical artifact and development-build workflow

- `scripts/build-dev.ps1` now provides normal Debug output under `src/FamilyFinance.App/bin/Debug/net10.0`; self-contained release remains canonical at `artifacts/windows/win-x64` (and `artifacts/linux/linux-x64` for Linux).
- Daily recurrence detection verification brings the serialized Release suite to 55/55. The canonical `artifacts/windows/win-x64/FamilyFinance.exe` was republished and passed a five-second launch check.
- Generated `win-x64-next` through `win-x64-next5` artifact directories were removed; only the canonical Windows artifact directory remains.

## 2026-07-31 — M3D daily-cadence correction

- The deterministic recurring detector supports daily cadence in addition to weekly and monthly. M3D acceptance criteria and evidence now reflect all three supported cadences.
- The existing serialized 55/55 Release test result includes the daily-detection extension.

## 2026-07-31 — M3E confirmed ledger deletion prepared

- Added M3E for confirmation-based deletion of normal, balance-adjustment, and schedule-posted ledger transactions.
- The slice requires atomic related-record handling, cancellation with no mutation, durable audit context for sensitive deletions, and exactly-once Calendar/projection behavior when a posted occurrence is reopened.

## 2026-07-31 — M3E completed

- Confirmation-based hard deletion is implemented for regular, balance-adjustment, and schedule-posted transactions. Adjustment metadata and schedule-posting links are deleted atomically with the ledger entry; a posted occurrence becomes pending again.
- Cancellation performs no mutation, and posting/skip conflicts remain protected after a reopened occurrence is re-recorded.
- M3E is complete. Serialized Release tests pass 59/59, and canonical `artifacts/windows/win-x64/FamilyFinance.exe` passed a five-second launch check.

## 2026-07-31 — M3F financial-workflow UI refinement completed

- Ledger now uses aligned full-width header/body geometry; Calendar supports anchored light-dismiss per-date transaction detail that switches when another date is selected.
- Schedules are editable. Recording retains a session-only Added row in the active schedule view until navigation away.
- M3F is complete. Serialized Release tests pass 63/63, and canonical `artifacts/windows/win-x64/FamilyFinance.exe` was republished and passed a five-second launch check.

## 2026-07-31 — Release artifact hygiene

- Inspected the canonical Windows artifact directory and removed only stale generated `libHarfBuzzSharp.pdb` and `libSkiaSharp.pdb` files.
- The canonical `artifacts/windows/win-x64` directory now contains only `FamilyFinance.exe` (103,944,846 bytes). Publish scripts already suppress new debug symbols; formal release inspection remains required when reusing fixed output directories.

## 2026-07-31 — M3G Ledger filtering prepared

- Added M3G for deterministic, non-mutating Ledger filtering by description/payee text, persisted category or Uncategorized, signed amount range, and inclusive date range.
- Filled filter fields combine with AND, blanks are ignored, reset restores the complete ledger, and no-result presentation must remain honest.

## 2026-07-31 — M3G completed

- Ledger filtering now supports case-insensitive description/payee text, Any/Uncategorized/persisted category, signed inclusive amount bounds, inclusive date bounds, AND composition, reset, and honest no-result presentation.
- M3G is complete. Serialized Release tests pass 64/64, and canonical `artifacts/windows/win-x64/FamilyFinance.exe` was republished and passed a five-second launch check.

## 2026-07-31 — Developer documentation and Plaid roadmap

- Added `docs/DEVELOPER.md` as the developer entrypoint for solution layout, commands, local data constraints, documentation, and worktree norms.
- Added M5B as a gated Plaid roadmap. Implementation is blocked pending owner-controlled dashboard setup, sandbox validation, explicit production pricing/trial review, consent, DPAPI protection, review-before-import, and disconnect/token-removal design.

## 2026-07-31 — Calendar drag-to-snap refinement

- Calendar thresholded drag-to-snap navigation is implemented and verified by the serialized 69-test suite.
- No build, publish, or launch verification was performed as part of this documentation update.

## 2026-07-31 — M3F Calendar popup layout refinement

- Calendar date-detail popup cards now constrain layout, wrap flexible descriptions, keep amounts in a separated fixed column, and show muted `Account · Category` context.
- The refinement was verified with 64/64 serialized Release tests and a canonical Windows artifact five-second launch check.

## 2026-07-31 — M3D recurring-detection preparation

- Added M3D for local deterministic weekly/monthly schedule suggestions from at least three matching same-account, normalized-description, exact-amount transactions.
- Suggestions require explicit user acceptance and optional end-date selection; no schedule may be created silently. AI, provider, network, statement import, and automatic matching are excluded.
- The documented initial limitations keep pattern detection explainable and prevent speculative inference from becoming financial data mutation.

## 2026-07-30 — M4 contract preparation

- Added M4A as bounded, provider-neutral contract work for local normalization/category proposals, provenance, and explicit user disposition.
- M4A excludes providers, network requests, secrets, ledger mutation, and privacy-model decisions. It can proceed without resolving the M4/M5 privacy model.

## 2026-07-30 — M4A implementation review

- Provider-neutral immutable suggestion contracts, confidence, provenance, request context, and a review-only service interface are implemented.
- A standalone `SuggestionReview` now enforces pending/accepted/rejected disposition, decision timestamps, and pending-reason constraints without adding a command, persistence, or ledger mutation path.
- M4A is complete; the serialized suite passes 24/24. Provider selection and the privacy/data-sharing model remain deferred.

## 2026-07-30 — Baseline captured

- Product direction, architecture baseline, milestones, and known decisions were recorded from the requirements discussion.
- M0 is active.
- No open product decision blocks solution scaffolding. The balance-adjustment decision blocks completion of the corresponding M3 workflow only.

## Risks and technical debt register

| ID | Item | Impact | Status / next action |
| --- | --- | --- | --- |
| R-001 | Financial privacy model is not selected | Encryption and AI integration cannot be finalized responsibly | Resolve before M4/M5. |
| R-002 | Balance-update semantics | Resolved | ADR-009: explicit ledger adjustment transaction. |
| R-003 | Scenario input set is not selected | Scenario UI and overrides cannot be finalized | Deferred to M3B; does not block M3. |
| R-004 | Dashboard contents are not selected | Dashboard can be structurally implemented, but final content cannot be accepted | Resolve during M2 design. |
| TD-001 | Statement import formats are intentionally deferred | Import is unavailable until M5 | Select initial file format before M5. |
| R-006 | Linux runtime smoke test is pending | Linux runtime behavior is not yet proven | Run the `linux-x64` artifact on a Linux host before claiming Linux runtime support. |
| R-007 | Clean-profile local database initialization is unverified | First-run local data initialization is not release-smoke-tested | Run the self-contained Windows artifact under an isolated Windows user profile or a testable application-data-path override. |
| R-008 | Plaid integration has external privacy, billing, consent, and secret-handling exposure | A connection could expose financial data or incur unreviewed costs | Keep M5B gated until every listed implementation gate is explicitly approved and verified. |
