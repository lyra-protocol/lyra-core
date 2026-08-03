/**
 * Sizing and pricing. Both deterministic, both deliberately taken away from the
 * model.
 *
 * ── Why the model does not size ─────────────────────────────────────────────
 *
 * Position sizing is a formula, not a judgement. Given conviction, equity,
 * volatility and the limits there is one correct answer, and it is reproducible.
 * Letting a model emit a number that multiplies directly into risk is the
 * fastest way to die: a single misplaced decimal is a 10x position, and it would
 * arrive wrapped in confident prose.
 *
 * The model contributes exactly one input to this — conviction — and even that
 * only scales within a cap the Guard enforces afterwards.
 *
 * ── Why the model does not price ────────────────────────────────────────────
 *
 * The correct limit price is mechanical: rest inside the spread, never cross.
 * Asking a model for it creates no upside and one new way to be refused.
 */

import { compare, parseDecimal } from "../orders.js";
import type { Limits } from "../risk/limits.js";

export type SizingInputs = {
  equityUsd: number;
  /** 0–1, from the model. The only model-supplied input here. */
  conviction: number;
  /**
   * Recent volatility of the asset as a fraction, e.g. 0.02 for 2% daily.
   *
   * Higher volatility means a smaller position for the same risk. Without this,
   * the same notional in BTC and in a memecoin are wildly different bets.
   */
  volatility: number;
  /** Volatility the sizing is calibrated against. Assets at this level size normally. */
  referenceVolatility?: number;
  limits: Limits;
};

/**
 * Notional for a new position.
 *
 * ```
 * notional = equity × maxPositionFraction × conviction × volatilityScalar
 * ```
 *
 * The volatility scalar is `reference / actual`, clamped to [0.25, 1]. It can
 * shrink a position but never inflate one: a quiet asset does not justify
 * betting more than the position cap, and an unclamped scalar would let an
 * unusually calm reading produce a position larger than the limit contemplates.
 */
export function sizePosition(inputs: SizingInputs): number {
  const { equityUsd, conviction, volatility, limits } = inputs;
  const reference = inputs.referenceVolatility ?? 0.02;

  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return 0;
  if (!Number.isFinite(conviction) || conviction <= 0) return 0;

  const clampedConviction = Math.min(1, conviction);
  const scalar =
    Number.isFinite(volatility) && volatility > 0
      ? Math.min(1, Math.max(0.25, reference / volatility))
      : 0.25; // Unknown volatility is treated as the riskiest case, not the average.

  const notional = equityUsd * limits.maxPositionFraction * clampedConviction * scalar;

  // Sub-dollar positions are noise that still costs fees and a ledger entry.
  return notional < 1 ? 0 : notional;
}

export type PricingInputs = {
  side: "long" | "short";
  bid: string;
  ask: string;
  /** Smallest price increment the venue accepts for this asset. */
  tickSize: string;
};

/**
 * The limit price for a maker order.
 *
 * Joins the near side of the book rather than trying to improve on it. Stepping
 * inside by a tick would gain queue priority but risks crossing when the spread
 * is one tick wide — and a crossing ALO order is cancelled by the venue, so the
 * "improvement" would simply mean not trading.
 *
 * Returns null when the book is crossed or inverted, which is a data problem
 * rather than a trading opportunity.
 */
export function makerPrice(inputs: PricingInputs): string | null {
  const bid = parseDecimal(inputs.bid, "bid");
  const ask = parseDecimal(inputs.ask, "ask");
  if (compare(bid, ask) >= 0) return null;

  // Join the bid to buy, join the ask to sell. Both rest; neither crosses.
  return inputs.side === "long" ? inputs.bid : inputs.ask;
}

/**
 * Stop price, from the risk budget rather than from the model.
 *
 * The distance is whatever puts the loss at `riskFraction` of equity for this
 * position size — so a larger position automatically gets a tighter stop, and no
 * single trade can consume the daily breaker on its own.
 */
export function stopPrice(inputs: {
  side: "long" | "short";
  entryPx: string;
  notionalUsd: number;
  equityUsd: number;
  /** Fraction of equity to risk on this trade. */
  riskFraction: number;
  /** Never place a stop tighter than this, or noise will trigger it. */
  minDistanceFraction?: number;
}): string | null {
  const entry = Number(inputs.entryPx);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (inputs.notionalUsd <= 0 || inputs.equityUsd <= 0) return null;

  const riskUsd = inputs.equityUsd * inputs.riskFraction;
  const distanceFraction = Math.max(
    riskUsd / inputs.notionalUsd,
    inputs.minDistanceFraction ?? 0.003,
  );

  const stop =
    inputs.side === "long" ? entry * (1 - distanceFraction) : entry * (1 + distanceFraction);

  return stop > 0 ? String(stop) : null;
}
