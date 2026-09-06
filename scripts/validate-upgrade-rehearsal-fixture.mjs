import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "test-fixtures", "upgrade-rehearsal", "v1", "profile.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function fail(message) {
  throw new Error(`Upgrade rehearsal fixture: ${message}`);
}

const manifest = fixture.manifest;
if (!manifest || manifest.fixtureFormatVersion !== 1 || manifest.fixtureId !== "money-map-upgrade-rehearsal-v1") {
  fail("manifest must declare the supported v1 fixture identity.");
}
for (const field of ["categories", "accounts", "transactions", "schedules", "recoveryStates"]) {
  if (!Array.isArray(fixture[field]) || fixture[field].length === 0) fail(`${field} must be a nonempty array.`);
}
for (const transaction of fixture.transactions) {
  if (!Number.isInteger(transaction.amountCents)) fail(`transaction ${transaction.id} must use integer cents.`);
}
for (const schedule of fixture.schedules) {
  if (!Number.isInteger(schedule.amountCents)) fail(`schedule ${schedule.id} must use integer cents.`);
}
const logical = { ...fixture };
delete logical.manifest;
const actualHash = crypto.createHash("sha256").update(canonical(logical)).digest("hex");
if (process.argv.includes("--print-hash")) {
  console.log(actualHash);
  process.exit(0);
}
if (manifest.expectedLogicalHash !== actualHash) {
  fail(`expected logical hash ${manifest.expectedLogicalHash}, got ${actualHash}.`);
}
console.log(`Validated ${manifest.fixtureId} (${actualHash}).`);
