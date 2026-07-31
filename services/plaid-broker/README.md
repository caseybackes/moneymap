# Family Finance Plaid Broker

This Cloudflare Worker is the remote security boundary for Plaid. The desktop app must never contain the Plaid secret or long-lived Plaid access tokens.

## Initial deployment

The first deployment exposes `GET /health`, a project page, and privacy page. Plaid Sandbox routes remain unavailable until Cloudflare secrets and the D1 database are configured.

1. Create the Worker named `family-finance-broker` in Cloudflare.
2. Deploy this source with Wrangler.
3. Confirm `https://<worker>.workers.dev/health` returns JSON with `status: "ok"`.

Do not add a Plaid secret, Plaid access token, or broker API token to source control or chat.

## Planned secret configuration

Cloudflare Worker secrets, set only through the dashboard or Wrangler:

- `BROKER_API_TOKEN` — per-install authenticated API credential.
- `PLAID_CLIENT_ID` — Plaid application identifier.
- `PLAID_SECRET` — Plaid application secret.
- `TOKEN_ENCRYPTION_KEY` — 32-byte random key used to encrypt stored Plaid Item tokens.

The worker binds a D1 database for encrypted token records and sync cursors. It never stores bank credentials.

## Sandbox test path

The React/Tauri app uses the isolated Sandbox Link lifecycle:

1. `POST /v1/sandbox/link-token` returns a short-lived Plaid Link token plus a one-time Sandbox session id and secret.
2. Plaid Link returns a short-lived public token to the desktop app.
3. `POST /v1/sandbox/link-complete` exchanges that public token at the broker, encrypts the resulting Plaid access token in D1, and returns a new per-connection key.
4. `POST /v1/sandbox/connections/{id}/sync` requires `x-family-finance-connection-key` and returns account and transaction changes for that connection.

The connection key is retained only in the encrypted desktop database. These routes are strictly Sandbox-only and do not authorize a real-bank Item.

`POST /v1/sandbox/bootstrap` remains an authenticated developer fixture that creates First Platypus Bank records using Plaid's `user_transactions_dynamic` persona. It consumes no Production Trial Item.
