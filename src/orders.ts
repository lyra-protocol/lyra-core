/**
 * Orders, and the enforcement of maker-only execution.
 *
 * ── Why this file is shaped the way it is ────────────────────────────────────
 *
 * The entire economics of the strategy rest on one number. Hyperliquid charges
 * 4.5 bps to take and 1.5 bps to make. At 1% average moves that is the
 * difference between needing a 56% win rate and needing 51.5% — 4.5 percentage
 * points, which is more edge than any amount of cleverness will produce
 * (DESIGN.md §3.7).
 *
 * So a single accidental market order is not a small cost overrun. It is a 3x
 * fee event, and a code path that "falls back to crossing when the limit does
 * not fill" would quietly convert the whole strategy into a losing one while
 * every dashboard still looked fine.
 *
 * A runtime `if (order.tif !== "Alo") throw` is not enough, because it can be
 * forgotten at the one call site that matters. Instead:
 *
 *   1. `ApprovedOrder` carries a private symbol brand. It cannot be constructed
 *      outside this module — not with a cast, not with an object literal.
 *   2. The execution layer accepts *only* `ApprovedOrder`.
 *   3. The only way to obtain one is `approveMaker()` or `approveCrossing()`,
 *      and the second demands an explicit, enumerated reason that is recorded.
 *
 * The result: crossing the spread is still possible — it must be, for a stop —
 * but it is impossible to do *by accident*, and impossible to do *silently*.
 */

import type { Side } from "./types.js";

/** Hyperliquid time-in-force values. */
export type Tif = "Alo" | "Ioc" | "Gtc";

/**
 * Fee rates in basis points, from the venue's live schedule (measured
 * 2026-08-02, base tier, no referral or staking discount).
 */
export const FEE_BPS = { maker: 1.5, taker: 4.5 } as const;

/**
 * The only reasons crossing the spread is permitted.
 *
 * Every one is a case where *not* filling costs more than the extra 3 bps.
 * There is deliberately no `"did_not_fill"` member: an unfilled maker order is
 * re-priced, never escalated to a taker, because that is the exact leak this
 * module exists to prevent.
 */
export type CrossingReason =
  /** A stop must fill. Paying 4.5 bps beats holding a position past its stop. */
  | "stop_loss"
  /** Margin is close enough to liquidation that the venue will do it for us, worse. */
  | "liquidation_avoidance"
  /** Kill switch or daily breaker: flatten now, argue about fees later. */
  | "emergency_flatten";

export type OrderIntent = {
  asset: string;
  side: Side;
  /** Decimal string. Never a float — see the note on precision below. */
  price: string;
  /** Decimal string, in base units of the asset. */
  size: string;
  reduceOnly: boolean;
  /**
   * Deterministic client order id, 128-bit hex.
   *
   * Derived from the decision that produced the order, so a retry after a
   * timeout re-sends the *same* id and the venue de-duplicates it. Without this,
   * a network hiccup during a fill turns one intended position into two real
   * ones. Mirrors the sequence idempotency in `lyra-record`.
   */
  cloid: string;
};

/** Best bid and ask, as strings, exactly as the venue published them. */
export type TopOfBook = {
  asset: string;
  bid: string;
  ask: string;
  /** When the venue stamped it. Staleness is checked by the guard, not here. */
  ts: number;
};

const APPROVED = Symbol("lyra.approved");

/**
 * An order that has passed the hot path and may be sent to the venue.
 *
 * The brand is a private symbol, so this type cannot be produced anywhere else
 * in the codebase. `as ApprovedOrder` does not work: the symbol is not exported.
 */
export type ApprovedOrder = OrderIntent & {
  readonly [APPROVED]: true;
  readonly tif: Tif;
  readonly feeBps: number;
  /** Present only when the spread is being crossed deliberately. */
  readonly crossingReason?: CrossingReason;
};

export class MakerViolation extends Error {
  constructor(
    message: string,
    readonly intent: OrderIntent,
    readonly book: TopOfBook,
  ) {
    super(message);
    this.name = "MakerViolation";
  }
}

/**
 * Approves a maker order, or refuses.
 *
 * Two things are checked, and both matter:
 *
 * **1. It must not cross.** Hyperliquid's ALO flag means the venue *cancels* an
 * order that would cross rather than converting it to a taker — so a crossing
 * ALO order cannot cost taker fees, but it also cannot fill, and a strategy that
 * keeps emitting them silently stops trading. Catching it here turns a silent
 * non-fill into a re-price.
 *
 * A buy must be strictly below the best ask; a sell strictly above the best bid.
 * Equality crosses: an order at exactly the opposing top of book matches it.
 *
 * **2. The comparison is exact.** Prices are compared as scaled integers rather
 * than floats. `0.1 + 0.2 !== 0.3` in binary floating point, and a rounding
 * error of one tick in the wrong direction is precisely the case this guard
 * exists to catch.
 */
