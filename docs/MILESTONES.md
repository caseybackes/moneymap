# Family Finance — Delivery Milestones

## Operating rule

Before implementation starts on a milestone, its acceptance criteria must be current and testable. After implementation, the owner records verification evidence and updates the status here.

## M0 — Foundation and architecture baseline

Status: **Completed 2026-07-30**

Acceptance criteria:

- A repository-local requirements baseline distinguishes confirmed requirements, exclusions, and unresolved decisions.
- An architecture baseline documents system boundaries, project layout, financial invariants, and accepted technology decisions.
- The solution contains an Avalonia desktop executable targeting .NET 10, a domain library, a SQLite persistence library, and test projects.
- The solution builds successfully on Windows.
- Automated domain tests run successfully.
- No direct financial-data connection or statement-import functionality is introduced.

Verification evidence:

- The repository contains `FamilyFinance.sln` with App, Domain, Data, and Domain.Tests projects.
- `.NET 10` is installed repository-locally in `.tooling` and excluded from source control.
- `dotnet test FamilyFinance.sln --configuration Release --no-restore` passed: 1/1 tests.
- `dotnet build FamilyFinance.sln --configuration Release --no-restore` succeeded with 0 warnings and 0 errors, producing `FamilyFinance.dll`.

## M1 — Local ledger foundation

Status: **Completed 2026-07-30**

Acceptance criteria:

- SQLite migrations create persistent Account, Transaction, and Category records, with stable identifiers and required relationships.
- The domain/application boundary can create accounts with opening balances, preferred categories, and manual ledger transactions; editing a transaction is supported without duplicate records.
- A transaction requires date, account, description/payee, and non-zero amount; notes and category are optional. When a category is selected, it must refer to a persisted user category.
- Account calculated balances derive from opening balance plus posted transactions using `decimal`; the calculation has an explicit and tested treatment for income and spending signs.
- A repository query returns ledger transactions with their account and category context in deterministic date/order semantics suitable for the later Ledger UI.
- Domain and persistence tests cover money calculations, required-field validation, edit behavior, migration of a new database, and persistence round trips.
- No schedule, scenario, statement-import, or AI behavior is added in this milestone.

Current evidence (2026-07-30):

- SQLite schema initialization creates accounts, categories, and transactions with primary keys and foreign keys.
- Account, Category, and Transaction creation/read operations are implemented; a missing account reference is tested as rejected by SQLite.
- Account balances are calculated from opening balance and account-matching transactions using `decimal`.
- `dotnet build FamilyFinance.sln --configuration Release --no-restore` succeeded with 0 warnings and 0 errors.
- Transaction editing preserves its identifier and creation time; repository updates replace the existing record and are tested not to create a duplicate.
- Domain validation rejects missing identifiers, account, date, blank description, and zero amount.
- The domain documents and tests the positive-income/negative-spending sign convention.
- Ledger queries return account/category display names with date, creation-time, and identifier tie-break ordering; this ordering is tested.
- `dotnet test FamilyFinance.sln --configuration Release --no-restore` passed: 14/14 tests.

Completion assessment:

- All M1 acceptance criteria are met by the current implementation and verification evidence.

## M2 — Desktop shell, dashboard, calendar, and ledger UI

Status: **Completed 2026-07-30**

Acceptance criteria:

- The installed application launches into its main Windows desktop window without requiring a browser.
- The icon-only sidebar provides navigation to Dashboard, Calendar, and Ledger; each icon has an accessible name or tooltip.
- Dashboard is the initial view. Until dashboard content is separately decided, it must display an honest persisted-data empty state or persisted values—never placeholder financial values.
- Ledger displays persisted transactions with date, account, description/payee, amount, category, and notes where present. The ledger's visible ordering matches the repository's documented deterministic ordering.
- The manual transaction workflow writes through the application boundary to the local SQLite ledger and reports persistence failures to the user.
- Calendar displays income and spending subtotals per date using persisted ledger data. Income and spending use the domain's documented transaction-sign convention.
- Creating or editing a ledger transaction refreshes every affected calendar date without restarting the application.
- UI integration tests or an equivalent repeatable verification exercise prove persisted transaction creation, ledger visibility, daily calendar subtotals, and calendar refresh after a ledger change.
- No direct financial-data connection, statement import, scheduling, scenario, or AI functionality is introduced.

