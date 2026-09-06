# Production upgrade rehearsal scope

Status: implemented as an offline CLI/test artifact; not a release mechanism and not part of a shipping Production build.

## Objective

Create a local-only, compile-time upgrade-rehearsal channel that can exercise current Money Map Production database migrations and recovery behavior against a deterministic, synthetic encrypted profile. It must not change or read the live Production profile, recovery registry, executable, Windows credential, Cloudflare Worker, or Plaid Item.

## In scope

- A third, mutually exclusive compile-time `rehearsal` build flavor, alongside Production and Development/Sandbox. It has a dedicated application identity, local-data directory, Credential Manager namespace, title, and artifact directory.
- A standalone rehearsal binary whose source closure excludes every provider, external-link, browser-opening, updater, telemetry, localhost-listener, and network command. Rehearsal code must not construct an HTTP client or contain a usable Production, Sandbox, Plaid, TradeStation, or broker host.
- A versioned, deterministic fixture specification in Git containing only synthetic accounts, transactions, schedules, categories, expected recovery states, and a declared logical-data hash. Do not commit a database file, generated backup, database key, provider credential, or personal financial data.
- A native rehearsal-fixture generator that builds a newly keyed SQLCipher database in a new fixed-root staging directory from the tracked specification, validates it, writes a manifest, then atomically promotes the whole staging directory. It must never discover, open, checkpoint, write, rename, truncate, or replace a live Production file. Plain filesystem copying of a `.db` or WAL sidecars is prohibited.
- A rehearsal-specific Credential Manager entry created from fresh random key material. It is never derived from, or allowed to read, the Production credential. The key is never displayed, exported, logged, or written into a source file or manifest.
- The fixture may include generated opaque recovery handles solely to exercise recovery UI/gating. It contains no provider IDs, connection secrets, cursors, access tokens, institution/account identifiers, or live recovery handles. Provider UI is absent.
- A synthetic rehearsal recovery registry containing generated opaque test-only handles. It is recreated from the fixture specification in a distinct rehearsal keyring account. The live recovery registry is never read, copied, deserialized, or referenced by the rehearsal runtime. Recovery and reset paths may exercise gating and presentation against the synthetic registry but can never revoke or contact an external connection.
- Deterministic automated coverage for: existing-profile migration, backup creation, same-profile restore, unreadable/missing generated-profile detection, recovery-state selection, and reset blocking. Rehearsal backups stay inside the rehearsal root, never `Documents\Money Map Backups`.
- Automated tests that assert the rehearsal channel cannot register or invoke external-capability commands, uses distinct profile/keyring/registry/backup identities, and never resolves the Production data directory.
- A manual checklist for generating the local fixture, launching the rehearsal executable, exercising the non-network recovery paths, and discarding the rehearsal profile afterward.

## Explicitly out of scope

- Deployment of a Cloudflare Worker, any external service change, or a Plaid API request.
- Installation or replacement of the live Production executable.
- Opening, modifying, resetting, backing up, restoring, copying, or inspecting the live Production database.
- Use of the real Production recovery registry, connection secrets, or any remote connection handle by normal rehearsal runtime.
- Testing live disconnect/revocation. Those paths require a separate mocked-broker or dedicated disposable-provider plan.
- Cross-Windows-user, cross-device, or credential-loss backup recovery. Those require an intentionally designed key-export/recovery feature.
- Shipping the rehearsal identity, flags, commands, or user-facing affordances in the normal Production artifact.

## Safety invariants

1. Build flavors are exhaustively mutually exclusive: exactly one of `production`, `sandbox-dev`, or `rehearsal` must be selected. Zero or multiple flavor selections fail compilation.
2. The rehearsal build must fail closed if its identity, storage path, credential namespace, synthetic-registry fixture, or network-disable policy is ambiguous.
3. A rehearsal build must never use `com.caseybackes.moneymap` data paths or credential entries.
4. A rehearsal build must contain no usable Production, Sandbox, Plaid, TradeStation, or broker host; it omits provider modules, `reqwest`, browser handoff, listeners, and external-navigation handlers. Its CSP permits only local content and its Tauri permissions deny shell/open, remote navigation, updater, and telemetry facilities.
5. The fixture generator must create a new staging destination only. It validates SQLCipher decryption, `integrity_check`, `foreign_key_check`, schema migrations, and the declared logical-data fingerprint before atomically promoting it. It must have no code path to live Production storage.
6. No rehearsal command or fixture generator may read the Production credential. Fresh rehearsal key material necessarily exists in process memory; it must not be logged, serialized, returned through IPC, written to files, or intentionally exported. Use scoped zeroization where the keyring API permits.
7. Production builds must fail if the rehearsal feature is enabled. Rehearsal artifacts have their own identifier and artifact directory, with bundling and release publishing disabled.
8. The rehearsal root must be fixed below its application-local directory. The fixture generator creates every segment, rejects reparse points, collisions, and nonempty destinations, keeps staging/final locations on one volume, and uses a manifest with a rehearsal-profile identifier, fixture schema/version, database schema versions, and logical fingerprint.

## Acceptance evidence

- Default Production and Development/Sandbox builds retain their existing identities and command sets.
- A rehearsal build compiles from its standalone source closure. Static source and compiled-binary scans find no HTTP construction, socket API, browser handoff, revoke/disconnect action, or external-provider host.
- A generated encrypted profile opens only through the rehearsal identity, migrates successfully, matches the tracked fixture's logical-data hash, and contains no provider credential or identifier.
- Migration is idempotent across repeated launch; a forced migration failure preserves only a rehearsal diagnostic/staging copy.
- Backup/restore and unavailable-database paths operate only on rehearsal files. Each backup is bound to the rehearsal-profile UUID and manifest; restore returns expected counts/schema, rejects a wrong key/profile, retains the prior rehearsal database on failure, and documents the retained-generation policy.
- Automated tests and a manual checklist document the negative assertions above, including synthetic-registry recovery states and the cleanup/rollback path.

## Proposed design decisions for review

1. Generate fresh random SQLCipher key material into a distinct rehearsal Credential Manager entry. The fixture generator and rehearsal runtime have no dependency on the Production key entry.
2. Implement the fixture generator natively. It keeps SQLCipher and Windows credential access inside Rust while keeping the Production boundary entirely outside the code path.
3. Use synthetic recovery-registry fixtures and an injected test-only storage fault for unavailable-profile states. Never corrupt a generated fixture or use a live remote handle to test recovery.
4. Implement in this sequence: exhaustive `BuildFlavor`/build-target matrix and command/CSP policy; isolated paths, keyring, backup root, and release-pipeline exclusions; deterministic native fixture generator and manifest/hash validation; synthetic recovery fixtures; hermetic migration/restore tests and manual rehearsal checklist.
