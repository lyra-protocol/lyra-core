/**
 * Durable execution state.
 *
 * The failure this exists to prevent is not a rejected order — it is an order
 * that was placed and then forgotten, because on restart the position exists and
 * nothing knows why it is there or what should protect it.
 *
 * So everything is persisted **before** the network call, never after. A crash
 * between writing and placing leaves an intent with no order, which reconciliation
 * can resolve. A crash between placing and writing would leave an order with no
 * intent, which it cannot.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type IntentStatus =
  | "intended"
  | "placed"
  | "filled"
  | "cancelled"
  | "rejected"
  | "failed";

export type StoredIntent = {
  cloid: string;
  decisionId: string;
  asset: string;
  side: "long" | "short";
  price: string;
  size: string;
  reduceOnly: boolean;
  tif: string;
  attempt: number;
  status: IntentStatus;
  venueOrderId: string | null;
  filledSize: string;
  avgFillPx: string | null;
  fee: string;
  createdAt: number;
  updatedAt: number;
  detail: string | null;
};

export type StoredPosition = {
  id: number;
  asset: string;
  decisionId: string;
  /** Arweave id of the reasoning written before this position opened. */
  reasoningId: string | null;
  side: "long" | "short";
  size: string;
  entryPx: string;
  openedAt: number;
  /** cloid of the protective stop resting at the venue. Null means unprotected. */
  stopCloid: string | null;
  /** Trigger price of that stop. Null when unprotected. */
  stopPx: string | null;
  closedAt: number | null;
  exitPx: string | null;
  pnl: string | null;
  fees: string | null;
  /** Sequence assigned when written to the ledger. Null until recorded. */
  recordedSequence: number | null;
  recordedArweaveId: string | null;
};

