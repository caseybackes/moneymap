import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maximumBlobBytes = 5 * 1024 * 1024;

const forbiddenPathRules = [
  ["environment file", /(^|\/)\.env(?:$|\.)/i],
  ["provider working state", /(^|\/)\.wrangler(?:\/|$)/i],
  ["generated dependency/build directory", /(^|\/)(?:node_modules|target|dist|dist-production|artifacts?|rehearsal-runtime)(?:\/|$)/i],
  ["database or backup", /(?:\.(?:db|sqlite|sqlite3|db-wal|db-shm|bak|backup)|(?:^|\/)backups?(?:\/|$))/i],
  ["generated executable or symbols", /\.(?:exe|dll|pdb|msi)$/i],
  ["private key or certificate material", /\.(?:pem|key|pfx|p12)$/i],
  ["personal-finance export", /(?:^|\/)[^/]*(?:account|balance|bank|financial|statement|transaction)[^/]*\.(?:csv|tsv|ofx|qfx|qif)$/i],
];

const secretRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", new RegExp(`(?:ghp_[A-Za-z0-9]{30,}|${"github_"}${"pat_"}[A-Za-z0-9_]{30,})`)],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Plaid access token", /access-(?:sandbox|development|production)-[A-Za-z0-9_-]{12,}/i],
  ["hard-coded credential", /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|connection[_-]?secret|plaid[_-]?secret|password)\s*[=:]\s*["']([^"'\r\n]{16,})["']/i],
];

