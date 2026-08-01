# Money Map test matrix

Run the desktop persistence regression suite from `apps/desktop/src-tauri`:

```powershell
cargo test --features sandbox-dev
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
