# Schedule proposal lifecycle

Status: implemented and exercised end to end through Linear ID-113

## Boundary

Schedule creation and update use one persisted lifecycle. An agent-facing caller may create, read, reject, or execute a proposal within its granted scopes. Confirmation is deliberately absent from the capability registry. Only the native user-confirmation adapter can create a two-minute confirmation artifact, after the application has rendered the exact proposal version and effect digest.

The lifecycle is:

`proposed -> approved -> executed`

Terminal alternatives are `rejected`, `expired`, `stale`, and `failed`. Every transition appends an audit event inside the same database transaction as the state change. The schedule mutation, executed state, consumed confirmation artifact, audit event, and idempotent outcome are committed atomically.

## Persisted data

Schema migration 11 adds four encrypted-profile tables:

- `finance_proposals` stores the exact before payload (or `null` for creation), after/effect payload, evidence, assumptions, canonical preconditions, actor identity/type, effect and request digests, timestamps, state, version, and result.
- `finance_confirmation_artifacts` binds one short-lived native confirmation to the profile, proposal version, confirming user, and effect digest.
- `finance_audit_events` records lifecycle transitions and minimized outcome metadata. It does not store credentials or provider payloads.
- `finance_execution_outcomes` binds an execution idempotency key to its original schedule and audit result.

## Concurrency and stale-data policy

Record versions are SHA-256 content fingerprints over the fields that define an account, transaction observation, or schedule. This avoids adding and maintaining a mutable row-version column across every existing writer. Proposal creation resolves the current account, evidence, and optional target schedule into canonical preconditions. Execution recalculates every fingerprint under a SQLite `IMMEDIATE` transaction.

If any record changed or disappeared, execution persists `stale` and creates no schedule. Concurrent confirmations serialize; exactly one caller can move the expected proposal version from `proposed` to `approved`. A repeated execution with the same idempotency key returns the original result without applying the mutation again.

## Current schedule-model limits

The lifecycle supports create and update for the cadences already represented by Money Map: daily, weekly, biweekly, monthly, quarterly, and annual/yearly. Amounts enter the proposal as a non-negative USD magnitude plus an explicit inflow/outflow direction, then map to the ledger's signed integer cents at execution.

`amountPolicy` and `temporalRole` are persisted because the review UI must distinguish estimates, statement amounts, due dates, autopay dates, and observed settlement timing. The current schedule table still stores one signed amount and one anchor date. ID-112 should show those semantics during review; later domain expansion can add obligation- or statement-specific fields without weakening this lifecycle.

## Downstream contract

The native recurring-review surface:

1. render `before`, `effect`, evidence, assumptions, expiry, and effect digest;
2. call the native confirmation adapter only from an explicit user action;
3. use the returned approved proposal version and artifact unchanged during execution;
4. treat expired, stale, rejected, and failed proposals as non-executable and explain the recorded state;
5. refresh the schedules projection after an executed result.

The complete detect-to-review-to-confirm-to-execute path is covered by the versioned synthetic fixture and lifecycle suites described in [`RECURRING-BILL-VERTICAL-SLICE.md`](RECURRING-BILL-VERTICAL-SLICE.md). These tests require no Plaid credential or Production profile.
