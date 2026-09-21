# Papertrail v3 operations

Papertrail is paper-only. The supervised service may monitor and simulate; it has no signer, allowance, private key, deposit, withdrawal, or order-submission path.

## Safe start and restart

1. Keep `.env` mode `0600`. Configure `ALERT_WEBHOOK_URL` and, if used, `ALERT_WEBHOOK_TOKEN` there. Never put either in launchd arguments, JSON exports, screenshots, or logs.
2. Run `npm run check && npm test && npm run build`.
3. Start with `npm start`. Startup is paused and runs SQLite integrity plus ledger reconciliation.
4. Test the webhook through `POST /api/webhook/test`, review critical alerts, then approve the exact paper code/config hashes through `POST /api/release/approve`.
5. `POST /api/resume/conditional` resumes only after every gate passes. Missing webhook delivery, stale feeds, a changed hash, an unclean shutdown, reconciliation error, or risk halt leaves entries paused.

Use SIGTERM or Ctrl-C. Shutdown drains the mutation queue, saves, checkpoints WAL, records a clean-shutdown marker, and releases the single-writer lock. Risk and settlement workers continue while entry copying is paused. The drain waits at most `SHUTDOWN_DRAIN_MS` (default 60 s) for the running job; past that the job is abandoned, state reverts to the last committed save, and the lock is still released. Keep the launchd `ExitTimeOut` (120 s in the shipped plist) above that budget, or launchd's SIGKILL leaves a stale lock.

`npm start` runs `node --import tsx` directly rather than the `tsx` CLI on purpose: the CLI is a wrapper process that force-kills its child as soon as it receives SIGTERM, so the server never got to release the lock when a job or upstream request was in flight. Do not reintroduce a wrapper (`tsx`, `nodemon`, a shell script without `exec`) between launchd and the server.

## Job watchdog

Every queued job has a deadline: `JOB_DEADLINE_MS` (default 5 min) for polls, verification and operator actions, `SCAN_DEADLINE_MS` (default 15 min) for scans. A job that overruns is failed like any other (its partial mutations are discarded), a critical `worker-hung` alert is raised, and the process exits with status 1 so launchd restarts it. The restart comes up paused; acknowledge the alert, review, then Resume. This replaced a silent failure mode in which one unfinished poll blocked exits, marks and shutdown for nineteen hours.

## Crash and stale lock recovery

Never delete a lock just because it exists. Read `data/tradesnipes-v3.sqlite.lock/owner.json`, check the exact PID with `ps -p PID -o pid=,command=`, and confirm no Papertrail process owns the database. Archive the lock metadata, remove only that exact lock directory, then restart. The conditional-resume gate will still refuse an unclean restart.

## Backup and restore drill

Run `npm run backup`. It checks the live SQLite database, creates a consistent `VACUUM INTO` backup, and verifies the backup. Test it with `npm run restore:verify -- data/backups/FILE.sqlite data/restore-verification/FILE.sqlite`. Restore verification never overwrites an existing target. To promote a restored database, stop the service, archive the current database and WAL/SHM files, verify the candidate again, move it into the configured path, and restart paused.

## launchd

Create `data/logs`, copy `launchd/com.papertrail.paper.plist` to `~/Library/LaunchAgents/`, run `plutil -lint` on the installed file, then use `launchctl bootstrap gui/$(id -u) ...`. Do not enable `CONDITIONAL_AUTO_RESUME=true` until webhook, backup/restore, crash-recovery, watchdog, and alert drills have succeeded. A service restart is not evidence that paper entry gates passed.

## Emergency control

`POST /api/halt/emergency` pauses entries immediately, latches the reason, and requests depth-limited exits. Missing liquidity keeps durable exit intents pending. `POST /api/halt/acknowledge` does not resume. Review alerts, reconciliation, fills, residual positions, configuration and release hashes before a separate conditional resume.
