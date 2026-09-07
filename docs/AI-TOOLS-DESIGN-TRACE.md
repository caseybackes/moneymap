# Money Map AI tools design trace

## Purpose

Capture concrete use cases against the current code before defining the in-app AI harness, MCP adapter, and repository-owned Codex skill. This is an implementation discovery record for Linear ID-91.

## Trace 1: add a missing student-loan payment schedule

### User intent

> I forgot to add my student-loan payment to Money Map. Find the latest few payments, determine the pattern, and add it to the budget as an upcoming scheduled transaction.

In current Money Map language, "budget" maps to a `scheduled_transactions` forecast entry. That mapping is user-language interpretation, not a durable domain identity: future budget envelopes, bills, obligations, and forecast events may become distinct concepts.

### Evidence available during discovery

Private Aidvantage email evidence showed a current statement and two recent payments with the same amount. The statement due date and the observed bank-settlement dates did not form a clean monthly sequence. Exact amounts, dates, account identifiers, and message references are intentionally omitted from this repository record.

These dates are different kinds of facts. A statement due date is an obligation date; a posted bank transaction is a settlement date. Money Map must retain that distinction instead of inferring that either one is the canonical recurrence anchor.

A supervised, temporary read-only inspection confirmed that the Production ledger contains two matching posted funding-account debits imported through Plaid and no matching schedule; six unrelated active schedules exist. The helper opened only the existing SQLCipher profile, enabled SQLite query-only mode, emitted no key material, and was removed immediately after the trace. Exact amounts, dates, account identifiers, and database record references remain omitted here. The native typed query surface implemented for ID-91 replaces this storage-coupled inspection pattern for future callers.

### Current code path

* Plaid Link requests only `transactions`, and the broker reads `/transactions/sync` plus cached `/accounts/get` data.
* `apply_plaid_sync_connection` normalizes Plaid transactions into the local `transactions` table. It stores a connection-scoped source, external transaction ID, provider description, normalized merchant key, signed integer cents, date, category, and pending state.
* `ledger_data` returns every transaction in one renderer-oriented response. It has no filters, pagination, provenance envelope, freshness, or stable tool schema.
* `recurring_suggestions` groups transactions by exact account, lowercased description, and exact amount. It requires three occurrences, recognizes only 6-8-day or 27-33-day averages, and returns at most eight suggestions.
* `scheduled_data` returns active transaction templates and calculates the next occurrence from recurrence plus `last_processed_occurrence`.
* `create_schedule` directly inserts a fixed-amount schedule after basic field validation.

### Why the current recurrence query misses or misstates this case

1. Only two confirmed payment emails are available in the discovery evidence.
2. June 16 to July 27 is 41 days, outside the current monthly window.
3. Plaid descriptions may vary even when the underlying payee is the same.
4. The payment amount may be stable today but change after repayment-plan recertification.
5. A due date on the 11th and a posted settlement date later in the month are different temporal roles.
6. The query does not check whether a matching active schedule already exists.
7. The result does not cite transaction IDs, dates, source, pending state, merchant resolution, or balance freshness.
8. The query supplies no confidence, amount variability, alternative cadence, or explanation.

### Proposed result for this trace

The agent should produce a reviewable schedule proposal after querying the local profile:

```json
{
  "proposalType": "schedule.create",
  "subject": {
    "kind": "obligation",
    "displayName": "Aidvantage student loan payment"
  },
  "fundingAccountRef": "resolve-from-matching-ledger-transactions",
  "startDate": null,
  "recurrence": "monthly",
  "amount": {
    "currency": "USD",
    "amountCents": null,
    "strategy": "fixed-until-reviewed",
    "resolutionStatus": "required-from-current-statement"
  },
  "evidenceRefs": [
    "external-evidence:current-servicer-statement",
    "money-map:transaction:resolve-latest-matching-payment",
    "money-map:transaction:resolve-previous-matching-payment"
  ],
  "assumptions": [
    "Use the statement due date as the forecast anchor.",
    "Use the latest repeated payment amount until a later statement changes it."
  ],
  "requiresConfirmation": true
}
```

The unresolved account reference is intentional. The app must match the actual ledger debits before rendering a confirmable proposal.

## Domain model learned from the trace

The AI-facing domain needs identities and relations beyond transaction-shaped schedules.

### Core entities

* **Account** - local financial account, with provider links and balance observations.
* **Transaction** - observed or manually recorded money movement.
* **Party** - normalized payee, payer, servicer, merchant, employer, or institution.
* **Obligation** - a bill, debt payment, premium, tax payment, or other amount due.
* **Schedule** - an expected future cash-flow rule. It may forecast an obligation but is not the obligation itself.
* **Statement** - source evidence that describes an obligation or account state for a period.
* **Observation** - a value observed at a time from a source, including balances and provider status.
* **Proposal** - a typed candidate change with evidence, assumptions, preconditions, expiry, and status.
* **Decision** - approval, rejection, correction, expiry, or execution outcome for a proposal.

### Important relations

