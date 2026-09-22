# Papertrail

**Paper-only copy trading for Polymarket.** Papertrail discovers prediction-market wallets with a verifiable track record, follows their trades in real time, and mirrors them into a simulated portfolio with real order-book depth, fees and risk limits — so you can find out whether "copy the winners" survives execution costs *before* any money is involved.

There is no live mode. The codebase contains no signer, private key, allowance or order-submission path, and every restart comes up paused behind integrity and reconciliation gates.

## What it does

1. **Discovers** wallets from Polymarket leaderboards (and Arkham, if you have a key), checks that they are recently active, and cross-verifies their P&L and ROI against an independent scanner.
2. **Screens** them with an interpretable equal-risk baseline — evidence, sample size, activity and verification checks. Wilson win rate is shown but is descriptive only. Pins cannot bypass hard evidence failures.
3. **Follows** the selected wallets' activity with 15-second polls and mirrors each BUY/SELL into the paper account. Fills consume fresh public order books (REST-validated WebSocket stream), bounded depth, per-market protocol fees plus a 25 bps stress cost, adverse-drift limits and a 0.9 entry-price ceiling.
4. **Sizes** every entry through simultaneous allocation against 0.5 % signal, 2 % market, 4 % trader/event and 25 % portfolio caps. Combo markets are refused. Missing books, fees or inventory reject the entry; missing exit liquidity becomes a durable, retried exit intent.
5. **Manages** open positions continuously — marks, stop-loss, concentration and drawdown limits, horizon exits and verified settlement — even while entries are paused.
6. **Measures** a shadow-only quantitative challenger alongside the champion: cost-adjusted event edge with 60-day decay, empirical-Bayes shrinkage, block bootstrap, FDR correction, CVaR and fold stability. It never trades; promotion needs the forward-paper, drawdown, stress, accounting, latency and recovery gates in [docs/VALIDATION.md](docs/VALIDATION.md).

## Quick start

Requires Node 22+ (tested on 26).

```bash
npm install
npm run check      # type-check
npm test           # ~130 tests, hermetic
npm run build
npm start          # API on 127.0.0.1:8787, serves the built UI, starts paused
```

Open [localhost:8787](http://localhost:8787). Review the account and controls, then press **Resume** (or `POST /api/resume/conditional`). Safety gates — a latched risk halt, a failed SQLite integrity check, an unacknowledged critical alert — always block; release-ceremony gates (clean shutdown, reconciliation, approved code/config hash, webhook drill) are advisory unless you pin `APPROVED_CODE_HASH`.

For development with hot reload:

```bash
npm run dev        # API via tsx watch + Vite on localhost:5173
```

## Configuration

Copy `.env.example` to `.env` (keep it mode `0600`). Everything is optional.

| Variable | Default | Purpose |
|---|---|---|
| `ARKHAM_API_KEY` | – | Enables Arkham leaderboard discovery; without it the public Polymarket leaderboard is used. |
| `PORT` | `8787` | API/UI port (binds to 127.0.0.1 only). |
| `POLL_INTERVAL_MS` | `15000` | Signal polling cadence. |
| `RESULT_VERIFICATION_INTERVAL_MS` | `300000` | Result and risk verification, including while paused. |
| `AUTO_DEPLOY_INTERVAL_MS` | `300000` | Deploy cycle, clamped to 5–10 minutes. |
| `DISCOVERY_INTERVAL_MS` | `3600000` | How often automatic cycles rescan traders (the button always rescans). |
| `JOB_DEADLINE_MS` / `SCAN_DEADLINE_MS` | `300000` / `900000` | Job watchdog; an overrun job is failed, alerted and the process restarts. |
| `SHUTDOWN_DRAIN_MS` | `60000` | How long SIGTERM waits for the running job before abandoning it. |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN` | – | Alert delivery. |
| `CONDITIONAL_AUTO_RESUME` | `false` | Resume automatically after restart when every gate passes. |
| `APPROVED_CODE_HASH` | – | Pin a code hash to make release gates blocking. |

Strategy parameters (risk caps, drift limits, allowed market categories, participation) live in **Strategy settings** in the UI and are persisted with the account.

## Running as a service (macOS)

A launchd agent is included. It runs the server as a single `node` process (deliberately not through the `tsx` CLI wrapper, which force-kills its child on SIGTERM and leaves a stale lock).

```bash
mkdir -p data/logs
cp launchd/com.papertrail.paper.plist ~/Library/LaunchAgents/   # edit the paths first
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.papertrail.paper.plist
```

Stop with `launchctl bootout gui/$(id -u)/com.papertrail.paper`. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for conditional resume, stale-lock recovery, verified backup/restore, the job watchdog, alerts and emergency shutdown.

## State and data

State is a transactional SQLite WAL journal at `data/tradesnipes-v3.sqlite` (the filename is historical). JSON is used only for export and archives. Use Ctrl-C/SIGTERM so the queue drains, the WAL checkpoints and the clean-shutdown marker is committed. **Reset simulation** archives the account to `data/archives/` and starts a fresh paused paper account. Historical trades are never replayed into a running account; onboarding and resumption start from the current time.

```bash
npm run backup                                   # VACUUM INTO + verify
npm run restore:verify -- data/backups/FILE.sqlite data/restore-verification/FILE.sqlite
```

## API

Read: `/api/health`, `/api/state`, `/api/performance`, `/api/validation`, `/api/validation/runs`, `/api/strategies`, `/api/workers`, `/api/alerts`, `/api/reconciliation`, `/api/events` (SSE).

Control: `POST /api/scan`, `/api/deploy`, `/api/poll`, `/api/resume/conditional`, `/api/halt/emergency`, `/api/halt/acknowledge`, `/api/reconciliation`, `/api/release/approve`, `/api/webhook/test`, `/api/simulation/reset`, `/api/alerts/:id/acknowledge`; `PATCH /api/settings`, `PATCH /api/traders/:address`.

Operator actions queue behind the running job rather than being refused; the UI shows what they are waiting on. Validation always reports `liveEnabled: false` and `eligibleForLive: false`.

## Validation and replay

```bash
npm run validate:replay                    # seeded synthetic scenarios — not market evidence
npm run validate:replay -- frames.jsonl    # chronological ReplayFrame observations
```

Read [docs/QUANT_AUDIT.md](docs/QUANT_AUDIT.md) and [docs/VALIDATION.md](docs/VALIDATION.md) before drawing conclusions from paper results. Current-leaderboard replay tapes are engineering-only because of survivorship and liquidity-proxy bias, and source capital/leverage is unknown when inventory and cash-flow evidence is incomplete.

## Project layout

```
src/server/      Express API, orchestrator (job queue + watchdog), paper engine, allocation, risk, SQLite store
src/server/sources/   Polymarket data/Gamma/CLOB clients, market WebSocket, Arkham, verification, timing
src/client/      React dashboard (Vite)
src/shared/      Types shared by server and client
scripts/         backup, restore verification, replay validation, tape builder
docs/            operations, quant audit, validation requirements, implementation notes
launchd/         macOS service definition
```

## Status

Papertrail is a research tool. **No strategy is validated for profit**, and nothing here is financial advice. The champion is a deliberately simple baseline; the challenger exists to be measured, not trusted. Treat every number on the dashboard as an estimate produced under the assumptions documented in `docs/`.

## License

No license has been chosen yet; all rights reserved until one is added.