const placeholder = /(?:canary|example|fake|fixture|placeholder|sample|test|dummy|changeme|redacted|your[-_])/i;
const absoluteUserHome = new RegExp(`(?:[A-Za-z]:${"\\\\"}Users${"\\\\"}[^\\\\\r\n]+|/${"ho"}${"me"}/[^/\r\n]+)`, "i");

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: options.binary ? null : "utf8",
    input: options.input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    const detail = result.error?.message ?? error?.trim() ?? `exit status ${String(result.status)}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function forbiddenPathFinding(file) {
  const normalized = file.replaceAll("\\", "/");
  if (/\.env\.example$/i.test(normalized) || /wrangler\.[^/]+\.jsonc\.example$/i.test(normalized)) return null;
  for (const [kind, rule] of forbiddenPathRules) if (rule.test(normalized)) return kind;
  return null;
}

function secretFinding(bytes, file = "") {
  const text = bytes.toString("utf8");
  for (const [kind, rule] of secretRules) {
    const match = text.match(rule);
    if (!match) continue;
    if (kind === "hard-coded credential" && placeholder.test(match[1])) continue;
    if (kind === "hard-coded credential" && /(^|\/)(?:test|tests|test-fixtures)(\/|$)/i.test(file.replaceAll("\\", "/")) && match[1].length < 24) continue;
    return kind;
  }
  return null;
}

function parseHistoryObjects() {
  const pathsByObject = new Map();
  const lines = git(["rev-list", "--objects", "--all"]).trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const oid = line.slice(0, separator);
    const file = line.slice(separator + 1);
    const files = pathsByObject.get(oid) ?? new Set();
    files.add(file);
    pathsByObject.set(oid, files);
  }
  if (!pathsByObject.size) return [];
  const objectIds = [...pathsByObject.keys()];
  const metadata = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: `${objectIds.join("\n")}\n` });
  return metadata.trim().split(/\r?\n/).map(line => {
    const [oid, type, rawSize] = line.split(" ");
    return { oid, type, size: Number(rawSize), paths: [...(pathsByObject.get(oid) ?? [])] };
  }).filter(item => item.type === "blob");
}

function readHistoryBlobs(objects) {
  const eligible = objects.filter(item => item.size <= maximumBlobBytes);
  if (!eligible.length) return new Map();
  const output = git(["cat-file", "--batch"], { input: Buffer.from(`${eligible.map(item => item.oid).join("\n")}\n`), binary: true });
  const contents = new Map();
  let offset = 0;
  for (const expected of eligible) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("git cat-file returned an incomplete header.");
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
    const start = headerEnd + 1;
    contents.set(expected.oid, output.subarray(start, start + size));
    offset = start + size + 1;
  }
  return contents;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function verifyFixtures(findings) {
  const fixtureRoot = path.join(root, "test-fixtures");
  if (!fs.existsSync(fixtureRoot)) return;
  const versionDirectories = [];
  for (const family of fs.readdirSync(fixtureRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const familyPath = path.join(fixtureRoot, family.name);
    for (const version of fs.readdirSync(familyPath, { withFileTypes: true }).filter(item => item.isDirectory())) {
      versionDirectories.push(path.join(familyPath, version.name));
    }
  }
  for (const directory of versionDirectories) {
    const relativeDirectory = path.relative(root, directory).replaceAll("\\", "/");
    const jsonFiles = fs.readdirSync(directory).filter(file => file.endsWith(".json"));
    if (!jsonFiles.length) {
      findings.push(["fixture manifest", relativeDirectory]);
      continue;
    }
    const documents = new Map(jsonFiles.map(file => [file, JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"))]));
    if ([...documents.values()].some(document => document.synthetic !== true && document.manifest?.synthetic !== true)) {
      findings.push(["fixture missing synthetic declaration", relativeDirectory]);
      continue;
    }
    const external = documents.get("manifest.json");
    if (external) {
      const data = documents.get(external.dataFile);
      if (external.synthetic !== true || !data || data.synthetic !== true || !/^[a-f0-9]{64}$/.test(external.sha256 ?? "")) {
        findings.push(["fixture manifest", relativeDirectory]);
        continue;
      }
      const text = fs.readFileSync(path.join(directory, external.dataFile), "utf8").replaceAll("\r\n", "\n");
      const digest = crypto.createHash("sha256").update(text, "utf8").digest("hex");
      if (digest !== external.sha256) findings.push(["fixture hash mismatch", relativeDirectory]);
      continue;
    }
    const embedded = [...documents.values()].find(document => document.manifest);
    if (!embedded?.manifest || embedded.manifest.synthetic !== true || !/^[a-f0-9]{64}$/.test(embedded.manifest.expectedLogicalHash ?? "")) {
      findings.push(["fixture manifest", relativeDirectory]);
      continue;
    }
    const logical = { ...embedded };
    delete logical.manifest;
    const digest = crypto.createHash("sha256").update(canonical(logical)).digest("hex");
    if (digest !== embedded.manifest.expectedLogicalHash) findings.push(["fixture hash mismatch", relativeDirectory]);
  }
}

function selfTest() {
  assert.equal(forbiddenPathFinding("records/personal-transactions.csv"), "personal-finance export");
  assert.equal(forbiddenPathFinding("docs/.env.example"), null);
  assert.equal(secretFinding(Buffer.from(`token = "${"github_"}${"pat_"}abcdefghijklmnopqrstuvwxyz0123456789"`)), "GitHub token");
  assert.equal(secretFinding(Buffer.from('password = "fixture-password-value"')), null);
  assert.equal(secretFinding(Buffer.from('password = "short-synthetic-key"'), "test/example.test.js"), null);
  assert.equal(secretFinding(Buffer.from('password = "realistic-looking-credential-material-123456"'), "test/example.test.js"), "hard-coded credential");
  assert.equal(secretFinding(Buffer.from("env.PLAID_SECRET")), null);
  assert.equal(absoluteUserHome.test(`${"C:"}${"\\"}${"Users"}${"\\"}someone${"\\"}file.txt`), true);
  console.log("Public-release gate self-test passed.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const findings = [];
const objects = parseHistoryObjects();
for (const object of objects) {
  for (const file of object.paths) {
    const kind = forbiddenPathFinding(file);
    if (kind) findings.push([`history ${kind}`, file]);
    if (object.size > maximumBlobBytes) findings.push(["history blob over 5 MiB", file]);
  }
}
const historyContents = readHistoryBlobs(objects);
for (const object of objects) {
  const bytes = historyContents.get(object.oid);
  if (!bytes) continue;
  for (const file of object.paths) {
    const kind = secretFinding(bytes, file);
    if (kind) findings.push([`history ${kind}`, file]);
  }
}

const visibleFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
for (const file of visibleFiles) {
  const kind = forbiddenPathFinding(file);
  if (kind) findings.push([`working tree ${kind}`, file]);
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const size = fs.statSync(absolute).size;
  if (size > maximumBlobBytes) findings.push(["working tree file over 5 MiB", file]);
  else {
    const bytes = fs.readFileSync(absolute);
    const secret = secretFinding(bytes, file);
    if (secret) findings.push([`working tree ${secret}`, file]);
    if (absoluteUserHome.test(bytes.toString("utf8"))) findings.push(["working tree absolute user-home path", file]);
  }
}

verifyFixtures(findings);

const unique = [...new Map(findings.map(([kind, file]) => [`${kind}\0${file}`, [kind, file]])).values()];
if (unique.length) {
  console.error("Public-release privacy gate failed. Matched values are intentionally omitted:");
  for (const [kind, file] of unique) console.error(`- ${kind}: ${file}`);
  process.exit(1);
}

console.log(`Public-release privacy gate passed (${objects.length} historical blobs, ${visibleFiles.length} visible files).`);
