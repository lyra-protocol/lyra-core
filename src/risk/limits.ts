/**
 * Hard limits.
 *
 * These live in code, not in a config file. A config file is something that can
 * be wrong at three in the morning with nobody watching, and the whole point of
 * these numbers is that they hold when nobody is watching (DESIGN.md §2.1).
 *
 * Changing any of them changes `strategy_id`, so the ledger shows the seam.
 */

export type Limits = {
  /**
   * Daily loss limit, as a fraction of session-start equity.
   *
   * Set to 7% deliberately. Measured venue-average leverage on the day of
   * writing was 27x, at which a 3.7% adverse move is a total loss — so this is
   * roughly two such moves of headroom, not a timid number.
   *
   * Measured from **session start, not from intraday peak.** Giving back part of
   * a gain is not the failure mode this exists to stop. The failure mode is the
   * doom loop: a loss motivating a larger bet to recover it. Peak-to-trough
   * measurement would halt a profitable session for being volatile, which is a
   * different and worse rule.
   */
  maxDailyLossFraction: number;

  /** Largest single position, as a fraction of equity. */
  maxPositionFraction: number;

  /** Largest total exposure across all positions, as a fraction of equity. */
  maxTotalExposureFraction: number;

  /**
   * Most positions open at once.
   *
   * Bounded by the universe (8–12 assets) and by the finding that 15 crypto
   * perps amount to ~1.6 independent bets. More positions here would be the
   * same trade repeated, paying fees each time.
   */
  maxOpenPositions: number;

  /** Most exposure in any single asset, as a fraction of equity. */
  maxPerAssetFraction: number;

  /**
   * Daily fee budget, as a fraction of equity.
   *
   * Turnover is a resource, not a free action. At 10 taker trades a day on a
   * $300 account, fees alone are 36% of the account per month.
   */
  maxDailyFeeFraction: number;

  /** Daily inference spend, in USD. Breach is a risk event like any other. */
  maxDailyInferenceUsd: number;

  /**
   * Oldest acceptable book before new positions are blocked.
   *
   * Hyperliquid publishes `l2Book` every 0.5s with `fast: true`. Four seconds
   * means several missed updates — enough that the book on hand may no longer
   * describe the market. Trading a frozen book is worse than not trading.
   */
  maxBookAgeMs: number;

  /**
   * Smallest expected move worth trading, as a fraction.
   *
   * Below this the round-trip fee dominates the edge and the trade is being made
   * for the venue's benefit. At maker pricing a 0.5% move costs 3 bps in fees —
   * already 6% of the move.
   */
  minExpectedMove: number;

  /** Refuse to act on a decision older than this. */
  maxDecisionAgeMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxDailyLossFraction: 0.07,
  maxPositionFraction: 0.25,
  maxTotalExposureFraction: 1.0,
  maxOpenPositions: 4,
  maxPerAssetFraction: 0.25,
  maxDailyFeeFraction: 0.005,
  maxDailyInferenceUsd: 2.0,
  maxBookAgeMs: 4_000,
  minExpectedMove: 0.005,
  maxDecisionAgeMs: 10_000,
};

/**
 * Sanity check on the limits themselves.
 *
 * A typo that turns 0.07 into 0.7 would not fail any test and would not be
 * visible in a log — it would simply mean the breaker never fires. So the limits
 * are validated at startup and refuse to load if they are not internally
 * coherent.
 */
export function validateLimits(l: Limits): void {
  const problems: string[] = [];

  const fraction = (name: keyof Limits, max: number) => {
    const v = l[name] as number;
    if (!Number.isFinite(v) || v <= 0 || v > max) {
      problems.push(`${name} must be in (0, ${max}], got ${v}`);
    }
  };

  fraction("maxDailyLossFraction", 0.5);
  fraction("maxPositionFraction", 1);
  fraction("maxTotalExposureFraction", 10);
  fraction("maxPerAssetFraction", 1);
  fraction("maxDailyFeeFraction", 0.1);
  fraction("minExpectedMove", 1);

  if (!Number.isInteger(l.maxOpenPositions) || l.maxOpenPositions < 1) {
    problems.push(`maxOpenPositions must be a positive integer, got ${l.maxOpenPositions}`);
  }
  if (l.maxPositionFraction > l.maxTotalExposureFraction) {
    problems.push("maxPositionFraction cannot exceed maxTotalExposureFraction");
  }
  if (l.maxPerAssetFraction > l.maxTotalExposureFraction) {
    problems.push("maxPerAssetFraction cannot exceed maxTotalExposureFraction");
  }
  if (l.maxBookAgeMs < 500) {
    problems.push("maxBookAgeMs below the venue's own 500ms cadence would block everything");
  }
  if (l.maxDailyInferenceUsd <= 0) {
    problems.push("maxDailyInferenceUsd must be positive");
  }

  if (problems.length > 0) {
    throw new Error(`limits are not coherent:\n  - ${problems.join("\n  - ")}`);
  }
}
