import { invoke } from "@tauri-apps/api/core";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

type Account = { id: string; name: string; accountType: string; balanceCents: number; plaidSubtype?: string | null; plaidMask?: string | null; plaidAvailableBalanceCents?: number | null; plaidRefreshedAt?: string | null };
type LedgerEntry = { id: string; accountId: string; transactionDate: string; description: string; accountName: string; categoryName: string; categoryId: string | null; amountCents: number };
type DashboardData = { incomeCents: number; spendingCents: number; accounts: Account[]; recentTransactions: LedgerEntry[] };
type LedgerData = { transactions: LedgerEntry[] };
type Schedule = { id: string; accountId: string; startDate: string; endDate: string | null; nextOccurrence: string; description: string; amountCents: number; recurrence: string; accountName: string };
type SandboxLinkSession = { linkToken: string; sessionId: string; sessionSecret: string; expiration: string };
type Category = { id: string; name: string };
type RecurringSuggestion = { accountId: string; accountName: string; description: string; amountCents: number; recurrence: string; nextOccurrence: string; occurrences: number };
type CalendarItem = { id: string; description: string; amountCents: number; scheduled?: boolean };
type ConnectedInstitution = { id: string; institutionName: string; environment: string; accountCount: number };
type View = "dashboard" | "ledger" | "calendar" | "scheduled" | "accounts" | "scenarios" | "categories";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = (cents: number) => money.format(cents / 100);

function Widget({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`widget ${className}`}><h2>{title}</h2>{children}</section>;
}

