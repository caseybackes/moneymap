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
| Existing-connection account selection | Open **Manage synced accounts**, verify Money Map's local-deletion disclosure, reopen one existing Item in account-selection update mode, and confirm a smaller selected-account set. | No new Item is created; deselected accounts and their transactions/schedules are deleted locally; retained accounts remain; later stale sync payloads cannot restore deselected accounts; the app confirms that local deletion completed. |
| Disconnect deletion | Disconnect one of two connections after creating a schedule on one linked account. | That connection's accounts, transactions, and schedules are deleted; the other connection remains. |
| Failure / overlap safety | A malformed payload fails after a valid baseline sync. Imports take a SQLite `IMMEDIATE` transaction with a five-second busy timeout. | The failed sync rolls back completely; overlapping write syncs serialize instead of interleaving partial state. |
| Exact recovery matching | Compare two registered production connections with one exact local match; compare a reused broker ID with a different secret. | Only the absent connection is considered orphaned; a broker ID with the wrong secret never counts as a match. |

Build the React surface from `apps/desktop`:

```powershell
npm run build
```

Validate the versioned AI capability contracts from the repository root:

```powershell
node .\scripts\validate-ai-contracts.mjs
```

The Worker has its own route/authorization tests in `services/plaid-broker`:

```powershell
npm test
```

These tests deliberately use only in-memory fixtures. They neither open Link nor consume a Sandbox or production connection slot.

## Production recovery matrix

The pure matching and environment-routing cases are automated. File loss, Windows Credential Manager, backup restoration, and broker revocation also require a packaged-build exercise because their safety boundary includes the operating system and deployed Worker.

| Scenario | Coverage | Required result |
| --- | --- | --- |
| Explicit Worker environment | Automated Worker test with missing and ambiguous `APP_ENVIRONMENT` values. | Health remains available; every financial route fails closed with `invalid_environment`. |
| Compiled desktop environment | Automated Rust checks in both default Production and `sandbox-dev` configurations, plus packaged-build smoke test. | Production accepts only its Production broker route; Development accepts only its Sandbox broker route. |
| Missing local database | Manual Production exercise with at least one recovery-registry connection. | Startup enters recovery before loading normal views or opening another connection. |
| Unreadable local database | Manual Production exercise using an invalid or unavailable database key. | Startup reports an unreadable encrypted profile and offers restore or explicit remote revocation; it does not silently replace the profile. |
| Partial local/remote mismatch | Automated exact-handle matching plus manual two-connection exercise. | The valid local connection remains; only the missing remote handle is offered for revocation. |
| Encrypted backup | Manual Production exercise after committed and WAL-backed writes. | Backup creation checkpoints the database and writes a timestamped `.moneymap-backup` under `Documents\\Money Map Backups` without exporting the key. |
| Same-profile restore | Manual exercise after creating newer local data. | Restore validates decryption, archives the replaced database, restores the backup, and then detects any newer remote connection absent from that backup. |
| Wrong-profile or wrong-key restore | Manual exercise with an unavailable database key. | Restore is rejected without replacing the current database. |
| Reset while recovery is required | Manual Production exercise. | Reset and new Link creation remain blocked until restore or successful revocation reconciles every orphaned handle. |
| Revocation failure | Manual or mocked broker failure. | The failed handle remains in the registry and recovery mode remains active. |
| Explicit full reset | Manual exercise with a missing or unreadable database. | After explicit confirmation, all surviving remote connections are revoked before a fresh encrypted profile is created. |
| Development isolation | Manual Development reset followed by Production startup. | Development cleanup never deletes or overwrites the Production recovery registry or Production local profile. |

## Native finance capability matrix

| Scenario | Automated assertion | Required result |
| --- | --- | --- |
| Existing-profile read | Open an encrypted fixture through the strict read-only helper; attempt a write. | Queries succeed; writes fail; a missing path is never created. |
| Capability authorization | Call transaction search without the transaction scope. | The request is rejected before SQL execution. |
| Bounded pagination | Request more than the maximum page size and page a deterministic fixture. | Oversized requests fail; valid pages have stable ordering and a bounded cursor. |
| Integer cents and provenance | Query the synthetic student-loan fixture. | Signed cents remain integers and results include typed refs, source, observation date, and sync freshness. |
| Recurring evidence | Detect the synthetic monthly payment with an existing matching schedule. | The candidate cites each transaction, distinguishes settlement timing, and returns the matching schedule ref. |
| Channel parity | Run `cargo check` with default features and with `sandbox-dev`. | The same read capability contract compiles in both channels without weakening the existing environment boundary. |

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
