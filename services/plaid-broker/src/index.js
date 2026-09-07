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

const plaidUrls = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com"
};

function appEnvironment(env) {
  if (env.APP_ENVIRONMENT !== "sandbox" && env.APP_ENVIRONMENT !== "production") {
    throw new Error('APP_ENVIRONMENT must be exactly "sandbox" or "production".');
  }
  return env.APP_ENVIRONMENT;
}

function plaidUrl(env) {
  return plaidUrls[appEnvironment(env)];
}

export function accountSelectionLinkTokenRequest(environment, connectionId, accessToken) {
  return {
    client_name: environment === "sandbox" ? "Money Map Dev Sandbox" : "Money Map",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: `${environment}-connection-${connectionId}` },
    access_token: accessToken,
    update: { account_selection_enabled: true }
  };
}

function requirePlaid(env) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.BROKER_DB) {
    return problem(503, "plaid_not_configured", "Plaid has not been configured for this environment.");
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
  const response = await fetch(`${plaidUrl(env)}${path}`, {
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
    access_token_ciphertext, access_token_iv, owner_secret_hash, sync_cursor, environment,
    transactions_update_status, sync_operation_state, sync_started_at
    FROM connections WHERE id = ?`).bind(id).first();
}

export function transactionSyncState(status, operation = "idle") {
  const transactionsStatus = status || "TRANSACTIONS_UPDATE_STATUS_UNKNOWN";
  const initialUpdateComplete = transactionsStatus === "INITIAL_UPDATE_COMPLETE" || transactionsStatus === "HISTORICAL_UPDATE_COMPLETE";
  const historicalUpdateComplete = transactionsStatus === "HISTORICAL_UPDATE_COMPLETE";
  return {
    operation,
    transactionsStatus,
    initialUpdateComplete,
    historicalUpdateComplete,
    pending: operation === "syncing" || !historicalUpdateComplete
  };
}

async function syncTransactions(env, connection) {
  // Startup and user-triggered refreshes can overlap. Acquire a two-minute
  // lease before contacting Plaid; a stale lease may be reclaimed after a
  // Worker interruption.
  const lease = await env.BROKER_DB.prepare(`UPDATE connections
    SET sync_operation_state = 'syncing', sync_started_at = unixepoch(), last_sync_error = NULL
    WHERE id = ? AND (sync_operation_state <> 'syncing' OR sync_started_at IS NULL OR sync_started_at < unixepoch() - 120)`)
    .bind(connection.id).run();
  if ((lease.meta?.changes ?? 0) === 0) {
    return {
      added: [], modified: [], removed: [], nextCursor: connection.sync_cursor ?? null,
      syncState: transactionSyncState(connection.transactions_update_status, "syncing")
    };
  }

  const added = [];
  const modified = [];
  const removed = [];
  let cursor = connection.sync_cursor ?? undefined;
  let updateStatus = connection.transactions_update_status ?? "TRANSACTIONS_UPDATE_STATUS_UNKNOWN";

  try {
    const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
    do {
      const result = await plaidPost(env, "/transactions/sync", {
        access_token: accessToken,
        ...(cursor !== null && cursor !== undefined ? { cursor } : {})
      });
      added.push(...(result.added ?? []));
      modified.push(...(result.modified ?? []));
      removed.push(...(result.removed ?? []));
      cursor = result.next_cursor;
      updateStatus = result.transactions_update_status ?? updateStatus;
      if (!result.has_more) break;
    } while (true);

    // Commit the cursor only after the complete page sequence. This prevents a
    // failed partial run from skipping changes on the next attempt.
    await env.BROKER_DB.prepare(`UPDATE connections
      SET sync_cursor = ?, transactions_update_status = ?, sync_operation_state = 'idle',
          sync_started_at = NULL, last_transaction_sync_at = unixepoch(), last_sync_error = NULL,
          updated_at = unixepoch()
      WHERE id = ?`).bind(cursor, updateStatus, connection.id).run();
    return {
      added, modified, removed, nextCursor: cursor,
      syncState: transactionSyncState(updateStatus)
    };
  } catch (error) {
    const failure = error instanceof Error ? error.message.slice(0, 160) : "Plaid transaction sync failed";
    await env.BROKER_DB.prepare(`UPDATE connections
      SET sync_operation_state = 'error', sync_started_at = NULL, last_sync_error = ?, updated_at = unixepoch()
      WHERE id = ?`).bind(failure, connection.id).run();
    throw error;
  }
}

async function getAccounts(env, connection) {
  const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
  const result = await plaidPost(env, "/accounts/get", { access_token: accessToken });
  // This is Plaid's free, cached account-data endpoint. Do not substitute
  // /accounts/balance/get here: that endpoint forces a real-time extraction
  // and is billed separately. The desktop records both the provider timestamp
  // (when available) and when Money Map retrieved this cached snapshot.
  return {
    accounts: result.accounts ?? [],
    balanceSource: "cached_accounts_get",
    balanceFetchedAt: new Date().toISOString()
  };
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

async function authorizeConnection(request, connection) {
  const presented = request.headers.get("x-money-map-connection-key");
  if (!presented || !connection.owner_secret_hash) return false;
  return (await secretHash(presented)) === connection.owner_secret_hash;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "money-map-plaid-broker", status: "ok" });
    }

    let environment;
    try {
      environment = appEnvironment(env);
    } catch (error) {
      return problem(500, "invalid_environment", error instanceof Error ? error.message : String(error));
    }

    const sandboxRoute = url.pathname.startsWith("/v1/sandbox/");
    if (sandboxRoute && environment !== "sandbox") {
      return problem(404, "sandbox_unavailable", "Sandbox routes are unavailable in this environment.");
    }

    if (request.method === "GET" && url.pathname === "/") {
      const title = environment === "sandbox" ? "Money Map Dev" : "Money Map";
      const description = environment === "sandbox"
        ? "This Sandbox service supports development-only account connections."
        : "This service securely brokers user-authorized financial account connections for Money Map.";
      return page(title, `<h1>${title}</h1>
        <p>Money Map is a private, local-first desktop finance application. ${description}</p>
        <p><a href="/privacy">Privacy</a> · <a href="mailto:cloud-admin@caseybackes.com">Contact</a></p>`);
    }

    if (request.method === "GET" && url.pathname === "/privacy") {
      return page(`${environment === "sandbox" ? "Money Map Dev" : "Money Map"} privacy`, `<h1>Privacy</h1>
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
        const accountSnapshot = await getAccounts(env, connection);
        return json({ connection: { id: connection.id, institutionName: connection.institution_name }, ...accountSnapshot, ...synced });
      } catch {
        return problem(502, "plaid_sandbox_error", "Plaid Sandbox sync failed.");
      }
    }

    // Each deployment has an isolated Plaid environment, D1 database, and
    // encryption key. A one-time session secret authorizes Link completion;
    // a distinct per-connection secret authorizes later sync and disconnect.
    const linkTokenRoute = url.pathname === "/v1/link-token" || url.pathname === "/v1/sandbox/link-token";
    if (request.method === "POST" && linkTokenRoute) {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      try {
        const sessionId = crypto.randomUUID();
        const sessionSecret = randomSecret();
        await env.BROKER_DB.prepare(`INSERT INTO sandbox_link_sessions(id, secret_hash, expires_at)
          VALUES (?, ?, unixepoch() + 14400)`).bind(sessionId, await secretHash(sessionSecret)).run();
        const result = await plaidPost(env, "/link/token/create", {
          client_name: environment === "sandbox" ? "Money Map Dev Sandbox" : "Money Map",
          language: "en",
          country_codes: ["US"],
          products: ["transactions"],
          transactions: { days_requested: 180 },
          user: { client_user_id: `${environment}-${sessionId}` }
        });
        return json({ linkToken: result.link_token, expiration: result.expiration, sessionId, sessionSecret });
      } catch {
        return problem(502, "plaid_error", "Plaid did not create a Link token.");
      }
    }

    const linkCompleteRoute = url.pathname === "/v1/link-complete" || url.pathname === "/v1/sandbox/link-complete";
    if (request.method === "POST" && linkCompleteRoute) {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      const body = await readJson(request);
      if (!body?.sessionId || !body?.sessionSecret || !body?.publicToken) {
        return problem(400, "invalid_request", "A Link session and Plaid public token are required.");
      }
      let session = await env.BROKER_DB.prepare(`SELECT id, secret_hash, completion_state, completion_started_at,
        completed_connection_id, completed_secret_ciphertext, completed_secret_iv, completed_institution_name
        FROM sandbox_link_sessions
        WHERE id = ? AND expires_at > unixepoch()`).bind(body.sessionId).first();
      if (!session || (await secretHash(body.sessionSecret)) !== session.secret_hash) {
        return problem(401, "invalid_link_session", "The Link session is invalid or expired.");
      }
      if (session.completion_state === "completed") {
        const connectionSecret = await decryptToken(session.completed_secret_ciphertext, session.completed_secret_iv, env.TOKEN_ENCRYPTION_KEY);
        return json({ connection: {
          id: session.completed_connection_id,
          institutionName: session.completed_institution_name,
          connectionSecret,
          environment
        }, replayed: true });
      }
      const claim = await env.BROKER_DB.prepare(`UPDATE sandbox_link_sessions
        SET completion_state = 'completing', completion_started_at = unixepoch()
        WHERE id = ? AND (completion_state = 'pending' OR (completion_state = 'completing' AND completion_started_at < unixepoch() - 120))`)
        .bind(session.id).run();
      if ((claim.meta?.changes ?? 0) === 0) {
        session = await env.BROKER_DB.prepare(`SELECT completion_state, completed_connection_id,
          completed_secret_ciphertext, completed_secret_iv, completed_institution_name
          FROM sandbox_link_sessions WHERE id = ?`).bind(session.id).first();
        if (session?.completion_state === "completed") {
          const connectionSecret = await decryptToken(session.completed_secret_ciphertext, session.completed_secret_iv, env.TOKEN_ENCRYPTION_KEY);
          return json({ connection: { id: session.completed_connection_id, institutionName: session.completed_institution_name, connectionSecret, environment }, replayed: true });
        }
        return problem(409, "link_completion_in_progress", "This Link completion is already in progress. Retry the same session.");
      }
      let exchangedAccessToken = null;
      try {
        const exchange = await plaidPost(env, "/item/public_token/exchange", { public_token: body.publicToken });
        exchangedAccessToken = exchange.access_token;
        const institution = body.institution ?? {};
        const encrypted = await encryptToken(exchange.access_token, env.TOKEN_ENCRYPTION_KEY);
        const connectionId = crypto.randomUUID();
        const connectionSecret = randomSecret();
        const encryptedConnectionSecret = await encryptToken(connectionSecret, env.TOKEN_ENCRYPTION_KEY);
        const institutionName = typeof institution.name === "string" ? institution.name : "Plaid institution";
        await env.BROKER_DB.batch([
          env.BROKER_DB.prepare(`INSERT INTO connections
            (id, plaid_item_id, institution_id, institution_name, access_token_ciphertext, access_token_iv, owner_secret_hash, environment)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            connectionId,
            exchange.item_id,
            typeof institution.institution_id === "string" ? institution.institution_id : "plaid-link",
            institutionName,
            encrypted.ciphertext,
            encrypted.iv,
            await secretHash(connectionSecret),
            environment
          ),
          env.BROKER_DB.prepare(`UPDATE sandbox_link_sessions SET completion_state = 'completed',
            completed_connection_id = ?, completed_secret_ciphertext = ?, completed_secret_iv = ?,
            completed_institution_name = ? WHERE id = ?`).bind(
            connectionId, encryptedConnectionSecret.ciphertext, encryptedConnectionSecret.iv, institutionName, session.id
          )
        ]);
        return json({ connection: {
          id: connectionId,
          institutionName,
          connectionSecret,
          environment
        } }, { status: 201 });
      } catch {
        if (exchangedAccessToken) {
          let revoked = false;
          try {
            await plaidPost(env, "/item/remove", { access_token: exchangedAccessToken });
            revoked = true;
          } catch {}
          await env.BROKER_DB.prepare("UPDATE sandbox_link_sessions SET completion_state = ? WHERE id = ?")
            .bind(revoked ? "failed" : "recovery_required", session.id).run();
        } else {
          await env.BROKER_DB.prepare("UPDATE sandbox_link_sessions SET completion_state = 'pending', completion_started_at = NULL WHERE id = ?")
            .bind(session.id).run();
        }
        return problem(502, "plaid_error", "Plaid could not complete Link.");
      }
    }

    const userConnectionMatch = /^\/v1\/(?:sandbox\/)?connections\/([^/]+)\/(sync|disconnect|account-selection-link-token)$/.exec(url.pathname);
    if (userConnectionMatch && request.method === "POST") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      const [, connectionId, operation] = userConnectionMatch;
      const connection = await getConnection(env, connectionId);
      if (!connection || connection.environment !== environment) return problem(404, "connection_not_found", "Connection not found.");
      if (!(await authorizeConnection(request, connection))) return problem(401, "unauthorized", "This connection requires its local connection key.");
      try {
        if (operation === "account-selection-link-token") {
          const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
          const result = await plaidPost(env, "/link/token/create", accountSelectionLinkTokenRequest(environment, connection.id, accessToken));
          return json({ linkToken: result.link_token, expiration: result.expiration });
        }
        if (operation === "sync") {
          const synced = await syncTransactions(env, connection);
          const accountSnapshot = await getAccounts(env, connection);
          return json({ connection: { id: connection.id, institutionName: connection.institution_name, environment }, ...accountSnapshot, ...synced });
        }
        const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
        await plaidPost(env, "/item/remove", { access_token: accessToken });
        await env.BROKER_DB.batch([
          env.BROKER_DB.prepare("DELETE FROM connections WHERE id = ?").bind(connectionId),
          env.BROKER_DB.prepare("UPDATE sandbox_link_sessions SET completion_state = 'revoked' WHERE completed_connection_id = ?").bind(connectionId)
        ]);
        return new Response(null, { status: 204 });
      } catch {
        return problem(502, "plaid_error", "Plaid request failed.");
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

    const connectionMatch = /^\/v1\/admin\/connections\/([^/]+)\/(sync|disconnect)$/.exec(url.pathname);
    if (connectionMatch && request.method === "POST") {
      const configFailure = requirePlaid(env);
      if (configFailure) return configFailure;
      const [, connectionId, operation] = connectionMatch;
      const connection = await getConnection(env, connectionId);
      if (!connection) return problem(404, "connection_not_found", "Connection not found.");

      try {
        if (operation === "sync") {
          const synced = await syncTransactions(env, connection);
          const accountSnapshot = await getAccounts(env, connection);
          return json({ connection: { id: connection.id, institutionName: connection.institution_name, environment: connection.environment }, ...accountSnapshot, ...synced });
        }

        const accessToken = await decryptToken(connection.access_token_ciphertext, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
        await plaidPost(env, "/item/remove", { access_token: accessToken });
        await env.BROKER_DB.prepare("DELETE FROM connections WHERE id = ?").bind(connectionId).run();
        return new Response(null, { status: 204 });
      } catch (error) {
        return problem(502, "plaid_error", "Plaid request failed.");
      }
    }

    // These routes remain closed until their secrets, token store, and Plaid
    // integration are deployed together. Never log request bodies or authorization headers.
    if (
      (request.method === "POST" && url.pathname === "/v1/sync") ||
      (request.method === "POST" && /^\/v1\/items\/[^/]+\/disconnect$/.test(url.pathname))
    ) {
      return notImplemented();
    }

    return problem(404, "not_found", "Route not found.");
  }
};
