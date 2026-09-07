import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const scriptRoot = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = join(scriptRoot, "..", "apps", "desktop", "src");
const files = ["App.tsx", "RecurringReview.tsx"];
const forbiddenCopy = [
  "Results are bounded",
  "responsive review",
  "Observed range",
  "Confidence",
  "Why Money Map flagged this",
  "too irregular to draft safely",
  "Affected evidence",
  "cited transactions",
  "Exact effect fingerprint",
  "exact proposal",
  "inert proposal",
  "current local evidence",
];

const findings = [];
for (const file of files) {
  const source = readFileSync(join(sourceRoot, file), "utf8");
  for (const phrase of forbiddenCopy) {
    if (source.toLowerCase().includes(phrase.toLowerCase())) findings.push(`${file}: ${phrase}`);
  }
}

if (findings.length) {
  console.error("UI copy check failed:\n" + findings.map(finding => `- ${finding}`).join("\n"));
  process.exit(1);
}

console.log("UI copy check passed.");
