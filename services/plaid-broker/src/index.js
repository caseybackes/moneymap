const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(init.headers ?? {})
  }
});

const problem = (status, code, message) => json({ error: { code, message } }, { status });

const page = (title, body) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{max-width:46rem;margin:4rem auto;padding:0 1.5rem;font:16px/1.55 system-ui,sans-serif;color:#18212f}h1{line-height:1.15}a{color:#0759b4}</style></head>
<body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const sandboxUrl = "https://sandbox.plaid.com";

function requirePlaid(env) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.BROKER_DB) {
    return problem(503, "plaid_not_configured", "Plaid sandbox has not been configured.");
  }

  return null;
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function bytesBase64(value) {
  return btoa(String.fromCharCode(...value));
}

function randomSecret() {
  return bytesBase64(crypto.getRandomValues(new Uint8Array(32)));
}

async function secretHash(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return bytesBase64(new Uint8Array(digest));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function encryptToken(token, keyText) {
  const key = await crypto.subtle.importKey("raw", base64Bytes(keyText), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { ciphertext: bytesBase64(new Uint8Array(ciphertext)), iv: bytesBase64(iv) };
}

async function decryptToken(ciphertext, iv, keyText) {
  const key = await crypto.subtle.importKey("raw", base64Bytes(keyText), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64Bytes(iv) }, key, base64Bytes(ciphertext));
  return new TextDecoder().decode(plaintext);
}

async function plaidPost(env, path, body) {
  const response = await fetch(`${sandboxUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body })
  });

  const responseBody = await response.json();
  if (!response.ok) {
    throw new Error(`Plaid request failed: ${responseBody.error_code ?? response.status}`);
  }

  return responseBody;
}

async function getConnection(env, id) {
  return env.BROKER_DB.prepare(`SELECT id, plaid_item_id, institution_id, institution_name,
    access_token_ciphertext, access_token_iv, owner_secret_hash, sync_cursor, environment
    FROM connections WHERE id = ?`).bind(id).first();
}

async function syncTransactions(env, connection) {
  const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
  const originalCursor = connection.sync_cursor ?? undefined;
  let cursor = originalCursor;
  const added = [];
  const modified = [];
  const removed = [];

  do {
    const result = await plaidPost(env, "/transactions/sync", { access_token: accessToken, ...(cursor ? { cursor } : {}) });
    added.push(...result.added);
    modified.push(...result.modified);
    removed.push(...result.removed);
    cursor = result.next_cursor;
    if (!result.has_more) {
      await env.BROKER_DB.prepare("UPDATE connections SET sync_cursor = ?, updated_at = unixepoch() WHERE id = ?").bind(cursor, connection.id).run();
      return { added, modified, removed, nextCursor: cursor };
    }
  } while (true);
}

async function getAccounts(env, connection) {
  const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
  const result = await plaidPost(env, "/accounts/get", { access_token: accessToken });
  return result.accounts ?? [];
}

function authorize(request, env) {
  if (!env.BROKER_API_TOKEN) {
    return problem(503, "broker_not_configured", "The broker has not been configured.");
  }

  if (request.headers.get("authorization") !== `Bearer ${env.BROKER_API_TOKEN}`) {
    return problem(401, "unauthorized", "A valid broker token is required.");
  }

  return null;
}

function notImplemented() {
  return problem(501, "not_configured", "Plaid access is not configured yet.");
}

async function authorizeSandboxConnection(request, connection) {
  const presented = request.headers.get("x-family-finance-connection-key");
  if (!presented || !connection.owner_secret_hash) return false;
  return (await secretHash(presented)) === connection.owner_secret_hash;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sandboxRoute = url.pathname.startsWith("/v1/sandbox/");
    if (sandboxRoute && env.APP_ENVIRONMENT !== "sandbox") {
      return problem(404, "sandbox_unavailable", "Sandbox routes are unavailable in this environment.");
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "money-map-broker-dev", status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return page("Money Map Dev", `<h1>Money Map Dev</h1>
        <p>Money Map Dev is a private desktop budgeting application for individual financial tracking. This Sandbox service supports development-only account connections.</p>
        <p><a href="/privacy">Privacy</a> · <a href="mailto:cloud-admin@caseybackes.com">Contact</a></p>`);
    }

    if (request.method === "GET" && url.pathname === "/privacy") {
      return page("Money Map Dev privacy", `<h1>Privacy</h1>
        <p>Money Map is a private local-first budgeting application. Financial-account connection credentials are entered only through Plaid Link and are not received or stored by Money Map.</p>
        <p>When a connection is enabled, this service stores an encrypted Plaid access token and the minimum connection metadata needed to import account and transaction data. The desktop application stores the imported budgeting data locally on the user's device.</p>
        <p>Connection data is used only to provide account synchronization for the connected household. It is not sold or used for advertising. Disconnecting an institution removes its stored Plaid access token and ends further synchronization.</p>
        <p>Questions: <a href="mailto:cloud-admin@caseybackes.com">cloud-admin@caseybackes.com</a>.</p>`);
    }

    if (!url.pathname.startsWith("/v1/")) {
      return problem(404, "not_found", "Route not found.");
    }

    // Temporary, deliberately sandbox-only desktop integration path. It exposes
    // generated Plaid test records only; it never returns credentials or accepts
    // a real Item. Production Link uses authenticated profile endpoints.
    if (request.method === "GET" && url.pathname === "/v1/sandbox/demo-transactions") {
      if (!env.BROKER_DB) return problem(503, "broker_not_configured", "The broker has not been configured.");
      const connection = await env.BROKER_DB.prepare(`SELECT id, plaid_item_id, institution_name, access_token_ciphertext, access_token_iv, sync_cursor
        FROM connections WHERE environment = 'sandbox' ORDER BY created_at DESC LIMIT 1`).first();
      if (!connection) return problem(404, "sandbox_connection_not_found", "Create a Plaid Sandbox connection first.");
      try {
        // Rehydrate the fixed test fixture on every explicit desktop import.
        // Local de-duplication, keyed by Plaid transaction id, makes this idempotent.
        connection.sync_cursor = null;
        const synced = await syncTransactions(env, connection);
        const accounts = await getAccounts(env, connection);
        return json({ connection: { id: connection.id, institutionName: connection.institution_name }, accounts, ...synced });
      } catch {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox sync failed.");
      }
    }

    // Sandbox Link is deliberately isolated from real-bank access. Link token
    // creation issues a one-time broker session; the session secret is needed
    // to complete and later synchronize this specific Sandbox Item.
    if (request.method === "POST" && url.pathname === "/v1/sandbox/link-token") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      try {
        const sessionId = crypto.randomUUID();
        const sessionSecret = randomSecret();
        await env.BROKER_DB.prepare(`INSERT INTO sandbox_link_sessions(id, secret_hash, expires_at)
          VALUES (?, ?, unixepoch() + 14400)`).bind(sessionId, await secretHash(sessionSecret)).run();
        const result = await plaidPost(env, "/link/token/create", {
          client_name: "Money Map Dev Sandbox",
          language: "en",
          country_codes: ["US"],
          products: ["transactions"],
          transactions: { days_requested: 180 },
          user: { client_user_id: `sandbox-${sessionId}` }
        });
        return json({ linkToken: result.link_token, expiration: result.expiration, sessionId, sessionSecret });
      } catch {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox did not create a Link token.");
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/sandbox/link-complete") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      const body = await readJson(request);
      if (!body?.sessionId || !body?.sessionSecret || !body?.publicToken) {
        return problem(400, "invalid_request", "A Sandbox session and Plaid public token are required.");
      }
      const session = await env.BROKER_DB.prepare(`SELECT id, secret_hash FROM sandbox_link_sessions
        WHERE id = ? AND expires_at > unixepoch()`).bind(body.sessionId).first();
      if (!session || (await secretHash(body.sessionSecret)) !== session.secret_hash) {
        return problem(401, "invalid_sandbox_session", "The Sandbox Link session is invalid or expired.");
      }
      try {
        const exchange = await plaidPost(env, "/item/public_token/exchange", { public_token: body.publicToken });
        const institution = body.institution ?? {};
        const encrypted = await encryptToken(exchange.access_token, env.TOKEN_ENCRYPTION_KEY);
        const connectionId = crypto.randomUUID();
        const connectionSecret = randomSecret();
        await env.BROKER_DB.prepare(`INSERT INTO connections
          (id, plaid_item_id, institution_id, institution_name, access_token_ciphertext, access_token_iv, owner_secret_hash, environment)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'sandbox')`).bind(
          connectionId,
          exchange.item_id,
          typeof institution.institution_id === "string" ? institution.institution_id : "sandbox-link",
          typeof institution.name === "string" ? institution.name : "Plaid Sandbox institution",
          encrypted.ciphertext,
          encrypted.iv,
          await secretHash(connectionSecret)
        ).run();
        await env.BROKER_DB.prepare("DELETE FROM sandbox_link_sessions WHERE id = ?").bind(session.id).run();
        return json({ connection: {
          id: connectionId,
          institutionName: typeof institution.name === "string" ? institution.name : "Plaid Sandbox institution",
          connectionSecret,
          environment: "sandbox"
        } }, { status: 201 });
      } catch {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox could not complete Link.");
      }
    }

    const sandboxConnectionMatch = /^\/v1\/sandbox\/connections\/([^/]+)\/(sync|disconnect)$/.exec(url.pathname);
    if (sandboxConnectionMatch && request.method === "POST") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      const [, connectionId, operation] = sandboxConnectionMatch;
      const connection = await getConnection(env, connectionId);
      if (!connection || connection.environment !== "sandbox") return problem(404, "connection_not_found", "Sandbox connection not found.");
      if (!(await authorizeSandboxConnection(request, connection))) return problem(401, "unauthorized", "This Sandbox connection requires its local connection key.");
      try {
        if (operation === "sync") {
          const synced = await syncTransactions(env, connection);
          return json({ connection: { id: connection.id, institutionName: connection.institution_name, environment: "sandbox" }, accounts: await getAccounts(env, connection), ...synced });
        }
        const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
        await plaidPost(env, "/item/remove", { access_token: accessToken });
        await env.BROKER_DB.prepare("DELETE FROM connections WHERE id = ?").bind(connectionId).run();
        return new Response(null, { status: 204 });
      } catch {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox request failed.");
      }
    }

    const authFailure = authorize(request, env);
    if (authFailure) {
      return authFailure;
    }

    if (request.method === "POST" && url.pathname === "/v1/sandbox/bootstrap") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;

      try {
        const publicToken = await plaidPost(env, "/sandbox/public_token/create", {
          institution_id: "ins_109508",
          initial_products: ["transactions"],
          options: { override_username: "user_transactions_dynamic", override_password: "pass_good" }
        });
        const exchange = await plaidPost(env, "/item/public_token/exchange", { public_token: publicToken.public_token });
        const encrypted = await encryptToken(exchange.access_token, env.TOKEN_ENCRYPTION_KEY);
        const id = crypto.randomUUID();
        await env.BROKER_DB.prepare(`INSERT INTO connections
          (id, plaid_item_id, institution_id, institution_name, access_token_ciphertext, access_token_iv, environment)
          VALUES (?, ?, ?, ?, ?, ?, 'sandbox')`).bind(
          id, exchange.item_id, "ins_109508", "First Platypus Bank", encrypted.ciphertext, encrypted.iv).run();
        return json({ connection: { id, institutionName: "First Platypus Bank", environment: "sandbox" } }, { status: 201 });
      } catch (error) {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox did not create a test connection.");
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/connections") {
      if (!env.BROKER_DB) return problem(503, "broker_not_configured", "The broker has not been configured.");
      const result = await env.BROKER_DB.prepare(`SELECT id, institution_id, institution_name, environment, created_at, updated_at
        FROM connections ORDER BY created_at DESC`).all();
      return json({ connections: result.results });
    }

    const connectionMatch = /^\/v1\/connections\/([^/]+)\/(sync|disconnect)$/.exec(url.pathname);
    if (connectionMatch && request.method === "POST") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      const [, connectionId, operation] = connectionMatch;
      const connection = await getConnection(env, connectionId);
      if (!connection) return problem(404, "connection_not_found", "Connection not found.");

      try {
        if (operation === "sync") {
          return json(await syncTransactions(env, connection));
        }

        const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
        await plaidPost(env, "/item/remove", { access_token: accessToken });
        await env.BROKER_DB.prepare("DELETE FROM connections WHERE id = ?").bind(connectionId).run();
        return new Response(null, { status: 204 });
      } catch (error) {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox request failed.");
      }
    }

    // These routes remain closed until their secrets, token store, and Plaid
    // integration are deployed together. Never log request bodies or authorization headers.
    if (
      (request.method === "POST" && url.pathname === "/v1/link/session") ||
      (request.method === "POST" && url.pathname === "/v1/link/complete") ||
      (request.method === "POST" && url.pathname === "/v1/sync") ||
      (request.method === "POST" && /^\/v1\/items\/[^/]+\/disconnect$/.test(url.pathname))
    ) {
      return notImplemented();
    }

    return problem(404, "not_found", "Route not found.");
  }
};
