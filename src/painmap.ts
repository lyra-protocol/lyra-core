/**
 * The Pain Map.
 *
 * Reconstructs, from enumerated on-chain positions, how much money the crowd is
 * currently losing on an asset and at what price it capitulates.
 *
 * Every sentiment measure in existence — funding rate, long/short ratio,
 * put/call — is a *proxy*, because on ordinary venues the real quantity is
 * unobservable. Hyperliquid publishes the counterparties of every trade and the
 * full position of any address, so here the real quantity can be enumerated
 * rather than estimated (DESIGN.md §3.8).
 *
 * ── On numbers in this file ─────────────────────────────────────────────────
 *
 * Aggregates are computed as JS numbers, which is a deliberate exception to the
 * decimal-strings rule. These are *statistics over a sample* used to decide
 * whether a setup exists — they are never recorded to the ledger, never paid out
 * and never displayed as a fill price. Anything that reaches the record keeps the
 * venue's own strings all the way through (`lyra-record` INTEGRATION.md).
 *
 * What is preserved exactly: every position cited to the model carries its
 * original strings and its address, so a claim can always be traced back to the
 * row it came from.
 */

import type { DatabaseSync } from "node:sqlite";

/** One enumerated position, with the venue's own strings intact. */
export type EnumeratedPosition = {
  addr: string;
  coin: string;
  /** Signed size. Positive is long, negative is short. Venue string. */
  szi: string;
  entryPx: string | null;
  liquidationPx: string | null;
  unrealizedPnl: string;
  leverage: string | null;
  positionValue: string;
  lastSeenTs: number;
};

/** A price level at which a measurable amount of forced flow would occur. */
export type ForcedLevel = {
  /** Distance from mid as a percentage. Negative is below. */
  pctFromMid: number;
  /** Notional that becomes a forced market order if price reaches here. */
  notionalUsd: number;
  positions: number;
  /**
   * Which way the forced flow goes.
   *
   * Longs are liquidated *below* spot and must SELL. Shorts are liquidated
   * *above* spot and must BUY. Getting this backwards inverts the entire
   * conclusion — it is the exact error the model made when the schema let it
   * skip the step (DESIGN.md §4.1).
   */
  direction: "forced_sells" | "forced_buys";
};

export type PainMap = {
  coin: string;
  /** Mid price used for every relative calculation, as the venue published it. */
  midPx: string;
  computedAt: number;

  positionsEnumerated: number;
  longs: { count: number; notionalUsd: number; unrealizedPnlUsd: number };
  shorts: { count: number; notionalUsd: number; unrealizedPnlUsd: number };

  /** Negative means the crowd is underwater. */
  aggregateUnrealizedPnlUsd: number;
  /**
   * Which side holds the loss.
   *
   * The single most important field: it determines whether forced flow is
   * buying or selling, and therefore which direction a squeeze runs.
   */
  losingSide: "longs" | "shorts" | "neither";
  meanLeverage: number;

  /** Forced-supply curve, nearest levels first. */
  forcedLevels: ForcedLevel[];

  /**
   * Share of enumerated notional held by the largest position.
   *
   * One whale and ten thousand retail accounts behave completely differently at
   * the same notional: a single holder can choose to close, a crowd cannot
   * coordinate. High concentration makes the map a statement about one actor.
   */
  concentration: number;
  largest: EnumeratedPosition[];

  /** How much of the venue's open interest this sample actually covers. */
  coverage: {
    enumeratedNotionalUsd: number;
    venueOpenInterestUsd: number | null;
    fraction: number | null;
    /** Positions whose data is older than the freshness bound. */
    staleCount: number;
  };
};

export type PainMapOptions = {
  /** Ignore positions not re-confirmed within this window. Default 10 minutes. */
  maxAgeMs?: number;
  /** Only report forced levels within this distance of mid. Default 15%. */
  maxDistancePct?: number;
  /** Bucket width for the forced-supply curve, in percent. Default 0.5. */
  bucketPct?: number;
  /** How many of the largest positions to carry through to the model. Default 5. */
  largestCount?: number;
  /** Venue open interest in USD, for the coverage figure. */
  venueOpenInterestUsd?: number | null;
};

const DEFAULTS = {
  maxAgeMs: 10 * 60_000,
  maxDistancePct: 15,
  bucketPct: 0.5,
  largestCount: 5,
} as const;

/**
 * Builds the Pain Map for one asset from the harvested position table.
 *
 * Reads `position_current`, which holds the latest state per (address, coin)
 * with `last_seen_ts` proving the position was still there at that moment.
 */
