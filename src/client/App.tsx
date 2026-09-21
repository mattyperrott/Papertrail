import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronRight,
  CircleAlert,
  Footprints,
  Database,
  ExternalLink,
  Filter,
  Gauge,
  Pause,
  Play,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  WalletCards,
  X,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AppSettings, DashboardState, DeployReport, PaperPosition, PaperTrade, TraderCandidate } from '../shared/types';

type Tab = 'overview' | 'traders' | 'ledger';
type TraderView = 'all' | 'active' | 'verified' | 'watched' | 'copied' | 'rejected';

const money = (value: number, compact = false) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 2,
  }).format(value);

const number = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);

const percent = (value: number | null) => {
  if (value === null) return '—';
  if (value !== 0 && Math.abs(value) < 0.01) return `${value > 0 ? '+' : '-'}<0.01%`;
  return `${value >= 0 ? '+' : ''}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`;
};

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const displayTraderName = (name: string) => name.startsWith('0x') && name.length > 16
  ? `${name.slice(0, 6)}…${name.slice(-4)}`
  : name;

const relativeTime = (iso?: string) => {
  if (!iso) return 'Not yet';
  const delta = Math.max(0, Date.now() - new Date(iso).getTime());
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
};

const timeUntil = (iso?: string) => {
  if (!iso) return 'scheduling';
  const delta = new Date(iso).getTime() - Date.now();
  if (delta <= 0) return 'due now';
  if (delta < 60_000) return `in ${Math.max(1, Math.ceil(delta / 1000))}s`;
  return `in ${Math.ceil(delta / 60_000)}m`;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

export function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [traderView, setTraderView] = useState<TraderView>('all');
  const [traderSort, setTraderSort] = useState<TraderSort | null>(null);

  useEffect(() => {
    api<DashboardState>('/api/state').then((data) => {
      setState(data);
      setSettingsDraft(data.settings);
    }).catch((error) => setNotice(error.message));
    const events = new EventSource('/api/events');
    events.addEventListener('state', (event) => {
      const data = JSON.parse((event as MessageEvent).data) as DashboardState;
      setState(data);
      setSettingsDraft((current) => current ?? data.settings);
    });
    events.addEventListener('scan', (event) => setNotice(JSON.parse((event as MessageEvent).data).message));
    events.addEventListener('paper-trade', (event) => {
      const trade = JSON.parse((event as MessageEvent).data) as PaperTrade;
      if (trade.status === 'filled') {
        setNotice(trade.side === 'SETTLE'
          ? `${trade.outcome} settled · ${trade.realizedPnl >= 0 ? '+' : ''}${money(trade.realizedPnl)}`
          : `${trade.side} copied · ${trade.outcome} · ${money(trade.notional)}`);
      }
    });
    events.addEventListener('error', (event) => {
      if ((event as MessageEvent).data) setNotice(JSON.parse((event as MessageEvent).data).message);
    });
    return () => events.close();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.length > 60 ? 12000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = async (key: string, action: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    // Operator actions wait their turn behind whatever the engine is running. A
    // scan can hold it for minutes, and a silent disabled button read as broken.
    const running = state?.providerStatus.activeJob;
    if (running) setNotice(`Queued behind ${running}${state?.providerStatus.queueDepth ? ` (+${state.providerStatus.queueDepth} waiting)` : ''}; it runs as soon as that finishes`);
    try {
      const result = await action();
      const text = typeof result === 'string' ? result : message;
      if (text) setNotice(text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const updatePaused = () => {
    if (!state) return;
    void run('pause', async () => {
      let message = 'Paper copying paused';
      if (state.settings.paused) {
        const result=await api<{resumed:boolean;checks:Array<{name:string;passed:boolean;blocking:boolean}>;warnings:string[]}>('/api/resume/conditional',{method:'POST'});
        if(!result.resumed)throw new Error(`Resume blocked: ${result.checks.filter(check=>!check.passed&&check.blocking).map(check=>check.name).join(', ')}`);
        message = result.warnings.length ? `Paper copying resumed · advisories: ${result.warnings.join(', ')}` : 'Paper copying resumed; all release gates passed';
      } else await api('/api/settings',{method:'PATCH',body:JSON.stringify({paused:true})});
      const next=await api<DashboardState>('/api/state');
      setState(next);
      setSettingsDraft(next.settings);
      return message;
    });
  };

  const acknowledgeHalt = () => {
    if (!state?.account.riskHalt) return;
    void run('halt', async () => {
      const next = await api<DashboardState>('/api/halt/acknowledge', { method: 'POST', body: JSON.stringify({ note: 'acknowledged from dashboard' }) });
      setState(next);
      setSettingsDraft(next.settings);
    }, 'Risk halt cleared; review positions, then Resume');
  };

  const deployNow = () => {
    void run('deploy', async () => {
      const result = await api<{ state: DashboardState; report: DeployReport }>('/api/deploy', { method: 'POST' });
      setState(result.state);
      setNotice(`${result.report.message} · ${number(result.report.exposurePct)}% deployed`);
    });
  };

  const saveSettings = () => {
    if (!settingsDraft) return;
    void run('settings', async () => {
      const next = await api<DashboardState>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(settingsDraft),
      });
      setState(next);
      setSettingsOpen(false);
    }, 'Risk and scanner controls saved');
  };

  const toggleTrader = (trader: TraderCandidate) => {
    const pinned = trader.selectionOverride === 'include';
    const enableCopy = !pinned && !trader.selected;
    void run(`trader-${trader.address}`, async () => {
      const next = await api<DashboardState>(`/api/traders/${trader.address}`, {
        method: 'PATCH',
        body: JSON.stringify({ selected: enableCopy }),
      });
      setState(next);
    }, `${trader.name} ${enableCopy ? 'requested for' : 'removed from'} paper copying`);
  };

  if (!state) return <LoadingScreen />;

  const activeCutoff = Date.now() - state.settings.scanner.maxInactiveHours * 3_600_000;
  const filteredTraders = state.traders
    .filter((trader) => `${trader.name} ${trader.address}`.toLowerCase().includes(query.toLowerCase()))
    .filter((trader) => traderView === 'all'
      || (traderView === 'active' && Date.parse(trader.lastActivityAt ?? '1970-01-01') >= activeCutoff)
      || (traderView === 'verified' && trader.verification.status === 'verified')
      || (traderView === 'watched' && trader.watched)
      || (traderView === 'copied' && trader.selected)
      || (traderView === 'rejected' && !trader.watched))
    .sort((a, b) => {
      if (traderSort) {
        // An explicit column sort is a pure sort; pinned-first only applies to the
        // default view, otherwise a low-ROI pin would sit on top of an ROI sort.
        const av = sortValue(a, traderSort.key), bv = sortValue(b, traderSort.key);
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return traderSort.dir === 'desc' ? bv - av : av - bv;
      }
      return Number(b.selectionOverride === 'include') - Number(a.selectionOverride === 'include');
    });
  const selectedCount = state.traders.filter((trader) => trader.selected).length;
  const watchedCount = state.traders.filter((trader) => trader.watched).length;
  const providerMessage = state.providerStatus.message.replace(/\s*·\s*\d+\s+watched\s*·\s*\d+\s+copied$/, '');
  const pnlPositive = state.summary.totalPnl >= 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><Footprints size={20} /><span>Paper<span>trail</span></span></div>
        <nav aria-label="Primary navigation">
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><BarChart3 />Overview</button>
          <button className={tab === 'traders' ? 'active' : ''} onClick={() => setTab('traders')}><Radar />Trader Intel</button>
          <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}><WalletCards />Paper Ledger</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="mode-card">
            <div className="mode-icon"><ShieldCheck size={18} /></div>
            <div><strong>Paper mode · v{state.account.methodologyVersion}</strong><span>Champion active · challenger shadow</span></div>
          </div>
          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings />Strategy settings</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow"><span className={`live-dot ${state.settings.paused ? 'paused' : ''}`} />
              {state.account.riskHalt ? 'RISK HALT LATCHED · ENTRIES BLOCKED' : state.settings.paused ? 'ENTRIES PAUSED · EXITS MONITORED' : 'FORWARD PAPER ENGINE'}
            </div>
            <h1>{tab === 'overview' ? 'Command center' : tab === 'traders' ? 'Trader intelligence' : 'Paper-trade ledger'}</h1>
          </div>
          <div className="top-actions">
            <div className="provider-chip"><Database size={14} /><span>{state.providerStatus.primary === 'arkham' ? 'Arkham' : 'Polymarket'}</span><b>×</b><span>PM Scan</span></div>
            <button className="secondary-button deploy-button" onClick={deployNow} disabled={busy === 'deploy' || state.providerStatus.scanning || state.providerStatus.autoDeploying || state.settings.paused} title="Rescan selected traders and allocate unused paper capital to their qualifying live positions">
              <Zap className={busy === 'deploy' || state.providerStatus.autoDeploying ? 'spin' : ''} />{state.providerStatus.autoDeploying ? 'Auto deploying…' : busy === 'deploy' ? 'Deploying…' : 'Scan & deploy'}
            </button>
            <button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><SlidersHorizontal /></button>
            {state.account.riskHalt ? (
              <button className="danger-button" onClick={acknowledgeHalt} disabled={busy === 'halt'} title={`${state.account.riskHalt.reason} · latched ${new Date(state.account.riskHalt.triggeredAt).toLocaleString()}. Clears the halt and re-bases the drawdown mark at current equity; the engine stays paused until you press Resume.`}>
                <ShieldCheck />{busy === 'halt' ? 'Clearing…' : 'Acknowledge halt'}
              </button>
            ) : (
              <button className={`primary-action ${state.settings.paused ? '' : 'running'}`} onClick={updatePaused} disabled={busy === 'pause'} title="Resume is refused by a latched risk halt, a failed SQLite integrity check, or an unacknowledged critical alert. Release-gate advisories (clean shutdown, reconciliation, approved hashes, webhook drill) are reported but only block when APPROVED_CODE_HASH is pinned.">
                {state.settings.paused ? <Play /> : <Pause />}{state.settings.paused ? 'Resume' : 'Pause'}
              </button>
            )}
          </div>
        </header>

        <section className="status-strip">
          <div className="status-left">{state.account.riskHalt && <span className="status-halt" title={`Latched ${new Date(state.account.riskHalt.triggeredAt).toLocaleString()}`}>HALT · {state.account.riskHalt.reason}</span>}<span className={state.providerStatus.primary === 'arkham' ? 'status-good' : 'status-warn'}>{state.providerStatus.primary === 'arkham' ? 'PRIMARY' : 'PUBLIC'}</span><span className="status-message" title={`${providerMessage} · ${watchedCount} watched · ${selectedCount} copied`}>{providerMessage} · {watchedCount} watched · {selectedCount} copied</span></div>
          <div className="status-right" title={state.providerStatus.lastAutoDeployMessage}>
            {(state.providerStatus.queueDepth ?? 0) > 0 && <span className="status-metric queued">Queued <strong>{state.providerStatus.queueDepth}</strong></span>}
            <span className="status-metric">Auto scan &amp; deploy <strong>{state.providerStatus.autoDeploying ? 'running now' : state.settings.paused ? 'idle while paused' : timeUntil(state.providerStatus.nextAutoDeployAt)}</strong></span>
            <span className="status-metric">Live poll <strong>{relativeTime(state.providerStatus.lastPollAt)}</strong></span>
            <span className="status-metric">Results <strong>{relativeTime(state.providerStatus.lastVerificationAt)}</strong></span>
          </div>
        </section>

        <section className="kpi-grid">
          <MetricCard label="Paper equity" value={money(state.summary.equity)} delta={percent(state.summary.totalReturnPct)} positive={pnlPositive} icon={<WalletCards />} />
          <MetricCard label="Net P&L" value={`${pnlPositive ? '+' : ''}${money(state.summary.totalPnl)}`} detail={`${money(state.account.realizedPnl)} realized`} positive={pnlPositive} icon={<Activity />} />
          <MetricCard label="Capital deployed" value={money(state.summary.exposure)} detail={`${number(state.summary.exposurePct)}% of equity`} icon={<Target />} />
          <MetricCard label="Buying power" value={money(state.account.cash)} detail={`Drawdown ${number(state.summary.currentDrawdownPct ?? 0)}% · ${state.summary.dailyObservations ?? 0} daily returns`} icon={<Zap />} />
        </section>

        {tab === 'overview' && (
          <>
            <section className="overview-grid">
              <article className="panel performance-panel">
                <PanelHeader kicker="PORTFOLIO" title="Paper performance" action={<span className="range-pill">Since reset</span>} />
                <div className="chart-heading">
                  <div><strong>{money(state.summary.equity)}</strong><span className={pnlPositive ? 'up' : 'down'}>{pnlPositive ? <ArrowUpRight /> : <ArrowDownRight />}{money(Math.abs(state.summary.totalPnl))}</span></div>
                  <span>Starting balance {money(state.account.startingBalance)}</span>
                </div>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={state.account.equityHistory} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b8f34a" stopOpacity={0.28} /><stop offset="100%" stopColor="#b8f34a" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid stroke="#252925" vertical={false} />
                      <XAxis dataKey="timestamp" tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} stroke="#697069" tickLine={false} axisLine={false} fontSize={11} minTickGap={35} />
                      <YAxis domain={['dataMin - 100', 'dataMax + 100']} tickFormatter={(value) => money(value, true)} stroke="#697069" tickLine={false} axisLine={false} fontSize={11} width={54} />
                      <Tooltip content={<ChartTooltip />} />
                      <Area type="monotone" dataKey="equity" stroke="#b8f34a" strokeWidth={2} fill="url(#equityFill)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </article>

              <article className="panel allocation-panel">
                <PanelHeader kicker="GUARDRAILS" title="Risk allocation" action={<Gauge size={18} />} />
                <div className="exposure-ring" style={{ '--progress': `${Math.min(100, state.summary.exposurePct)}%` } as React.CSSProperties}>
                  <div><strong>{number(state.summary.exposurePct)}%</strong><span>deployed</span></div>
                </div>
                <div className="guardrail-list">
                  <Guardrail label="Per signal" value={`${state.settings.risk.maxRiskPerTradePct}%`} />
                  <Guardrail label="Per market" value={`${state.settings.risk.maxPositionPct}%`} />
                  <Guardrail label="Per trader / event" value={`${state.settings.risk.maxTraderExposurePct}% / ${state.settings.risk.maxEventExposurePct}%`} />
                  <Guardrail label="Portfolio cap" value={`${state.settings.risk.maxTotalExposurePct}%`} />
                  <Guardrail label="Daily / drawdown halt" value={`${state.settings.risk.maxDailyLossPct}% / ${state.settings.risk.maxDrawdownPct}%`} />
                  <Guardrail label="Max. duration" value={`${state.settings.risk.maxPositionDurationDays} days`} />
                  <Guardrail label="Sim. slippage" value={`${state.settings.risk.slippageBps} bps`} />
                </div>
              </article>
            </section>

            <section className="lower-grid">
              <article className="panel">
                <PanelHeader kicker="POSITIONS" title="Open paper positions" action={<button className="text-button" onClick={() => setTab('ledger')}>Full ledger <ChevronRight /></button>} />
                <PositionsTable state={state} compact />
              </article>
              <article className="panel signal-panel">
                <PanelHeader kicker="SIGNAL TAPE" title={`Recent copied-trader activity · ${state.settings.scanner.replayHours}h`} action={<span className="live-label"><span /> LIVE</span>} />
                <SignalTape state={state} />
              </article>
            </section>
          </>
        )}

        {tab === 'traders' && (
          <section className="panel traders-panel">
            <div className="page-toolbar">
              <div>
                <div className="eyebrow">CROSS-SOURCE RANKING</div>
                <h2>{watchedCount} watched · {selectedCount} paper-copied</h2>
              </div>
              <div className="toolbar-actions">
                <label className="search-field"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or wallet" /></label>
                <button className="secondary-button" onClick={() => void run('scan', () => api('/api/scan', { method: 'POST' }), 'Fresh scan started')} disabled={busy === 'scan' || state.providerStatus.scanning || state.providerStatus.autoDeploying}>
                  <RefreshCw className={state.providerStatus.scanning ? 'spin' : ''} />Rescan
                </button>
                <label className="trader-filter" aria-label="Filter trader results"><Filter /><select value={traderView} onChange={(event) => setTraderView(event.target.value as TraderView)}><option value="all">All 500</option><option value="active">Active &lt;24h</option><option value="verified">Verified</option><option value="watched">Watched</option><option value="copied">Paper-copied</option><option value="rejected">Rejected</option></select></label>
              </div>
            </div>
            <ScanFunnelStrip state={state} />
            <TraderTable traders={filteredTraders} onToggle={toggleTrader} busy={busy} sort={traderSort} onSort={setTraderSort} />
          </section>
        )}

        {tab === 'ledger' && (
          <section className="ledger-layout">
            <article className="panel page-panel">
              <div className="page-toolbar">
                <div><div className="eyebrow">SIMULATED EXECUTION</div><h2>{state.account.trades.length} recorded decisions</h2></div>
                <div className="toolbar-actions">
                  <button className="secondary-button" onClick={() => void run('poll', () => api('/api/poll', { method: 'POST' }), 'Marks and official results verified')} disabled={busy === 'poll' || state.providerStatus.verifying}><RefreshCw className={busy === 'poll' || state.providerStatus.verifying ? 'spin' : ''} />{state.providerStatus.verifying ? 'Verifying…' : 'Refresh marks'}</button>
                  <button className="danger-button" onClick={() => {
                    if (window.confirm('Archive this paper account and create a clean, paused v3 account? No historical trades will be replayed.')) {
                      void run('reset', async () => setState(await api('/api/simulation/reset', { method: 'POST' })), 'Fresh paused v3 paper account created');
                    }
                  }}><RotateCcw />Reset</button>
                </div>
              </div>
              <PositionsTable state={state} />
            </article>
            <article className="panel page-panel trade-log-panel">
              <PanelHeader kicker="AUDIT LOG" title="Paper executions and skips" action={<span className="range-pill">Newest first</span>} />
              <TradeLog trades={state.account.trades} />
            </article>
          </section>
        )}
      </main>

      {settingsOpen && settingsDraft && (
        <SettingsDrawer settings={settingsDraft} onChange={setSettingsDraft} onClose={() => setSettingsOpen(false)} onSave={saveSettings} saving={busy === 'settings'} />
      )}
      {notice && <div className="toast"><Check size={16} />{notice}<button onClick={() => setNotice(null)} aria-label="Dismiss"><X /></button></div>}
    </div>
  );
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="brand-mark"><Footprints /><span>Paper<span>trail</span></span></div><div className="loading-line"><span /></div><p>Starting the paper terminal…</p></div>;
}

