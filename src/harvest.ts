/**
 * The position harvester.
 *
 * Hyperliquid publishes the counterparties of every trade, and current
 * positions for any address — including the exact price at which each is
 * forcibly closed. It does **not** publish history: `clearinghouseState` is
 * current-state only, and no archive of it exists anywhere.
 *
 * So a position-history dataset can only be built by watching continuously,
 * starting whenever you start. A day not observed is a day nobody can ever
 * recover (DESIGN.md §3.9). That is why this runs before the rest of the agent
 * is finished: the clock is already running.
 *
 * Two loops, running concurrently:
 *   discover — WebSocket trade feed, collecting both counterparties of every fill
 *   poll     — rate-limited sweep of known addresses, recording their positions
 */

import WebSocket from "ws";
import { Store, type PositionRow } from "./db.js";
import {
  HyperliquidPublic,
  RateLimiter,
  isRealAddress,
  sleep,
  type ClearinghouseState,
} from "./hyperliquid.js";

const WS_URL = "wss://api.hyperliquid.xyz/ws";

export type HarvesterConfig = {
  /** Assets whose trade feeds are watched for address discovery. */
  universe: string[];
  dbPath: string;
  /** Weight per minute to spend. Venue ceiling is 1200; half leaves headroom. */
  weightPerMinute: number;
  /** Do not re-poll an address more often than this. */
  minPollIntervalMs: number;
  /** Addresses per polling batch. */
  batchSize: number;
};

export const DEFAULT_CONFIG: HarvesterConfig = {
  // Chosen for decorrelation, not popularity (DESIGN.md §3.4).
  universe: ["BTC", "ETH", "HYPE", "SOL", "PAXG", "KAITO", "XRP", "DOGE"],
  dbPath: ".lyra/venue.db",
  weightPerMinute: 600,
  minPollIntervalMs: 5 * 60_000,
  batchSize: 20,
};

export class Harvester {
  private readonly store: Store;
  private readonly api: HyperliquidPublic;
  private ws: WebSocket | null = null;
  private running = false;
  private discovered = 0;
  private polls = 0;
  private reconnects = 0;
  private changes = 0;
  private closures = 0;

  constructor(private readonly config: HarvesterConfig = DEFAULT_CONFIG) {
    this.store = new Store(config.dbPath);
    this.api = new HyperliquidPublic(RateLimiter.perMinute(config.weightPerMinute));
  }

  start(): void {
    this.running = true;
    const startedAt = this.store.getMeta("started_at");
    if (!startedAt) {
      // The single most important number in the dataset: when observation began.
      this.store.setMeta("started_at", String(Date.now()));
    }
    this.connect();
    void this.pollLoop();
    void this.midLoop();
    void this.reportLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ws?.close();
    await sleep(100);
    this.store.close();
  }

  // ── discovery ──────────────────────────────────────────────────────────────

  /**
   * The trade feed names both sides of every fill, which is the only reason the
   * address universe can be built at all. Reconnects forever: a dropped socket
   * is missing data, and missing data cannot be backfilled.
   */
  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      for (const coin of this.config.universe) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
      }
      log(`connected, watching ${this.config.universe.length} assets`);
    });

    ws.on("message", (raw: Buffer) => {
      let msg: { channel?: string; data?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.channel !== "trades" || !Array.isArray(msg.data)) return;
      for (const trade of msg.data as { time?: number; users?: string[] }[]) {
        const ts = trade.time ?? Date.now();
        for (const addr of trade.users ?? []) {
          if (!isRealAddress(addr)) continue;
          this.store.seenTrading(addr.toLowerCase(), ts);
          this.discovered++;
        }
      }
    });

    ws.on("close", () => {
      if (!this.running) return;
      this.reconnects++;
      log("socket closed, reconnecting in 2s");
      setTimeout(() => this.connect(), 2000);
    });

    ws.on("error", (err: Error) => {
      log(`socket error: ${err.message}`);
      ws.close();
    });
  }

  // ── polling ────────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const due = this.store.dueForPoll(
        this.config.batchSize,
        this.config.minPollIntervalMs,
        Date.now(),
      );
      if (due.length === 0) {
        await sleep(5_000);
        continue;
      }
      for (const addr of due) {
        if (!this.running) break;
        await this.pollOne(addr);
      }
    }
  }

  private async pollOne(addr: string): Promise<void> {
    const ts = Date.now();
    try {
      const state = await this.api.clearinghouseState(addr);
      this.persist(addr, ts, state);
      this.store.recordPoll(addr, ts);
      this.polls++;
    } catch (error) {
      // Recorded rather than thrown: one bad address must not stop the harvest.
      this.store.recordPoll(addr, ts, (error as Error).message.slice(0, 200));
    }
  }

  private persist(addr: string, ts: number, state: ClearinghouseState): void {
    const summary = state.marginSummary;
    if (summary) {
      this.store.insertAccount({
        addr,
        ts,
        accountValue: summary.accountValue,
        totalNtlPos: summary.totalNtlPos,
        totalMarginUsed: summary.totalMarginUsed,
        withdrawable: state.withdrawable,
      });
    }

    const rows: PositionRow[] = [];
    for (const entry of state.assetPositions ?? []) {
      const p = entry.position;
      if (!p || p.szi === "0.0" || p.szi === "0") continue;
      rows.push({
        addr,
        coin: p.coin,
        ts,
        // Every one of these stays a string. See db.ts.
        szi: p.szi,
        entryPx: p.entryPx ?? null,
        liquidationPx: p.liquidationPx ?? null,
        unrealizedPnl: p.unrealizedPnl,
        leverage: p.leverage?.value !== undefined ? String(p.leverage.value) : null,
        leverageType: p.leverage?.type ?? null,
        positionValue: p.positionValue,
        marginUsed: p.marginUsed,
      });
    }
    this.changes += this.store.upsertPositions(rows);
    // A position that vanished was closed or liquidated — the single most
    // informative event this dataset can capture, and one that cannot be
    // reconstructed later from anything Hyperliquid serves.
    this.closures += this.store.closeMissing(addr, ts, new Set(rows.map((r) => r.coin)));
  }

  // ── market context ─────────────────────────────────────────────────────────

  /**
   * Mid prices alongside the snapshots. Without them a position recorded today
   * cannot be interpreted in a year — "liquidation at 65501" means nothing
   * unless you know the price was 63402 at the time.
   */
  private async midLoop(): Promise<void> {
    while (this.running) {
      try {
        const mids = await this.api.allMids();
        this.store.insertMids(Date.now(), mids, this.config.universe);
      } catch {
        // Non-fatal. Positions matter more than context.
      }
      await sleep(30_000);
    }
  }

  private async reportLoop(): Promise<void> {
    while (this.running) {
      await sleep(60_000);
      if (!this.running) break;
      const s = this.store.stats();
      log(
        `addresses ${s.addresses} (${s.polled} polled) | open ${s.openPositions} | ` +
          `changes logged ${s.positions} | closures ${this.closures} | ` +
          `polls ${this.polls} | reconnects ${this.reconnects}`,
      );
    }
  }

  stats() {
    return {
      ...this.store.stats(),
      polls: this.polls,
      changes: this.changes,
      closures: this.closures,
      reconnects: this.reconnects,
    };
  }
}

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}