function NetWorthChart({ netWorth, transactions }: { netWorth: number; transactions: LedgerEntry[] }) {
  const points = useMemo(() => {
    const byDate = new Map<string, number>();
    transactions.forEach(item => byDate.set(item.transactionDate, (byDate.get(item.transactionDate) ?? 0) + item.amountCents));
    const changes = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right));
    let running = netWorth - changes.reduce((sum, [, amount]) => sum + amount, 0);
    const history = changes.map(([date, amount]) => ({ date, value: running += amount }));
    return history.length ? history : [{ date: "Today", value: netWorth }];
  }, [netWorth, transactions]);
  const values = points.map(point => point.value); const minimum = Math.min(...values); const maximum = Math.max(...values); const span = Math.max(maximum - minimum, 1);
  const path = points.map((point, index) => { const x = points.length === 1 ? 600 : (index / (points.length - 1)) * 600; const y = 132 - ((point.value - minimum) / span) * 104; return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
  const area = `${path} L600 150 L0 150 Z`;
  return <div className="net-worth-chart"><svg viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label="Net worth over the selected time period"><defs><linearGradient id="net-worth-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#5bc9f5" stopOpacity=".32"/><stop offset="1" stopColor="#5bc9f5" stopOpacity="0"/></linearGradient></defs><path className="chart-area" d={area}/><path className="chart-line" d={path}/></svg><div><span>{points[0].date}</span><span>{points.at(-1)?.date}</span></div></div>;
}

function ScenarioModel({ netWorth, incomeCents, spendingCents }: { netWorth: number; incomeCents: number; spendingCents: number }) {
  const [income, setIncome] = useState(incomeCents / 100);
  const [spending, setSpending] = useState(spendingCents / 100);
  const [seeded, setSeeded] = useState(false);
  const [contribution, setContribution] = useState(0);
  const [oneTime, setOneTime] = useState(0);
  const [months, setMonths] = useState(12);
  useEffect(() => { if (!seeded && (incomeCents !== 0 || spendingCents !== 0)) { setIncome(incomeCents / 100); setSpending(spendingCents / 100); setSeeded(true); } }, [incomeCents, spendingCents, seeded]);
  const monthlyNet = income - spending - contribution;
  const projection = Array.from({ length: months }, (_, index) => ({ month: index + 1, balance: netWorth / 100 + oneTime + monthlyNet * (index + 1) }));
  const ending = projection.at(-1)?.balance ?? netWorth / 100 + oneTime;
  return <div className="scenario-grid"><Widget title="Scenario inputs" className="scenario-inputs"><p className="empty-copy">Change the numbers. Your ledger stays untouched.</p><label>Monthly income<input type="number" step="0.01" value={income} onChange={event => setIncome(Number(event.target.value) || 0)} /></label><label>Monthly spending<input type="number" step="0.01" value={spending} onChange={event => setSpending(Number(event.target.value) || 0)} /></label><label>Additional monthly savings / debt payment<input type="number" step="0.01" value={contribution} onChange={event => setContribution(Number(event.target.value) || 0)} /></label><label>One-time change<input type="number" step="0.01" value={oneTime} onChange={event => setOneTime(Number(event.target.value) || 0)} /></label><label>Projection horizon<select value={months} onChange={event => setMonths(Number(event.target.value))}><option value={3}>3 months</option><option value={6}>6 months</option><option value={12}>12 months</option><option value={24}>24 months</option><option value={60}>5 years</option></select></label></Widget><Widget title="Projected balance" className="scenario-result"><strong className={`big-number ${ending >= 0 ? "positive" : "negative"}`}>{money.format(ending)}</strong><p>{money.format(monthlyNet)} net change per month · {months} month scenario</p><div className="scenario-chart">{projection.map(point => <div key={point.month} style={{ height: `${Math.max(6, Math.min(100, (Math.abs(point.balance) / Math.max(...projection.map(item => Math.abs(item.balance)), 1)) * 100))}%` }} title={`Month ${point.month}: ${money.format(point.balance)}`} />)}</div><div className="scenario-summary"><span>Start<strong>{formatMoney(netWorth)}</strong></span><span>One-time<strong>{money.format(oneTime)}</strong></span><span>End<strong>{money.format(ending)}</strong></span></div></Widget><Widget title="Monthly projection" className="scenario-table">{projection.map(point => <div key={point.month}><span>Month {point.month}</span><strong className={point.balance >= 0 ? "positive" : "negative"}>{money.format(point.balance)}</strong></div>)}</Widget></div>;
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"account" | "transaction" | "schedule" | "adjustment" | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<LedgerEntry | null>(null);
  const [adjustingAccount, setAdjustingAccount] = useState<Account | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [syncingAccounts, setSyncingAccounts] = useState(false);
  const [connections, setConnections] = useState<ConnectedInstitution[]>([]);
  const [rangeMonths, setRangeMonths] = useState<number | null>(1);

  const refresh = useCallback(() => { void invoke<DashboardData>("dashboard_data").then(setDashboard).catch((reason: unknown) => setError(String(reason))); }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => { void invoke<Category[]>("categories_data").then(setCategories).catch((reason: unknown) => setError(String(reason))); }, []);
  useEffect(() => { if (dashboard) void invoke<RecurringSuggestion[]>("recurring_suggestions").then(setSuggestions).catch((reason: unknown) => setError(String(reason))); }, [dashboard]);
  useEffect(() => { if (view === "ledger" || view === "calendar") void invoke<LedgerData>("ledger_data").then(setLedger).catch((reason: unknown) => setError(String(reason))); if (view === "dashboard" || view === "scheduled" || view === "calendar") void invoke<Schedule[]>("scheduled_data").then(setSchedules).catch((reason: unknown) => setError(String(reason))); if (view === "accounts") void invoke<ConnectedInstitution[]>("plaid_connections_data").then(setConnections).catch((reason: unknown) => setError(String(reason))); }, [view]);

  const netWorth = useMemo(() => dashboard?.accounts.reduce((total, account) => total + account.balanceCents, 0) ?? 0, [dashboard]);
  const periodTransactions = useMemo(() => { if (!dashboard) return []; if (rangeMonths === null) return dashboard.recentTransactions; const start = new Date(); start.setMonth(start.getMonth() - rangeMonths); return dashboard.recentTransactions.filter(item => new Date(`${item.transactionDate}T12:00:00`) >= start); }, [dashboard, rangeMonths]);
  const periodIncome = periodTransactions.filter(item => item.amountCents > 0).reduce((sum, item) => sum + item.amountCents, 0);
  const periodSpending = -periodTransactions.filter(item => item.amountCents < 0).reduce((sum, item) => sum + item.amountCents, 0);
  const periodLabel = rangeMonths === null ? "All activity" : rangeMonths === 1 ? "Last month" : rangeMonths === 12 ? "Last year" : `Last ${rangeMonths} months`;
  async function addSuggestedSchedule(item: RecurringSuggestion) { await invoke("create_schedule", { input: { accountId: item.accountId, startDate: item.nextOccurrence, description: item.description, amountCents: item.amountCents, recurrence: item.recurrence } }); setSuggestions(current => current.filter(candidate => !(candidate.accountId === item.accountId && candidate.description === item.description && candidate.amountCents === item.amountCents))); }
  async function syncConnectedAccounts() { setSyncingAccounts(true); setError(null); try { await invoke("sync_plaid_sandbox_connections"); refresh(); if (view === "ledger" || view === "calendar") void invoke<LedgerData>("ledger_data").then(setLedger); } catch (reason) { setError(String(reason)); } finally { setSyncingAccounts(false); } }
  async function disconnectConnectedAccount(connection: ConnectedInstitution) { if (!confirm(`Disconnect ${connection.institutionName}? Local history will be kept, but future sync will stop.`)) return; setSyncingAccounts(true); try { await invoke("disconnect_plaid_sandbox_connection", { connectionId: connection.id }); setConnections(current => current.filter(item => item.id !== connection.id)); } catch (reason) { setError(String(reason)); } finally { setSyncingAccounts(false); } }

  return <main className="app-shell">
    <aside className="rail" aria-label="Primary navigation">
      <div className="brand-mark">F</div>
      <button className={`nav-button ${view === "dashboard" ? "selected" : ""}`} onClick={() => setView("dashboard")} aria-label="Dashboard">▦</button>
      <button className={`nav-button ${view === "calendar" ? "selected" : ""}`} onClick={() => setView("calendar")} aria-label="Calendar">□</button>
      <button className={`nav-button ${view === "ledger" ? "selected" : ""}`} onClick={() => setView("ledger")} aria-label="Ledger">☷</button>
      <button className={`nav-button ${view === "accounts" ? "selected" : ""}`} onClick={() => setView("accounts")} aria-label="Accounts">◎</button>
      <button className={`nav-button ${view === "scheduled" ? "selected" : ""}`} onClick={() => setView("scheduled")} aria-label="Scheduled transactions">⌁</button>
      <button className={`nav-button ${view === "scenarios" ? "selected" : ""}`} onClick={() => setView("scenarios")} aria-label="Scenario modeling">AI</button>
      <button className={`nav-button ${view === "categories" ? "selected" : ""}`} onClick={() => setView("categories")} aria-label="Categories">#</button>
    </aside>
    <section className="page">
      <header className="page-header"><div><p className="eyebrow">{view === "dashboard" ? "OVERVIEW" : view === "calendar" || view === "scheduled" || view === "scenarios" ? "PLANNING" : "RECORDS"}</p><h1>{view === "dashboard" ? "Dashboard" : view === "calendar" ? "Calendar" : view === "scheduled" ? "Scheduled transactions" : view === "accounts" ? "Accounts & cards" : view === "categories" ? "Categories" : view === "scenarios" ? "Scenario modeling" : "Ledger"}</h1></div>{view !== "scenarios" && view !== "categories" ? <button className="primary-action" onClick={() => setDialog(view === "scheduled" ? "schedule" : view === "accounts" ? "account" : "transaction")}>{view === "scheduled" ? "Add schedule" : view === "accounts" ? "Add account" : "Add transaction"}</button> : null}</header>
      {error ? <p className="status error">Local data store unavailable: {error}</p> : null}
      {!dashboard && !error ? <p className="status">Opening encrypted local data store...</p> : null}
      {dashboard && view === "dashboard" ? <div className="dashboard-grid">
        <Widget title="Net worth" className="net-worth-widget">
          <strong className="big-number">{formatMoney(netWorth)}</strong><p>Across all local accounts</p>
          <NetWorthChart netWorth={netWorth} transactions={periodTransactions} />
        </Widget>
        <Widget title={periodLabel} className="month-widget">
          <div className="metric"><span>Income</span><strong className="positive">{formatMoney(periodIncome)}</strong></div>
          <div className="metric"><span>Spending</span><strong className="negative">{formatMoney(periodSpending)}</strong></div>
          <div className="range-buttons">{[["1M",1],["3M",3],["6M",6],["1Y",12],["All",null]].map(([label, months]) => <button key={label as string} className={rangeMonths === months ? "active" : ""} onClick={() => setRangeMonths(months as number | null)}>{label}</button>)}</div>
        </Widget>
        <Widget title="Accounts & cards" className="accounts-widget">
          <div className="account-grid">
            {dashboard.accounts.map((account) => <article className="account-card" key={account.id}><small>{account.plaidSubtype ?? account.accountType}{account.plaidMask ? ` · •••• ${account.plaidMask}` : ""}</small><h3>{account.name}</h3><strong>{formatMoney(account.balanceCents)}</strong>{account.plaidAvailableBalanceCents !== null && account.plaidAvailableBalanceCents !== undefined ? <em>Available {formatMoney(account.plaidAvailableBalanceCents)}</em> : null}</article>)}
            <SandboxLinkButton onImported={refresh} />
          </div>
        </Widget>
        <Widget title="Recent transactions" className="recent-widget">
          {dashboard.recentTransactions.length === 0 ? <p className="empty-copy">Add a transaction or connect an account to start your ledger.</p> : <div className="transaction-list">{dashboard.recentTransactions.slice(0, 5).map((item) => <div className="transaction-row" key={item.id}><div><strong>{item.description}</strong><small>{item.transactionDate} · {item.accountName}</small></div><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div>}
        </Widget>
        {schedules.length > 0 ? <Widget title="Upcoming" className="upcoming-widget"><div className="upcoming-list">{[...schedules].sort((left, right) => left.nextOccurrence.localeCompare(right.nextOccurrence)).slice(0, 5).map(item => <div className="upcoming-row" key={item.id}><div><strong>{item.description}</strong><small>{item.nextOccurrence} - {item.accountName} - {item.recurrence}</small></div><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div></Widget> : null}
        {suggestions.length > 0 ? <Widget title="Recurring suggestions" className="suggestions-widget">
          {suggestions.length === 0 ? <p className="empty-copy">No clear recurring patterns to review.</p> : <div className="suggestion-list">{suggestions.map(item => <div className="suggestion-row" key={`${item.accountId}:${item.description}:${item.amountCents}`}><div><strong>{item.description}</strong><small>{item.accountName} · {formatMoney(item.amountCents)} · {item.recurrence} · next {item.nextOccurrence}</small></div><span><button onClick={() => setSuggestions(current => current.filter(candidate => candidate !== item))}>Dismiss</button><button className="primary-action" onClick={() => void addSuggestedSchedule(item)}>Add schedule</button></span></div>)}</div>}
        </Widget> : null}
      </div> : null}
      {view === "ledger" ? <Ledger transactions={ledger?.transactions ?? []} onEdit={(entry) => { setEditingTransaction(entry); setDialog("transaction"); }} onDeleted={() => { refresh(); void invoke<LedgerData>("ledger_data").then(setLedger); }} /> : null}
      {view === "calendar" ? <Calendar month={calendarMonth} transactions={ledger?.transactions ?? []} schedules={schedules} onMonthChange={setCalendarMonth} /> : null}
      {view === "scheduled" ? <Scheduled schedules={schedules} onEdit={(schedule) => { setEditingSchedule(schedule); setDialog("schedule"); }} onChanged={() => { refresh(); void invoke<Schedule[]>("scheduled_data").then(setSchedules); }} /> : null}
      {view === "accounts" ? <Accounts accounts={dashboard?.accounts ?? []} connections={connections} onAdd={() => setDialog("account")} onAdjust={(account) => { setAdjustingAccount(account); setDialog("adjustment"); }} onSync={() => void syncConnectedAccounts()} onDisconnect={(connection) => void disconnectConnectedAccount(connection)} syncing={syncingAccounts} /> : null}
      {view === "scenarios" ? <ScenarioModel netWorth={netWorth} incomeCents={dashboard?.incomeCents ?? 0} spendingCents={dashboard?.spendingCents ?? 0} /> : null}
      {view === "categories" ? <CategoryManager categories={categories} onCreated={() => void invoke<Category[]>("categories_data").then(setCategories)} /> : null}
      {dialog === "account" ? <AccountDialog onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} /> : null}
      {dialog === "transaction" ? <TransactionDialog accounts={dashboard?.accounts ?? []} categories={categories} entry={editingTransaction} onClose={() => { setDialog(null); setEditingTransaction(null); }} onSaved={() => { setDialog(null); setEditingTransaction(null); refresh(); if (view === "ledger") void invoke<LedgerData>("ledger_data").then(setLedger); }} /> : null}
      {dialog === "schedule" ? <ScheduleDialog accounts={dashboard?.accounts ?? []} schedule={editingSchedule} onClose={() => { setDialog(null); setEditingSchedule(null); }} onSaved={() => { setDialog(null); setEditingSchedule(null); setView("scheduled"); void invoke<Schedule[]>("scheduled_data").then(setSchedules); }} /> : null}
      {dialog === "adjustment" && adjustingAccount ? <BalanceAdjustmentDialog account={adjustingAccount} onClose={() => { setDialog(null); setAdjustingAccount(null); }} onSaved={() => { setDialog(null); setAdjustingAccount(null); refresh(); if (view === "ledger") void invoke<LedgerData>("ledger_data").then(setLedger); }} /> : null}
    </section>
  </main>;
}

function Ledger({ transactions, onEdit, onDeleted }: { transactions: LedgerEntry[]; onEdit: (entry: LedgerEntry) => void; onDeleted: () => void }) {
  const [query, setQuery] = useState(""); const [category, setCategory] = useState("all"); const [fromDate, setFromDate] = useState(""); const [toDate, setToDate] = useState(""); const [amount, setAmount] = useState(""); const [visible, setVisible] = useState(50);
  const categories = useMemo(() => [...new Set(transactions.map(item => item.categoryName))].sort(), [transactions]);
  const filtered = useMemo(() => transactions.filter(item => {
    const hasQuery = `${item.description} ${item.accountName} ${item.categoryName} ${Math.abs(item.amountCents / 100).toFixed(2)}`.toLowerCase().includes(query.toLowerCase());
    const hasCategory = category === "all" || item.categoryName === category;
    const hasDate = (!fromDate || item.transactionDate >= fromDate) && (!toDate || item.transactionDate <= toDate);
    const numericAmount = Number(amount); const hasAmount = !amount || (Number.isFinite(numericAmount) && Math.abs(item.amountCents) >= Math.round(numericAmount * 100));
    return hasQuery && hasCategory && hasDate && hasAmount;
  }), [transactions, query, category, fromDate, toDate, amount]);
  useEffect(() => setVisible(50), [query, category, fromDate, toDate, amount]);
  async function remove(item: LedgerEntry) { if (!confirm(`Delete ${item.description}?`)) return; await invoke("delete_transaction", { transactionId: item.id }); onDeleted(); }
  function clearFilters() { setQuery(""); setCategory("all"); setFromDate(""); setToDate(""); setAmount(""); }
  return <section className="ledger-widget"><div className="ledger-toolbar ledger-filters"><input aria-label="Search transactions" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search description or account" /><select aria-label="Filter by category" value={category} onChange={event => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map(name => <option key={name} value={name}>{name}</option>)}</select><label>From<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>To<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label><label>Min. amount<input type="number" min="0" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="$0.00" /></label><button onClick={clearFilters}>Clear</button><span>{filtered.length} records</span></div><div className="ledger-table"><div className="ledger-head"><span>Date</span><span>Description</span><span>Account</span><span>Amount</span></div>{filtered.length === 0 ? <p className="empty-copy">No matching transactions.</p> : filtered.slice(0, visible).map(item => <div className="ledger-row" key={item.id}><span>{item.transactionDate}</span><span><strong>{item.description}</strong><small>{item.categoryName}</small></span><span>{item.accountName}</span><span className="ledger-amount"><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong><div className="ledger-actions"><button onClick={() => onEdit(item)}>Edit</button><button onClick={() => void remove(item)}>Delete</button></div></span></div>)}</div>{visible < filtered.length ? <div className="ledger-load"><button className="primary-action" onClick={() => setVisible(count => count + 50)}>Load 50 more</button><span>{Math.min(visible, filtered.length)} of {filtered.length}</span></div> : null}</section>;
}

function Scheduled({ schedules, onEdit, onChanged }: { schedules: Schedule[]; onEdit: (schedule: Schedule) => void; onChanged: () => void }) {
  const [processing, setProcessing] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  async function process(item: Schedule, operation: "record" | "skip") {
    setProcessing(`${operation}:${item.id}`);
    try {
      const occurrence = await invoke<string>(operation === "record" ? "record_schedule_occurrence" : "skip_schedule_occurrence", { scheduleId: item.id });
      setStatus(current => ({ ...current, [item.id]: operation === "record" ? `Recorded ${occurrence}` : `Skipped ${occurrence}` }));
      onChanged();
    } finally { setProcessing(null); }
  }
  return <section className="ledger-widget scheduled-widget"><div className="ledger-head"><span>Next occurrence</span><span>Description</span><span>Account</span><span>Amount & actions</span></div>{schedules.length === 0 ? <p className="empty-copy">No scheduled transactions yet.</p> : schedules.map(item => <div className="ledger-row" key={item.id}><span>{item.nextOccurrence}<small>{item.recurrence} · starts {item.startDate}{item.endDate ? ` · ends ${item.endDate}` : ""}</small></span><strong>{item.description}</strong><span>{item.accountName}</span><span className="schedule-actions"><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong><div><button onClick={() => onEdit(item)}>Edit</button><button disabled={processing !== null} onClick={() => void process(item, "skip")}>{processing === `skip:${item.id}` ? "Skipping…" : "Skip"}</button><button className="primary-action" disabled={processing !== null} onClick={() => void process(item, "record")}>{processing === `record:${item.id}` ? "Recording…" : "Record"}</button></div>{status[item.id] ? <small className="schedule-status">{status[item.id]}</small> : null}</span></div>)}</section>;
}

function Accounts({ accounts, connections, onAdd, onAdjust, onSync, onDisconnect, syncing }: { accounts: Account[]; connections: ConnectedInstitution[]; onAdd: () => void; onAdjust: (account: Account) => void; onSync: () => void; onDisconnect: (connection: ConnectedInstitution) => void; syncing: boolean }) { return <section className="ledger-widget accounts-page"><div className="accounts-toolbar"><p className="empty-copy">Connected Sandbox accounts can be refreshed without going through Link again.</p><button className="primary-action" disabled={syncing || connections.length === 0} onClick={onSync}>{syncing ? "Syncing accounts…" : "Sync connected accounts"}</button></div>{connections.length > 0 ? <div className="connected-institutions">{connections.map(connection => <div key={connection.id}><span><strong>{connection.institutionName}</strong><small>{connection.accountCount} linked account{connection.accountCount === 1 ? "" : "s"} · {connection.environment}</small></span><button disabled={syncing} onClick={() => onDisconnect(connection)}>Disconnect</button></div>)}</div> : null}<div className="account-grid">{accounts.map(account => <article className="account-card" key={account.id}><small>{account.accountType}</small><h3>{account.name}</h3><strong>{formatMoney(account.balanceCents)}</strong><button className="account-adjust" onClick={() => onAdjust(account)}>Update balance</button></article>)}<button className="connect-card" onClick={onAdd}><span>+</span><strong>Add local account</strong><small>Manual account or balance tracking</small></button><SandboxLinkButton onImported={() => window.location.reload()} /></div></section>; }

function CategoryManager({ categories, onCreated }: { categories: Category[]; onCreated: () => void }) {
  const [name, setName] = useState(""); const [error, setError] = useState<string | null>(null);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); try { await invoke("create_category", { name }); setName(""); setError(null); onCreated(); } catch (reason) { setError(String(reason)); } }
  return <div className="category-layout"><Widget title="Preferred categories" className="category-list"><p className="empty-copy">Used for manual entries and future category suggestions.</p><div>{categories.map(category => <span key={category.id}>{category.name}</span>)}</div></Widget><Widget title="Add category" className="category-add"><form onSubmit={add}><label>Name<input value={name} onChange={event => setName(event.target.value)} required placeholder="Pet care" /></label><button className="primary-action" type="submit">Add category</button>{error ? <p className="form-error">{error}</p> : null}</form></Widget></div>;
}

function SandboxLinkButton({ onImported }: { onImported: () => void }) {
  const [session, setSession] = useState<SandboxLinkSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function begin() {
    setLoading(true); setMessage(null);
    try { setSession(await invoke<SandboxLinkSession>("create_plaid_sandbox_link_session")); }
    catch (reason) { setMessage(String(reason)); setLoading(false); }
  }
  if (session) return <PlaidLinkLauncher session={session} onDone={() => { setSession(null); setLoading(false); onImported(); }} onCancelled={() => { setSession(null); setLoading(false); }} />;
  return <div className="connect-card sandbox-link-card"><span>+</span><strong>{loading ? "Preparing Plaid Link…" : "Connect Sandbox account"}</strong><small>Uses Plaid Link · Sandbox only · no Trial slot</small><button onClick={() => void begin()} disabled={loading}>{loading ? "Working…" : "Open Plaid Link"}</button>{message ? <small className="form-error">{message}</small> : null}</div>;
}

function PlaidLinkLauncher({ session, onDone, onCancelled }: { session: SandboxLinkSession; onDone: () => void; onCancelled: () => void }) {
  const [status, setStatus] = useState("Opening Plaid Link…");
  const completingRef = useRef(false);
  const { open, ready } = usePlaidLink({
    token: session.linkToken,
    onSuccess: async (publicToken, metadata) => {
      completingRef.current = true;
      setStatus("Importing encrypted Sandbox records…");
      try {
        await invoke<number>("complete_plaid_sandbox_link", { input: {
          sessionId: session.sessionId, sessionSecret: session.sessionSecret, publicToken,
          institutionId: metadata.institution?.institution_id ?? null, institutionName: metadata.institution?.name ?? null,
        } });
        onDone();
      } catch (reason) { setStatus(`Import failed: ${String(reason)}`); }
    },
    onExit: () => { if (!completingRef.current) onCancelled(); },
  });
  useEffect(() => { if (ready) open(); }, [open, ready]);
  return <div className="connect-card sandbox-link-card"><span>↗</span><strong>{status}</strong><small>{ready ? "Complete or cancel the Plaid window." : "Loading Plaid Link…"}</small></div>;
}

function Calendar({ month, transactions, schedules, onMonthChange }: { month: Date; transactions: LedgerEntry[]; schedules: Schedule[]; onMonthChange: (month: Date) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; width: number } | null>(null);
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const first = new Date(year, monthIndex, 1); const start = new Date(year, monthIndex, 1 - first.getDay());
  const monthTitle = month.toLocaleString("en-US", { month: "long", year: "numeric" });
  const transactionMap = new Map<string, CalendarItem[]>();
  transactions.forEach(item => transactionMap.set(item.transactionDate, [...(transactionMap.get(item.transactionDate) ?? []), item]));
  function scheduledEntriesFor(key: string): CalendarItem[] {
    const candidate = new Date(`${key}T12:00:00`);
    return schedules.filter(schedule => {
      const firstOccurrence = new Date(`${schedule.nextOccurrence}T12:00:00`);
      if (candidate < firstOccurrence) return false;
      if (schedule.endDate && key > schedule.endDate) return false;
      const days = Math.round((candidate.getTime() - firstOccurrence.getTime()) / 86400000);
      if (schedule.recurrence === "daily") return true;
      if (schedule.recurrence === "weekly") return days % 7 === 0;
      if (schedule.recurrence === "biweekly") return days % 14 === 0;
      const months = (candidate.getFullYear() - firstOccurrence.getFullYear()) * 12 + candidate.getMonth() - firstOccurrence.getMonth();
      const interval = schedule.recurrence === "quarterly" ? 3 : schedule.recurrence === "yearly" ? 12 : 1;
      return candidate.getDate() === firstOccurrence.getDate() && months >= 0 && months % interval === 0;
    }).map(schedule => ({ id: `scheduled:${schedule.id}:${key}`, description: schedule.description, amountCents: schedule.amountCents, scheduled: true }));
  }
  const selectedItems = selected ? [...(transactionMap.get(selected) ?? []), ...scheduledEntriesFor(selected)] : [];
  useEffect(() => { if (!selected) return; const close = (event: PointerEvent) => { if (surfaceRef.current && !surfaceRef.current.contains(event.target as Node)) setSelected(null); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [selected]);
  function changeMonth(delta: number) { setSelected(null); onMonthChange(new Date(year, monthIndex + delta, 1)); }
  function onPointerDown(event: React.PointerEvent<HTMLElement>) { if ((event.target as HTMLElement).closest("button")) return; const width = event.currentTarget.getBoundingClientRect().width; dragRef.current = { pointerId: event.pointerId, startX: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }
  function onPointerMove(event: React.PointerEvent<HTMLElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; setOffset(Math.max(-drag.width, Math.min(drag.width, event.clientX - drag.startX))); }
  function onPointerUp(event: React.PointerEvent<HTMLElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; dragRef.current = null; const releaseOffset = event.clientX - drag.startX; const direction = Math.abs(releaseOffset) > drag.width / 2 ? (releaseOffset < 0 ? 1 : -1) : 0; setSettling(true); if (!direction) { setOffset(0); window.setTimeout(() => setSettling(false), 380); return; } setOffset(direction > 0 ? -drag.width : drag.width); window.setTimeout(() => { changeMonth(direction); setSettling(false); setOffset(0); }, 380); }
  return <section className="calendar-widget" ref={surfaceRef}><div className="calendar-controls"><button onClick={() => changeMonth(-1)}>‹</button><strong>{monthTitle}</strong><button onClick={() => changeMonth(1)}>›</button></div><div className="calendar-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}><div className={`calendar-grid ${settling ? "settling" : ""}`} style={{ transform: `translateX(${offset}px)` }}>{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day => <div className="calendar-day-name" key={day}>{day}</div>)}{Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const key = date.toISOString().slice(0, 10); const entries = [...(transactionMap.get(key) ?? []), ...scheduledEntriesFor(key)]; const income = entries.filter(item => item.amountCents > 0).reduce((sum, item) => sum + item.amountCents, 0); const spend = entries.filter(item => item.amountCents < 0).reduce((sum, item) => sum + item.amountCents, 0); return <button className={`calendar-cell ${date.getMonth() !== monthIndex ? "outside" : ""} ${selected === key ? "selected-cell" : ""}`} onClick={() => setSelected(key)} key={key}><span>{date.getDate()}</span>{income ? <small className="positive">+{formatMoney(income)}</small> : null}{spend ? <small className="negative">{formatMoney(spend)}</small> : null}</button>; })}</div></div>{selected ? <aside className="date-popover"><header><strong>{new Date(`${selected}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</strong><button onClick={() => setSelected(null)}>×</button></header>{selectedItems.length === 0 ? <p className="empty-copy">No transactions or planned items.</p> : selectedItems.map(item => <div className="popover-item" key={item.id}><span>{item.description}{item.scheduled ? <small>Planned · scheduled</small> : null}</span><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</aside> : null}</section>;
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

function BalanceAdjustmentDialog({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await invoke("adjust_account_balance", { input: { accountId: account.id, targetBalanceCents: Math.round(Number(form.get("balance")) * 100), transactionDate: form.get("date"), notes: form.get("notes") || null } }); onSaved(); }
    catch (reason) { setError(String(reason)); }
  }
  return <div className="dialog-backdrop"><form className="dialog" onSubmit={submit}><header><h2>Update balance</h2><button type="button" onClick={onClose}>×</button></header><p className="empty-copy">{account.name} currently shows {formatMoney(account.balanceCents)}. Saving creates an adjustment record.</p><label>Actual balance<input name="balance" type="number" step="0.01" required defaultValue={(account.balanceCents / 100).toFixed(2)} autoFocus /></label><label>Date<input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label><label>Notes<textarea name="notes" rows={2} placeholder="Optional reason for this adjustment" /></label>{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">Save adjustment</button></footer></form></div>;
}

function TransactionDialog({ accounts, categories, entry, onClose, onSaved }: { accounts: Account[]; categories: Category[]; entry: LedgerEntry | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const input = { accountId: form.get("accountId"), transactionDate: form.get("date"), description: form.get("description"), amountCents: Math.round(Number(form.get("amount")) * 100), categoryId: form.get("categoryId") || null, notes: form.get("notes") || null };
    try { if (entry) await invoke("update_transaction", { input: { id: entry.id, ...input } }); else await invoke("create_transaction", { input }); onSaved(); }
    catch (reason) { setError(String(reason)); }
  }
  return <div className="dialog-backdrop"><form className="dialog" onSubmit={submit}><header><h2>{entry ? "Edit transaction" : "Add transaction"}</h2><button type="button" onClick={onClose}>×</button></header>{accounts.length === 0 ? <p className="empty-copy">Create an account first.</p> : <><label>Account<select name="accountId" required defaultValue={entry?.accountId}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>Date<input name="date" type="date" defaultValue={entry?.transactionDate ?? new Date().toISOString().slice(0, 10)} required /></label><label>Description<input name="description" required placeholder="Groceries" defaultValue={entry?.description} /></label><label>Amount<input name="amount" type="number" step="0.01" required placeholder="-48.20" defaultValue={entry ? (entry.amountCents / 100).toFixed(2) : undefined} /></label><label>Category<select name="categoryId" defaultValue={entry?.categoryId ?? ""}><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Notes<textarea name="notes" rows={3} /></label></>}{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button>{accounts.length > 0 ? <button className="primary-action" type="submit">{entry ? "Save changes" : "Save transaction"}</button> : null}</footer></form></div>;
}

function ScheduleDialog({ accounts, schedule, onClose, onSaved }: { accounts: Account[]; schedule: Schedule | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const input = { accountId: form.get("accountId"), startDate: form.get("date"), endDate: form.get("endDate") || null, description: form.get("description"), amountCents: Math.round(Number(form.get("amount")) * 100), recurrence: form.get("recurrence") }; try { if (schedule) await invoke("update_schedule", { input: { id: schedule.id, ...input } }); else await invoke("create_schedule", { input }); onSaved(); } catch (reason) { setError(String(reason)); } }
  return <div className="dialog-backdrop"><form className="dialog" onSubmit={submit}><header><h2>{schedule ? "Edit scheduled transaction" : "Add scheduled transaction"}</h2><button type="button" onClick={onClose}>×</button></header>{accounts.length === 0 ? <p className="empty-copy">Create an account first.</p> : <><label>Account<select name="accountId" defaultValue={schedule?.accountId}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Starts<input name="date" type="date" defaultValue={schedule?.startDate ?? new Date().toISOString().slice(0, 10)} /></label><label>Ends (optional)<input name="endDate" type="date" defaultValue={schedule?.endDate ?? ""} /></label><label>Description<input name="description" required defaultValue={schedule?.description} /></label><label>Amount<input name="amount" type="number" step="0.01" required defaultValue={schedule ? (schedule.amountCents / 100).toFixed(2) : undefined} /></label><label>Repeats<select name="recurrence" defaultValue={schedule?.recurrence ?? "monthly"}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option><option value="quarterly">Every 3 months</option><option value="yearly">Yearly</option></select></label></>}{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button>{accounts.length > 0 ? <button className="primary-action" type="submit">{schedule ? "Save changes" : "Save schedule"}</button> : null}</footer></form></div>;
}
