# Methodology v3 implementation status

## Confirmed correctness and safety changes

- Fresh, account-identified methodology-v3 paper state; bounded dashboard views with a normalized SQLite WAL audit journal.
- Wilson win rate is descriptive only. The old `minWinRate` and `minScore` payload fields are compatibility inputs and are not skill gates.
- Event-sourced position cycles keep scaling buys together and separate full exit/re-entry. Held-to-resolution and early-exit observations remain distinguishable.
- Copyable edge uses quantity-weighted event economics, 60-day exponential decay, effective sample size, empirical-Bayes pool shrinkage, event/day block bootstrap, Benjamini-Hochberg correction, fold stability, profit concentration and CVaR ranking.
- Challenger gates are 40 effective event clusters, positive cost-stressed 95% lower edge, FDR at most 10%, at least 70% positive folds, and at most 20% profit concentration. Challenger capital remains zero.
- Champion desired capital is the minimum of source target, 0.5% equity and executable depth. Desires are projected together across cash, 2% market, 4% trader/event and 25% portfolio caps. A 10% no-trade band and venue minimum size suppress churn.
- Books consume displayed levels at 5% participation. Market fees are mandatory metadata; 25 bps is added as paper stress. Missing/stale books, fees, inventory, market timing, category tags, excessive drift and combos fail closed.
- Durable signal decisions and exit intents keep transient quote failures retryable. Risk/source sells remain pending through partial liquidity. Source snapshots use their own observation times.
- Stops include 20% position loss, 2% UTC-day loss and 7.5% drawdown. Concentration trims only required excess, weakest stored edge first. Re-entry after risk exit requires observed source zero plus a later BUY.
- SQLite records source events, assessments, decisions, fills, lots, exit intents, cycles, equity closes, worker health, alerts, reconciliations and validation runs. JSON is archive/export only.
- Startup is paused. Conditional resume checks clean shutdown, DB integrity, reconciliation, feed freshness, risk/alerts, code/config hashes and a recent webhook test. Live execution remains absent.

## Experimental and not promoted

- Posterior edge selection, empirical-Bayes shrinkage strength and one-tenth lower-bound Kelly sizing are research algorithms. The sizing formula is implemented for tests but challenger order generation is deliberately absent.
- Public WebSocket books are maintained from snapshots/deltas and validated or recovered with REST hashes. Paper fills are still simulations, not proof of queue position or venue matching.
- Historical current-leaderboard tapes and proxy books are engineering-only. They cannot establish alpha because of survivorship, missing point-in-time universes, and approximate liquidity.

## Insufficient evidence / release blockers

- No profitable strategy is validated. The prior replay was negative in development and holdout.
- Source capital, transfers, leverage, hedges and related accounts remain unknown when complete cash-flow/inventory evidence is unavailable.
- Ninety forward-paper days, 200 independent settled event clusters, challenger superiority, 7.5%/12% drawdown limits, P99 latency, zero reconciliation discrepancies, and backup/recovery/watchdog/webhook drills have not passed.
- Process workers expose separate health records, but sustained-load timing and failure-isolation still require a supervised fault drill. This is a release gate, not a profitability claim.
