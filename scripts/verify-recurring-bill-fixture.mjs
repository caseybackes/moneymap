import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(root, "test-fixtures", "recurring-bill", "v1");
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "manifest.json"), "utf8"));
const dataPath = path.join(fixtureDirectory, manifest.dataFile);
const bytes = fs.readFileSync(dataPath);
const canonicalText = bytes.toString("utf8").replaceAll("\r\n", "\n");
const data = JSON.parse(canonicalText);
const digest = crypto.createHash("sha256").update(canonicalText, "utf8").digest("hex");

if (manifest.fixtureFormatVersion !== 1) throw new Error("Unsupported recurring-bill fixture format.");
if (manifest.fixtureId !== data.fixtureId) throw new Error("Fixture identity differs from its manifest.");
if (manifest.sha256 !== digest) throw new Error(`Fixture hash mismatch: expected ${manifest.sha256}, got ${digest}.`);
if (!data.transactions.some(transaction => transaction.pending)) throw new Error("Fixture must contain a pending edge case.");
if (!data.transactions.some(transaction => transaction.amountCents > 0)) throw new Error("Fixture must contain a refund edge case.");
if (!data.transactions.some(transaction => transaction.categoryId === "category-transfers")) throw new Error("Fixture must contain a transfer edge case.");
if (!data.schedules.length) throw new Error("Fixture must contain an existing schedule match.");

console.log(`Verified ${manifest.fixtureId} at sha256:${digest}.`);
