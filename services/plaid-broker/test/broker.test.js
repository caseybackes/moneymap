import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import worker, { accountSelectionLinkTokenRequest, transactionSyncState } from "../src/index.js";

test("account selection update reuses the Item without creating a new connection", () => {
  assert.deepEqual(accountSelectionLinkTokenRequest("production", "connection-1", "access-production-1"), {
    client_name: "Money Map",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: "production-connection-connection-1" },
    access_token: "access-production-1",
    update: { account_selection_enabled: true }
  });
});

test("transaction sync remains pending until Plaid reports historical history ready", () => {
  assert.deepEqual(transactionSyncState("NOT_READY"), {
    operation: "idle",
    transactionsStatus: "NOT_READY",
    initialUpdateComplete: false,
    historicalUpdateComplete: false,
    pending: true
  });
  assert.equal(transactionSyncState("INITIAL_UPDATE_COMPLETE").pending, true);
  assert.equal(transactionSyncState("HISTORICAL_UPDATE_COMPLETE").pending, false);
  assert.equal(transactionSyncState("HISTORICAL_UPDATE_COMPLETE", "syncing").pending, true);
});

test("health is public and non-cacheable", async () => {
  const response = await worker.fetch(new Request("https://broker.example/health"), {});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { service: "money-map-plaid-broker", status: "ok" });
});

test("public project and privacy pages are available", async () => {
  const home = await worker.fetch(new Request("https://broker.example/"), { APP_ENVIRONMENT: "sandbox" });
  const privacy = await worker.fetch(new Request("https://broker.example/privacy"), { APP_ENVIRONMENT: "sandbox" });

  assert.equal(home.status, 200);
  assert.match(await home.text(), /Money Map Dev/);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Plaid Link/);
});

test("broker routes remain unavailable before configuration", async () => {
  const response = await worker.fetch(new Request("https://broker.example/v1/sync", { method: "POST" }), { APP_ENVIRONMENT: "sandbox" });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "broker_not_configured");
});

test("Sandbox Link token route remains closed until all Plaid secrets are configured", async () => {
  const response = await worker.fetch(new Request("https://broker.example/v1/sandbox/link-token", { method: "POST" }), { APP_ENVIRONMENT: "sandbox" });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "plaid_not_configured");
});

test("Sandbox endpoints stay unavailable in a production deployment", async () => {
  const response = await worker.fetch(new Request("https://broker.example/v1/sandbox/link-token", { method: "POST" }), { APP_ENVIRONMENT: "production" });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "sandbox_unavailable");
});

test("broker routes require the configured bearer token", async () => {
  const request = new Request("https://broker.example/v1/sync", { method: "POST" });
  const response = await worker.fetch(request, { APP_ENVIRONMENT: "sandbox", BROKER_API_TOKEN: "test-token" });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});

test("broker fails closed when APP_ENVIRONMENT is missing", async () => {
  const response = await worker.fetch(new Request("https://broker.example/"), {});

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "invalid_environment");
});

test("broker fails closed when APP_ENVIRONMENT is ambiguous", async () => {
  const response = await worker.fetch(new Request("https://broker.example/v1/sync", { method: "POST" }), { APP_ENVIRONMENT: "prod" });

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "invalid_environment");
});

test("Link completion replay returns the same persisted connection authority", async () => {
  const originalCrypto = globalThis.crypto;
  globalThis.crypto = webcrypto;
  const sessionSecret = "session-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionSecret));
  const session = {
    id: "session-1",
    secret_hash: Buffer.from(digest).toString("base64"),
    completion_state: "pending",
    completion_started_at: null,
    completed_connection_id: null,
    completed_secret_ciphertext: null,
    completed_secret_iv: null,
    completed_institution_name: null
  };
  const database = {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return sql.includes("FROM sandbox_link_sessions") ? { ...session } : null; },
        async run() {
          if (sql.includes("SET completion_state = 'completing'")) {
            if (session.completion_state !== "pending") return { meta: { changes: 0 } };
            session.completion_state = "completing";
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      };
    },
    async batch(statements) {
      const completion = statements.find(statement => statement.sql.includes("SET completion_state = 'completed'"));
      const [id, ciphertext, iv, institutionName] = completion.args;
      Object.assign(session, {
        completion_state: "completed",
        completed_connection_id: id,
        completed_secret_ciphertext: ciphertext,
        completed_secret_iv: iv,
        completed_institution_name: institutionName
      });
      return statements.map(() => ({ success: true }));
    }
  };
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/item/public_token/exchange")) {
      exchanges += 1;
      return Response.json({ access_token: "access-1", item_id: "item-1" });
    }
    throw new Error(`Unexpected Plaid request: ${url}`);
  };
  const env = {
    APP_ENVIRONMENT: "production",
    PLAID_CLIENT_ID: "client",
    PLAID_SECRET: "secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BROKER_DB: database
  };
  const request = () => new Request("https://broker.example/v1/link-complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, sessionSecret, publicToken: "public-1", institution: { name: "Test Bank" } })
  });
  try {
    const first = await worker.fetch(request(), env);
    const firstBody = await first.json();
    const replay = await worker.fetch(request(), env);
    const replayBody = await replay.json();
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(exchanges, 1);
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.connection.id, firstBody.connection.id);
    assert.equal(replayBody.connection.connectionSecret, firstBody.connection.connectionSecret);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) globalThis.crypto = originalCrypto;
    else delete globalThis.crypto;
  }
});