* `Transaction --funded_by--> Account`
* `Transaction --counterparty--> Party`
* `Transaction --settles--> Obligation`
* `Obligation --payable_to--> Party`
* `Statement --asserts--> Obligation`
* `Schedule --forecasts--> Transaction`
* `Schedule --plans_for--> Obligation`
* `Proposal --supported_by--> EvidenceRef`
* `Proposal --changes--> RecordRef`
* `Decision --resolves--> Proposal`

The encrypted relational database can remain canonical. A graph view can be derived from typed records and relations. A graph database is not required for the first implementation.

## Extensibility requirements

### Versioned semantic envelope

Every tool request and result should carry:

* `schemaVersion` and `capabilityVersion`;
* stable opaque record IDs and typed record references;
* an explicit `kind` from a versioned vocabulary;
* source/provenance and observation timestamps;
* currency plus integer minor units;
* confidence and assumptions for derived facts;
* an `extensions` object for additive provider- or standard-specific fields;
* warnings for partial, stale, estimated, or conflicting data.

Use JSON Schema as the executable contract. Keep optional mappings to outside ontologies or graph vocabularies in adapters. Do not make provider payloads or a fashionable external vocabulary the canonical Money Map model.

### Capability registry

Expose discoverable capabilities instead of assuming a fixed tool list. Each capability declares:

* name, version, request schema, result schema, and pagination behavior;
* read, propose, confirm, execute, or external-effect permission class;
* required record scopes;
* freshness and consistency guarantees;
* idempotency and concurrency behavior;
* deprecation and compatibility metadata.

MCP should publish these capabilities as tools and resources. The in-app harness should call the same native capability layer directly. Other future transports should adapt the same contracts.

## First tool slice

### Read tools

* `finance.capabilities.list`
* `finance.accounts.search`
* `finance.transactions.search`
* `finance.schedules.search`
* `finance.recurring.detect`
* `finance.records.get_evidence`
* `finance.entities.resolve_party`

`finance.transactions.search` must support server-side date, amount, account, party/merchant, source, pending, and category filters with bounded pagination. Results must include source and freshness fields that `ledger_data` currently omits.

`finance.recurring.detect` must return the cited observations, amount distribution, date distribution, candidate temporal roles, matched schedules, confidence, and explanation. It must tolerate merchant aliases and variable amounts.

### Proposal and mutation tools

* `finance.proposals.create_schedule`
* `finance.proposals.get`
* `finance.proposals.reject`
* `finance.proposals.execute_confirmed`

The creation tool writes a proposal, not a schedule. Execution requires a short-lived confirmation artifact created by Money Map after the native app renders the exact before/after change. Proposals carry precondition versions, expiry, and idempotency keys. Execution rechecks the preconditions inside one database transaction.

Provider connection changes, payments, transfers, trades, messages, and other external effects remain absent from the first capability set.

## MCP, harness, skill, and scripts

### Native harness

Own domain queries, proposals, confirmation, execution, audit, authorization, and encrypted storage in Rust. Keep the React layer responsible for rendering chat, evidence, and confirmation state.

### MCP adapter

Expose the native capability registry over an opt-in loopback-only MCP server. Default to read and propose scopes. Never expose SQL, the SQLCipher key, provider tokens, broker secrets, or a generic command executor.

### Repository-owned skill

Place the future skill under `skills/money-map-finance/`. Keep `SKILL.md` concise and route detailed material to:

* `references/capability-contract.md`
* `references/domain-model.md`
* `references/financial-safety.md`
* `references/use-cases.md`

The skill should teach the workflow: discover capabilities, query bounded evidence, resolve ambiguity, cite records, create a proposal, wait for native confirmation, execute only the confirmed proposal, and verify the resulting projection.

### Deterministic scripts

Repository-owned scripts should validate and generate contracts rather than contain personal finance data or decision logic. Initial candidates:

* validate JSON Schemas and compatibility rules;
* generate MCP tool descriptors from the capability registry;
* run contract fixtures and redaction checks;
* verify every mutating capability requires a proposal and confirmation artifact;
* detect breaking schema changes and stale skill references in CI.

## Decisions and open questions from Trace 1

### Decisions

1. Treat MCP as a transport adapter over a native domain capability layer.
2. Treat the Codex skill as orchestration and safety knowledge stored with the codebase.
3. Keep canonical facts and relations in encrypted local storage; derive graph projections.
4. Separate bills/obligations, observed payments, and forecast schedules.
5. Make recurring detection evidence-producing and ontology-aware.
6. Require proposals and native confirmation for every financial-record mutation.

### Open questions

1. Should an obligation support statement-specific variable amounts while its schedule stores only an expected amount policy?
2. Should external evidence such as Gmail remain an ephemeral citation, or may a user import a minimized statement fact into the encrypted profile?
3. Which party-resolution fields should be retained from Plaid before merchant normalization loses information?
4. How should schedule matching handle a due date, autopay initiation date, and bank settlement date that differ?
5. What record-version mechanism should back proposal preconditions: row versions, updated timestamps, or an append-only change sequence?
6. Which graph interchange mappings are useful enough to maintain without constraining the canonical schema?
