# Money Map TradeStation broker

This Cloudflare Worker is the dedicated secret boundary for Money Map's future **read-only TradeStation** connection. It is intentionally separate from the Plaid broker.

Use a separate Worker and D1 database for each environment. `wrangler.sim.jsonc.example` defines the Dev/SIM broker consumed only by Money Map Dev; it must be deployed before the desktop SIM connection control can be tested. Keep it distinct from the existing production broker and give it distinct setup/encryption secrets.

## Security model

- TradeStation's client secret, the Worker encryption key, and the Money Map setup key exist only as Cloudflare Worker secrets.
- The Worker encrypts TradeStation refresh tokens in its dedicated D1 database with AES-GCM.
- The desktop app receives a time-limited browser authorization URL and a one-time connection key. It never receives the TradeStation client secret or refresh token.
- OAuth asks only for `openid`, `offline_access`, `MarketData`, and `ReadAccount`. No trade/order scope is requested or implemented.
- `/health` remains public and reports configuration status without exposing secrets. All OAuth-start operations require the desktop setup key.

## Deployment sequence

1. Deploy this Worker and apply its D1 migration.
2. The desktop uses TradeStation's default permitted local callback: `http://localhost:31022`. It receives the authorization code locally and posts it to this Worker for exchange; no Cloudflare callback URL needs to be registered with TradeStation.
3. Add these Cloudflare secrets interactively. Do not place their values in source, an `.env` file, logs, or chat:
   - `TRADESTATION_CLIENT_ID`
   - `TRADESTATION_CLIENT_SECRET`
   - `TOKEN_ENCRYPTION_KEY` — a 32-byte base64 encryption key
   - `EXTERNAL_SETUP_KEY` — a high-entropy Money Map device-to-broker setup key
4. The desktop integration will call `POST /v1/oauth/start`, open the returned authorization URL, receive the browser redirect on `localhost:31022`, post it to `/v1/oauth/exchange`, then poll `/v1/oauth/status/:sessionId` with its one-time connection key.

The Worker currently implements secure authorization setup only. Read-only account, position, balance, and history endpoints are added after a successful connection test confirms the exact TradeStation response model for this account.
