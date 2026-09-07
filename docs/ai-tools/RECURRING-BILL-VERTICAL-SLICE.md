# Recurring bill vertical slice

Status: implemented for Linear ID-113

## Delivered native path

Money Map can detect a recurring posted bill, show the exact observations behind it, distinguish an existing schedule match from a missing schedule, let the user correct the proposed schedule, and persist an inert proposal. The native review surface renders the proposed effect, assumptions, evidence, expiry, and effect digest before explicit confirmation. Execution revalidates the confirmed proposal and commits the schedule, audit event, confirmation consumption, and idempotent outcome atomically.

This path is local and deterministic. It needs no Plaid credential, provider request, deployed Worker, Production profile, model call, memory store, or external adapter. It runs against the existing encrypted profile in the normal app and against an in-memory database in tests.

## Detection boundaries

The current detector groups observations by account and normalized provider merchant key, falling back to description where that field is unavailable. It only scans posted, non-scheduled outflows. A transaction categorized as a transfer is excluded. Positive refunds and pending transactions are excluded. These rules keep transfers and reversals from becoming bill candidates while retaining variable bill amounts and provider description variants under one candidate.

Candidates expose signed integer-cent minimum, median, and maximum amounts. Dates describe observed settlement timing; they do not claim a statement due date. Existing active schedules are returned as matches for review rather than silently duplicated. The user remains responsible for accepting or correcting cadence, amount, and date.

## Versioned synthetic fixture

`test-fixtures/recurring-bill/v1/data.json` is a small, wholly synthetic fixture tracked in Git. Its manifest fixes fixture format version 1 and the exact SHA-256 digest `faf6b26888aeb25f1cdf10b88ffec488b19a3ecd2f4d1aceda80a4cc7d2535a2` over canonical LF UTF-8 content, independent of platform checkout line endings.

The fixture covers:

- no existing schedule for a variable monthly electric bill;
- one existing matching rent schedule;
- description variants sharing one merchant key;
- a positive refund, pending charge, and recurring transfer that must not become evidence;
- integer-cent amount distribution and a deterministic next expected settlement date.

Rust tests verify the manifest hash and detector outcomes. `node .\scripts\verify-recurring-bill-fixture.mjs` provides a fast repository-level integrity check. Proposal tests separately cover approval, rejection, expiry, stale evidence, fabricated-confirmation bypass, concurrency, atomic execution, and idempotent replay.

## Deferred layers

An MCP adapter remains deferred. When added, it must be a disabled-by-default transport over these same native capabilities and must not gain SQL, shell, confirmation, provider-secret, or direct mutation access. Model orchestration, conversational memory, reusable skills, and broader AI analysis are also separate future slices. None is required for recurring review to work in the desktop application.

## Safety and release impact

The tests do not open Plaid Link, call Plaid, read a provider API key, deploy a Worker, access a Production profile, build an installer, or replace an installed executable. Shipping this slice to an existing installation requires a new desktop build; that normal application startup will apply the already-defined local proposal-table migration to the encrypted profile. The current installed Production executable and its data are unchanged until the user deliberately installs a later build.