Current evidence (2026-07-30):

- The Avalonia application initializes a local SQLite database under the user's `LocalApplicationData` directory.
- The current UI provides account setup, manual transaction creation/editing, Dashboard, Ledger, Calendar, and accessible icon-only navigation.
- Dashboard values and Calendar daily subtotals are queried from persisted ledger data.
- `FinancialSummaries` now owns tested dashboard-period and calendar-day calculations. After a transaction save, the App refreshes the currently active view; Calendar saves therefore redraw Calendar with the persisted totals.
- Ledger rows now include notes when present.
- Supplied verification result: Release build completed with 0 warnings/errors and 17/17 regression tests passed.
- A Windows executable launch check passed: the application started, remained alive for two seconds, then was stopped.

Completion assessment:

- An Avalonia.Headless test opens Calendar in the real `MainWindow`, uses the owned transaction dialog controls to create a persisted transaction, verifies the active Calendar immediately renders the daily spending subtotal, then verifies the persisted description and notes in Ledger. This proves the required desktop-control workflow.
- All M2 acceptance criteria are met by the current implementation and verification evidence.

## M2A — Preferred category management

Status: **Completed 2026-07-30**

This is adjacent confirmed-requirement work, not a reopening of M2 and not a dependency on M3's scheduling/scenario decisions.

Acceptance criteria:

- The icon sidebar provides an accessible navigation route to a local Categories view.
- Categories view lists persisted preferred categories using deterministic name ordering and gives an honest empty state when none exist.
- Users can create a category with a non-blank name. Duplicate names and persistence errors are shown without silently changing data.
- The manual transaction create and edit dialogs list the persisted preferred categories and allow the user to select one or leave the transaction uncategorized.
- A selected category persists with the transaction and is visible in Ledger; an uncategorized transaction continues to be supported.
- Automated persistence/UI verification covers category creation/listing and selecting a category in the transaction workflow.
- No AI categorization, statement import, scheduling, or scenario capability is introduced.

Verification evidence:

- Categories view is accessible from the icon sidebar and renders persisted categories from the deterministic repository order, with an empty state when none exist.
- The add-category dialog validates blank names and surfaces duplicate/persistence errors without writing a replacement record.
- Transaction create/edit dialogs load persisted categories and retain the uncategorized option.
- Avalonia.Headless verification creates `Groceries` through the Categories UI, selects it in the real transaction dialog, saves, and asserts the persisted transaction `CategoryId` matches.
- `dotnet test FamilyFinance.sln --configuration Release --no-restore --maxcpucount:1` passed: 18/18 tests.

## M3 — Schedules and balance adjustments

Status: **Completed 2026-07-30**

Acceptance criteria:

- Users can create scheduled future transactions that appear in calendar and balance projections.
- Schedules support daily, weekly, and monthly recurrence, optional end dates, and individual skipped occurrences.
- A manual balance update creates an explicit ledger adjustment transaction that records target balance, prior calculated balance, adjustment amount, timestamp, and user reason/note.
- Balance projections include adjustment transactions under the normal authoritative-ledger rules.
- Domain and persistence tests cover recurrence/end/skip behavior and auditable balance-adjustment calculations.

Resolved decisions:

- Balance updates are explicit ledger adjustment transactions.
- The first schedule rules are daily, weekly, monthly, optional end date, and per-occurrence skips.

Current evidence (2026-07-30):

