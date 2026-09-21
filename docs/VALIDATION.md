# Validation contract and operational gates

This document fixes requirements before future tuning. None of the tests below authorizes live execution. Live execution is absent from this application; `/api/validation` deliberately cannot return eligible for live trading.

## Completed in this review

- TypeScript checks and production build.
- Unit/integration tests covering accounting conservation, fee-inclusive caps, source parsing, eligibility, immutable duplicate handling, partial fills, depleted depth, staleness, risk latching, source pagination, resolution evidence, durable save/load, corruption refusal, locking, restart pause, API access and HTTP recovery.
- A 1,000-decision deterministic randomized buy/sell invariant simulation.
- A seeded synthetic replay with chronological cold starts, five event-grouped walk-forward folds, a seven-day purge/embargo, and fee/spread/depth/delay stresses. This checks simulation machinery; these frames are not historical prices, independently observed traders, or evidence of alpha.
- An isolated migration smoke test of a copy of the existing account: 3,171 decisions and 34 positions retained, starts paused, strict quotes enabled. The original state file was hash-checked unchanged.

Run `npm test`, `npm run check`, `npm run build`, and `npm run validate:replay`. The replay report is written to `artifacts/quant-validation.json`. `scripts/smoke-preserved-state.ts` checks a temporary copy; it does not start the real bot or modify the user's account.

## Required datasets and research protocol (outstanding)

Collect and retain timestamped discovery universes, selected/rejected wallet snapshots, source capital flows and complete execution lots, fees/rebates, market/settlement lifecycle events, book depth, receipt times and normalized event identities. Keep raw observations separately from derived estimates. Include unsuccessful and subsequently inactive wallets, and do not select a historic universe from today's leaderboard.

`ReplayFrame` in `src/server/backtest.ts` defines the offline input contract. Each frame contains an observation time, contemporaneous trader evidence, signal, source positions, executable books/fees, and optional timestamped confirmed binary resolutions. The runner rejects future source, quote, position, verification and settlement information and nonchronological frames. Replay has no network calls. Parameters are frozen across reported validation folds; every parameter trial still needs an external append-only trial registry before research promotion.

For the actual strategy study, preregister parameters and objective, use rolling development/validation/untouched-test periods, group splits by shared market/event, purge overlapping holding periods and embargo at least the longest holding period. Preserve the point-in-time discovery universe. Retain every parameter trial; use block bootstrap by event/day and a multiple-testing-adjusted significance calculation. Only evaluate the untouched test once after choosing a model. Compare to cash and simple equal-risk copying at the same costs and opportunity set.

Optimize net expected returns subject to drawdown, tail loss, capacity, turnover and concentration constraints. Include parameter-neighborhood stability and different time regimes. Stress wider spreads, adverse drift, smaller depth, double fees, 1/5/30/120-second observation delays, complete outages, throttling, missing pages, duplicate events and reordered receipts. Uncertain or unavailable fills must not count as completed trades.

## Forward paper and release gates (outstanding)

1. At least 90 completed calendar-day returns in an uncontaminated version 3 account and at least 200 independent settled event clusters. More data may be required for a meaningful confidence interval; these minima are not sufficient alone.
2. Positive lower 95% event-block-bootstrap confidence bound on net excess return over the preregistered baseline in the untouched historical test and forward paper period. Correct for the number of strategies tried. No single trader/event may explain more than 20% of net profits.
3. Maximum drawdown no greater than 7.5% under base assumptions and 12% under preregistered cost/liquidity stress; no breached cash, position, market, event or owner invariant. Risk controls must recover safely from forced faults without creating fills or losing positions.
4. Every copied lifecycle reconciled; no unresolved duplicate, missed-page, monetary or settlement discrepancy. Record source-to-observation and observation-to-decision latency; 99th percentile decision delay must remain below the configured signal-age cutoff. Establish a stricter market-specific cutoff from observed decay.
5. Book capture, fee metadata and quote timestamps verified against actual API contracts; empirically validate depth participation and fill assumptions. Complete a paper burn-in with representative markets and actual observation delays. The current synthetic tests do not satisfy this requirement.
6. Verify independent worker timing under sustained load, durable webhook alerts/dead-letter handling, secrets review, recovery drills, SQLite backup/restore and crash-safe account ownership. No silent degraded data feeds. Worker health and priority controls being present is not the same as passing the drill.
7. If live execution is separately implemented: paper/live isolation, explicit human authorization, per-order limits, daily-loss limit, reserved cash/open-order accounting, canonical on-chain fill IDs and finality states, reconciliation after submit timeout, cancel/replace races, venue status/restriction validation, external kill switch and capped canary capital. A passed test suite alone cannot enable live mode.

## Safe restart and incident procedure

Normal shutdown: pause entries, send SIGTERM/Ctrl-C, wait for SQLite checkpoint and lock release. Restart with the same data path. Conditional resume requires account totals, pending exits, provider freshness, alerts, webhook delivery, reconciliation, and approved code/config hashes. A financial halt cannot be cleared by Resume; preserve/export the account and investigate. Reset archives the prior account first.

After a hard crash, first establish that the recorded lock owner is dead and no other instance uses the data path. Preserve the SQLite database, WAL/SHM files, and lock metadata before manually removing only the exact stale lock directory. Corrupt state must be restored from a verified backup; do not delete it to force a new balance. A supervisor may restart the process, but conditional resume rejects the unclean shutdown.
