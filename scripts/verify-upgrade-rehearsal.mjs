import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "apps/desktop/src-tauri/src/rehearsal_main.rs",
  "apps/desktop/src-tauri/src/rehearsal_runtime.rs",
];
const combined = sources.map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const forbidden = [
  "https://", "http://", "reqwest", "std::net", "TcpListener", "TcpStream", "UdpSocket",
  "open_external", "webbrowser", "Command::new", "revoke", "disconnect",
  "production.plaid.com", "sandbox.plaid.com", "money-map-plaid-broker",
];
for (const token of forbidden) {
  if (combined.includes(token)) throw new Error(`Rehearsal source contains forbidden network token: ${token}`);
}
const config = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.rehearsal.conf.json"), "utf8"));
if (config.identifier !== "com.caseybackes.moneymap.rehearsal") throw new Error("Rehearsal application identity drifted.");
if (!config.app.security.csp.includes("connect-src 'self'")) throw new Error("Rehearsal CSP must deny remote connections.");
if (config.bundle.active !== false) throw new Error("Rehearsal must remain excluded from installers and publishing.");

const binaryPath = process.argv[2];
if (binaryPath) {
  const binary = fs.readFileSync(path.resolve(binaryPath)).toString("latin1");
  for (const token of ["reqwest", "open_external", "production.plaid.com", "sandbox.plaid.com", "money-map-plaid-broker"]) {
    if (binary.toLowerCase().includes(token.toLowerCase())) throw new Error(`Rehearsal binary contains forbidden capability token: ${token}`);
  }
}
console.log(`Verified rehearsal source isolation, local-only CSP${binaryPath ? ", and binary host absence" : ""}.`);
