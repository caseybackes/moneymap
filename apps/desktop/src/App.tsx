import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

type Account = { id: string; name: string; accountType: string; balanceCents: number };
type LedgerEntry = { id: string; transactionDate: string; description: string; accountName: string; amountCents: number };
type DashboardData = { incomeCents: number; spendingCents: number; accounts: Account[]; recentTransactions: LedgerEntry[] };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = (cents: number) => money.format(cents / 100);

function Widget({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`widget ${className}`}><h2>{title}</h2>{children}</section>;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<DashboardData>("dashboard_data").then(setDashboard).catch((reason: unknown) => setError(String(reason)));
  }, []);

  const netWorth = useMemo(() => dashboard?.accounts.reduce((total, account) => total + account.balanceCents, 0) ?? 0, [dashboard]);

  return <main className="app-shell">
    <aside className="rail" aria-label="Primary navigation">
      <div className="brand-mark">F</div>
      <button className="nav-button selected" aria-label="Dashboard">▦</button>
      <button className="nav-button" aria-label="Calendar">□</button>
      <button className="nav-button" aria-label="Ledger">☷</button>
      <button className="nav-button" aria-label="Accounts">◎</button>
      <button className="nav-button" aria-label="Scheduled transactions">⌁</button>
      <button className="nav-button" aria-label="AI workspace">AI</button>
    </aside>
    <section className="page">
      <header className="page-header"><div><p className="eyebrow">OVERVIEW</p><h1>Dashboard</h1></div><button className="primary-action">Add transaction</button></header>
      {error ? <p className="status error">Local data store unavailable: {error}</p> : null}
      {!dashboard && !error ? <p className="status">Opening encrypted local data store...</p> : null}
      {dashboard ? <div className="dashboard-grid">
        <Widget title="Net worth" className="net-worth-widget">
          <strong className="big-number">{formatMoney(netWorth)}</strong><p>Across all local accounts</p>
          <div className="sparkline" aria-label="Net worth history placeholder"><span /><span /><span /><span /><span /></div>
        </Widget>
        <Widget title="This month" className="month-widget">
          <div className="metric"><span>Income</span><strong className="positive">{formatMoney(dashboard.incomeCents)}</strong></div>
          <div className="metric"><span>Spending</span><strong className="negative">{formatMoney(dashboard.spendingCents)}</strong></div>
          <div className="range-buttons"><button className="active">1M</button><button>3M</button><button>6M</button><button>1Y</button><button>All</button></div>
        </Widget>
        <Widget title="Accounts & cards" className="accounts-widget">
          <div className="account-grid">
            {dashboard.accounts.map((account) => <article className="account-card" key={account.id}><small>{account.accountType}</small><h3>{account.name}</h3><strong>{formatMoney(account.balanceCents)}</strong></article>)}
            <button className="connect-card"><span>+</span><strong>Connect another account</strong><small>Secure Plaid Link</small></button>
          </div>
        </Widget>
        <Widget title="Recent transactions" className="recent-widget">
          {dashboard.recentTransactions.length === 0 ? <p className="empty-copy">Add a transaction or connect an account to start your ledger.</p> : <div className="transaction-list">{dashboard.recentTransactions.map((item) => <div className="transaction-row" key={item.id}><div><strong>{item.description}</strong><small>{item.transactionDate} · {item.accountName}</small></div><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div>}
        </Widget>
      </div> : null}
    </section>
  </main>;
}