export function buildPainMap(
  db: DatabaseSync,
  coin: string,
  midPx: string,
  options: PainMapOptions = {},
): PainMap {
  const opts = { ...DEFAULTS, ...options };
  const now = Date.now();
  const mid = Number(midPx);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`midPx must be a positive decimal string, got ${JSON.stringify(midPx)}`);
  }

  const rows = db
    .prepare(
      `SELECT addr, coin, szi, entry_px, liquidation_px, unrealized_pnl,
              leverage, position_value, last_seen_ts
       FROM position_current
       WHERE coin = ? AND szi != '0'`,
    )
    .all(coin) as {
    addr: string;
    coin: string;
    szi: string;
    entry_px: string | null;
    liquidation_px: string | null;
    unrealized_pnl: string;
    leverage: string | null;
    position_value: string;
    last_seen_ts: number;
  }[];

  const fresh: EnumeratedPosition[] = [];
  let staleCount = 0;

  for (const r of rows) {
    if (now - r.last_seen_ts > opts.maxAgeMs) {
      // A position last confirmed an hour ago may well be closed. Counting it
      // would inflate the map with flow that no longer exists.
      staleCount++;
      continue;
    }
    fresh.push({
      addr: r.addr,
      coin: r.coin,
      szi: r.szi,
      entryPx: r.entry_px,
      liquidationPx: r.liquidation_px,
      unrealizedPnl: r.unrealized_pnl,
      leverage: r.leverage,
      positionValue: r.position_value,
      lastSeenTs: r.last_seen_ts,
    });
  }

  const longs = { count: 0, notionalUsd: 0, unrealizedPnlUsd: 0 };
  const shorts = { count: 0, notionalUsd: 0, unrealizedPnlUsd: 0 };
  let leverageSum = 0;
  let leverageCount = 0;

  for (const p of fresh) {
    const size = Number(p.szi);
    const notional = Math.abs(Number(p.positionValue));
    const pnl = Number(p.unrealizedPnl);
    if (!Number.isFinite(notional) || !Number.isFinite(pnl)) continue;

    const bucket = size > 0 ? longs : shorts;
    bucket.count++;
    bucket.notionalUsd += notional;
    bucket.unrealizedPnlUsd += pnl;

    const lev = Number(p.leverage);
    if (Number.isFinite(lev) && lev > 0) {
      leverageSum += lev;
      leverageCount++;
    }
  }

  const aggregate = longs.unrealizedPnlUsd + shorts.unrealizedPnlUsd;

  // Which side is losing is decided by which side actually holds the loss, not
  // by which is larger. A big profitable side and a small drowning one is a
  // different market from the reverse.
  let losingSide: PainMap["losingSide"] = "neither";
  if (longs.unrealizedPnlUsd < 0 && longs.unrealizedPnlUsd < shorts.unrealizedPnlUsd) {
    losingSide = "longs";
  } else if (shorts.unrealizedPnlUsd < 0 && shorts.unrealizedPnlUsd < longs.unrealizedPnlUsd) {
    losingSide = "shorts";
  }

  const enumeratedNotional = longs.notionalUsd + shorts.notionalUsd;
  const sorted = [...fresh].sort(
    (a, b) => Math.abs(Number(b.positionValue)) - Math.abs(Number(a.positionValue)),
  );
  const largestNotional = sorted.length > 0 ? Math.abs(Number(sorted[0]!.positionValue)) : 0;

  return {
    coin,
    midPx,
    computedAt: now,
    positionsEnumerated: fresh.length,
    longs,
    shorts,
    aggregateUnrealizedPnlUsd: aggregate,
    losingSide,
    meanLeverage: leverageCount > 0 ? leverageSum / leverageCount : 0,
    forcedLevels: buildForcedCurve(fresh, mid, opts.maxDistancePct, opts.bucketPct),
    concentration: enumeratedNotional > 0 ? largestNotional / enumeratedNotional : 0,
    largest: sorted.slice(0, opts.largestCount),
    coverage: {
      enumeratedNotionalUsd: enumeratedNotional,
      venueOpenInterestUsd: opts.venueOpenInterestUsd ?? null,
      fraction:
        opts.venueOpenInterestUsd && opts.venueOpenInterestUsd > 0
          ? enumeratedNotional / opts.venueOpenInterestUsd
          : null,
      staleCount,
    },
  };
}

/**
 * The forced-supply curve.
 *
 * For each price bucket, the notional that becomes a forced market order if
 * price reaches it. Summed from actual liquidation prices — not modelled from
 * open interest and an assumed leverage distribution, which is what every
 * liquidation heatmap does because on other venues the real prices do not exist.
 */
function buildForcedCurve(
  positions: EnumeratedPosition[],
  mid: number,
  maxDistancePct: number,
  bucketPct: number,
): ForcedLevel[] {
  const buckets = new Map<number, { notionalUsd: number; positions: number; isLong: boolean }>();

  for (const p of positions) {
    if (!p.liquidationPx) continue;
    const liq = Number(p.liquidationPx);
    const notional = Math.abs(Number(p.positionValue));
    const size = Number(p.szi);
    if (!Number.isFinite(liq) || liq <= 0 || !Number.isFinite(notional) || notional <= 0) continue;

    const pct = ((liq - mid) / mid) * 100;
    if (Math.abs(pct) > maxDistancePct) continue;

    // Snap toward mid so a bucket never claims flow nearer than it really is.
    const key = Math.trunc(pct / bucketPct) * bucketPct;
    const existing = buckets.get(key);
    if (existing) {
      existing.notionalUsd += notional;
      existing.positions++;
    } else {
      buckets.set(key, { notionalUsd: notional, positions: 1, isLong: size > 0 });
    }
  }

  return [...buckets.entries()]
    .map(([pctFromMid, b]) => ({
      pctFromMid,
      notionalUsd: b.notionalUsd,
      positions: b.positions,
      // Longs liquidate below and must sell; shorts liquidate above and must buy.
      direction: (pctFromMid < 0 ? "forced_sells" : "forced_buys") as ForcedLevel["direction"],
    }))
    .sort((a, b) => Math.abs(a.pctFromMid) - Math.abs(b.pctFromMid));
}

/**
 * Nearest forced level of meaningful size, in either direction.
 *
 * Used by the materiality gate: price approaching real forced flow is one of the
 * few things worth waking the model for.
 */
export function nearestCluster(map: PainMap, minNotionalUsd: number): ForcedLevel | null {
  return map.forcedLevels.find((l) => l.notionalUsd >= minNotionalUsd) ?? null;
}
