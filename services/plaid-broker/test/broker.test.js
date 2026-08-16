import assert from "node:assert/strict";
import test from "node:test";
import worker, { transactionSyncState } from "../src/index.js";

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
  const home = await worker.fetch(new Request("https://broker.example/"), {});
  const privacy = await worker.fetch(new Request("https://broker.example/privacy"), {});

  assert.equal(home.status, 200);
  assert.match(await home.text(), /Money Map Dev/);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Plaid Link/);
});

test("broker routes remain unavailable before configuration", async () => {
  const response = await worker.fetch(new Request("https://broker.example/v1/sync", { method: "POST" }), {});

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
  const response = await worker.fetch(request, { BROKER_API_TOKEN: "test-token" });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});
