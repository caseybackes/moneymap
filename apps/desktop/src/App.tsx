import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type DatabaseStatus = {
  databasePath: string;
  encrypted: boolean;
  schemaVersion: number;
};

export function App() {
  const [status, setStatus] = useState<DatabaseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<DatabaseStatus>("database_status")
      .then(setStatus)
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  return (
    <main className="app-shell">
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand-mark">F</div>
        <button className="nav-button selected" aria-label="Dashboard">▦</button>
        <button className="nav-button" aria-label="Calendar">□</button>
        <button className="nav-button" aria-label="Ledger">☷</button>
        <button className="nav-button" aria-label="Accounts">◎</button>
      </aside>
      <section className="migration-panel">
        <p className="eyebrow">FAMILY FINANCE</p>
        <h1>React/Tauri migration in progress</h1>
        <p className="lede">The replacement desktop shell is connected to its own encrypted local database boundary. Dashboard, ledger, calendar, schedules, and Plaid Link are being ported into components next.</p>
        {error ? <p className="status error">Local data store unavailable: {error}</p> : null}
        {status ? (
          <dl className="status-card">
            <div><dt>Encrypted storage</dt><dd>{status.encrypted ? "Ready" : "Unavailable"}</dd></div>
            <div><dt>Schema</dt><dd>v{status.schemaVersion}</dd></div>
            <div><dt>Location</dt><dd>{status.databasePath}</dd></div>
          </dl>
        ) : !error ? <p className="status">Opening encrypted local data store…</p> : null}
      </section>
    </main>
  );
}
