import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { DashboardState } from '../shared/types.js';

export class SqliteJournal {
  private database?: DatabaseSync;
  constructor(readonly path:string) {}

  open() {
    if(this.database) return;
    const db=this.database=new DatabaseSync(this.path);
    chmodSync(this.path,0o600);
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,updated_at TEXT NOT NULL,config_hash TEXT);
      CREATE TABLE IF NOT EXISTS raw_observations(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_events(id TEXT PRIMARY KEY,source_at TEXT,received_at TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trader_assessments(id TEXT PRIMARY KEY,trader_address TEXT NOT NULL,assessed_at TEXT NOT NULL,sleeve TEXT NOT NULL,eligible INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signal_decisions(id TEXT PRIMARY KEY,source_event_id TEXT NOT NULL,state TEXT NOT NULL,decided_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fills(id TEXT PRIMARY KEY,source_event_id TEXT,filled_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lots(id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exit_intents(position_id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS position_cycles(id TEXT PRIMARY KEY,closed_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS equity_closes(timestamp TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,level TEXT NOT NULL,delivered_at TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_health(name TEXT PRIMARY KEY,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliation_reports(id TEXT PRIMARY KEY,checked_at TEXT NOT NULL,passed INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_runs(id TEXT PRIMARY KEY,started_at TEXT NOT NULL,passed INTEGER,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS source_events_source_at ON source_events(source_at);
      CREATE INDEX IF NOT EXISTS decisions_event ON signal_decisions(source_event_id);
      CREATE INDEX IF NOT EXISTS fills_event ON fills(source_event_id);
      CREATE INDEX IF NOT EXISTS alerts_created ON alerts(created_at);
    `);
  }

  integrityCheck() {
    this.open();
    const row=this.database!.prepare('PRAGMA integrity_check').get() as Record<string,string>|undefined;
    return Boolean(row&&Object.values(row)[0]==='ok');
  }

  readSnapshot():DashboardState|undefined {
    this.open();
    const row=this.database!.prepare('SELECT payload FROM state_snapshot WHERE id=1').get() as {payload:string}|undefined;
    return row?JSON.parse(row.payload) as DashboardState:undefined;
  }

  metadata(key:string) {
    this.open();
    return (this.database!.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined)?.value;
  }

  setMetadata(key:string,value:string) {
    this.open();
    this.database!.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
  }

  persist(state:DashboardState,configHash:string) {
    this.open();
    const db=this.database!;
    const json=(value:unknown)=>JSON.stringify(value);
    db.exec('BEGIN IMMEDIATE');
    try {
      const now=new Date().toISOString();
      db.prepare('INSERT INTO state_snapshot(id,payload,updated_at,config_hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,config_hash=excluded.config_hash').run(json(state),now,configHash);
      const source=db.prepare('INSERT OR IGNORE INTO source_events(id,source_at,received_at,payload) VALUES(?,?,?,?)');
      for(const row of state.sourceTrades) source.run(row.id,new Date(row.timestamp*1000).toISOString(),row.receivedAt??now,json(row));
      const decision=db.prepare('INSERT INTO signal_decisions(id,source_event_id,state,decided_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,decided_at=excluded.decided_at,payload=excluded.payload');
      for(const row of state.account.signalDecisions??[]) decision.run(row.id,row.sourceEventId,row.state,row.decidedAt,json(row));
      const fill=db.prepare('INSERT OR IGNORE INTO fills(id,source_event_id,filled_at,payload) VALUES(?,?,?,?)');
      for(const row of state.account.trades) if(row.status==='filled') fill.run(row.id,row.sourceTradeId,row.fillAt??row.timestamp,json(row));
      const lot=db.prepare('INSERT INTO lots(id,updated_at,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload');
      const intent=db.prepare('INSERT INTO exit_intents(position_id,updated_at,payload) VALUES(?,?,?) ON CONFLICT(position_id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload');
      for(const row of state.account.positions) {lot.run(row.id,row.updatedAt,json(row));if(row.exitIntent) intent.run(row.id,row.exitIntent.lastAttemptAt??row.exitIntent.since,json(row.exitIntent));}
      const cycle=db.prepare('INSERT OR IGNORE INTO position_cycles(id,closed_at,payload) VALUES(?,?,?)');
      for(const row of state.account.completedCycles??[]) cycle.run(row.id,row.closedAt,json(row));
      const close=db.prepare('INSERT OR REPLACE INTO equity_closes(timestamp,payload) VALUES(?,?)');
      for(const row of state.account.dailyCloses??[]) close.run(row.timestamp,json(row));
      const alert=db.prepare('INSERT INTO alerts(id,created_at,level,delivered_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET delivered_at=excluded.delivered_at,payload=excluded.payload');
      for(const row of state.account.alerts??[]) alert.run(row.id,row.createdAt,row.level,row.deliveredAt??null,json(row));
      const health=db.prepare('INSERT INTO worker_health(name,updated_at,payload) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload');
      for(const [name,row] of Object.entries(state.account.workerHealth??{})) health.run(name,row.completedAt??row.startedAt??now,json(row));
      const reconcile=db.prepare('INSERT OR IGNORE INTO reconciliation_reports(id,checked_at,passed,payload) VALUES(?,?,?,?)');
      for(const row of state.account.reconciliations??[]) reconcile.run(row.id,row.checkedAt,row.passed?1:0,json(row));
      const validation=db.prepare('INSERT INTO validation_runs(id,started_at,passed,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET passed=excluded.passed,payload=excluded.payload');
      for(const row of state.validationRuns??[]) validation.run(row.id,row.startedAt,row.passed===undefined?null:row.passed?1:0,json(row));
      const assessment=db.prepare('INSERT OR IGNORE INTO trader_assessments(id,trader_address,assessed_at,sleeve,eligible,payload) VALUES(?,?,?,?,?,?)');
      for(const row of state.assessments??[]) assessment.run(row.id,row.traderAddress,row.assessedAt,row.sleeve,row.eligible?1:0,json(row));
      this.setMetadata('clean_shutdown','false');
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }

  checkpoint() {this.database?.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
  close(clean=true) {if(!this.database)return;if(clean)this.setMetadata('clean_shutdown','true');this.checkpoint();this.database.close();this.database=undefined;}
}
