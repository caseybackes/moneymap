# ADR 0001: Native capability layer with optional stdio MCP adapter

- Status: Proposed
- Date: 2026-08-21
- Linear: ID-91

## Context

Money Map is a local-first native application. Its Rust/Tauri process owns SQLCipher access, OS credential storage, environment separation, and financial mutations. The current renderer-oriented commands return broad UI projections and allow direct schedule creation; they are unsuitable as stable agent contracts.

The application needs an in-app conversational harness and a standards-friendly integration point without duplicating domain behavior or weakening the native security boundary.

## Decision

Implement a transport-independent capability layer inside the native Rust codebase.

Each capability has a versioned JSON Schema contract, permission class, required actor scopes, freshness behavior, pagination behavior, and compatibility metadata. Native code performs authorization, queries, proposal transitions, confirmation verification, execution, and auditing.

The in-app harness calls this layer in process through thin Tauri adapters. An optional, explicitly enabled stdio MCP adapter publishes the same registry and translates MCP messages to native requests. The first adapter will not listen on a network interface.

Implement the MCP transport as a separate Rust adapter binary or package boundary so MCP dependencies and lifecycle behavior do not enter the canonical domain module. Target the current stable MCP revision, `2026-07-28`, through RMCP 3.x, while retaining SDK-provided compatibility for legacy `2025-11-25` clients during a documented transition window. Modern clients use stateless `server/discover` plus per-request protocol metadata; legacy clients use the earlier `initialize` lifecycle. Capability authorization and profile binding are evaluated per request and never inferred from transport session state. Follow the official [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), and [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) specifications, and pin the adapter SDK through `Cargo.lock`.

Streamable HTTP, remote discovery, and OAuth are deferred. Adding them requires a separate threat model and ADR covering authentication, origin and network exposure, token lifecycle, revocation, and remote profile selection.

Mutation uses a persisted proposal lifecycle. Schedule creation produces an inert proposal containing evidence, assumptions, an effect digest, expiry, idempotency key, and record-version preconditions. The native UI creates a short-lived confirmation artifact after showing the exact effect. Execution verifies scope, artifact binding, proposal state, expiry, idempotency, and preconditions in one database transaction.

Canonical contracts remain provider-neutral and use typed opaque refs, ISO currencies with integer minor units, provenance, observed timestamps, freshness, warnings, and additive `extensions`.

## Consequences

- Tauri, MCP, and future transports share domain behavior and safety policy.
- React does not become a privileged database or credential boundary.
- MCP clients can discover capabilities without gaining SQL, shell, secrets, or arbitrary broker access.
- Read operations require bounded query APIs instead of renderer-wide ledger payloads.
- Mutations require more state and UI work: proposal persistence, confirmation artifacts, row versions, audit events, and expiry handling.
- Schema evolution and compatibility testing become release responsibilities.
- Provider-specific fields require explicit adapter mappings or optional extensions.

## Rejected alternatives

### MCP server owns domain logic

This duplicates authorization and mutation rules, creates drift from the desktop app, and risks moving SQLCipher or credential access outside the established native boundary.

### Expose existing Tauri commands directly

The commands are renderer-shaped, incompletely scoped, weakly versioned, and include a direct schedule insert path. They do not provide the evidence, freshness, pagination, proposal, or concurrency semantics required for agent use.

### General SQL or command-execution tool

It cannot enforce stable domain semantics, least privilege, provider isolation, or reviewable mutation effects. It also expands prompt-injection impact beyond the finance capability set.

### Network MCP endpoint in the first release

Remote authentication, transport security, discovery, and lifecycle management add a separate exposure surface. Stdio satisfies local interoperability while the authorization model is proven.

## Follow-up decisions

- Select the persisted record-version mechanism and audit-event representation.
- Define how an MCP process obtains a profile-bound actor grant without exposing profile secrets.
- Specify schema compatibility checks and capability deprecation windows.
- Decide whether minimized external statement facts may be imported as encrypted evidence records.
