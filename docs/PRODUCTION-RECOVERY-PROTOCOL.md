# Production recovery protocol

This document records the recovery contract implemented by ID-82 and ID-83.

## Local profile contract

- A profile belongs to one Money Map environment, one Money Map profile identity, and the Windows profile that protects its SQLCipher key.
- Backups are created with SQLite's online backup API into a staged SQLCipher database, validated, and atomically renamed into the fixed `Documents/Money Map Backups` directory.
- Money Map validates the encryption key, profile identity, environment, integrity, foreign keys, and schema compatibility before a backup is listed or restored.
- Restore stages and validates the candidate before replacing the active database. The prior database and SQLite sidecars are archived. Backups and pre-restore archives are never deleted automatically.
- A schema migration must first create and validate an encrypted backup. Migration stops if backup creation fails.

## Authority states

The desktop compares three independent sources of evidence: profile lifecycle, the readable local database, and the Windows-credential recovery registry.

- A truly absent lifecycle, database, and registry is a first run.
- Consistent local and registry connection handles are healthy.
- A readable database may repair a missing or stale registry when the database contains the stronger evidence.
- Registry handles missing from a readable database are orphaned remote authority.
- A missing or unreadable database with recorded handles is lost local state.
- Corrupt, cross-profile, cross-environment, or otherwise contradictory evidence is unknown authority.
- Orphaned, lost, and unknown authority block new Production connections. Unknown authority also blocks destructive reset and offers no revoke shortcut because the set of remote connections cannot be proven.

## Link completion protocol

Each Link session has a D1 completion state. The broker leases a pending session before exchanging its public token. Concurrent completion receives `409` and must retry the same session. Once the exchange succeeds, one D1 `batch()` atomically creates the connection and records the encrypted, replayable connection authority on the session. A repeated completion returns the same connection ID and secret without another Plaid exchange.

If persistence fails after an exchange, the broker attempts `item/remove`. A successful compensation marks the session failed; an unsuccessful compensation marks it `recovery_required`. The desktop records the returned authority in the Windows recovery registry before inserting it into the local database. If that journal write fails, the desktop asks the broker to disconnect the new connection and refuses to proceed.

## Irreducible provider boundary

There is a small distributed-systems gap if the Worker terminates after Plaid returns an access token and before D1 persists it. The process has no durable token with which to compensate, and Plaid's public-token exchange does not provide a broker-controlled idempotency key or a lookup mechanism for recovering that response. The implementation narrows this interval, prevents concurrent/replayed exchanges during normal execution, persists replay authority atomically, and compensates every caught post-exchange failure. It does not claim crash-atomicity across Plaid and D1.

Operationally, an ambiguous completion must be treated as a recovery incident: do not start a new Link session; retry the same session, inspect the broker state and Plaid Item inventory, and revoke any unmatched Item before clearing the block.

## Release boundary

These changes do not modify an installed Production profile until a rebuilt desktop is installed and run. The D1 migration and Worker code likewise have no effect until explicitly deployed. Apply the D1 migration before deploying the Worker, then rebuild and install the desktop; do not reverse that order.
