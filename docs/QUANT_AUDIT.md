# Papertrail v3 quantitative audit

Reviewed and implemented 15 September 2026. Papertrail is paper-only; no wallet signing, allowances, order submission, deposits, withdrawals, or live capital code exists.

## Confirmed calculation defects corrected

The v2 scanner used duplicated Wilson thresholds and could use outcome frequency as a proxy for skill. A 95% favourite buyer can have a high win rate and negative expectancy. V3 keeps exact W/L and Wilson output only as description. The champion requires complete, fresh evidence and uses equal-risk allocation; the shadow challenger is ranked by a conservative cost-adjusted edge-to-CVaR ratio.

History now reconstructs inventory cycles instead of treating fills as independent bets. Several buys before an exit are one cycle; a later buy after zero is a re-entry. Event legs are collapsed to `e_g = sum(q_i * (netExitOrOutcome_i - allInEntry_i)) / sum(q_i)`. Held-to-resolution and early-exit/trading outcomes are retained separately. Capital, transfers and leverage are not inferred when full inventory/cash-flow evidence is unavailable.

Recency weight is `exp(-ln(2) * ageDays / 60)` and effective sample size is `(sum w)^2 / sum(w^2)`. The trader mean shrinks to the category/regime pool using `mu_s = (n_eff * mu_t + k * mu_pool) / (n_eff + k)`; `k` is a clipped method-of-moments within/between variance estimate. A deterministic event/day block bootstrap supplies the one-sided 95% lower bound. Benjamini-Hochberg q-values control scan-level multiple testing. Challenger eligibility also requires at least 40 effective clusters, 70% positive rolling folds and no trader/event contributing more than 20% of positive profit.

Ranking is `mu_L / max(CVaR95 loss, 0.01)`. Capacity is displayed and enforced through current executable depth, never added as a profit bonus. The challenger is experimental and shadow-only.

## Execution and risk corrections

For a requested buy, the engine consumes asks and calculates `cost = sum(q_level * price_level + protocolFee_level + 25bp stress_level)`. Market-specific fee rate/exponent, timestamp, tick and minimum size are mandatory. Public WebSocket snapshots/deltas are hash-compared with REST snapshots; gaps recover through REST. Missing or stale metadata cannot authorize a fill.

Champion desired capital per signal is `min(source target, 0.5% equity, executable depth)`. All desires are projected simultaneously across cash, 2% market, 4% trader, 4% event and 25% portfolio ceilings. Conservative exposure is `sum(max(costBasis, markedValue))`. A 10% target-change band and venue minimum suppress churn and dust.

Buy and sell accounting includes entry/exit fees. Sale cost release is proportional to shares. Equity conservation is tested as `equity - startingBalance = realizedPnl + sum(unrealizedPnl)`. Requested, filled and unfilled shares plus source, receipt/decision, quote and fill timestamps are retained. Partial/risk exits remain durable intents rather than disappearing after a transient quote failure.

Hard controls are 20% position stop, seven-day holding/result horizon, 2% UTC-day loss halt, and 7.5% high-water drawdown halt. Concentration exits trim required excess in weakest-edge order. A risk-closed asset cannot re-enter until the source is observed at zero and emits a later BUY. Combo entries remain blocked until void and fractional/partial payout fixtures pass.

## Automation and data integrity

SQLite WAL is authoritative. Normalized tables retain observations, source events, trader assessments, decisions, fills, lots, exit intents, completed cycles, equity closes, alerts, worker health, reconciliations and validation runs. Dashboard arrays are bounded; JSON is export/archive only. Single-writer locking, full synchronous commits, integrity checks, reconciliation, clean-shutdown markers, WAL checkpointing, verified backup/restore and fail-closed startup are implemented.

Trader lifecycle requires two consecutive eligible scans for automatic onboarding, immediately blocks hard evidence failures, and tolerates fewer than three soft failures. Existing positions remain under exit monitoring after selection displacement. Alert delivery uses stable event IDs, deduplication, bounded HTTPS attempts, exponential jitter and a dead-letter state. Secrets remain in a mode-0600 `.env` and are excluded from API state and logs.

Conditional paper resume checks clean shutdown, database integrity, reconciliation, fresh feeds, no halt/critical alert, approved code/config hashes and a recent successful webhook test. The launchd template can supervise the paused paper service. See [operations](OPERATIONS.md).

## Evidence boundary

Unit/property/integration tests demonstrate implemented invariants, not alpha. Replay uses chronological cold starts, event-grouped walk-forward splits, a seven-day purge/embargo, and fee/spread/depth/delay stress. Current-leaderboard/proxy-book tapes are explicitly engineering-only due to survivorship and liquidity approximation.

The prior development and holdout replay was negative. No strategy is validated for live trading. Promotion requires the untouched-data, 90-day/200-event forward-paper, drawdown, latency, reconciliation and recovery gates in [validation requirements](VALIDATION.md). `/api/validation` always returns `liveEnabled: false` and `eligibleForLive: false`.