- SQLite persistence and domain generation exist for daily, weekly, and monthly schedules with optional end dates and individually skipped occurrences.
- The desktop app provides scheduled-transaction creation, occurrence skips, upcoming schedule display, and future calendar inclusion.
- The desktop balance-adjustment workflow uses the target-balance factory and persists `BalanceBeforeAdjustment`, `TargetBalance`, derived adjustment amount, timestamp, and required reason in the adjustment transaction.
- `AccountBalanceProjector` is a pure Domain calculation that combines authoritative ledger data and scheduled occurrences through the next three months; Dashboard renders the projected balance.
- Supplied verification result: `dotnet test FamilyFinance.sln --configuration Release --no-restore --maxcpucount:1` passed 29/29, and a local `FamilyFinance.exe` launch check remained alive for two seconds.

Completion assessment:

- Balance-adjustment migrations and persistence retain the pre-adjustment and target balances, and enforce that the adjustment amount is their difference.
- Scheduled transactions are included in calendar and three-month account-balance projections; normal ledger balance calculations include explicit adjustment transactions.
- All M3 acceptance criteria are met. M3B numerical scenario modeling remains deferred and non-blocking.

Post-completion integrity and recurrence verification (2026-07-31):

- Add and Edit transaction dialogs support an optional repeat schedule with daily/weekly/monthly recurrence and optional end date. They atomically persist the current transaction (including an edit) and start the schedule on the next recurrence.
- Balance adjustments calculate the balance as of their selected date and are locked from editing in the Ledger UI as audit entries.
- Migrations execute atomically and are recoverable; startup failures surface a recovery window rather than failing silently. Account types are validated at the domain boundary.
- Current canonical verification result: serialized Release tests pass 55/55, and republished `artifacts/windows/win-x64/FamilyFinance.exe` passed a five-second launch check.

## M3B — Numerical scenario modeling (deferred)

Status: Deferred

This work remains in product scope but must not block M3.

Acceptance criteria:

- Structured scenario overrides generate numerical projections without altering persisted real-ledger data.
- A scenario UI edits structured inputs rather than using chat as the modeling interface.
- Tests prove scenario isolation and calculation correctness.

## M3C — Explicit scheduled-occurrence posting

Status: **Completed 2026-07-31**

This slice posts an occurrence only on direct user action. It does not introduce automatic matching, bank synchronization, or statement import.

Acceptance criteria:

- An upcoming scheduled occurrence exposes an explicit user action to post that occurrence; no schedule is posted or matched automatically.
- Posting creates one ledger transaction with the occurrence date, account, description, amount, category, and notes copied from the schedule.
- In one database transaction, posting records an auditable occurrence-resolution entry linked to the schedule, occurrence date, and created ledger transaction. The entry distinguishes a posted occurrence from a user-skipped occurrence.
- A duplicate post or skip of the same schedule occurrence is prevented and reports a clear error without creating another ledger transaction.
- Calendar and account projections exclude both posted and skipped schedule occurrences. A posted occurrence appears through the ledger only, so it contributes exactly once to daily and projected totals.
- The Ledger provides enough display context to identify a transaction created from a scheduled occurrence.
- Domain, persistence, and desktop UI tests cover explicit posting, atomic rollback on failure, duplicate prevention, audit linkage, and no-double-count calendar/projection results.
- No automatic matching, external financial-data connection, statement import, AI action, or scenario behavior is introduced.

Current evidence (2026-07-31):

- Migration 5 creates a durable schedule-occurrence-to-posted-transaction audit link.
- The Scheduled Transactions view provides an explicit Record action. Posting atomically creates a regular ledger transaction, records the occurrence posting, and prevents both duplicate posts and skip/post conflicts.
- Posted and skipped occurrences are excluded from schedule occurrence queries, Calendar totals, and account projections, so a posted amount appears through the ledger once.
- Ledger query/render exposes the durable posting link as `Posted from schedule` with the occurrence date.
- Current canonical verification result: serialized Release tests pass 55/55, and republished `artifacts/windows/win-x64/FamilyFinance.exe` passed a five-second launch check.

Completion assessment:

- All M3C acceptance criteria are met by the current implementation and verification evidence.

## M3D — Deterministic recurring-transaction suggestions

Status: **Completed 2026-07-31**