export class ExecutionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL"); // Execution state must survive power loss.
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision (
        id            TEXT PRIMARY KEY,
        at            INTEGER NOT NULL,
        asset         TEXT NOT NULL,
        action        TEXT NOT NULL,
        conviction    REAL NOT NULL,
        expected_move REAL NOT NULL,
        audit_json    TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        reasoning_arweave_id TEXT,
        outcome       TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS intent (
        cloid          TEXT PRIMARY KEY,
        decision_id    TEXT NOT NULL,
        asset          TEXT NOT NULL,
        side           TEXT NOT NULL,
        price          TEXT NOT NULL,
        size           TEXT NOT NULL,
        reduce_only    INTEGER NOT NULL,
        tif            TEXT NOT NULL,
        attempt        INTEGER NOT NULL,
        status         TEXT NOT NULL,
        venue_order_id TEXT,
        filled_size    TEXT NOT NULL DEFAULT '0',
        avg_fill_px    TEXT,
        fee            TEXT NOT NULL DEFAULT '0',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        detail         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_intent_status ON intent(status);
      CREATE INDEX IF NOT EXISTS idx_intent_decision ON intent(decision_id);

      CREATE TABLE IF NOT EXISTS position (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        asset         TEXT NOT NULL,
        decision_id   TEXT NOT NULL,
        reasoning_id  TEXT,
        side          TEXT NOT NULL,
        size          TEXT NOT NULL,
        entry_px      TEXT NOT NULL,
        opened_at     INTEGER NOT NULL,
        stop_cloid    TEXT,
        stop_px       TEXT,
        closed_at     INTEGER,
        exit_px       TEXT,
        pnl           TEXT,
        fees          TEXT,
        recorded_sequence   INTEGER,
        recorded_arweave_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_position_open ON position(closed_at);
    `);

    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
    // so a column added after a database is in the field needs this. Cheap,
    // idempotent, and it runs before anything reads the column.
    for (const [table, column, type] of [["position", "stop_px", "TEXT"]] as const) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }

  /** Persisted before the model result is acted on, so nothing is lost on a crash. */
  saveDecision(d: {
    id: string;
    at: number;
    asset: string;
    action: string;
    conviction: number;
    expectedMove: number;
    auditJson: string;
    decisionJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decision
           (id, at, asset, action, conviction, expected_move, audit_json, decision_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.at, d.asset, d.action, d.conviction, d.expectedMove, d.auditJson, d.decisionJson);
  }

  setReasoningId(decisionId: string, arweaveId: string): void {
    this.db
      .prepare(`UPDATE decision SET reasoning_arweave_id = ? WHERE id = ?`)
      .run(arweaveId, decisionId);
  }

  setDecisionOutcome(decisionId: string, outcome: string): void {
    this.db.prepare(`UPDATE decision SET outcome = ? WHERE id = ?`).run(outcome, decisionId);
  }

  /** Written before the order is sent. The ordering is the whole point. */
  createIntent(i: Omit<StoredIntent, "status" | "venueOrderId" | "filledSize" | "avgFillPx" | "fee" | "updatedAt" | "detail">): void {
    this.db
      .prepare(
        `INSERT INTO intent
           (cloid, decision_id, asset, side, price, size, reduce_only, tif, attempt,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
      )
      .run(
        i.cloid, i.decisionId, i.asset, i.side, i.price, i.size,
        i.reduceOnly ? 1 : 0, i.tif, i.attempt, i.createdAt, i.createdAt,
      );
  }

  updateIntent(
    cloid: string,
    patch: Partial<Pick<StoredIntent, "status" | "venueOrderId" | "filledSize" | "avgFillPx" | "fee" | "detail">>,
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [Date.now()];
    const map: Record<string, string> = {
      status: "status",
      venueOrderId: "venue_order_id",
      filledSize: "filled_size",
      avgFillPx: "avg_fill_px",
      fee: "fee",
      detail: "detail",
    };
    for (const [key, column] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[key];
      if (v !== undefined) {
        sets.push(`${column} = ?`);
        values.push(v as string | number | null);
      }
    }
    values.push(cloid);
    this.db.prepare(`UPDATE intent SET ${sets.join(", ")} WHERE cloid = ?`).run(...values);
  }

  getIntent(cloid: string): StoredIntent | undefined {
    const r = this.db.prepare(`SELECT * FROM intent WHERE cloid = ?`).get(cloid) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToIntent(r) : undefined;
  }

  /** Intents that were never resolved — the crash-recovery set. */
  unresolvedIntents(): StoredIntent[] {
    return (
      this.db
        .prepare(`SELECT * FROM intent WHERE status IN ('intended','placed') ORDER BY created_at`)
        .all() as Record<string, unknown>[]
    ).map(rowToIntent);
  }

  openPosition(p: Omit<StoredPosition, "id" | "closedAt" | "exitPx" | "pnl" | "recordedSequence" | "recordedArweaveId" | "stopPx">): number {
    const info = this.db
      .prepare(
        `INSERT INTO position
           (asset, decision_id, reasoning_id, side, size, entry_px, opened_at, stop_cloid, fees)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.asset, p.decisionId, p.reasoningId, p.side, p.size, p.entryPx, p.openedAt,
           p.stopCloid, p.fees ?? "0");
    return Number(info.lastInsertRowid);
  }

  /** The reasoning record written before this decision's order was placed. */
  reasoningIdFor(decisionId: string): string | null {
    const r = this.db
      .prepare(`SELECT reasoning_arweave_id AS id FROM decision WHERE id = ?`)
      .get(decisionId) as { id: string | null } | undefined;
    return r?.id ?? null;
  }

  /**
   * The open position a resting stop belongs to.
   *
   * A triggered stop arrives as a fill whose cloid is the stop's, not the
   * entry's, so without this lookup a stop fill is indistinguishable from an
   * unknown position — the one finding that halts the agent.
   */
  positionByStopCloid(stopCloid: string): StoredPosition | undefined {
    const r = this.db
      .prepare(`SELECT * FROM position WHERE stop_cloid = ? AND closed_at IS NULL`)
      .get(stopCloid) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : undefined;
  }

  /**
   * Averages a further fill into an open position.
   *
   * She scales into a level rather than taking it in one order, so a second
   * fill on the same side is an addition, not a second position. Inserting a
   * second row would make `positionByAsset` ambiguous and double-count the
   * notional the guard sees.
   */
  resizePosition(positionId: number, next: { size: string; entryPx: string; fees: string }): void {
    this.db
      .prepare(`UPDATE position SET size = ?, entry_px = ?, fees = ? WHERE id = ?`)
      .run(next.size, next.entryPx, next.fees, positionId);
  }

  /**
   * Records the stop resting at the venue.
   *
   * The trigger price is stored alongside the id because the id alone cannot
   * answer the only question anyone asks of a position — how much of this is
   * at risk. Reconstructing it later would mean re-deriving a number the venue
   * already accepted, which is a different number the moment sizing changes.
   */
  attachStop(positionId: number, stopCloid: string, stopPx: string | null): void {
    this.db
      .prepare(`UPDATE position SET stop_cloid = ?, stop_px = ? WHERE id = ?`)
      .run(stopCloid, stopPx, positionId);
  }

  closePosition(
    positionId: number,
    close: { closedAt: number; exitPx: string; pnl: string; fees: string },
  ): void {
    this.db
      .prepare(`UPDATE position SET closed_at = ?, exit_px = ?, pnl = ?, fees = ? WHERE id = ?`)
      .run(close.closedAt, close.exitPx, close.pnl, close.fees, positionId);
  }

  markRecorded(positionId: number, sequence: number, arweaveId: string): void {
    this.db
      .prepare(`UPDATE position SET recorded_sequence = ?, recorded_arweave_id = ? WHERE id = ?`)
      .run(sequence, arweaveId, positionId);
  }

  openPositions(): StoredPosition[] {
    return (
      this.db.prepare(`SELECT * FROM position WHERE closed_at IS NULL`).all() as Record<string, unknown>[]
    ).map(rowToPosition);
  }

  /**
   * Closed positions not yet on the ledger.
   *
   * A trade that closed but was never recorded is a hole in the record, so this
   * list is drained on every loop rather than only on the happy path.
   */
  unrecordedClosures(): StoredPosition[] {
    return (
      this.db
        .prepare(`SELECT * FROM position WHERE closed_at IS NOT NULL AND recorded_arweave_id IS NULL ORDER BY closed_at`)
        .all() as Record<string, unknown>[]
    ).map(rowToPosition);
  }

  /**
   * Realised pnl and fees, split either side of a moment.
   *
   * The daily breaker needs the equity the session *opened* with, which is not
   * a number any venue reports — it has to be reconstructed from what closed
   * before today. Getting this from `equityUsd()` at the time of the call is
   * what made the breaker measure zero drawdown forever.
   */
  realisedAround(sinceMs: number): { beforePnl: number; beforeFees: number; sincePnl: number; sinceFees: number } {
    const q = (where: string) =>
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CAST(pnl AS REAL)), 0) AS p,
                  COALESCE(SUM(CAST(fees AS REAL)), 0) AS f
             FROM position WHERE closed_at IS NOT NULL AND ${where}`,
        )
        .get(sinceMs) as { p: number; f: number };
    const before = q("closed_at < ?");
    const since = q("closed_at >= ?");
    return { beforePnl: before.p, beforeFees: before.f, sincePnl: since.p, sinceFees: since.f };
  }

  positionByAsset(asset: string): StoredPosition | undefined {
    const r = this.db
      .prepare(`SELECT * FROM position WHERE asset = ? AND closed_at IS NULL`)
      .get(asset) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

function rowToIntent(r: Record<string, unknown>): StoredIntent {
  return {
    cloid: r.cloid as string,
    decisionId: r.decision_id as string,
    asset: r.asset as string,
    side: r.side as "long" | "short",
    price: r.price as string,
    size: r.size as string,
    reduceOnly: Boolean(r.reduce_only),
    tif: r.tif as string,
    attempt: r.attempt as number,
    status: r.status as IntentStatus,
    venueOrderId: (r.venue_order_id as string) ?? null,
    filledSize: r.filled_size as string,
    avgFillPx: (r.avg_fill_px as string) ?? null,
    fee: r.fee as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    detail: (r.detail as string) ?? null,
  };
}

function rowToPosition(r: Record<string, unknown>): StoredPosition {
  return {
    id: r.id as number,
    asset: r.asset as string,
    decisionId: r.decision_id as string,
    reasoningId: (r.reasoning_id as string) ?? null,
    side: r.side as "long" | "short",
    size: r.size as string,
    entryPx: r.entry_px as string,
    openedAt: r.opened_at as number,
    stopCloid: (r.stop_cloid as string) ?? null,
    stopPx: (r.stop_px as string) ?? null,
    closedAt: (r.closed_at as number) ?? null,
    exitPx: (r.exit_px as string) ?? null,
    pnl: (r.pnl as string) ?? null,
    fees: (r.fees as string) ?? null,
    recordedSequence: (r.recorded_sequence as number) ?? null,
    recordedArweaveId: (r.recorded_arweave_id as string) ?? null,
  };
}
