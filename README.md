# Family Finance

Desktop personal-finance application for Windows 10 first, with Linux support planned afterwards.

Developer setup, commands, data constraints, and documentation map: [docs/DEVELOPER.md](docs/DEVELOPER.md).

Plaid broker source: [services/plaid-broker](services/plaid-broker). Its initial Worker exposes only a health check and contains no credentials.

## Requirements captured so far

### Scope

- Tracks one person's finances across multiple accounts.
- Account types include checking, savings, retirement, investments, tax, and other user-defined accounts.
- Transactions are entered manually for the first version. Statement import will be added later.

### Navigation

- The landing page is a dashboard.
- Navigation uses an icon-only sidebar.
- The calendar and ledger are separate navigable views.

### Calendar

- The calendar shows daily subtotals for spending and income.
- It updates when transactions are added, edited, imported, or scheduled.

### Ledger and transactions

- The ledger is the detailed record of all transactions.
- A manual transaction has: date, account, description/payee, amount, category, and notes.

### Accounts and balances

- Accounts have an opening balance.
- A calculated balance is derived from transactions.
- The user can manually update an account balance.
- Manual balance updates must be auditable: entered balance, timestamp, reason/note, and resulting adjustment are retained.

### Categories and AI assistance

- The user maintains preferred categories.
- An LLM normalizes merchant and description data and suggests categories.
- Suggested categories require user approval before records change.

### Scheduled transactions

- The user can create scheduled future transactions.
- The app detects recurring transaction patterns and suggests scheduled transactions.
- Scheduled transactions appear on future calendar dates and participate in totals and modeling.

### Scenarios and analysis

- What-if functionality is numerical scenario modeling, based on structured changes to amounts, dates, schedules, balances, and related financial inputs.
- Scenario changes recalculate calendar totals, ledger projections, and balances.
- Conversational AI is used after calculations to analyze results; it is not the scenario-modeling interface.

## Decisions still needed

- Dashboard contents.
- Exact behavior of a manual balance update: explicit adjustment transaction, reconciled balance with discrepancy, or another accounting model.
- Definition of the user category system and category-management workflow.
- Scenario creation and editing interface.
- Local data storage, encryption, backup, and LLM privacy model.