This slice detects narrow, explainable local patterns and proposes a schedule for explicit user acceptance. It does not use AI, a provider, network access, or automatic schedule creation.

Acceptance criteria:

- The detector evaluates posted regular transactions locally and recognizes a candidate only when at least three transactions have the same account, deterministic normalized description, and exact signed amount.
- Initial cadence recognition supports daily, weekly, and monthly patterns. A candidate identifies its supporting transaction dates, proposed recurrence, and next proposed occurrence date.
- Description normalization is deterministic and documented. It does not use an LLM or external service.
- Different accounts, differing amounts, fewer than three matching entries, and cadence outside daily/weekly/monthly produce no suggestion.
- A suggested schedule is not persisted until the user explicitly accepts it. Acceptance presents the proposed recurrence/start date and allows an optional end date.
- Acceptance creates one future schedule through the normal local schedule persistence path; declining/dismissing a suggestion leaves no schedule or ledger mutation.
- Accepted schedules start after the latest supporting posted transaction, avoiding duplicate historical accounting.
- Domain tests cover: valid daily, weekly, and monthly candidates; each rejection condition; deterministic normalization; and correct proposed next date.
- Persistence/UI tests cover: no silent schedule creation; explicit acceptance with and without an end date; dismissal with no mutation; and calendar/projection inclusion only after acceptance.

Known limitations of the initial rule:

- It does not infer variable-amount patterns, multiple simultaneous cadence hypotheses, transfers, cadence outside daily/weekly/monthly, irregular recurrence, or merchant aliases beyond the documented deterministic normalization.
- It only observes local posted ledger transactions and does not perform statement import, bank synchronization, AI analysis, or automatic matching.

Current evidence (2026-07-31):

- `RecurringTransactionDetector` is a local deterministic Domain service. It groups regular entries by account, case/punctuation/whitespace-normalized description, and exact signed amount; it only returns daily/weekly/monthly runs of three or more entries.
- Dashboard renders supporting dates, next occurrence, and an explicit Add schedule action. A matching accepted schedule is filtered from later suggestions.
- Domain tests cover daily/weekly/monthly detection, normalization, exact-match rejection, separate accounts, balance-adjustment exclusion, and irregular run separation.
- Desktop UI coverage verifies a monthly suggestion can be explicitly accepted with and without an optional end date, persists a schedule beginning after the supporting entries, preserves its notes, and removes the action from Dashboard.
- Dismissing a suggestion is session-only and is covered to prove no schedule or ledger mutation occurs.
- Current canonical verification result: serialized Release tests pass 55/55, and republished `artifacts/windows/win-x64/FamilyFinance.exe` passed a five-second launch check.

Completion assessment:

- All M3D acceptance criteria are met by the current implementation and verification evidence.

## M3E — Confirmed ledger deletion

Status: **Completed 2026-07-31**

This slice adds an explicit user-initiated delete action. It does not add bulk deletion, automatic cleanup, or external-data synchronization.

Acceptance criteria:

- Ledger exposes a delete action for normal, balance-adjustment, and schedule-posted transactions. The action presents a confirmation that identifies the transaction and any schedule/audit consequence.
- Canceling confirmation performs no ledger, schedule, posting, skip, projection, or audit mutation.
- Confirmed normal-transaction deletion removes that entry and refreshes Ledger, Calendar, balances, Dashboard, and recurring suggestions affected by it.
- Confirmed balance-adjustment deletion removes its financial effect and associated adjustment metadata as one confirmed hard-delete operation, leaving no broken audit relationship.
- Confirmed deletion of a transaction posted from a schedule atomically removes the ledger entry, clears the schedule-posting link without a dangling foreign key, and reopens that schedule occurrence for future Calendar/projection accounting.
- A deleted schedule-posted occurrence can be explicitly recorded again; it is not silently recreated or double counted.
- Deletion behavior is atomic: an error while updating related posting data leaves both the ledger transaction and its related records unchanged.
- Domain, persistence, and desktop UI tests cover confirmation/cancel behavior; normal and adjustment deletion; schedule-posted deletion/reopen; duplicate prevention after re-recording; rollback on injected persistence failure; and affected Calendar/projection totals.
- No bulk deletion, automatic matching, statement import, external financial-data connection, AI action, or scenario behavior is introduced.

