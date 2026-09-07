import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, ChartNoAxesCombined, Check, ChevronRight, CircleUserRound, Ellipsis, LayoutDashboard, Link2, LoaderCircle, Pencil, Plus, ReceiptText, RefreshCw, Repeat2, SkipForward, Sparkles, Trash2, Unplug, WalletCards, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import moneyMapIcon from "../src-tauri/icons/money-map-plaid-1024.png";
import { RecurringReview } from "./RecurringReview";
import "./category-manager.css";
import "./shell-layout.css";

type Account = { id: string; name: string; accountType: string; balanceCents: number; plaidConnectionId?: string | null; plaidAccountSubtype?: string | null; mask?: string | null; availableBalanceCents?: number | null; balanceRefreshedAt?: string | null };
type LedgerEntry = { id: string; accountId: string; transactionDate: string; description: string; accountName: string; categoryName: string; categoryId: string | null; amountCents: number };
type DashboardData = { incomeCents: number; spendingCents: number; accounts: Account[]; recentTransactions: LedgerEntry[] };
type LedgerData = { transactions: LedgerEntry[] };
type Schedule = { id: string; accountId: string; startDate: string; endDate: string | null; nextOccurrence: string; description: string; amountCents: number; recurrence: string; accountName: string };
type SandboxLinkSession = { linkToken: string; sessionId: string; sessionSecret: string; expiration: string };
type Category = { id: string; name: string };
type CalendarItem = { id: string; description: string; amountCents: number; scheduled?: boolean };
type ConnectedInstitution = { id: string; institutionName: string; environment: string; accountCount: number };
type AppCapabilities = { sandboxEnabled: boolean };
type RecoveryStatus = { state: string; recoveryRequired: boolean; authorityUnknown: boolean; databaseExists: boolean; databaseReadable: boolean; backupAvailable: boolean; orphanedConnections: number; message: string };
type ProfileBackupResult = { backupPath: string; createdAt: number };
type ProfileBackupSummary = { path: string; createdAt: number; sourceSchemaVersion: number; applicationVersion: string };
type PlaidSyncResult = { changed: number; pendingConnections: number; statuses: string[] };
type TradeStationConnectionStatus = { status: "not_connected" | "preparing" | "waiting_for_browser" | "exchanging" | "connected" | "failed"; message: string; connectionId: string | null };
type View = "dashboard" | "ledger" | "calendar" | "scheduled" | "accounts" | "investments" | "scenarios" | "settings";
type PendingDisconnect = { connection: ConnectedInstitution; confirming: boolean };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatMaskedAccountIdentifier = (mask?: string | null) => mask?.trim() ? `****${mask.trim()}` : null;
const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

async function synchronizePlaidHistory(onProgress: (attempt: number) => void, maxAttempts = 20): Promise<PlaidSyncResult> {
  let aggregate: PlaidSyncResult = { changed: 0, pendingConnections: 0, statuses: [] };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await invoke<PlaidSyncResult>("sync_plaid_connections");
    aggregate = {
      changed: aggregate.changed + result.changed,
      pendingConnections: result.pendingConnections,
      statuses: result.statuses,
    };
    if (result.pendingConnections === 0) return aggregate;
    onProgress(attempt);
    if (attempt < maxAttempts) await wait(3_000);
  }
  return aggregate;
}

