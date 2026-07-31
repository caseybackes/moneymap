import { invoke } from "@tauri-apps/api/core";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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
  const [dialog, setDialog] = useState<"account" | "transaction" | null>(null);

  const refresh = useCallback(() => { void invoke<DashboardData>("dashboard_data").then(setDashboard).catch((reason: unknown) => setError(String(reason))); }, []);
  useEffect(refresh, [refresh]);

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
      <header className="page-header"><div><p className="eyebrow">OVERVIEW</p><h1>Dashboard</h1></div><button className="primary-action" onClick={() => setDialog("transaction")}>Add transaction</button></header>
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
            <button className="connect-card" onClick={() => setDialog("account")}><span>+</span><strong>Connect another account</strong><small>Add locally now · Plaid Link next</small></button>
          </div>
        </Widget>
        <Widget title="Recent transactions" className="recent-widget">
          {dashboard.recentTransactions.length === 0 ? <p className="empty-copy">Add a transaction or connect an account to start your ledger.</p> : <div className="transaction-list">{dashboard.recentTransactions.map((item) => <div className="transaction-row" key={item.id}><div><strong>{item.description}</strong><small>{item.transactionDate} · {item.accountName}</small></div><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div>}
        </Widget>
      </div> : null}
      {dialog === "account" ? <AccountDialog onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} /> : null}
      {dialog === "transaction" ? <TransactionDialog accounts={dashboard?.accounts ?? []} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} /> : null}
    </section>
  </main>;
}

function AccountDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await invoke("create_account", { input: { name: form.get("name"), accountType: form.get("type"), openingBalanceCents: Math.round(Number(form.get("balance")) * 100) } }); onSaved(); }
    catch (reason) { setError(String(reason)); }
  }
  return <div className="dialog-backdrop"><form className="dialog" onSubmit={submit}><header><h2>Add account</h2><button type="button" onClick={onClose}>×</button></header><label>Name<input name="name" required autoFocus placeholder="Everyday checking" /></label><label>Type<select name="type" defaultValue="checking"><option value="checking">Checking</option><option value="savings">Savings</option><option value="credit-card">Credit card</option><option value="investment">Investment</option><option value="loan">Loan</option></select></label><label>Opening balance<input name="balance" type="number" step="0.01" defaultValue="0" required /></label>{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Save account</button></footer></form></div>;
}

function TransactionDialog({ accounts, onClose, onSaved }: { accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await invoke("create_transaction", { input: { accountId: form.get("accountId"), transactionDate: form.get("date"), description: form.get("description"), amountCents: Math.round(Number(form.get("amount")) * 100), notes: form.get("notes") || null } }); onSaved(); }
    catch (reason) { setError(String(reason)); }
  }
  return <div className="dialog-backdrop"><form className="dialog" onSubmit={submit}><header><h2>Add transaction</h2><button type="button" onClick={onClose}>×</button></header>{accounts.length === 0 ? <p className="empty-copy">Create an account first.</p> : <><label>Account<select name="accountId" required>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>Date<input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label><label>Description<input name="description" required placeholder="Groceries" /></label><label>Amount<input name="amount" type="number" step="0.01" required placeholder="-48.20" /></label><label>Notes<textarea name="notes" rows={3} /></label></>}{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button>{accounts.length > 0 ? <button className="primary-action" type="submit">Save transaction</button> : null}</footer></form></div>;
}
