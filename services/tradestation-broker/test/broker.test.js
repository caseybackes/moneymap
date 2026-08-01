import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("health is available before broker secrets are configured", async () => {
  const response = await worker.fetch(new Request("https://broker.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: "money-map-tradestation-broker", status: "ok", configured: false });
});

test("oauth setup is unavailable until every required secret is present", async () => {
  const response = await worker.fetch(new Request("https://broker.example/v1/oauth/start", { method: "POST" }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "tradestation_not_configured");
});