function MetricCard({ label, value, detail, delta, positive, icon }: { label: string; value: string; detail?: string; delta?: string; positive?: boolean; icon: React.ReactNode }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><div>{icon}</div></div><strong>{value}</strong><div className={positive === false ? 'metric-detail down' : 'metric-detail'}>{delta ?? detail}</div></article>;
}

function PanelHeader({ kicker, title, action }: { kicker: string; title: string; action?: React.ReactNode }) {
  return <header className="panel-header"><div><span>{kicker}</span><h2>{title}</h2></div>{action}</header>;
}

function Guardrail({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function ScanFunnelStrip({ state }: { state: DashboardState }) {
  const funnel = state.scanFunnel;
  const items = [
    ['Scanned', funnel.scanned],
    ['Active <24h', funnel.active],
    ['Verified', funnel.verified],
    ['Rejected', funnel.rejected],
    ['Watched', funnel.watched],
    ['Paper-copied', funnel.copied],
  ] as const;
  return <div className="scan-funnel" role="group" aria-label="Trader scan funnel">
    {items.map(([label, value], index) => <div key={label} className={label === 'Rejected' ? 'rejected' : label === 'Paper-copied' ? 'copied' : ''}>
      <span>{label}</span><strong>{number(value)}</strong>{index < items.length - 1 && <ChevronRight />}
    </div>)}
  </div>;
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { timestamp: string; equity: number } }> }) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;
  return <div className="chart-tooltip"><span>{new Date(point.timestamp).toLocaleString()}</span><strong>{money(point.equity)}</strong></div>;
}

