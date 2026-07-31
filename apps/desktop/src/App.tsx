import { invoke } from "@tauri-apps/api/core";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Account = { id: string; name: string; accountType: string; balanceCents: number };
type LedgerEntry = { id: string; transactionDate: string; description: string; accountName: string; amountCents: number };
type DashboardData = { incomeCents: number; spendingCents: number; accounts: Account[]; recentTransactions: LedgerEntry[] };
type LedgerData = { transactions: LedgerEntry[] };
type View = "dashboard" | "ledger" | "calendar";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = (cents: number) => money.format(cents / 100);

function Widget({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`widget ${className}`}><h2>{title}</h2>{children}</section>;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"account" | "transaction" | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const refresh = useCallback(() => { void invoke<DashboardData>("dashboard_data").then(setDashboard).catch((reason: unknown) => setError(String(reason))); }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (view === "ledger" || view === "calendar") void invoke<LedgerData>("ledger_data").then(setLedger).catch((reason: unknown) => setError(String(reason))); }, [view]);

  const netWorth = useMemo(() => dashboard?.accounts.reduce((total, account) => total + account.balanceCents, 0) ?? 0, [dashboard]);

  return <main className="app-shell">
    <aside className="rail" aria-label="Primary navigation">
      <div className="brand-mark">F</div>
      <button className={`nav-button ${view === "dashboard" ? "selected" : ""}`} onClick={() => setView("dashboard")} aria-label="Dashboard">▦</button>
      <button className={`nav-button ${view === "calendar" ? "selected" : ""}`} onClick={() => setView("calendar")} aria-label="Calendar">□</button>
      <button className={`nav-button ${view === "ledger" ? "selected" : ""}`} onClick={() => setView("ledger")} aria-label="Ledger">☷</button>
      <button className="nav-button" aria-label="Accounts">◎</button>
      <button className="nav-button" aria-label="Scheduled transactions">⌁</button>
      <button className="nav-button" aria-label="AI workspace">AI</button>
    </aside>
    <section className="page">
      <header className="page-header"><div><p className="eyebrow">{view === "dashboard" ? "OVERVIEW" : view === "calendar" ? "PLANNING" : "RECORDS"}</p><h1>{view === "dashboard" ? "Dashboard" : view === "calendar" ? "Calendar" : "Ledger"}</h1></div><button className="primary-action" onClick={() => setDialog("transaction")}>Add transaction</button></header>
      {error ? <p className="status error">Local data store unavailable: {error}</p> : null}
      {!dashboard && !error ? <p className="status">Opening encrypted local data store...</p> : null}
      {dashboard && view === "dashboard" ? <div className="dashboard-grid">
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
      {view === "ledger" ? <Ledger transactions={ledger?.transactions ?? []} /> : null}
      {view === "calendar" ? <Calendar month={calendarMonth} transactions={ledger?.transactions ?? []} onMonthChange={setCalendarMonth} /> : null}
      {dialog === "account" ? <AccountDialog onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} /> : null}
      {dialog === "transaction" ? <TransactionDialog accounts={dashboard?.accounts ?? []} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} /> : null}
    </section>
  </main>;
}

function Ledger({ transactions }: { transactions: LedgerEntry[] }) {
  return <section className="ledger-widget"><div className="ledger-toolbar"><input aria-label="Search transactions" placeholder="Search transactions" /><span>{transactions.length} records</span></div><div className="ledger-table"><div className="ledger-head"><span>Date</span><span>Description</span><span>Account</span><span>Amount</span></div>{transactions.length === 0 ? <p className="empty-copy">Your ledger is empty.</p> : transactions.map(item => <div className="ledger-row" key={item.id}><span>{item.transactionDate}</span><strong>{item.description}</strong><span>{item.accountName}</span><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div></section>;
}

function Calendar({ month, transactions, onMonthChange }: { month: Date; transactions: LedgerEntry[]; onMonthChange: (month: Date) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const first = new Date(year, monthIndex, 1); const start = new Date(year, monthIndex, 1 - first.getDay());
  const monthTitle = month.toLocaleString("en-US", { month: "long", year: "numeric" });
  const transactionMap = new Map<string, LedgerEntry[]>();
  transactions.forEach(item => transactionMap.set(item.transactionDate, [...(transactionMap.get(item.transactionDate) ?? []), item]));
  const selectedItems = selected ? transactionMap.get(selected) ?? [] : [];
  return <section className="calendar-widget"><div className="calendar-controls"><button onClick={() => onMonthChange(new Date(year, monthIndex - 1, 1))}>‹</button><strong>{monthTitle}</strong><button onClick={() => onMonthChange(new Date(year, monthIndex + 1, 1))}>›</button></div><div className="calendar-grid">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day => <div className="calendar-day-name" key={day}>{day}</div>)}{Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const key = date.toISOString().slice(0, 10); const entries = transactionMap.get(key) ?? []; const income = entries.filter(item => item.amountCents > 0).reduce((sum, item) => sum + item.amountCents, 0); const spend = entries.filter(item => item.amountCents < 0).reduce((sum, item) => sum + item.amountCents, 0); return <button className={`calendar-cell ${date.getMonth() !== monthIndex ? "outside" : ""} ${selected === key ? "selected-cell" : ""}`} onClick={() => setSelected(key)} key={key}><span>{date.getDate()}</span>{income ? <small className="positive">+{formatMoney(income)}</small> : null}{spend ? <small className="negative">{formatMoney(spend)}</small> : null}</button>; })}</div>{selected ? <aside className="date-popover"><header><strong>{new Date(`${selected}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</strong><button onClick={() => setSelected(null)}>×</button></header>{selectedItems.length === 0 ? <p className="empty-copy">No transactions.</p> : selectedItems.map(item => <div className="popover-item" key={item.id}><span>{item.description}</span><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</aside> : null}</section>;
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
