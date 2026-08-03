/**
 * The state the hot path reasons over.
 *
 * A plain snapshot with no methods and no I/O, so `Guard` stays a pure function
 * of its inputs and can be tested exhaustively without a venue, a clock or a
 * database.
 *
 * Everything here is a number rather than a decimal string, and that is a
 * deliberate exception to the rule elsewhere in the codebase. These values are
 * only ever compared against fractional limits — never recorded, never
 * displayed, never written to the ledger. Money that reaches the record keeps
 * the venue's own strings all the way through.
 */

export type OpenPosition = {
  asset: string;
  side: "long" | "short";
  /** Absolute notional in quote currency. */
  notionalUsd: number;
  /** Entry price, as the venue reported it. */
  entryPx: string;
  /** Liquidation price, as the venue reported it, when one exists. */
  liquidationPx: string | null;
};

export type RiskState = {
  /** Current account equity, including unrealised PnL. */
  equityUsd: number;

  /**
   * Equity at the start of the session, the reference for the daily breaker.
   *
   * Sessions roll at UTC midnight. The choice matters: measuring drawdown from
   * here rather than from the intraday peak means a profitable but volatile
   * session is not halted for giving back part of a gain.
   */
  sessionStartEquityUsd: number;

  /** Sum of absolute notional across all open positions. */
  totalNotionalUsd: number;

  positions: Map<string, OpenPosition>;

  /** Assets she is permitted to trade. Deterministic, versioned, not model-chosen. */
  universe: readonly string[];

  /** Venue fees paid this session. Turnover is a budgeted resource. */
  feesPaidTodayUsd: number;

  /** Inference spend this session. Breach is a risk event like any other. */
  inferenceSpentTodayUsd: number;

  /**
   * Set by ingestion when the feed gaps or timestamps drift.
   *
   * The difference between an agent that stops when blind and one that trades a
   * frozen book.
   */
  feedDegraded: boolean;

  /** One flag, checked before everything. Halts all new risk. */
  killSwitch: boolean;
};

/** A state with nothing open — the shape at session start, and the test baseline. */
export function emptyState(
  equityUsd: number,
  universe: readonly string[],
): RiskState {
  return {
    equityUsd,
    sessionStartEquityUsd: equityUsd,
    totalNotionalUsd: 0,
    positions: new Map(),
    universe,
    feesPaidTodayUsd: 0,
    inferenceSpentTodayUsd: 0,
    feedDegraded: false,
    killSwitch: false,
  };
}

/** UTC day boundary. Used to decide when to roll the session reference. */
export function sessionKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}