function Widget({ title, children, className = "", action }: { title: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return <section className={`widget ${className}`}><header className="widget-header"><h2>{title}</h2>{action}</header>{children}</section>;
}

function IconAction({ label, tone = "default", className = "", children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "default" | "danger"; children: React.ReactNode }) {
  return <button {...props} className={`icon-action ${tone === "danger" ? "danger" : ""} ${className}`.trim()} aria-label={label} title={label}>{children}</button>;
}

function OverflowActions({ label = "More actions", children }: { label?: string; children: React.ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  return <details className="overflow-actions" ref={details}><summary aria-label={label} title={label}><Ellipsis aria-hidden="true" /></summary><div className="overflow-menu" role="menu" onClick={() => details.current?.removeAttribute("open")}>{children}</div></details>;
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
  const [recoveringStore, setRecoveringStore] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null);
  const [dialog, setDialog] = useState<"account" | "transaction" | "schedule" | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<LedgerEntry | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [syncingAccounts, setSyncingAccounts] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectedInstitution[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<PendingDisconnect | null>(null);
  const [rangeMonths, setRangeMonths] = useState<number | null>(1);
  const [startupSyncing, setStartupSyncing] = useState(true);
  const [startupSyncMessage, setStartupSyncMessage] = useState("Opening local finance profile…");
  const [startupSyncWarning, setStartupSyncWarning] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const storeEpoch = useRef(0);

  const refresh = useCallback(() => {
    const epoch = storeEpoch.current;
    void invoke<DashboardData>("dashboard_data").then((data) => {
      if (epoch !== storeEpoch.current) return;
      setDashboard(data); setError(null);
    }).catch((reason: unknown) => { if (epoch === storeEpoch.current) setError(String(reason)); });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const epoch = storeEpoch.current;
      try {
        const profileRecovery = await invoke<RecoveryStatus>("recovery_status");
        if (cancelled || epoch !== storeEpoch.current) return;
        setRecoveryStatus(profileRecovery);
        if (profileRecovery.recoveryRequired) {
          setError(null);
          setStartupSyncing(false);
          return;
        }
        const [initialDashboard, initialCategories, initialConnections, initialSchedules, capabilities] = await Promise.all([
          invoke<DashboardData>("dashboard_data"), invoke<Category[]>("categories_data"), invoke<ConnectedInstitution[]>("plaid_connections_data"), invoke<Schedule[]>("scheduled_data"), invoke<AppCapabilities>("app_capabilities")
        ]);
        if (cancelled || epoch !== storeEpoch.current) return;
        setDashboard(initialDashboard); setCategories(initialCategories); setConnections(initialConnections); setSchedules(initialSchedules); setSandboxEnabled(capabilities.sandboxEnabled); setError(null);
        if (initialConnections.length === 0) { setStartupSyncMessage("Local profile ready."); return; }
        setStartupSyncMessage(`Refreshing ${initialConnections.length} connected ${initialConnections.length === 1 ? "institution" : "institutions"}…`);
        try {
          const syncResult = await synchronizePlaidHistory(attempt => {
            if (!cancelled) setStartupSyncMessage(`Plaid is preparing transaction history… retry ${attempt} of 20`);
          });
          const [refreshedDashboard, refreshedConnections, refreshedSchedules] = await Promise.all([
            invoke<DashboardData>("dashboard_data"), invoke<ConnectedInstitution[]>("plaid_connections_data"), invoke<Schedule[]>("scheduled_data")
          ]);
          if (cancelled || epoch !== storeEpoch.current) return;
          setDashboard(refreshedDashboard); setConnections(refreshedConnections); setSchedules(refreshedSchedules);
          if (syncResult.pendingConnections > 0) {
            setStartupSyncWarning("Plaid is still preparing transaction history. Saved account balances are available, and Money Map will continue on the next startup or manual sync.");
          } else {
            setStartupSyncMessage("Connected accounts are up to date.");
          }
        } catch (reason) {
          if (cancelled || epoch !== storeEpoch.current) return;
          setStartupSyncWarning(`Could not refresh connected accounts. Showing saved local data. ${String(reason)}`);
        }
      } catch (reason) { if (!cancelled && epoch === storeEpoch.current) setError(String(reason)); }
      finally { if (!cancelled && epoch === storeEpoch.current) setStartupSyncing(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { const epoch = storeEpoch.current; const report = (reason: unknown) => { if (epoch === storeEpoch.current) setError(String(reason)); }; if (view === "ledger" || view === "calendar") void invoke<LedgerData>("ledger_data").then((data) => { if (epoch === storeEpoch.current) setLedger(data); }).catch(report); if (view === "dashboard" || view === "scheduled" || view === "calendar") void invoke<Schedule[]>("scheduled_data").then((data) => { if (epoch === storeEpoch.current) setSchedules(data); }).catch(report); if (view === "accounts") void invoke<ConnectedInstitution[]>("plaid_connections_data").then((data) => { if (epoch === storeEpoch.current) setConnections(data); }).catch(report); }, [view]);

  const netWorth = useMemo(() => dashboard?.accounts.reduce((total, account) => total + account.balanceCents, 0) ?? 0, [dashboard]);
  const periodTransactions = useMemo(() => { if (!dashboard) return []; if (rangeMonths === null) return dashboard.recentTransactions; const start = new Date(); start.setMonth(start.getMonth() - rangeMonths); return dashboard.recentTransactions.filter(item => new Date(`${item.transactionDate}T12:00:00`) >= start); }, [dashboard, rangeMonths]);
  const periodIncome = periodTransactions.filter(item => item.amountCents > 0).reduce((sum, item) => sum + item.amountCents, 0);
  const periodSpending = -periodTransactions.filter(item => item.amountCents < 0).reduce((sum, item) => sum + item.amountCents, 0);
  const periodLabel = rangeMonths === null ? "All activity" : rangeMonths === 1 ? "Last month" : rangeMonths === 12 ? "Last year" : `Last ${rangeMonths} months`;
  async function syncConnectedAccounts() { setSyncingAccounts(true); setError(null); setSyncMessage("Refreshing connected accounts…"); try { const result = await synchronizePlaidHistory(attempt => setSyncMessage(`Plaid is preparing transaction history… retry ${attempt} of 20`)); setSyncMessage(result.pendingConnections > 0 ? "Plaid is still preparing transaction history. Retry later or restart Money Map." : result.changed === 0 ? "Up to date." : `Synced ${result.changed} transaction change${result.changed === 1 ? "" : "s"}.`); refresh(); if (view === "ledger" || view === "calendar") void invoke<LedgerData>("ledger_data").then(setLedger); } catch (reason) { setError(String(reason)); } finally { setSyncingAccounts(false); } }
  async function disconnectConnectedAccount(connection: ConnectedInstitution) { setPendingDisconnect({ connection, confirming: false }); }
  async function confirmDisconnect() {
    const pending = pendingDisconnect;
    if (!pending) return;
    setPendingDisconnect({ ...pending, confirming: true }); setSyncingAccounts(true);
    try {
      await invoke("disconnect_plaid_connection", { connectionId: pending.connection.id });
      setConnections(current => current.filter(item => item.id !== pending.connection.id));
      refresh();
      void invoke<LedgerData>("ledger_data").then(setLedger);
      void invoke<Schedule[]>("scheduled_data").then(setSchedules);
      setPendingDisconnect(null);
    } catch (reason) { setError(String(reason)); setPendingDisconnect(null); }
    finally { setSyncingAccounts(false); }
  }
  async function recoverLocalStore() {
    if (!confirm("Start a fresh encrypted local store? The unreadable file will be preserved in the app data folder, but it cannot be used without its original encryption key.")) return;
    setRecoveringStore(true);
    storeEpoch.current += 1;
    setError(null);
    try {
      await invoke("reset_unavailable_database");
      refresh();
      void invoke<Category[]>("categories_data").then(setCategories).catch((reason: unknown) => setError(String(reason)));
    } catch (reason) { setError(String(reason)); } finally { setRecoveringStore(false); }
  }
  async function restoreLocalProfile() {
    setRecoveringStore(true); setError(null);
    try {
      await invoke<ProfileBackupResult>("restore_latest_profile_backup");
      window.location.reload();
    } catch (reason) { setError(String(reason)); setRecoveringStore(false); }
  }
  async function revokeAndStartFresh() {
    const canKeepProfile = Boolean(recoveryStatus?.databaseExists && recoveryStatus.databaseReadable);
    const prompt = canKeepProfile
      ? `Revoke ${recoveryStatus?.orphanedConnections ?? 0} remote connection(s) missing from this local profile? Existing local accounts and transactions will be preserved.`
      : "Revoke every recorded remote bank connection and start a new local profile? This stops future synchronization for the old profile. Reconnecting later requires going through the bank connection flow again.";
    if (!confirm(prompt)) return;
    setRecoveringStore(true); setError(null);
    try {
      await invoke("revoke_orphaned_connections");
      if (!canKeepProfile) await invoke("reset_unavailable_database");
      window.location.reload();
    } catch (reason) { setError(String(reason)); setRecoveringStore(false); }
  }

  return <main className="app-shell">
    <aside className="rail" aria-label="Primary navigation">
      <div className="brand-mark" role="img" aria-label="Money Map" style={{ background: `#0b1625 url(${moneyMapIcon}) center / cover no-repeat`, border: "1px solid #2c4059" }} />
      <button className={`nav-button ${view === "dashboard" ? "selected" : ""}`} onClick={() => setView("dashboard")} aria-label="Dashboard" aria-current={view === "dashboard" ? "page" : undefined} title="Dashboard"><LayoutDashboard aria-hidden="true" /></button>
      <button className={`nav-button ${view === "calendar" ? "selected" : ""}`} onClick={() => setView("calendar")} aria-label="Calendar" aria-current={view === "calendar" ? "page" : undefined} title="Calendar"><CalendarDays aria-hidden="true" /></button>
      <button className={`nav-button ${view === "ledger" ? "selected" : ""}`} onClick={() => setView("ledger")} aria-label="Ledger" aria-current={view === "ledger" ? "page" : undefined} title="Ledger"><ReceiptText aria-hidden="true" /></button>
      <button className={`nav-button ${view === "accounts" ? "selected" : ""}`} onClick={() => setView("accounts")} aria-label="Accounts and cards" aria-current={view === "accounts" ? "page" : undefined} title="Accounts and cards"><WalletCards aria-hidden="true" /></button>
      <button className={`nav-button ${view === "scheduled" ? "selected" : ""}`} onClick={() => setView("scheduled")} aria-label="Scheduled transactions" aria-current={view === "scheduled" ? "page" : undefined} title="Scheduled transactions"><Repeat2 aria-hidden="true" /></button>
      <button className={`nav-button ${view === "scenarios" ? "selected" : ""}`} onClick={() => setView("scenarios")} aria-label="Scenario modeling" aria-current={view === "scenarios" ? "page" : undefined} title="Scenario modeling"><Sparkles aria-hidden="true" /></button>
      <button className={`nav-button ${view === "investments" ? "selected" : ""}`} onClick={() => setView("investments")} aria-label="Investments" aria-current={view === "investments" ? "page" : undefined} title="Investments"><ChartNoAxesCombined aria-hidden="true" /></button>
      <div className="profile-rail">
        {profileMenuOpen ? <div className="profile-menu" role="menu"><strong>Local profile</strong><small>Money Map on this device</small><button onClick={() => { setProfileMenuOpen(false); setView("settings"); }}>Settings & connections</button></div> : null}
        <button className={`profile-button ${view === "settings" ? "selected" : ""}`} aria-label="Profile and settings" aria-current={view === "settings" ? "page" : undefined} aria-expanded={profileMenuOpen} title="Profile and settings" onClick={() => setProfileMenuOpen(open => !open)}><CircleUserRound aria-hidden="true" /></button>
      </div>
    </aside>
    <section className="page">
      <header className="page-header"><div><p className="eyebrow">{view === "dashboard" ? "OVERVIEW" : view === "calendar" || view === "scheduled" || view === "scenarios" ? "PLANNING" : view === "investments" ? "PORTFOLIO" : view === "settings" ? "PROFILE" : "RECORDS"}</p><h1>{view === "dashboard" ? "Dashboard" : view === "calendar" ? "Calendar" : view === "scheduled" ? "Scheduled transactions" : view === "accounts" ? "Accounts & cards" : view === "investments" ? "Investments" : view === "scenarios" ? "Scenario modeling" : view === "settings" ? "Settings" : "Ledger"}</h1></div>{view !== "scenarios" && view !== "accounts" && view !== "investments" && view !== "settings" ? <button className="primary-action" onClick={() => setDialog(view === "scheduled" ? "schedule" : "transaction")}>{view === "scheduled" ? "Add schedule" : "Add transaction"}</button> : null}</header>
      {startupSyncing ? <div className="startup-sync" role="status" aria-live="polite"><span className="sync-spinner" /><span><strong>{startupSyncMessage}</strong><small>Your dashboard remains available while the refresh runs.</small></span></div> : null}
      {!startupSyncing && startupSyncWarning ? <div className="startup-sync warning"><span>!</span><span><strong>Account refresh did not finish.</strong><small>{startupSyncWarning}</small></span></div> : null}
      {recoveryStatus?.recoveryRequired ? <section className="recovery-panel" role="alert"><div><p className="eyebrow">PROFILE RECOVERY</p><h2>{recoveryStatus.authorityUnknown ? "Connection authority cannot be verified" : "Remote connections need your decision"}</h2><p>{recoveryStatus.message}</p><small>{recoveryStatus.authorityUnknown ? "Money Map will not create or reset a Production profile while remote authority is unknown." : `${recoveryStatus.orphanedConnections} recorded remote ${recoveryStatus.orphanedConnections === 1 ? "connection" : "connections"}. Money Map has blocked a new bank connection so the existing paid connection cannot be duplicated.`}</small></div><div className="recovery-actions">{recoveryStatus.backupAvailable ? <button className="primary-action" disabled={recoveringStore} onClick={() => void restoreLocalProfile()}>{recoveringStore ? "Restoring…" : "Restore latest encrypted backup"}</button> : null}{!recoveryStatus.authorityUnknown ? <button className="destructive-action" disabled={recoveringStore} onClick={() => void revokeAndStartFresh()}>{recoveringStore ? "Working…" : recoveryStatus.databaseExists && recoveryStatus.databaseReadable ? "Revoke missing connections" : "Revoke old connections and start fresh"}</button> : null}</div><p className="recovery-note">Backups are SQLCipher-encrypted and can be restored only by the same Windows profile that created them.</p></section> : null}
      {error ? <div className="status error"><strong>Local data store unavailable.</strong><span>{error}</span>{recoveryStatus && !recoveryStatus.recoveryRequired ? <><p>This file cannot be opened by the current Windows profile. The unreadable file will be preserved before a fresh encrypted store is created.</p><button disabled={recoveringStore} onClick={() => void recoverLocalStore()}>{recoveringStore ? "Preparing fresh store…" : "Preserve file and start fresh"}</button></> : null}</div> : null}
      {!dashboard && !error && !recoveryStatus?.recoveryRequired ? <p className="status">Opening encrypted local data store...</p> : null}
      {dashboard && view === "dashboard" ? <div className="dashboard-grid">
        <Widget title="Net worth" className="net-worth-widget">
          <strong className="big-number">{formatMoney(netWorth)}</strong><p>Across all local accounts</p>
          <NetWorthChart netWorth={netWorth} transactions={periodTransactions} />
          <div className="net-worth-period-summary">
            <div className="period-metrics" aria-label={`${periodLabel} summary`}>
              <span className="period-label">{periodLabel}</span>
              <div><small>Income</small><strong className="positive">{formatMoney(periodIncome)}</strong></div>
              <div><small>Spending</small><strong className="negative">{formatMoney(periodSpending)}</strong></div>
              <div><small>Net flow</small><strong className={periodIncome - periodSpending >= 0 ? "positive" : "negative"}>{formatMoney(periodIncome - periodSpending)}</strong></div>
            </div>
            <div className="range-buttons" aria-label="Net-worth date range">{[["1M",1],["3M",3],["6M",6],["1Y",12],["All",null]].map(([label, months]) => <button key={label as string} className={rangeMonths === months ? "active" : ""} onClick={() => setRangeMonths(months as number | null)}>{label}</button>)}</div>
          </div>
        </Widget>
        <Widget title="Recent transactions" className="recent-widget" action={dashboard.recentTransactions.length > 0 ? <button className="widget-link" onClick={() => setView("ledger")}>View all <ChevronRight aria-hidden="true" /></button> : null}>
          {dashboard.recentTransactions.length === 0 ? <p className="empty-copy">Add a transaction or connect an account to start your ledger.</p> : <div className="transaction-list">{dashboard.recentTransactions.slice(0, 5).map((item) => <div className="transaction-row" key={item.id}><div><strong>{item.description}</strong><small>{item.transactionDate} · {item.accountName}</small></div><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div>}
        </Widget>
        <Widget title="Accounts & cards" className="accounts-widget" action={dashboard.accounts.length > 0 ? <button className="widget-link" onClick={() => setView("accounts")}>View all <ChevronRight aria-hidden="true" /></button> : null}>
          <div className="dashboard-account-list">
            {dashboard.accounts.slice(0, 6).map((account) => <button type="button" className="account-card" onClick={() => { setSelectedAccountId(account.id); setView("accounts"); }} key={account.id}><small>{account.plaidAccountSubtype ?? account.accountType}{formatMaskedAccountIdentifier(account.mask) ? ` · ${formatMaskedAccountIdentifier(account.mask)}` : ""}</small><h3>{account.name}</h3><strong>{formatMoney(account.balanceCents)}</strong>{account.availableBalanceCents !== null && account.availableBalanceCents !== undefined ? <em>Available {formatMoney(account.availableBalanceCents)}</em> : null}</button>)}
            {dashboard.accounts.length === 0 ? <DashboardConnectCard sandboxEnabled={sandboxEnabled} onImported={refresh} onManageAccounts={() => setView("accounts")} /> : null}
          </div>
        </Widget>
        {schedules.length > 0 ? <Widget title="Upcoming" className="upcoming-widget" action={<button className="widget-link" onClick={() => setView("scheduled")}>View all <ChevronRight aria-hidden="true" /></button>}><div className="upcoming-list">{[...schedules].sort((left, right) => left.nextOccurrence.localeCompare(right.nextOccurrence)).slice(0, 4).map(item => <div className="upcoming-row" key={item.id}><div><strong>{item.description}</strong><small>{item.nextOccurrence} - {item.accountName} - {item.recurrence}</small></div><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</div></Widget> : null}
        <RecurringReview onExecuted={() => { refresh(); void invoke<Schedule[]>("scheduled_data").then(setSchedules); if (ledger) void invoke<LedgerData>("ledger_data").then(setLedger); }} />
      </div> : null}
      {view === "ledger" ? <Ledger transactions={ledger?.transactions ?? []} onEdit={(entry) => { setEditingTransaction(entry); setDialog("transaction"); }} onDeleted={() => { refresh(); void invoke<LedgerData>("ledger_data").then(setLedger); }} /> : null}
      {view === "calendar" ? <Calendar month={calendarMonth} transactions={ledger?.transactions ?? []} schedules={schedules} onMonthChange={setCalendarMonth} /> : null}
      {view === "scheduled" ? <Scheduled schedules={schedules} onEdit={(schedule) => { setEditingSchedule(schedule); setDialog("schedule"); }} onChanged={() => { refresh(); void invoke<Schedule[]>("scheduled_data").then(setSchedules); }} /> : null}
      {view === "accounts" ? <Accounts accounts={dashboard?.accounts ?? []} connections={connections} sandboxEnabled={sandboxEnabled} syncMessage={syncMessage} selectedAccountId={selectedAccountId} onSelectAccount={setSelectedAccountId} onAdd={() => setDialog("account")} onSync={() => void syncConnectedAccounts()} onDisconnect={(connection) => void disconnectConnectedAccount(connection)} syncing={syncingAccounts} /> : null}
      {view === "investments" ? <InvestmentView sandboxEnabled={sandboxEnabled} onOpenSettings={() => setView("settings")} /> : null}
      {view === "scenarios" ? <ScenarioModel netWorth={netWorth} incomeCents={dashboard?.incomeCents ?? 0} spendingCents={dashboard?.spendingCents ?? 0} /> : null}
      {view === "settings" ? <SettingsView sandboxEnabled={sandboxEnabled} onOpenInvestments={() => setView("investments")} categories={categories} onCategoryCreated={() => void invoke<Category[]>("categories_data").then(setCategories)} /> : null}
      {dialog === "account" ? <AccountDialog onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} /> : null}
      {dialog === "transaction" ? <TransactionDialog accounts={dashboard?.accounts ?? []} categories={categories} entry={editingTransaction} onClose={() => { setDialog(null); setEditingTransaction(null); }} onSaved={() => { setDialog(null); setEditingTransaction(null); refresh(); if (view === "ledger") void invoke<LedgerData>("ledger_data").then(setLedger); }} /> : null}
      {dialog === "schedule" ? <ScheduleDialog accounts={dashboard?.accounts ?? []} schedule={editingSchedule} onClose={() => { setDialog(null); setEditingSchedule(null); }} onSaved={() => { setDialog(null); setEditingSchedule(null); setView("scheduled"); void invoke<Schedule[]>("scheduled_data").then(setSchedules); }} /> : null}
      {pendingDisconnect ? <ConfirmationDialog title={`Disconnect ${pendingDisconnect.connection.institutionName}?`} confirmLabel="Disconnect and delete" busy={pendingDisconnect.confirming} onCancel={() => setPendingDisconnect(null)} onConfirm={() => void confirmDisconnect()}><p>This removes this institution's Plaid connection and deletes every linked account, imported transaction, manual transaction, balance adjustment, and scheduled transaction from this Money Map profile.</p><p>Reconnecting later pulls a fresh copy from Plaid.</p></ConfirmationDialog> : null}
    </section>
  </main>;
}

function TradeStationSimConnection({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<TradeStationConnectionStatus | null>(null);
  const [setupKey, setSetupKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const refreshStatus = useCallback(() => void invoke<TradeStationConnectionStatus>("tradestation_sim_connection_status").then(setStatus).catch(reason => setStatus({ status: "failed", message: String(reason), connectionId: null })), []);
  useEffect(() => { refreshStatus(); const timer = window.setInterval(refreshStatus, 1500); return () => window.clearInterval(timer); }, [refreshStatus]);
  async function saveKey() { setSaving(true); try { await invoke("save_tradestation_sim_setup_key", { value: setupKey }); setSetupKey(""); await refreshStatus(); } finally { setSaving(false); } }
  async function connect() { setWorking(true); try { await invoke("start_tradestation_sim_connection"); await refreshStatus(); } catch (reason) { setStatus({ status: "failed", message: String(reason), connectionId: null }); } finally { setWorking(false); } }
  const active = status?.status === "preparing" || status?.status === "waiting_for_browser" || status?.status === "exchanging";
  return <div className={`tradestation-connection ${compact ? "compact" : ""}`}><div><strong>TradeStation SIM</strong><small>Dev-only OAuth. Uses simulated account data; the desktop never receives your TradeStation client secret or refresh token.</small></div>{status ? <p className={status.status === "failed" ? "form-error" : "empty-copy"}>{status.message}</p> : null}{status?.status !== "connected" ? <><label>Dev broker setup key<input type="password" value={setupKey} onChange={event => setSetupKey(event.target.value)} placeholder="Stored in Windows Credential Manager" autoComplete="off" /></label><button disabled={saving || !setupKey.trim()} onClick={() => void saveKey()}>{saving ? "Saving…" : "Save setup key"}</button><button className="primary-action" disabled={active || working} onClick={() => void connect()}>{active || working ? "Waiting for sign-in…" : "Connect TradeStation SIM"}</button></> : <span className="connection-complete">Connected securely · Portfolio sync is next.</span>}</div>;
}

function InvestmentView({ sandboxEnabled, onOpenSettings }: { sandboxEnabled: boolean; onOpenSettings: () => void }) {
  return <div className="investment-grid">
    <Widget title="Portfolio overview" className="investment-overview"><strong className="big-number">No investment data yet</strong><p>Connect a brokerage or retirement account to include positions, cash, dividends, options activity, and performance in your financial picture.</p>{sandboxEnabled ? <TradeStationSimConnection /> : <button className="primary-action" onClick={onOpenSettings}>Set up an external connection</button>}</Widget>
    <Widget title="Connection paths" className="investment-paths"><div><strong>TradeStation</strong><small>Direct read-only connection for balances, positions, and market data.</small><span>{sandboxEnabled ? "SIM connection available in this Dev build" : "Production connection work is next"}</span></div><div><strong>Principal and other supported firms</strong><small>Use Plaid Investments when the institution supports it.</small><span>Production connection work is next</span></div></Widget>
    <Widget title="What Money Map will track" className="investment-scope"><div><span>Accounts & cash</span><span>Holdings & allocations</span><span>Trades & options activity</span><span>Dividends & interest</span><span>Performance over time</span><span>Tax-relevant events</span></div><p>Imported records remain local. The future copilot will use this context alongside banking, debt, income, insurance, and taxes.</p></Widget>
  </div>;
}

function SettingsView({ sandboxEnabled, onOpenInvestments, categories, onCategoryCreated }: { sandboxEnabled: boolean; onOpenInvestments: () => void; categories: Category[]; onCategoryCreated: () => void }) {
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupResult, setBackupResult] = useState<ProfileBackupResult | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backups, setBackups] = useState<ProfileBackupSummary[]>([]);
  const [selectedBackup, setSelectedBackup] = useState("");
  async function refreshBackups() {
    const available = await invoke<ProfileBackupSummary[]>("list_profile_backups");
    setBackups(available);
    setSelectedBackup(current => available.some(item => item.path === current) ? current : available[0]?.path ?? "");
  }
  useEffect(() => { void refreshBackups().catch((reason: unknown) => setBackupError(String(reason))); }, []);
  async function createBackup() {
    setBackupBusy(true); setBackupError(null);
    try { setBackupResult(await invoke<ProfileBackupResult>("export_profile_backup")); await refreshBackups(); }
    catch (reason) { setBackupError(String(reason)); }
    finally { setBackupBusy(false); }
  }
  async function restoreSelectedBackup() {
    if (!selectedBackup || !confirm("Restore this encrypted profile backup? Money Map will retain the current profile as a pre-restore archive.")) return;
    setBackupBusy(true); setBackupError(null);
    try { await invoke("restore_profile_backup", { backupPath: selectedBackup }); window.location.reload(); }
    catch (reason) { setBackupError(String(reason)); setBackupBusy(false); }
  }
  return <div className="settings-grid">
    <Widget title="External connections" className="settings-connections"><div className="connection-setting"><div><strong>TradeStation</strong><small>Direct read-only OAuth connection for brokerage balances, positions, and market data.</small><p>Client secret and OAuth refresh token remain in the dedicated Cloudflare TradeStation broker. Money Map receives imported investment records only.</p></div>{sandboxEnabled ? <TradeStationSimConnection compact /> : <button className="primary-action" onClick={onOpenInvestments}>View investment setup</button>}</div><div className="connection-setting"><div><strong>Banking and retirement institutions</strong><small>Plaid handles supported accounts, including eligible investment accounts.</small><p>Connect and manage supported institutions through Accounts & cards.</p></div></div></Widget>
    <Widget title="Local profile" className="settings-profile"><strong>Money Map profile</strong><p>This desktop profile is local to this Windows user. Financial records are encrypted locally.</p><div className="settings-backup-actions"><button className="primary-action" disabled={backupBusy} onClick={() => void createBackup()}>{backupBusy ? "Working…" : "Create encrypted backup"}</button>{backups.length ? <><label>Available encrypted backups<select value={selectedBackup} disabled={backupBusy} onChange={event => setSelectedBackup(event.target.value)}>{backups.map(item => <option key={item.path} value={item.path}>{new Date(item.createdAt * 1000).toLocaleString()} · schema {item.sourceSchemaVersion} · Money Map {item.applicationVersion}</option>)}</select></label><button disabled={backupBusy || !selectedBackup} onClick={() => void restoreSelectedBackup()}>Restore selected backup</button></> : <small>No compatible backups are available for this profile.</small>}{backupResult ? <p className="backup-result"><strong>Backup created</strong><span>{backupResult.backupPath}</span></p> : null}{backupError ? <p className="form-error">{backupError}</p> : null}</div><small>Backups remain SQLCipher-encrypted and use the database key protected by this Windows profile. Money Map never deletes backups or pre-restore archives automatically.</small></Widget>
    <Widget title="Categories" className="settings-categories"><CategoryManager categories={categories} onCreated={onCategoryCreated} /></Widget>
  </div>;
}

function ConfirmationDialog({ title, children, confirmLabel, busy, onCancel, onConfirm }: { title: string; children: React.ReactNode; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title"><header><h2 id="confirmation-title">{title}</h2><button aria-label="Cancel" disabled={busy} onClick={onCancel}>×</button></header><div className="confirmation-copy">{children}</div><footer><button disabled={busy} onClick={onCancel}>Cancel</button><button className="primary-action destructive-action" disabled={busy} onClick={onConfirm}>{busy ? "Disconnecting…" : confirmLabel}</button></footer></section></div>;
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
  return <section className="ledger-widget"><div className="ledger-toolbar ledger-filters"><input aria-label="Search transactions" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search description or account" /><select aria-label="Filter by category" value={category} onChange={event => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map(name => <option key={name} value={name}>{name}</option>)}</select><label>From<input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></label><label>To<input type="date" value={toDate} onChange={event => setToDate(event.target.value)} /></label><label>Min. amount<input type="number" min="0" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="$0.00" /></label><IconAction label="Clear filters" onClick={clearFilters}><X aria-hidden="true" /></IconAction><span>{filtered.length} records</span></div><div className="ledger-table"><div className="ledger-head"><span>Date</span><span>Description</span><span>Account</span><span>Amount</span><span aria-hidden="true" /></div>{filtered.length === 0 ? <p className="empty-copy">No matching transactions.</p> : filtered.slice(0, visible).map(item => <div className="ledger-row" key={item.id}><span>{item.transactionDate}</span><span className="ledger-description"><strong>{item.description}</strong><small>{item.categoryName}</small></span><span className="ledger-account">{item.accountName}</span><strong className={`ledger-value ${item.amountCents >= 0 ? "positive" : "negative"}`}>{formatMoney(item.amountCents)}</strong><div className="ledger-actions"><IconAction label={`Edit ${item.description}`} onClick={() => onEdit(item)}><Pencil aria-hidden="true" /></IconAction><OverflowActions label={`More actions for ${item.description}`}><button className="overflow-menu-item danger" role="menuitem" onClick={() => void remove(item)}><Trash2 aria-hidden="true" />Delete transaction</button></OverflowActions></div></div>)}</div>{visible < filtered.length ? <div className="ledger-load"><button className="secondary-action" onClick={() => setVisible(count => count + 50)}>Load 50 more</button><span>{Math.min(visible, filtered.length)} of {filtered.length}</span></div> : null}</section>;
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
  return <section className="ledger-widget scheduled-widget"><div className="ledger-head"><span>Next occurrence</span><span>Description</span><span>Account</span><span>Amount</span><span aria-hidden="true" /></div>{schedules.length === 0 ? <p className="empty-copy">No scheduled transactions yet.</p> : schedules.map(item => <div className="ledger-row" key={item.id}><span>{item.nextOccurrence}<small>{item.recurrence} · starts {item.startDate}{item.endDate ? ` · ends ${item.endDate}` : ""}</small></span><span className="ledger-description"><strong>{item.description}</strong>{status[item.id] ? <small className="schedule-status" role="status">{status[item.id]}</small> : null}</span><span className="ledger-account">{item.accountName}</span><strong className={`ledger-value ${item.amountCents >= 0 ? "positive" : "negative"}`}>{formatMoney(item.amountCents)}</strong><div className="schedule-actions"><IconAction label={`Edit ${item.description}`} disabled={processing !== null} onClick={() => onEdit(item)}><Pencil aria-hidden="true" /></IconAction><IconAction label={`Skip ${item.nextOccurrence}`} disabled={processing !== null} onClick={() => void process(item, "skip")}>{processing === `skip:${item.id}` ? <LoaderCircle className="spin" aria-hidden="true" /> : <SkipForward aria-hidden="true" />}</IconAction><IconAction label={`Record ${item.nextOccurrence}`} disabled={processing !== null} onClick={() => void process(item, "record")}>{processing === `record:${item.id}` ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}</IconAction></div></div>)}</section>;
}

function Accounts({ accounts, connections, sandboxEnabled, syncMessage, selectedAccountId, onSelectAccount, onAdd, onSync, onDisconnect, syncing }: { accounts: Account[]; connections: ConnectedInstitution[]; sandboxEnabled: boolean; syncMessage: string | null; selectedAccountId: string | null; onSelectAccount: (accountId: string | null) => void; onAdd: () => void; onSync: () => void; onDisconnect: (connection: ConnectedInstitution) => void; syncing: boolean }) {
  const linkedAccountIds = new Set(accounts.filter(account => account.plaidConnectionId).map(account => account.id));
  const localAccounts = accounts.filter(account => !linkedAccountIds.has(account.id));
  const connectionIds = new Set(connections.map(connection => connection.id));
  const ungroupedLinkedAccounts = accounts.filter(account => account.plaidConnectionId && !connectionIds.has(account.plaidConnectionId));

  function accountRows(groupAccounts: Account[]) {
    if (groupAccounts.length === 0) return <p className="account-group-empty">No accounts selected for this connection.</p>;
    return <div className="compact-account-list">{groupAccounts.map(account => {
      const expanded = selectedAccountId === account.id;
      const subtype = account.plaidAccountSubtype ?? account.accountType;
      const mask = formatMaskedAccountIdentifier(account.mask);
      return <div className={`compact-account ${expanded ? "expanded" : ""}`} key={account.id}>
        <button type="button" className="compact-account-row" aria-expanded={expanded} onClick={() => onSelectAccount(expanded ? null : account.id)}>
          <span className="account-kind">{subtype}{mask ? <small>{mask}</small> : null}</span>
          <strong className="account-name">{account.name}</strong>
          <span className="account-row-balance"><strong>{formatMoney(account.balanceCents)}</strong>{account.availableBalanceCents !== null && account.availableBalanceCents !== undefined ? <small>{formatMoney(account.availableBalanceCents)} available</small> : null}</span>
          <ChevronRight aria-hidden="true" />
        </button>
        {expanded ? <section className="compact-account-details" aria-label={`${account.name} details`}>
          <span><small>Source</small><strong>{account.plaidConnectionId ? "Plaid connection" : "Local account"}</strong></span>
          <span><small>Account type</small><strong>{account.accountType}{account.plaidAccountSubtype ? ` · ${account.plaidAccountSubtype}` : ""}</strong></span>
          {mask ? <span><small>Account</small><strong>{mask}</strong></span> : null}
          <span><small>{account.balanceRefreshedAt ? "Last refreshed" : "Balance basis"}</small><strong>{account.balanceRefreshedAt ? new Date(account.balanceRefreshedAt).toLocaleString() : "Opening balance and ledger activity"}</strong></span>
        </section> : null}
      </div>;
    })}</div>;
  }

  return <section className="ledger-widget accounts-page compact-accounts-page">
    <div className="accounts-toolbar compact-accounts-toolbar">
      <span><p className="empty-copy">{sandboxEnabled ? "Sandbox connections and local accounts" : "Connected and local accounts"}</p>{syncMessage ? <small className="sync-message">{syncMessage}</small> : null}</span>
      <div className="account-page-actions">
        {connections.length > 0 ? <IconAction label="Sync connected accounts" type="button" disabled={syncing} onClick={onSync}><RefreshCw aria-hidden="true" className={syncing ? "spin" : ""} /></IconAction> : null}
        <IconAction label="Add local account" type="button" onClick={onAdd}><Plus aria-hidden="true" /></IconAction>
        <PlaidLinkButton sandboxEnabled={sandboxEnabled} compact onImported={() => window.location.reload()} />
      </div>
    </div>
    <div className="account-groups">
      {connections.map(connection => <section className="account-group" key={connection.id}>
        <header className="account-group-header">
          <span><strong>{connection.institutionName}</strong><small>{connection.accountCount} linked account{connection.accountCount === 1 ? "" : "s"}{sandboxEnabled ? " · Sandbox" : ""}</small></span>
          <OverflowActions label={`More actions for ${connection.institutionName}`}>
            <button className="overflow-menu-item danger" disabled={syncing} onClick={() => onDisconnect(connection)}><Unplug aria-hidden="true" />Disconnect institution</button>
          </OverflowActions>
        </header>
        {accountRows(accounts.filter(account => account.plaidConnectionId === connection.id))}
      </section>)}
      {ungroupedLinkedAccounts.length > 0 ? <section className="account-group"><header className="account-group-header"><span><strong>Connected accounts</strong><small>{ungroupedLinkedAccounts.length} account{ungroupedLinkedAccounts.length === 1 ? "" : "s"}</small></span></header>{accountRows(ungroupedLinkedAccounts)}</section> : null}
      {localAccounts.length > 0 ? <section className="account-group"><header className="account-group-header"><span><strong>Local accounts</strong><small>{localAccounts.length} manually managed account{localAccounts.length === 1 ? "" : "s"}</small></span></header>{accountRows(localAccounts)}</section> : null}
      {accounts.length === 0 ? <div className="empty-account-state"><WalletCards aria-hidden="true" /><strong>No accounts yet</strong><span>Add a local account or connect an institution to begin.</span></div> : null}
    </div>
  </section>;
}

function CategoryManager({ categories, onCreated }: { categories: Category[]; onCreated: () => void }) {
  const [name, setName] = useState(""); const [error, setError] = useState<string | null>(null);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); try { await invoke("create_category", { name }); setName(""); setError(null); onCreated(); } catch (reason) { setError(String(reason)); } }
  return <div className="category-manager"><p className="empty-copy">Used for manual entries and category suggestions.</p><div className="category-list">{categories.map(category => <span key={category.id}>{category.name}</span>)}</div><form onSubmit={add}><label>Name<input value={name} onChange={event => setName(event.target.value)} required placeholder="Pet care" /></label><button className="secondary-action" type="submit">Add</button>{error ? <p className="form-error">{error}</p> : null}</form></div>;
}

function PlaidLinkButton({ sandboxEnabled, onImported, compact = false }: { sandboxEnabled: boolean; onImported: () => void; compact?: boolean }) {
  const [session, setSession] = useState<SandboxLinkSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function begin() {
    setLoading(true); setMessage(null);
    try { setSession(await invoke<SandboxLinkSession>("create_plaid_link_session")); }
    catch (reason) { setMessage(String(reason)); setLoading(false); }
  }
  if (session) return <PlaidLinkLauncher compact={compact} session={session} onDone={() => { setSession(null); setLoading(false); onImported(); }} onCancelled={() => { setSession(null); setLoading(false); }} />;
  if (compact) return <button className="primary-action compact-connect-action" type="button" onClick={() => void begin()} disabled={loading}><Link2 aria-hidden="true" />{loading ? "Preparing…" : "Connect new account"}</button>;
  return <div className="connect-card sandbox-link-card"><span>+</span><strong>{loading ? "Preparing secure connection…" : sandboxEnabled ? "Connect Sandbox account" : "Connect new account"}</strong><small>{sandboxEnabled ? "Sandbox connection · no Trial slot" : "Securely connect a financial institution"}</small><button onClick={() => void begin()} disabled={loading}>{loading ? "Working…" : "Connect new account"}</button>{message ? <small className="form-error">{message}</small> : null}</div>;
}

function DashboardConnectCard({ sandboxEnabled, onImported, onManageAccounts }: { sandboxEnabled: boolean; onImported: () => void; onManageAccounts: () => void }) {
  void onManageAccounts;
  return <PlaidLinkButton sandboxEnabled={sandboxEnabled} onImported={onImported} />;
}

function PlaidLinkLauncher({ session, onDone, onCancelled, compact = false }: { session: SandboxLinkSession; onDone: () => void; onCancelled: () => void; compact?: boolean }) {
  const [status, setStatus] = useState("Opening secure connection…");
  const completingRef = useRef(false);
  const { open, ready } = usePlaidLink({
    token: session.linkToken,
    onSuccess: async (publicToken, metadata) => {
      completingRef.current = true;
      setStatus("Importing encrypted financial records…");
      try {
        await invoke<PlaidSyncResult>("complete_plaid_link", { input: {
          sessionId: session.sessionId, sessionSecret: session.sessionSecret, publicToken,
          institutionId: metadata.institution?.institution_id ?? null, institutionName: metadata.institution?.name ?? null,
          selectedAccountIds: metadata.accounts.map(account => account.id),
        } });
        onDone();
      } catch (reason) { setStatus(`Import failed: ${String(reason)}`); }
    },
    onExit: () => { if (!completingRef.current) onCancelled(); },
  });
  useEffect(() => { if (ready) open(); }, [open, ready]);
  if (compact) return <span className="compact-link-status" role="status">{status}</span>;
  return <div className="connect-card sandbox-link-card"><span>↗</span><strong>{status}</strong><small>{ready ? "Complete or cancel the Plaid window." : "Loading Plaid Link…"}</small></div>;
}

function Calendar({ month, transactions, schedules, onMonthChange }: { month: Date; transactions: LedgerEntry[]; schedules: Schedule[]; onMonthChange: (month: Date) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
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
  useEffect(() => { if (!selected) return; const close = (event: PointerEvent) => { const target = event.target as HTMLElement; if (!surfaceRef.current?.contains(target) || !target.closest(".calendar-cell, .date-popover")) { setSelected(null); setPopoverAnchor(null); } }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [selected]);
  function changeMonth(delta: number) { setSelected(null); setPopoverAnchor(null); onMonthChange(new Date(year, monthIndex + delta, 1)); }
  function selectDate(key: string, target: HTMLButtonElement) {
    const surface = surfaceRef.current;
    if (!surface) { setSelected(key); return; }
    const cell = target.getBoundingClientRect(); const bounds = surface.getBoundingClientRect();
    const popoverWidth = 336; const popoverHeight = 246; const margin = 12;
    const left = Math.max(margin, Math.min(cell.left - bounds.left, bounds.width - popoverWidth - margin));
    const below = bounds.bottom - cell.bottom;
    const preferredTop = below >= popoverHeight + margin ? cell.bottom - bounds.top + 8 : cell.top - bounds.top - popoverHeight - 8;
    const top = Math.max(margin, Math.min(preferredTop, bounds.height - popoverHeight - margin));
    setPopoverAnchor({ left, top }); setSelected(key);
  }
  function onPointerDown(event: React.PointerEvent<HTMLElement>) { if ((event.target as HTMLElement).closest("button")) return; const width = event.currentTarget.getBoundingClientRect().width; dragRef.current = { pointerId: event.pointerId, startX: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }
  function onPointerMove(event: React.PointerEvent<HTMLElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; setOffset(Math.max(-drag.width, Math.min(drag.width, event.clientX - drag.startX))); }
  function onPointerUp(event: React.PointerEvent<HTMLElement>) { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; dragRef.current = null; const releaseOffset = event.clientX - drag.startX; const direction = Math.abs(releaseOffset) > drag.width / 2 ? (releaseOffset < 0 ? 1 : -1) : 0; setSettling(true); if (!direction) { setOffset(0); window.setTimeout(() => setSettling(false), 380); return; } setOffset(direction > 0 ? -drag.width : drag.width); window.setTimeout(() => { changeMonth(direction); setSettling(false); setOffset(0); }, 380); }
  return <section className="calendar-widget" ref={surfaceRef}><div className="calendar-controls"><button onClick={() => changeMonth(-1)}>‹</button><strong>{monthTitle}</strong><button onClick={() => changeMonth(1)}>›</button></div><div className="calendar-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}><div className={`calendar-grid ${settling ? "settling" : ""}`} style={{ transform: `translateX(${offset}px)` }}>{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day => <div className="calendar-day-name" key={day}>{day}</div>)}{Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const key = date.toISOString().slice(0, 10); const entries = [...(transactionMap.get(key) ?? []), ...scheduledEntriesFor(key)]; const income = entries.filter(item => item.amountCents > 0).reduce((sum, item) => sum + item.amountCents, 0); const spend = entries.filter(item => item.amountCents < 0).reduce((sum, item) => sum + item.amountCents, 0); return <button className={`calendar-cell ${date.getMonth() !== monthIndex ? "outside" : ""} ${selected === key ? "selected-cell" : ""}`} onClick={event => selectDate(key, event.currentTarget)} key={key}><span>{date.getDate()}</span>{income ? <small className="positive">+{formatMoney(income)}</small> : null}{spend ? <small className="negative">{formatMoney(spend)}</small> : null}</button>; })}</div></div>{selected && popoverAnchor ? <aside className="date-popover" style={popoverAnchor}><header><strong>{new Date(`${selected}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</strong><button onClick={() => { setSelected(null); setPopoverAnchor(null); }}>×</button></header>{selectedItems.length === 0 ? <p className="empty-copy">No transactions or planned items.</p> : selectedItems.map(item => <div className="popover-item" key={item.id}><span className="popover-description" title={item.description}>{item.description}{item.scheduled ? <small>Planned · scheduled</small> : null}</span><strong className={item.amountCents >= 0 ? "positive" : "negative"}>{formatMoney(item.amountCents)}</strong></div>)}</aside> : null}</section>;
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

function TransactionDialog({ accounts, categories, entry, onClose, onSaved }: { accounts: Account[]; categories: Category[]; entry: LedgerEntry | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [scheduleRepeat, setScheduleRepeat] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const input = { accountId: form.get("accountId"), transactionDate: form.get("date"), description: form.get("description"), amountCents: Math.round(Number(form.get("amount")) * 100), categoryId: form.get("categoryId") || null, notes: form.get("notes") || null, scheduleRecurrence: !entry && scheduleRepeat ? String(form.get("scheduleRecurrence")) : null };
    try { if (entry) await invoke("update_transaction", { input: { id: entry.id, ...input } }); else await invoke("create_transaction", { input }); onSaved(); }
    catch (reason) { setError(String(reason)); }
  }
  return <div className="dialog-backdrop"><form className="dialog" onSubmit={submit}><header><h2>{entry ? "Edit transaction" : "Add transaction"}</h2><button type="button" onClick={onClose}>×</button></header>{accounts.length === 0 ? <p className="empty-copy">Create an account first.</p> : <><label>Account<select name="accountId" required defaultValue={entry?.accountId}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>Date<input name="date" type="date" defaultValue={entry?.transactionDate ?? new Date().toISOString().slice(0, 10)} required /></label><label>Description<input name="description" required placeholder="Groceries" defaultValue={entry?.description} /></label><label>Amount<input name="amount" type="number" step="0.01" required placeholder="-48.20" defaultValue={entry ? (entry.amountCents / 100).toFixed(2) : undefined} /></label><label>Category<select name="categoryId" defaultValue={entry?.categoryId ?? ""}><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Notes<textarea name="notes" rows={3} /></label>{!entry ? <><label className="repeat-toggle"><input type="checkbox" checked={scheduleRepeat} onChange={event => setScheduleRepeat(event.target.checked)} /> Schedule this again</label>{scheduleRepeat ? <label>Repeats<select name="scheduleRecurrence" defaultValue="monthly"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option><option value="quarterly">Every 3 months</option><option value="yearly">Yearly</option></select></label> : null}</> : null}</>}{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button>{accounts.length > 0 ? <button className="primary-action" type="submit">{entry ? "Save changes" : "Save transaction"}</button> : null}</footer></form></div>;
}

function ScheduleDialog({ accounts, schedule, onClose, onSaved }: { accounts: Account[]; schedule: Schedule | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const input = { accountId: form.get("accountId"), startDate: form.get("date"), endDate: form.get("endDate") || null, description: form.get("description"), amountCents: Math.round(Number(form.get("amount")) * 100), recurrence: form.get("recurrence") }; try { if (schedule) await invoke("update_schedule", { input: { id: schedule.id, ...input } }); else await invoke("create_schedule", { input }); onSaved(); } catch (reason) { setError(String(reason)); } }
  return <div className="dialog-backdrop"><form className="dialog schedule-dialog" onSubmit={submit}><header><h2>{schedule ? "Edit scheduled transaction" : "Add scheduled transaction"}</h2><button type="button" onClick={onClose}>×</button></header>{accounts.length === 0 ? <p className="empty-copy">Create an account first.</p> : <><label>Account<select name="accountId" defaultValue={schedule?.accountId}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><div className="schedule-dialog-row"><label>Starts<input name="date" type="date" defaultValue={schedule?.startDate ?? new Date().toISOString().slice(0, 10)} /></label><label>Ends (optional)<input name="endDate" type="date" defaultValue={schedule?.endDate ?? ""} /></label></div><label>Description<input name="description" required defaultValue={schedule?.description} /></label><div className="schedule-dialog-row"><label>Amount<input name="amount" type="number" step="0.01" required defaultValue={schedule ? (schedule.amountCents / 100).toFixed(2) : undefined} /></label><label>Repeats<select name="recurrence" defaultValue={schedule?.recurrence ?? "monthly"}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option><option value="quarterly">Every 3 months</option><option value="yearly">Yearly</option></select></label></div></>}{error ? <p className="form-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Cancel</button>{accounts.length > 0 ? <button className="primary-action" type="submit">{schedule ? "Save changes" : "Save schedule"}</button> : null}</footer></form></div>;
}