Risks to manage:

- Deleting a posted scheduled occurrence reopens it for projection, which can surprise a user if they intended a permanent removal; the confirmation must make this consequence clear.
- Confirmed deletion is permanent, including balance-adjustment metadata and schedule-posting context; the confirmation must make this destructive consequence clear.

Verification evidence (2026-07-31):

- Ledger exposes confirmation-based delete actions for regular, balance-adjustment, and schedule-posted transactions. Cancellation leaves state unchanged.
- Repository deletion is atomic. Deleting a schedule-posted entry clears its posting link and restores the occurrence as pending, with no broken foreign key.
- Supplied verification result: serialized Release tests pass 59/59, and republished canonical `artifacts/windows/win-x64/FamilyFinance.exe` passed a five-second launch check.

Completion assessment:

- All M3E acceptance criteria are met by the current implementation and verification evidence.

## M3F — Financial-workflow UI refinement

Status: **Completed 2026-07-31**

Acceptance criteria:

- Ledger header and transaction body use the same full-width table geometry, preserving column alignment while the Ledger is resized.
- Selecting a Calendar date opens an anchored, light-dismiss transaction-detail flyout; selecting a different date replaces the flyout's transaction context.
- Scheduled transactions are editable through the desktop UI.
- Recording an occurrence adds a session-only Added row to the current schedule view until navigation away, while the authoritative posted transaction remains in Ledger.
- Desktop UI tests cover these interaction states where practical; the release artifact is manually launch-checked after the UI pass.
- No scenario, import, external-data, AI, or automatic-matching behavior is introduced.

Verification evidence:

- The Ledger, Calendar detail flyout, schedule editing, and Record-session row behavior were verified in the desktop UI pass.
- Calendar date-detail popups use constrained cards with wrapped flexible descriptions, a fixed separated amount column, and a muted `Account · Category` context line.
- Supplied verification result: serialized Release tests pass 63/63, and canonical `artifacts/windows/win-x64/FamilyFinance.exe` was republished and passed a five-second launch check.

Follow-up verification (2026-07-31):

- The Calendar popup layout refinement was verified with the serialized 64/64 Release suite and a canonical Windows artifact five-second launch check.
- Calendar thresholded drag-to-snap navigation was verified with the serialized 69-test suite. No build, publish, or launch verification was performed for this documentation update.

## M3G — Ledger filtering

Status: **Completed 2026-07-31**

This slice only changes the Ledger view's query/display state. It does not change, import, categorize, or synchronize ledger data.

Acceptance criteria:

- Ledger provides filters for description/payee name text, persisted category (including an explicit Uncategorized choice), signed amount minimum/maximum, and date start/end.
- Description/payee matching is a documented case-insensitive substring match. Persisted category filtering uses the stored category relationship; Uncategorized matches only transactions with no category.
- Amount bounds operate on the signed ledger amount and date bounds are inclusive. Invalid numeric/date range input produces a clear validation state without changing ledger data.
- All populated filters combine with logical AND. Blank filter fields are ignored.
- Reset clears every filter field and restores the complete deterministically ordered Ledger result set.
- An honest empty-result state is shown when no transactions match; it is distinct from the empty-ledger state.
- Applying, changing, clearing, or resetting filters does not create, edit, delete, recategorize, post, skip, or otherwise mutate any ledger/schedule/audit record.
- Domain/query tests cover each individual filter, inclusive bounds, AND composition, blank-field behavior, persisted category versus Uncategorized, reset, and no-match behavior.
- Desktop UI tests cover applying a combined filter and reset, asserting the underlying persisted ledger records are unchanged.

Verification evidence:

