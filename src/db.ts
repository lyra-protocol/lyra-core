/**
 * The local store for harvested venue state.
 *
 * Every numeric value from the venue is stored as TEXT, exactly as Hyperliquid
 * sent it. Not as REAL, not as a JS number. A price of "63586.0" is stored as
 * "63586.0". This is the grounding rule (DESIGN.md §-1) applied at the storage
 * layer: if Lyra later reports a number, it is the venue's own bytes, never
 * something reconstructed through a float.
 *
 * SQLite is used through node:sqlite, which ships with Node 24 — so there is no
 * native compilation, which matters because production is ARM (Oracle A1).
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type PositionRow = {
  addr: string;
  coin: string;
  ts: number;
  szi: string;
  entryPx: string | null;
  liquidationPx: string | null;
  unrealizedPnl: string;
  leverage: string | null;
  leverageType: string | null;
  positionValue: string;
  marginUsed: string;
};

export type AccountRow = {
  addr: string;
  ts: number;
  accountValue: string;
  totalNtlPos: string;
  totalMarginUsed: string;
  withdrawable: string;
};

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets the read-only serve process read while core writes (DESIGN.md §7.3).
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS address (
        addr         TEXT PRIMARY KEY,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        trade_count  INTEGER NOT NULL DEFAULT 0,
        last_polled  INTEGER,
        poll_count   INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_address_poll
        ON address(last_polled ASC);

      -- One row per (address, coin) per poll where a position existed.
      CREATE TABLE IF NOT EXISTS position (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        addr           TEXT NOT NULL,
        coin           TEXT NOT NULL,
        ts             INTEGER NOT NULL,
        szi            TEXT NOT NULL,
        entry_px       TEXT,
        liquidation_px TEXT,
        unrealized_pnl TEXT NOT NULL,
        leverage       TEXT,
        leverage_type  TEXT,
        position_value TEXT NOT NULL,
        margin_used    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_position_coin_ts ON position(coin, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_position_addr_ts ON position(addr, ts DESC);

      -- Current state, one row per (addr, coin).
      --
      -- 'position' above is an append-only log of *changes*; this is the latest
      -- value. Splitting them is what keeps the dataset affordable: polling the
      -- same address every 5 minutes mostly re-reads an unchanged position, and
      -- storing those verbatim would cost ~675 MB/day of duplicates.
      --
      -- last_seen_ts is bumped on every poll even when nothing changed, so the
      -- record still proves the position existed continuously — which is the
      -- part that matters and the part that cannot be recovered later.
      CREATE TABLE IF NOT EXISTS position_current (
        addr           TEXT NOT NULL,
        coin           TEXT NOT NULL,
        first_seen_ts  INTEGER NOT NULL,
        last_seen_ts   INTEGER NOT NULL,
        last_change_ts INTEGER NOT NULL,
        szi            TEXT NOT NULL,
        entry_px       TEXT,
        liquidation_px TEXT,
        unrealized_pnl TEXT NOT NULL,
        leverage       TEXT,
        leverage_type  TEXT,
        position_value TEXT NOT NULL,
        margin_used    TEXT NOT NULL,
        PRIMARY KEY (addr, coin)
      );

      CREATE INDEX IF NOT EXISTS idx_current_coin ON position_current(coin);

      CREATE TABLE IF NOT EXISTS account (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        addr              TEXT NOT NULL,
        ts                INTEGER NOT NULL,
        account_value     TEXT NOT NULL,
        total_ntl_pos     TEXT NOT NULL,
        total_margin_used TEXT NOT NULL,
        withdrawable      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_account_addr_ts ON account(addr, ts DESC);

      -- Market context, so a snapshot can be interpreted against the price that
      -- was live when it was taken rather than the price now.
      CREATE TABLE IF NOT EXISTS mid (
        ts   INTEGER NOT NULL,
        coin TEXT NOT NULL,
        px   TEXT NOT NULL,
        PRIMARY KEY (ts, coin)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Records that an address traded. Called for both counterparties of every
   * public trade, which is how the address universe is discovered at all.
   */
  seenTrading(addr: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO address (addr, first_seen, last_seen, trade_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(addr) DO UPDATE SET
           last_seen   = excluded.last_seen,
           trade_count = address.trade_count + 1`,
      )
      .run(addr, ts, ts);
  }

  /**
   * Addresses due for a position poll, oldest first.
   *
   * NULLs sort first, so newly discovered addresses are polled before known ones
   * are refreshed — a position we have never seen is worth more than a slightly
   * staler copy of one we have.
   */
  dueForPoll(limit: number, minIntervalMs: number, now: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT addr FROM address
         WHERE last_polled IS NULL OR last_polled < ?
         ORDER BY last_polled ASC NULLS FIRST
         LIMIT ?`,
      )
      .all(now - minIntervalMs, limit) as { addr: string }[];
    return rows.map((r) => r.addr);
  }

  recordPoll(addr: string, ts: number, error?: string): void {
    this.db
      .prepare(
        `UPDATE address
         SET last_polled = ?, poll_count = poll_count + 1, last_error = ?
         WHERE addr = ?`,
      )
      .run(ts, error ?? null, addr);
  }

  /**
   * Writes positions, appending to the history log only where something changed.
   *
   * "Changed" deliberately ignores `unrealized_pnl` and `margin_used`: both move
   * with every tick of the mark price, so treating them as changes would make
   * every poll a write and defeat the point. They are recomputable from the
   * position plus the mid price, which is why `mid` is recorded separately.
   *
   * What counts as a change is the trader's *decision*: size, entry, leverage,
   * or the liquidation price. Those only move when they act or when margin
   * moves — and those are the events worth keeping forever.
   *
   * Returns how many rows were appended to the history log.
   */
  upsertPositions(rows: PositionRow[]): number {
    if (rows.length === 0) return 0;

    const prev = this.db.prepare(
      `SELECT szi, entry_px, liquidation_px, leverage, first_seen_ts
       FROM position_current WHERE addr = ? AND coin = ?`,
    );
    const appendHistory = this.db.prepare(
      `INSERT INTO position
         (addr, coin, ts, szi, entry_px, liquidation_px, unrealized_pnl,
          leverage, leverage_type, position_value, margin_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const writeCurrent = this.db.prepare(
      `INSERT INTO position_current
         (addr, coin, first_seen_ts, last_seen_ts, last_change_ts, szi, entry_px,
          liquidation_px, unrealized_pnl, leverage, leverage_type, position_value, margin_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(addr, coin) DO UPDATE SET
         last_seen_ts   = excluded.last_seen_ts,
         last_change_ts = excluded.last_change_ts,
         szi            = excluded.szi,
         entry_px       = excluded.entry_px,
         liquidation_px = excluded.liquidation_px,
         unrealized_pnl = excluded.unrealized_pnl,
         leverage       = excluded.leverage,
         leverage_type  = excluded.leverage_type,
         position_value = excluded.position_value,
         margin_used    = excluded.margin_used`,
    );
    const touch = this.db.prepare(
      `UPDATE position_current
       SET last_seen_ts = ?, unrealized_pnl = ?, position_value = ?, margin_used = ?
       WHERE addr = ? AND coin = ?`,
    );

    let appended = 0;
    for (const r of rows) {
      const before = prev.get(r.addr, r.coin) as
        | { szi: string; entry_px: string | null; liquidation_px: string | null; leverage: string | null; first_seen_ts: number }
        | undefined;

      const changed =
        !before ||
        before.szi !== r.szi ||
        before.entry_px !== r.entryPx ||
        before.liquidation_px !== r.liquidationPx ||
        before.leverage !== r.leverage;

      if (changed) {
        appendHistory.run(
          r.addr, r.coin, r.ts, r.szi, r.entryPx, r.liquidationPx,
          r.unrealizedPnl, r.leverage, r.leverageType, r.positionValue, r.marginUsed,
        );
        appended++;
        writeCurrent.run(
          r.addr, r.coin, before?.first_seen_ts ?? r.ts, r.ts, r.ts, r.szi, r.entryPx,
          r.liquidationPx, r.unrealizedPnl, r.leverage, r.leverageType, r.positionValue, r.marginUsed,
        );
      } else {
        touch.run(r.ts, r.unrealizedPnl, r.positionValue, r.marginUsed, r.addr, r.coin);
      }
    }
    return appended;
  }

  /**
   * Marks positions that have disappeared since the last poll.
   *
   * A position vanishing is one of the most informative events available — it
   * means closed or liquidated — so it must not be inferred from silence later.
   */
  closeMissing(addr: string, ts: number, stillOpen: Set<string>): number {
    const open = this.db
      .prepare(`SELECT coin FROM position_current WHERE addr = ? AND szi != '0'`)
      .all(addr) as { coin: string }[];
    const gone = open.filter((r) => !stillOpen.has(r.coin));
    if (gone.length === 0) return 0;

    const appendHistory = this.db.prepare(
      `INSERT INTO position
         (addr, coin, ts, szi, entry_px, liquidation_px, unrealized_pnl,
          leverage, leverage_type, position_value, margin_used)
       VALUES (?, ?, ?, '0', NULL, NULL, '0', NULL, NULL, '0', '0')`,
    );
    const drop = this.db.prepare(
      `DELETE FROM position_current WHERE addr = ? AND coin = ?`,
    );
    for (const r of gone) {
      appendHistory.run(addr, r.coin, ts);
      drop.run(addr, r.coin);
    }
    return gone.length;
  }

  insertAccount(row: AccountRow): void {
    this.db
      .prepare(
        `INSERT INTO account
           (addr, ts, account_value, total_ntl_pos, total_margin_used, withdrawable)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.addr, row.ts, row.accountValue, row.totalNtlPos, row.totalMarginUsed, row.withdrawable);
  }

  insertMids(ts: number, mids: Record<string, string>, universe: string[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO mid (ts, coin, px) VALUES (?, ?, ?)`,
    );
    for (const coin of universe) {
      const px = mids[coin];
      if (px !== undefined) stmt.run(ts, coin, px);
    }
  }

  stats(): {
    addresses: number;
    polled: number;
    positions: number;
    openPositions: number;
    accounts: number;
    oldestSnapshot: number | null;
  } {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get() as { n: number }).n;
    const oldest = this.db
      .prepare(`SELECT MIN(ts) AS n FROM position`)
      .get() as { n: number | null };
    return {
      addresses: one(`SELECT COUNT(*) AS n FROM address`),
      polled: one(`SELECT COUNT(*) AS n FROM address WHERE last_polled IS NOT NULL`),
      positions: one(`SELECT COUNT(*) AS n FROM position`),
      openPositions: one(`SELECT COUNT(*) AS n FROM position_current`),
      accounts: one(`SELECT COUNT(*) AS n FROM account`),
      oldestSnapshot: oldest.n,
    };
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}
