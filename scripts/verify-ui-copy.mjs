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

const appSource = readFileSync(join(sourceRoot, "App.tsx"), "utf8");
const recurringSource = readFileSync(join(sourceRoot, "RecurringReview.tsx"), "utf8");
const dashboardCss = readFileSync(join(sourceRoot, "styles.css"), "utf8");
const recurringCss = readFileSync(join(sourceRoot, "recurring-review.css"), "utf8");
const requiredDashboardContracts = [
  [appSource, 'className="dashboard-lower"', "dashboard lower region"],
  [appSource, 'className="dashboard-side-stack"', "dashboard side stack"],
  [recurringSource, 'className="candidate-values"', "compact recurring values"],
  [dashboardCss, ".dashboard-lower{", "two-column lower dashboard layout"],
  [recurringCss, ".recurring-candidate:hover>footer", "pointer action reveal"],
  [recurringCss, ".recurring-candidate:focus-within>footer", "keyboard action reveal"],
  [recurringCss, "@media(hover:none)", "touch action fallback"],
  [recurringCss, "max-height:250px", "bounded recurring list"],
];

for (const [source, token, description] of requiredDashboardContracts) {
  if (!source.includes(token)) findings.push(`dashboard interaction contract: missing ${description}`);
}

if (findings.length) {
  console.error("UI copy check failed:\n" + findings.map(finding => `- ${finding}`).join("\n"));
  process.exit(1);
}

console.log("UI copy check passed.");
