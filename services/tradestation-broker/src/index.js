const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers ?? {}) }
});

const problem = (status, code, message) => json({ error: { code, message } }, { status });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const authorizationScopes = ["openid", "offline_access", "MarketData", "ReadAccount"];

function configured(env) {
  return Boolean(env.TRADESTATION_CLIENT_ID && env.TRADESTATION_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY && env.EXTERNAL_SETUP_KEY && env.TRADESTATION_REDIRECT_URI && env.TRADESTATION_DB);
}

function randomBase64Url(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

async function equalHash(value, expected) {
  const actual = await hash(value);
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function keyBytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function base64(value) {
  return btoa(String.fromCharCode(...value));
}

async function encrypt(value, keyText) {
  const key = await crypto.subtle.importKey("raw", keyBytes(keyText), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { ciphertext: base64(new Uint8Array(ciphertext)), iv: base64(iv) };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function requireSetupAccess(request, env) {
  const supplied = request.headers.get("x-money-map-setup-key");
  if (!configured(env)) return problem(503, "tradestation_not_configured", "TradeStation connection setup has not been configured.");
  if (!supplied || !(await equalHash(supplied, await hash(env.EXTERNAL_SETUP_KEY)))) return problem(401, "unauthorized", "A valid Money Map setup key is required.");
  return null;
}

async function exchangeAuthorizationCode(env, code) {
  const response = await fetch("https://signin.tradestation.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.TRADESTATION_CLIENT_ID,
      client_secret: env.TRADESTATION_CLIENT_SECRET,
      code,
      redirect_uri: env.TRADESTATION_REDIRECT_URI
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.refresh_token !== "string") throw new Error(`token_exchange_${body.error ?? response.status}`);
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ service: "money-map-tradestation-broker", status: "ok", configured: configured(env) });

    if (request.method === "POST" && url.pathname === "/v1/oauth/start") {
      const accessFailure = await requireSetupAccess(request, env);
      if (accessFailure) return accessFailure;
      const sessionId = crypto.randomUUID();
      const state = randomBase64Url();
      const connectionKey = randomBase64Url();
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      await env.TRADESTATION_DB.prepare("INSERT INTO oauth_sessions (id, state_hash, connection_key_hash, expires_at) VALUES (?, ?, ?, ?)")
        .bind(sessionId, await hash(state), await hash(connectionKey), expiresAt).run();
      const authorize = new URL("https://signin.tradestation.com/authorize");
      authorize.search = new URLSearchParams({ response_type: "code", client_id: env.TRADESTATION_CLIENT_ID, audience: "https://api.tradestation.com", redirect_uri: env.TRADESTATION_REDIRECT_URI, scope: authorizationScopes.join(" "), state }).toString();
      return json({ sessionId, connectionKey, authorizationUrl: authorize.toString(), expiresAt });
    }

    if (request.method === "POST" && url.pathname === "/v1/oauth/exchange") {
      if (!configured(env)) return problem(503, "tradestation_not_configured", "TradeStation connection setup has not been configured.");
      const body = await readJson(request);
      if (!body || typeof body.code !== "string" || typeof body.state !== "string" || typeof body.sessionId !== "string" || typeof body.connectionKey !== "string") return problem(400, "invalid_callback", "An authorization code, state, session ID, and connection key are required.");
      const session = await env.TRADESTATION_DB.prepare("SELECT id, connection_key_hash FROM oauth_sessions WHERE id = ? AND state_hash = ? AND status = 'pending' AND expires_at > unixepoch()")
        .bind(body.sessionId, await hash(body.state)).first();
      if (!session) return problem(400, "invalid_session", "This TradeStation connection session is missing or expired.");
      if (!(await equalHash(body.connectionKey, session.connection_key_hash))) return problem(401, "unauthorized", "This TradeStation connection session is not authorized.");
      try {
        const token = await exchangeAuthorizationCode(env, body.code);
        const encrypted = await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY);
        await env.TRADESTATION_DB.batch([
          env.TRADESTATION_DB.prepare("INSERT OR REPLACE INTO connections (id, refresh_token_ciphertext, refresh_token_iv, scopes, updated_at) VALUES (?, ?, ?, ?, unixepoch())").bind(session.id, encrypted.ciphertext, encrypted.iv, authorizationScopes.join(" ")),
          env.TRADESTATION_DB.prepare("UPDATE oauth_sessions SET status = 'complete', completed_at = unixepoch() WHERE id = ?").bind(session.id)
        ]);
        return json({ status: "complete", connectionId: session.id });
      } catch (error) {
        await env.TRADESTATION_DB.prepare("UPDATE oauth_sessions SET status = 'failed', error_code = ?, completed_at = unixepoch() WHERE id = ?").bind("token_exchange_failed", session.id).run();
        console.error(JSON.stringify({ event: "tradestation_oauth_exchange_failed", sessionId: session.id, message: String(error) }));
        return problem(502, "token_exchange_failed", "TradeStation did not complete the connection. Try again from Money Map.");
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/oauth/status/")) {
      const sessionId = url.pathname.split("/").at(-1);
      const connectionKey = request.headers.get("x-money-map-connection-key");
      if (!sessionId || !connectionKey) return problem(400, "invalid_request", "A session ID and connection key are required.");
      const session = await env.TRADESTATION_DB.prepare("SELECT status, connection_key_hash, expires_at FROM oauth_sessions WHERE id = ?").bind(sessionId).first();
      if (!session || !(await equalHash(connectionKey, session.connection_key_hash))) return problem(404, "not_found", "Connection session not found.");
      return json({ status: session.status, expiresAt: session.expires_at });
    }

    return problem(404, "not_found", "Route not found.");
  }
};