function PositionsTable({ state, compact = false }: { state: DashboardState; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const positions = compact ? state.account.positions.slice(0, 5) : state.account.positions;
  if (!positions.length) return <EmptyState icon={<Target />} title="Waiting for a qualifying buy" copy="The signal engine is watching selected traders. New buys will appear here after risk checks." />;
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="Open paper positions"><table className="data-table"><thead><tr><th>Market / outcome</th><th>Copied from</th><th>Avg / current</th><th>Value</th><th>Unrealized</th></tr></thead><tbody>{positions.map((position) => (
    <tr key={position.id}>
      <td><div className="market-cell"><span className="outcome-badge">{position.outcome}</span><div><strong>{position.title}</strong><div className="position-meta"><span>{number(position.shares)} shares</span><ResolutionTimer position={position} now={now} /></div></div></div></td>
      <td><div className="trader-compact"><Avatar name={position.traderName} /><div><strong>{displayTraderName(position.traderName)}</strong><span>{shortAddress(position.traderAddress)}</span></div></div></td>
      <td><strong>{number(position.avgPrice * 100)}¢</strong><span className="sub-value">{number(position.currentPrice * 100)}¢</span></td>
      <td><strong>{money(position.currentValue)}</strong><span className="sub-value">{money(position.costBasis)} cost</span></td>
      <td><span className={position.unrealizedPnl >= 0 ? 'pnl up' : 'pnl down'}>{position.unrealizedPnl >= 0 ? '+' : ''}{money(position.unrealizedPnl)}</span></td>
    </tr>
  ))}</tbody></table></div>;
}

function durationLabel(milliseconds: number) {
  const minutes = Math.max(1, Math.round(Math.abs(milliseconds) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function ResolutionTimer({ position, now }: { position: PaperPosition; now: number }) {
  const expected = position.expectedEndAt ? Date.parse(position.expectedEndAt) : Number.NaN;
  const estimated = position.timingSource === 'title-estimate' || position.timingSource === 'activity-estimate';
  const title = position.timingSource === 'activity-estimate'
    ? 'Approximate sports result window based on 24 hours after the copied trade; official settlement may differ.'
    : position.timingSource === 'title-estimate'
      ? 'Approximate end inferred from the date in the market title; official settlement may happen later.'
      : position.timingSource === 'polymarket-combo'
        ? `Official Polymarket combo lifecycle for the ${position.comboSide ?? 'unknown'} side and its underlying legs.`
        : 'Polymarket scheduled end; official settlement can happen later after the result is confirmed.';

  if (position.resolutionStatus === 'resolved') {
    const result = position.result && position.result !== 'unknown' ? position.result : 'resolved';
    return <span className={`resolution-timer ${result}`} title={title}>
      {result === 'won' ? 'Won' : result === 'lost' ? 'Lost' : 'Result posted'}
    </span>;
  }
  if (!Number.isFinite(expected)) {
    return <span className="resolution-timer unknown" title="This market does not expose a reliable scheduled end yet.">No ETA</span>;
  }
  const remaining = expected - now;
  if (remaining <= 0) {
    const recheckAt = Date.parse(position.nextVerificationAt ?? '');
    const recheckRemaining = recheckAt - now;
    return <span className="resolution-timer awaiting" title={title}>
      {Number.isFinite(recheckAt) && recheckRemaining > 0
        ? `Awaiting result · recheck in ${durationLabel(recheckRemaining)}`
        : 'Checking official result…'}
    </span>;
  }
  return <span className={`resolution-timer ${estimated ? 'estimated' : 'scheduled'}`} title={title}>
    {estimated ? '~' : ''}{durationLabel(remaining)} to result
  </span>;
}

function SignalTape({ state }: { state: DashboardState }) {
  const cutoff = Date.now() / 1000 - state.settings.scanner.replayHours * 3600;
  const recentTrades = state.sourceTrades.filter((trade) => trade.timestamp >= cutoff);
  if (!recentTrades.length) return <EmptyState icon={<Radar />} title="Listening for fresh trades" copy={`No tracked-trader trades in the last ${state.settings.scanner.replayHours} hours. New activity will appear here live.`} />;
  return <div className="signal-list" tabIndex={0} role="region" aria-label="Tracked trader activity">{recentTrades.slice(0, 8).map((trade) => (
    <div className="signal-row" key={trade.id}>
      <div className={`side-icon ${trade.side.toLowerCase()}`}>{trade.side === 'BUY' ? <ArrowDownRight /> : <ArrowUpRight />}</div>
      <div className="signal-copy"><div><strong>{displayTraderName(trade.traderName)}</strong><span className={`side-word ${trade.side.toLowerCase()}`}>{trade.side}</span><b>{trade.outcome}</b></div><p>{trade.title}</p></div>
      <div className="signal-value"><strong>{money(trade.notional)}</strong><span>{relativeTime(new Date(trade.timestamp * 1000).toISOString())}</span></div>
    </div>
  ))}</div>;
}

function qualificationFor(trader: TraderCandidate) {
  if (trader.selectionOverride === 'include' && trader.verification.status==='verified') return { label: trader.entryEligible?'Confirmed':'Onboarding', className: trader.entryEligible?'qualified':'building', scoreLabel: 'Pinned' };
  if (!trader.watched) return { label: 'Rejected', className: 'rejected', scoreLabel: 'Reject' };
  if (trader.reasons.includes('Insufficient settled sample')) {
    return { label: 'Building sample', className: 'building', scoreLabel: 'Promising' };
  }
  return { label: 'Qualified', className: 'qualified', scoreLabel: 'Qualified' };
}

type TraderSortKey = 'winRate' | 'roi' | 'pnl' | 'trades' | 'lastActivityAt' | 'score';
type TraderSort = { key: TraderSortKey; dir: 'asc' | 'desc' };
/** Numeric value for a sortable column; null sorts last in either direction. */
function sortValue(trader: TraderCandidate, key: TraderSortKey): number | null {
  const raw = key === 'lastActivityAt' ? Date.parse(trader.lastActivityAt ?? '') : trader[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function SortHeader({ label, column, sort, onSort }: { label: string; column: TraderSortKey; sort: TraderSort | null; onSort: (next: TraderSort | null) => void }) {
  const active = sort?.key === column;
  // desc -> asc -> off: the first click shows the best at the top, which is what a
  // ranking column is for; the third click restores the default pinned-first view.
  const next = (): TraderSort | null => !active ? { key: column, dir: 'desc' } : sort!.dir === 'desc' ? { key: column, dir: 'asc' } : null;
  return <th aria-sort={active ? (sort!.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className={`sort-button ${active ? 'active' : ''}`} onClick={() => onSort(next())} title={`Sort by ${label.toLowerCase()}`}>
      {label}<span className="sort-mark">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : '↕'}</span>
    </button>
  </th>;
}

function TraderTable({ traders, onToggle, busy, sort, onSort }: { traders: TraderCandidate[]; onToggle: (trader: TraderCandidate) => void; busy: string | null; sort: TraderSort | null; onSort: (next: TraderSort | null) => void }) {
  if (!traders.length) return <EmptyState icon={<Radar />} title="No scanner results yet" copy="Run a fresh scan or loosen the filters in Strategy settings." />;
  return <div className="table-scroll trader-table-wrap" tabIndex={0} role="region" aria-label="Ranked trader candidates"><table className="data-table trader-table"><thead><tr><th>Rank / trader</th><th>Leaderboards</th><th>Sources</th>
    <SortHeader label="Win rate" column="winRate" sort={sort} onSort={onSort} />
    <SortHeader label="ROI" column="roi" sort={sort} onSort={onSort} />
    <SortHeader label="P&L" column="pnl" sort={sort} onSort={onSort} />
    <SortHeader label="Sample" column="trades" sort={sort} onSort={onSort} />
    <SortHeader label="Last trade" column="lastActivityAt" sort={sort} onSort={onSort} />
    <SortHeader label="Edge / CVaR" column="score" sort={sort} onSort={onSort} />
    <th>Status</th><th>Paper copy</th></tr></thead><tbody>{traders.map((trader) => (
    <tr key={trader.address} className={trader.selected ? 'selected-row' : ''}>
      <td><div className="rank-trader"><span>#{trader.rank}</span><Avatar name={trader.name} src={trader.avatar} /><div><strong>{displayTraderName(trader.name)}</strong><a href={`https://polymarket.com/profile/${trader.address}`} target="_blank" rel="noreferrer">{shortAddress(trader.address)} <ExternalLink /></a></div></div></td>
      <td><div className="period-stack">{(trader.leaderboardPeriods ?? []).map((period) => <span key={period}>{period}</span>)}</div></td>
      <td><div className="source-stack"><span className={trader.provider === 'arkham' ? 'source arkham' : 'source poly'}>{trader.provider === 'arkham' ? 'ARKHAM' : 'POLY'}</span><a className={`source verify ${trader.verification.status}`} href={trader.verification.url} target="_blank" rel="noreferrer">PM SCAN</a></div></td>
      <td><strong>{percent(trader.winRate)}</strong>{trader.verification.wins !== undefined && <span className="sub-value">{trader.verification.wins}W / {trader.verification.losses}L</span>}</td>
      <td><span className={(trader.roi ?? 0) >= 0 ? 'pnl up' : 'pnl down'}>{percent(trader.roi)}</span></td>
      <td><strong>{money(trader.pnl, true)}</strong><span className="sub-value">all-time rank</span></td>
      <td><strong>{trader.trades ? number(trader.trades) : '—'}</strong><span className="sub-value">{trader.openPositions} open</span></td>
      <td><strong>{relativeTime(trader.lastActivityAt)}</strong><span className="sub-value">{trader.lastActivityAt ? new Date(trader.lastActivityAt).toLocaleDateString() : 'No activity found'}</span></td>
      <td><div className="score-cell" title={trader.edge ? `Lower edge: ${trader.edge.edgeLowerBound ?? 'unavailable'}; CVaR95 loss: ${trader.edge.cvar95Loss ?? 'unavailable'}; effective sample: ${trader.edge.effectiveSampleSize ?? 0}; stable folds: ${trader.edge.positiveFoldPct ?? 0}%; FDR: ${trader.edge.falseDiscoveryRate === undefined ? 'n/a' : `${number(trader.edge.falseDiscoveryRate)}%`}${trader.edge.notes?.length ? `\n${trader.edge.notes.join('\n')}` : ''}` : 'Not measured yet: expectancy is measured for the watched shortlist on each scan.'}><div className="score-ring" style={{ '--score': `${Math.max(0,Math.min(100,trader.score*50)) * 3.6}deg` } as React.CSSProperties}>{trader.edge?number(trader.edge.rankingRatio??0):'—'}</div><span>{!trader.edge ? 'Unmeasured' : trader.edge.eligible ? 'Experimental' : 'Insufficient'}</span></div></td>
      <td><span className={`watch-status ${qualificationFor(trader).className}`} title={trader.reasons.join(' · ') || 'All configured qualification checks passed'}>{qualificationFor(trader).label}</span></td>
      <td><div className="tracking-control"><button className={`toggle ${trader.selected || trader.selectionOverride === 'include' ? 'on' : ''}`} onClick={() => onToggle(trader)} disabled={busy === `trader-${trader.address}`} aria-label={`${trader.selectionOverride === 'include' || trader.selected ? 'Remove' : 'Request'} paper copying ${trader.name}`}><span /></button>{trader.selectionOverride && <small>{trader.selectionOverride === 'include' ? 'Pinned' : 'Muted'}</small>}</div></td>
    </tr>
  ))}</tbody></table></div>;
}

function TradeLog({ trades }: { trades: PaperTrade[] }) {
  if (!trades.length) return <EmptyState icon={<Activity />} title="No paper decisions yet" copy="Reset with a replay window or wait for new tracked-trader activity." />;
  return <div className="trade-log" tabIndex={0} role="region" aria-label="Paper executions and skips">{trades.slice(0, 100).map((trade) => (
    <div key={`${trade.id}-${trade.timestamp}`} className={`trade-log-row ${trade.status}`}>
      <span className={`trade-status ${trade.status}`}>{trade.status === 'filled' ? <Check /> : <CircleAlert />}</span>
      <div className="trade-main"><div><span className={`side-word ${trade.side.toLowerCase()}`}>{trade.side}</span><strong>{trade.outcome}</strong><b>{trade.title}</b></div><p>{trade.reason} · {trade.traderName} · {new Date(trade.timestamp).toLocaleString()}</p></div>
      <div className="trade-numbers" title={`Fees: ${money(trade.fees ?? 0)}; unfilled: ${number(trade.unfilledShares ?? 0)} shares; ${trade.executionModel ?? 'legacy model'}`}><strong>{trade.status === 'filled' ? money(trade.notional) : 'Skipped'}</strong><span>{number(trade.fillPrice * 100)}¢ · {number(trade.shares)} sh</span></div>
    </div>
  ))}</div>;
}

function EmptyState({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) {
  return <div className="empty-state"><div>{icon}</div><strong>{title}</strong><p>{copy}</p></div>;
}

function Avatar({ name, src }: { name: string; src?: string }) {
  const initials = name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  return src ? <img className="avatar" src={src} alt="" /> : <span className="avatar generated">{initials}</span>;
}

function SettingsDrawer({ settings, onChange, onClose, onSave, saving }: { settings: AppSettings; onChange: (settings: AppSettings) => void; onClose: () => void; onSave: () => void; saving: boolean }) {
  const risk = settings.risk;
  const scanner = settings.scanner;
  const setRisk = (key: keyof typeof risk, value: number) => onChange({ ...settings, risk: { ...risk, [key]: value } });
  const setScanner = (key: keyof typeof scanner, value: number | string) => onChange({ ...settings, scanner: { ...scanner, [key]: value } });
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="settings-drawer" aria-label="Strategy settings">
      <header><div><span className="eyebrow">CONTROL PLANE</span><h2>Strategy settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={onClose}><X /></button></header>
      <div className="drawer-content">
        <section><h3>Trader scanner</h3><p>Discovers unique wallets across Polymarket's daily, weekly, and monthly P&amp;L leaderboards, then applies activity and PolymarketScan checks.</p>
          <div className="field-grid">
            <SelectField label="Category" value={scanner.category} onChange={(value) => setScanner('category', value)} options={['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE', 'WEATHER', 'ECONOMICS', 'TECH', 'FINANCE']} />
            <div className="coverage-field"><span>Leaderboard coverage</span><strong>DAY + WEEK + MONTH</strong></div>
          </div>
          <RangeField label="One-sided confidence level" value={scanner.confidenceLevelPct??95} min={90} max={99} suffix="%" onChange={(value) => setScanner('confidenceLevelPct', value)} />
          <NumberField label="Minimum effective event clusters" value={scanner.minEffectiveEventClusters??40} onChange={(value) => setScanner('minEffectiveEventClusters', value)} />
          <RangeField label="Maximum false-discovery rate" value={scanner.maxFalseDiscoveryRatePct??10} min={1} max={25} suffix="%" onChange={(value) => setScanner('maxFalseDiscoveryRatePct', value)} />
          <NumberField label="Minimum settled sample" value={scanner.minTrades} onChange={(value) => setScanner('minTrades', value)} />
          <NumberField label="Discovery pool (unique wallets)" value={scanner.candidatePoolSize} onChange={(value) => setScanner('candidatePoolSize', value)} />
          <NumberField label="Maximum watched traders" value={scanner.maxWatchedTraders} onChange={(value) => setScanner('maxWatchedTraders', value)} />
          <NumberField label="Maximum paper-copied traders" value={scanner.maxTrackedTraders} onChange={(value) => setScanner('maxTrackedTraders', value)} />
          <p>Wilson win rate is descriptive only. Challenger ranking uses the net-edge lower bound divided by CVaR and remains shadow-only.</p>
          <NumberField label="Active-trader window (hours)" value={scanner.maxInactiveHours} onChange={(value) => setScanner('maxInactiveHours', value)} />
        </section>
        <section><h3>Paper risk engine</h3><p>Fresh books, protocol fees, maximum loss, market, event, trader and portfolio caps apply to every entry. Missing exit liquidity leaves a pending position.</p>
          <NumberField label="Starting paper balance" value={risk.startingBalance} prefix="$" onChange={(value) => setRisk('startingBalance', value)} />
          <RangeField label="Maximum risk per trade" value={risk.maxRiskPerTradePct} min={0.1} max={5} step={0.1} suffix="%" onChange={(value) => setRisk('maxRiskPerTradePct', value)} />
          <RangeField label="Maximum per market" value={risk.maxPositionPct} min={0.5} max={15} step={0.5} suffix="%" onChange={(value) => setRisk('maxPositionPct', value)} />
          <RangeField label="Maximum total exposure" value={risk.maxTotalExposurePct} min={5} max={100} suffix="%" onChange={(value) => setRisk('maxTotalExposurePct', value)} />
          <NumberField label="Source notional multiplier" value={risk.sourceNotionalMultiplier} suffix="×" step={0.1} onChange={(value) => setRisk('sourceNotionalMultiplier', value)} />
          <NumberField label="Maximum order-book slippage" value={risk.slippageBps} suffix=" bps" onChange={(value) => setRisk('slippageBps', value)} />
          <NumberField label="Maximum signal age" value={risk.maxSignalAgeSeconds ?? 120} suffix=" seconds" onChange={(value) => setRisk('maxSignalAgeSeconds', value)} />
          <NumberField label="Maximum quote age" value={risk.maxQuoteAgeSeconds ?? 15} suffix=" seconds" onChange={(value) => setRisk('maxQuoteAgeSeconds', value)} />
          <NumberField label="Maximum trader exposure" value={risk.maxTraderExposurePct ?? 4} suffix="%" onChange={(value) => setRisk('maxTraderExposurePct', value)} />
          <NumberField label="Maximum event exposure" value={risk.maxEventExposurePct ?? 4} suffix="%" onChange={(value) => setRisk('maxEventExposurePct', value)} />
          <NumberField label="Drawdown shutdown" value={risk.maxDrawdownPct ?? 7.5} suffix="%" onChange={(value) => setRisk('maxDrawdownPct', value)} />
          <NumberField label="UTC-day loss shutdown" value={risk.maxDailyLossPct ?? 2} suffix="%" onChange={(value) => setRisk('maxDailyLossPct', value)} />
          <NumberField label="Position stop loss (100 = off)" value={risk.stopLossPct ?? 20} suffix="%" onChange={(value) => setRisk('stopLossPct', value)} />
          <NumberField label="Depth participation limit" value={risk.maxParticipationPct ?? 5} suffix="%" onChange={(value) => setRisk('maxParticipationPct', value)} />
          <NumberField label="Target-change no-trade band" value={risk.noTradeBandPct ?? 10} suffix="%" onChange={(value) => setRisk('noTradeBandPct', value)} />
          <NumberField label="Maximum days to result" value={risk.maxPositionDurationDays} suffix=" days" step={0.25} onChange={(value) => setRisk('maxPositionDurationDays', value)} />
        </section>
      </div>
      <footer><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-action" onClick={onSave} disabled={saving}>{saving ? <RefreshCw className="spin" /> : <Check />}Save controls</button></footer>
    </aside>
  </div>;
}

function RangeField({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix: string; onChange: (value: number) => void }) {
  return <label className="range-field"><div><span>{label}</span><strong>{number(value)}{suffix}</strong></div><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function NumberField({ label, value, prefix = '', suffix = '', step = 1, onChange }: { label: string; value: number; prefix?: string; suffix?: string; step?: number; onChange: (value: number) => void }) {
  return <label className="number-field"><span>{label}</span><div>{prefix}<input type="number" value={value} step={step} onChange={(event) => onChange(Number(event.target.value))} />{suffix}</div></label>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
}