test("a concurrent Link completion is rejected before a second Plaid exchange", async () => {
  const originalCrypto = globalThis.crypto;
  globalThis.crypto = webcrypto;
  const sessionSecret = "session-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionSecret));
  const session = {
    id: "session-concurrent",
    secret_hash: Buffer.from(digest).toString("base64"),
    completion_state: "completing",
    completion_started_at: Math.floor(Date.now() / 1000),
    completed_connection_id: null,
    completed_secret_ciphertext: null,
    completed_secret_iv: null,
    completed_institution_name: null
  };
  const database = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { return { ...session }; },
        async run() { return { meta: { changes: 0 } }; }
      };
    }
  };
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async () => { exchanges += 1; throw new Error("Plaid must not be called"); };
  try {
    const response = await worker.fetch(new Request("https://broker.example/v1/link-complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, sessionSecret, publicToken: "public-1" })
    }), {
      APP_ENVIRONMENT: "production",
      PLAID_CLIENT_ID: "client",
      PLAID_SECRET: "secret",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      BROKER_DB: database
    });
    assert.equal(response.status, 409);
    assert.equal(exchanges, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) globalThis.crypto = originalCrypto;
    else delete globalThis.crypto;
  }
});

test("a failed D1 commit compensates by revoking the exchanged Plaid Item", async () => {
  const originalCrypto = globalThis.crypto;
  globalThis.crypto = webcrypto;
  const sessionSecret = "session-secret";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionSecret));
  const session = {
    id: "session-compensation",
    secret_hash: Buffer.from(digest).toString("base64"),
    completion_state: "pending",
    completion_started_at: null,
    completed_connection_id: null,
    completed_secret_ciphertext: null,
    completed_secret_iv: null,
    completed_institution_name: null
  };
  const database = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return { ...session }; },
        async run() {
          if (sql.includes("SET completion_state = 'completing'")) {
            session.completion_state = "completing";
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE sandbox_link_sessions SET completion_state = ?")) {
            session.completion_state = this.args[0];
          }
          return { meta: { changes: 1 } };
        }
      };
    },
    async batch() { throw new Error("simulated D1 commit failure"); }
  };
  const originalFetch = globalThis.fetch;
  const plaidCalls = [];
  globalThis.fetch = async (url) => {
    plaidCalls.push(String(url));
    if (String(url).endsWith("/item/public_token/exchange")) {
      return Response.json({ access_token: "access-1", item_id: "item-1" });
    }
    if (String(url).endsWith("/item/remove")) return Response.json({ removed: true });
    throw new Error(`Unexpected Plaid request: ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("https://broker.example/v1/link-complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, sessionSecret, publicToken: "public-1" })
    }), {
      APP_ENVIRONMENT: "production",
      PLAID_CLIENT_ID: "client",
      PLAID_SECRET: "secret",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      BROKER_DB: database
    });
    assert.equal(response.status, 502);
    assert.equal(session.completion_state, "failed");
    assert.equal(plaidCalls.filter(url => url.endsWith("/item/public_token/exchange")).length, 1);
    assert.equal(plaidCalls.filter(url => url.endsWith("/item/remove")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) globalThis.crypto = originalCrypto;
    else delete globalThis.crypto;
  }
});