export function approveMaker(intent: OrderIntent, book: TopOfBook): ApprovedOrder {
  if (intent.asset !== book.asset) {
    throw new MakerViolation(
      `order is for ${intent.asset} but the book is for ${book.asset}`,
      intent,
      book,
    );
  }

  const price = parseDecimal(intent.price, "price");
  const size = parseDecimal(intent.size, "size");
  if (size.neg || size.isZero) {
    throw new MakerViolation(`size must be positive, got ${intent.size}`, intent, book);
  }

  const bid = parseDecimal(book.bid, "bid");
  const ask = parseDecimal(book.ask, "ask");

  if (intent.side === "long") {
    if (compare(price, ask) >= 0) {
      throw new MakerViolation(
        `a buy at ${intent.price} would cross the ask at ${book.ask}. ` +
          `Hyperliquid cancels a crossing ALO order rather than filling it, so this ` +
          `would not trade. Re-price below the ask — never escalate to a taker.`,
        intent,
        book,
      );
    }
  } else if (compare(price, bid) <= 0) {
    throw new MakerViolation(
      `a sell at ${intent.price} would cross the bid at ${book.bid}. ` +
        `Hyperliquid cancels a crossing ALO order rather than filling it, so this ` +
        `would not trade. Re-price above the bid — never escalate to a taker.`,
      intent,
      book,
    );
  }

  return brand(intent, "Alo", FEE_BPS.maker);
}

/**
 * Approves an order that will cross the spread.
 *
 * Requires an enumerated reason, which is recorded on the order and travels into
 * the audit trail. Every legitimate use is an exit under duress; there is no
 * reason value that means "the maker order did not fill".
 *
 * Uses IOC rather than GTC: if it cannot fill now, a resting taker order is not
 * what was wanted, and leaving one behind would keep paying to be wrong.
 */
export function approveCrossing(
  intent: OrderIntent,
  reason: CrossingReason,
): ApprovedOrder {
  if (!intent.reduceOnly) {
    // Every legitimate crossing is an exit. Crossing to *open* would mean paying
    // 4.5 bps to enter a position nobody was forcing us into.
    throw new MakerViolation(
      `crossing the spread is only permitted to reduce a position (reason: ${reason}), ` +
        `but this order is not reduce-only`,
      intent,
      { asset: intent.asset, bid: "0", ask: "0", ts: Date.now() },
    );
  }
  return brand(intent, "Ioc", FEE_BPS.taker, reason);
}

function brand(
  intent: OrderIntent,
  tif: Tif,
  feeBps: number,
  crossingReason?: CrossingReason,
): ApprovedOrder {
  return Object.freeze({
    ...intent,
    [APPROVED]: true as const,
    tif,
    feeBps,
    ...(crossingReason ? { crossingReason } : {}),
  }) as ApprovedOrder;
}

/** Round-trip cost in basis points, used by the turnover budget. */
export function roundTripBps(entry: ApprovedOrder, exit: ApprovedOrder): number {
  return entry.feeBps + exit.feeBps;
}

/* ── exact decimal comparison ─────────────────────────────────────────────────
 *
 * Small and self-contained on purpose. Comparing two prices is the only decimal
 * operation this module needs, and doing it by scaling to a common exponent as
 * BigInt is both exact and obvious. Anything involving arithmetic on money uses
 * decimal.js elsewhere; nothing here needs it.
 */

type Dec = { digits: bigint; scale: number; neg: boolean; isZero: boolean };

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function parseDecimal(value: string, label: string): Dec {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new TypeError(
      `${label} must be a decimal string, got ${JSON.stringify(value)}. ` +
        `Numbers are rejected: a float cannot represent a price exactly.`,
    );
  }
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const dot = body.indexOf(".");
  const digitsText = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot === -1 ? 0 : body.length - dot - 1;
  const digits = BigInt(digitsText);
  return { digits, scale, neg, isZero: digits === 0n };
}

/** −1, 0 or 1. Exact: no floating point anywhere in the comparison. */
export function compare(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const av = (a.neg ? -a.digits : a.digits) * 10n ** BigInt(scale - a.scale);
  const bv = (b.neg ? -b.digits : b.digits) * 10n ** BigInt(scale - b.scale);
  return av === bv ? 0 : av < bv ? -1 : 1;
}