- Ledger supports case-insensitive description/payee matching; Any, Uncategorized, and persisted-category choices; signed inclusive amount bounds; and inclusive date bounds.
- Filled filters compose with AND, blank fields are ignored, Reset restores the complete Ledger, and no-match results have an honest empty-result state.
- Supplied verification result: serialized Release tests pass 64/64, and canonical `artifacts/windows/win-x64/FamilyFinance.exe` was republished and passed a five-second launch check.

Completion assessment:

- All M3G acceptance criteria are met by the current implementation and verification evidence.

## M4 — AI-assisted normalization and categorization

Status: Pending

Acceptance criteria:

- The AI boundary returns normalization/category suggestions without persisting changes itself.
- The UI displays suggestion provenance and requires explicit user approval to apply a change.
- Core functionality remains available with no AI provider configured or no network access.

## M4A — Local AI suggestion-contract preparation

Status: **Completed 2026-07-30**

This is contract preparation only. It does not select an AI provider or change the unresolved privacy model.

Acceptance criteria:

- A provider-neutral local contract models category/normalization suggestions as proposals, separate from `Transaction` and persistence entities.
- Each proposal records source transaction identity, proposed normalized payee/description and/or category, confidence where available, and provenance sufficient to identify the producing component/model or manual source.
- The contract models explicit user disposition (accepted, rejected, or pending); no proposal has a path to mutate a ledger transaction implicitly.
- Applying an accepted proposal requires a separate explicit application operation at a future UI/application boundary; this preparation item does not implement that operation or modify persisted ledger records.
- With no provider configured, all existing local application workflows build, launch, and operate without an error, network dependency, or hidden fallback.
- Tests verify the proposal/disposition invariants and prove no Data-layer write is performed by the local suggestion contracts.
- No AI SDK/provider integration, network request, secret/configuration, statement import, or privacy-model decision is introduced.

Current evidence (2026-07-30):

- `FamilyFinance.AI` contains immutable, provider-neutral request/result/suggestion contracts with request context, confidence bounds, and provenance.
- `ITransactionSuggestionService` is review-only and its project has no persistence or provider implementation.
- Contract tests cover copied review input, confidence validation, context/provenance retention, and review disposition/timestamp invariants; the serialized test suite passes 24/24.
- No application workflow is configured to call an AI provider, so core local operation remains independent of network/provider configuration.

Completion assessment:

- `SuggestionReview` is a standalone immutable review record with explicit `Pending`, `Accepted`, and `Rejected` dispositions. Pending reviews cannot contain a decision timestamp/reason; accepted or rejected reviews require a timestamp.
- `FamilyFinance.AI` contains no package or project dependency on Data/persistence or a provider SDK, and exposes no command/application interface. It cannot perform a ledger write.
- All M4A acceptance criteria are met by the current implementation and verification evidence.

## M5A — Operational release and platform viability

Status: **Completed 2026-07-31**

This milestone is limited to distributable executable artifacts and Linux build viability. It does not select a statement-import format, backup/encryption design, AI provider, or privacy model.

Acceptance criteria:

- The documented Windows release command produces a self-contained `win-x64` single-file executable under an ignored release-artifact directory, without relying on a globally installed .NET runtime.
- The Windows artifact includes the native SQLite runtime required by local persistence (`e_sqlite3.dll`); the Linux artifact includes its `libe_sqlite3.so` counterpart.
- The Windows release artifact launches from a clean output location, remains running for the launch smoke-check interval, and can be stopped cleanly.
- Release instructions state the supported Windows runtime identifier, artifact location, and how to run the executable; they distinguish the verified framework-dependent development build from the self-contained distribution artifact.
- The documented Linux release command produces a self-contained `linux-x64` artifact under an ignored release-artifact directory using the same source tree and project.
- Linux artifact verification records the build host and target runtime identifier. A launch smoke test is required on a Linux environment before claiming Linux runtime support; a successful cross-publish alone proves build viability only.
- Publish scripts fail non-zero on restore/publish failure and do not store generated artifacts or local data in source control.
- Publish scripts set `DebugSymbols=false` and `DebugType=None`. Because their output directories are fixed and not cleaned, a formal release must use a fresh/versioned workspace or inspect the artifact directory for stale `.pdb` files.
- Release verification does not introduce external financial-data connections, statement import, provider configuration, telemetry, or cloud storage.

