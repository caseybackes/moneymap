# Money Map test matrix

Run both desktop persistence configurations from `apps/desktop/src-tauri`:

```powershell
cargo test
cargo test --no-default-features --features sandbox-dev
```

| Scenario | Automated assertion | Required result |
| --- | --- | --- |
| Repeat Link | Same institution plus the same selected account IDs resolves to the existing local connection; the database uniqueness constraint rejects a duplicate connection identity. | No second Plaid Item or imported account set. |
| Two institutions, identical Sandbox fixtures | Tartan and First Gingham each return the same external account/transaction IDs. | Both sets remain present and independent. |
| Repeated sync / startup | Apply an unchanged sync payload twice. | Accounts, links, and transactions remain one copy per connection. |
| Selected-account cleanup | A sync payload contains an unselected account's transaction and removes a selected transaction. | The unselected transaction is ignored; the removed selected transaction disappears. |
| Disconnect deletion | Disconnect one of two connections after creating a schedule on one linked account. | That connection's accounts, transactions, and schedules are deleted; the other connection remains. |
| Failure / overlap safety | A malformed payload fails after a valid baseline sync. Imports take a SQLite `IMMEDIATE` transaction with a five-second busy timeout. | The failed sync rolls back completely; overlapping write syncs serialize instead of interleaving partial state. |

The Worker has its own route/authorization tests in `services/plaid-broker`:

```powershell
npm test
```

These tests deliberately use only in-memory fixtures. They neither open Link nor consume a Sandbox or production connection slot.

## Recurring bill vertical-slice matrix

Validate the Git-tracked fixture and its manifest from the repository root:

```powershell
node .\scripts\verify-recurring-bill-fixture.mjs
```

| Scenario | Automated assertion | Required result |
| --- | --- | --- |
| Fixture integrity | Hash `test-fixtures/recurring-bill/v1/data.json` and compare it with the versioned manifest. | Fixture identity, format version, and exact SHA-256 digest match. |
| Candidate boundaries | Detect the synthetic electric bill, rent, refund, pending charge, and recurring savings transfer. | Exactly the electric bill and rent are candidates; refund, pending charge, and transfer are excluded. |
| Variable amounts and duplicate grouping | Four electric descriptions share one merchant key with different signed integer-cent amounts. | One monthly candidate cites four observations and reports deterministic minimum, median, maximum, and next settlement date. |
| Existing and absent schedules | Detect once with the rent schedule and once after schedules are removed. | Rent cites its existing schedule; electric has no match; after removal all match lists are empty. |
| Proposal lifecycle | Exercise create/replay, native confirmation, rejection, expiry, stale evidence, fabricated confirmation, concurrent confirmation, execution, and execution replay. | Only a current native-confirmed proposal executes; mutation and audit are atomic and replay creates no duplicate schedule. |
| Environment isolation | Run Production, Sandbox, rehearsal, and frontend build checks without launching the app. | Matrices pass without Plaid calls, credentials, deployed secrets, Production-profile access, Worker deployment, installer creation, or installed-app replacement. |
