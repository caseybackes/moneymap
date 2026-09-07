import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = path.join(repositoryRoot, "docs", "ai-tools", "schemas", "v1");
const schemaFiles = fs.readdirSync(schemaDirectory)
  .filter(name => name.endsWith(".schema.json"))
  .sort();

if (schemaFiles.length === 0) throw new Error("No AI contract schemas were found.");

const documents = new Map(schemaFiles.map(name => {
  const source = fs.readFileSync(path.join(schemaDirectory, name), "utf8");
  return [name, JSON.parse(source)];
}));

function pointerValue(document, pointer, source) {
  if (pointer === "" || pointer === "/") return document;
  return pointer.split("/").slice(1).reduce((value, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !(key in value)) {
      throw new Error(`Unresolved JSON Pointer #${pointer} from ${source}`);
    }
    return value[key];
  }, document);
}

let referenceCount = 0;
function inspect(value, sourceName) {
  if (Array.isArray(value)) {
    value.forEach(item => inspect(item, sourceName));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (typeof value.$ref === "string") {
    referenceCount += 1;
    const [targetName, pointer = ""] = value.$ref.split("#", 2);
    const resolvedName = targetName || sourceName;
    const target = documents.get(resolvedName);
    if (!target) throw new Error(`Missing schema ${resolvedName} referenced by ${sourceName}`);
    pointerValue(target, pointer, sourceName);
  }
  Object.values(value).forEach(item => inspect(item, sourceName));
}

for (const [name, document] of documents) {
  if (document.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error(`${name} must declare JSON Schema Draft 2020-12.`);
  }
  if (typeof document.$id !== "string" || !document.$id.includes("/schemas/ai-tools/v1/")) {
    throw new Error(`${name} must have a stable v1 schema identifier.`);
  }
  inspect(document, name);
}

const envelope = documents.get("capability-envelope.schema.json");
const money = envelope?.$defs?.Money;
if (!money?.required?.includes("amountCents") || money?.properties?.amountCents?.type !== "integer") {
  throw new Error("Money must require integer amountCents.");
}
const pageLimit = envelope?.$defs?.PageRequest?.properties?.limit;
if (pageLimit?.maximum !== 100 || pageLimit?.default !== 25) {
  throw new Error("Schema pagination bounds must match the native 25/100 contract.");
}

const serialized = [...documents.values()].map(document => JSON.stringify(document)).join("\n");
for (const forbidden of ["databaseKey", "accessToken", "connectionSecret", "providerToken", "executeSql", "shellCommand"]) {
  if (serialized.includes(forbidden)) throw new Error(`Forbidden capability field found: ${forbidden}`);
}

console.log(`Validated ${documents.size} AI contract schemas and ${referenceCount} local references.`);