Verification evidence:

- The original Windows self-contained artifact was invalid: Windows Event Log recorded a `DllNotFoundException` for `e_sqlite3`, because the native SQLite package was a Data-project-only `PrivateAssets` dependency and was omitted from App publish output.
- After adding a direct `SQLitePCLRaw.lib.e_sqlite3` reference to the App project, `win-x64` was republished at `artifacts/windows/win-x64` with `e_sqlite3.dll`. The artifact passed a five-second launch check with no matching .NET Runtime error.
- `linux-x64` was republished at `artifacts/linux/linux-x64` with `libe_sqlite3.so`.
- Supplied verification result: `dotnet test FamilyFinance.sln --configuration Release --no-restore --maxcpucount:1` passed 31/31.
- The launch check did not prove clean-profile `LocalApplicationData` database initialization: .NET ignored the temporary `LOCALAPPDATA` override. Clean-profile database initialization remains a separate operational-test gap.
- Linux self-contained `linux-x64` publish succeeded at `artifacts/linux/linux-x64` on the Windows build host.
- Linux runtime smoke testing is not claimed because no Linux host was available. The successful Linux artifact establishes build viability only, as required by this milestone.
- [Release operations](RELEASE.md) document the commands, runtime identifiers, artifact locations, verification boundary, and fixed-output-directory precaution.

Release handling note:

- The publish scripts intentionally use fixed artifact paths and do not delete outputs. Formal distributions should be published from a fresh or versioned workspace; no deletion was performed as part of this verification.

## M5 — Import and operational hardening

Status: Pending

Acceptance criteria:

- A chosen statement-file import format supports review before ledger persistence.
- Backup/restore and the selected encryption/privacy model are implemented and documented.
- Windows packaging is documented and verified; a Linux build path is documented and checked.

## M5B — Plaid transaction import (gated roadmap)

Status: Gated

This roadmap item is not authorized for implementation until every gate below is explicitly satisfied. It does not select a Plaid product, create an account, make a network request, or store a token.

Implementation gates:

- The project owner creates and controls the Plaid dashboard account, reviews its terms/billing ownership, and enables a sandbox environment.
- Sandbox-only development proves the selected transaction retrieval flow against non-production test data before any production credential is requested.
- Before a production trial, the owner reviews current Plaid pricing, expected volume, trial limits, billing exposure, and the specific production capability requested; production use requires an explicit go-ahead after that review.
- Each end user receives a clear consent step before a connection is initiated, identifying Plaid as an external financial-data provider and stating what account/transaction data will be requested.
- On Windows, Plaid secrets and access tokens are protected with DPAPI scoped to the intended local user. They are never written to logs, source control, plaintext configuration, or diagnostic UI.
- Linux token protection is a separate design decision. Plaid connection support must not be claimed cross-platform until an equivalent Linux secret-storage strategy is selected and verified.
- Retrieved transactions first enter a local review/staging workflow. No fetched transaction is silently added, edited, categorized, scheduled, or deleted in the authoritative ledger.
- The review workflow identifies source institution/account context and supports explicit user approval before persistence, with duplicate-handling rules defined and tested before production use.
- Users can remove a connection and locally remove its protected token; the provider-side revocation/disconnect workflow must be documented before production use.

Acceptance criteria after gates are opened:

- Sandbox integration, consent UX, DPAPI handling, staging/review, approval, duplicate behavior, disconnect, and error behavior have automated and manual verification appropriate to their risk.
- Production trial evidence records approved pricing/billing review and uses no wider production scope than explicitly approved.
- Core manual-entry, local-ledger, schedule, and calculation workflows remain usable with no Plaid account, connection, network, or token configured.
- No user banking credential is collected, displayed, or stored by Family Finance.
