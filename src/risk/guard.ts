/**
 * The hot path.
 *
 * Every order passes through here before it can reach the venue, and nothing
 * else in the system may produce an `ApprovedOrder`. It is deterministic, does
 * no I/O, calls no model, and is a pure function of the state it is handed —
 * which is what makes it testable to exhaustion and what makes it trustworthy at
 * three in the morning.
 *
 * ── The asymmetry that makes an LLM tolerable in the decision loop ───────────
 *
 * The model chooses among permitted actions. It does not define what is
 * permitted. The hot path can veto anything the model proposes; the model can
 * never override the hot path. That single direction of authority is what allows
 * a non-deterministic component to be trusted with money at all (DESIGN.md §2.1).
 *
 * It is also why this file assumes the model will eventually produce something
 * absurd — a size ten times too large, a price from a stale book, a decision
 * about an asset that is not in the universe. Every one of those is a normal
 * input here, rejected by name, not an exceptional case.
 */

import {
  approveCrossing,
  approveMaker,
  type ApprovedOrder,
  type CrossingReason,
  type OrderIntent,
  type TopOfBook,
} from "../orders.js";
import { DEFAULT_LIMITS, validateLimits, type Limits } from "./limits.js";
import type { RiskState } from "./state.js";

/** Why an order was refused. Stable identifiers — the ledger records these. */
export type RefusalCode =
  | "kill_switch"
  | "daily_loss_breached"
  | "fee_budget_exhausted"
  | "inference_budget_exhausted"
  | "book_stale"
  | "decision_stale"
  | "asset_not_in_universe"
  | "max_positions"
  | "position_too_large"
  | "asset_exposure_too_large"
  | "total_exposure_too_large"
  | "expected_move_too_small"
  | "would_cross_spread"
  | "not_reduce_only"
  | "no_position_to_reduce"
  /** A close for this asset is already resting. A second one flips the side. */
  | "exit_already_resting"
  | "malformed";

export type Refusal = { ok: false; code: RefusalCode; detail: string };
export type Approval = { ok: true; order: ApprovedOrder };
export type GuardResult = Approval | Refusal;

export type OpenRequest = {
  intent: OrderIntent;
  book: TopOfBook;
  /** The move the decision expects, as a fraction. Checked against minExpectedMove. */
  expectedMove: number;
  /** When the decision was made. Stale decisions are refused. */
  decidedAt: number;
  /** Notional value of the order in quote currency, as a number. Sizing only. */
  notionalUsd: number;
};

export type ReduceRequest = {
  intent: OrderIntent;
  book: TopOfBook;
  decidedAt: number;
  /**
   * Set only when the position must be closed regardless of cost. Anything else
   * is a maker exit, re-priced if it would cross.
   */
  urgent?: CrossingReason;
};

export class Guard {
  constructor(
    private readonly limits: Limits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    // Refuses to construct on incoherent limits. A typo turning 0.07 into 0.7
    // would otherwise mean the breaker silently never fires.
    validateLimits(limits);
  }

  /**
   * Opening or increasing a position.
   *
   * Checks run cheapest-and-most-fatal first, so a halted system does no work
   * and the refusal reported is the most fundamental one rather than whichever
   * happened to be tested first.
   */
  approveOpen(req: OpenRequest, state: RiskState): GuardResult {
    const halted = this.checkHalts(state);
    if (halted) return halted;

    const fresh = this.checkFreshness(req.book, req.decidedAt, state);
    if (fresh) return fresh;

    if (!state.universe.includes(req.intent.asset)) {
      return refuse(
        "asset_not_in_universe",
        `${req.intent.asset} is not in the universe [${state.universe.join(", ")}]. ` +
          `The universe is deterministic and versioned; the model selects within it, ` +
          `it does not extend it.`,
      );
    }

    if (req.intent.reduceOnly) {
      return refuse("malformed", "an opening order must not be reduce-only");
    }

    if (!Number.isFinite(req.notionalUsd) || req.notionalUsd <= 0) {
      return refuse("malformed", `notionalUsd must be positive, got ${req.notionalUsd}`);
    }

    // Below this, the round-trip fee eats the move and the trade is being made
    // for the venue's benefit rather than ours.
    if (!(req.expectedMove >= this.limits.minExpectedMove)) {
      return refuse(
        "expected_move_too_small",
        `expected move ${(req.expectedMove * 100).toFixed(3)}% is below the ` +
          `${(this.limits.minExpectedMove * 100).toFixed(2)}% floor; fees would dominate the edge`,
      );
    }

    const equity = state.equityUsd;
    const existing = state.positions.get(req.intent.asset);

    if (!existing && state.positions.size >= this.limits.maxOpenPositions) {
      return refuse(
        "max_positions",
        `already holding ${state.positions.size} positions, limit ${this.limits.maxOpenPositions}`,
      );
    }

    const positionFraction = req.notionalUsd / equity;
    if (positionFraction > this.limits.maxPositionFraction) {
      return refuse(
        "position_too_large",
        `order is ${(positionFraction * 100).toFixed(1)}% of equity, limit ` +
          `${(this.limits.maxPositionFraction * 100).toFixed(1)}%`,
      );
    }

    // Per-asset exposure counts what is already on, so three separate orders
    // cannot be used to build a position larger than one order could.
    const assetAfter = (existing?.notionalUsd ?? 0) + req.notionalUsd;
    if (assetAfter / equity > this.limits.maxPerAssetFraction) {
      return refuse(
        "asset_exposure_too_large",
        `${req.intent.asset} exposure would reach ${((assetAfter / equity) * 100).toFixed(1)}% ` +
          `of equity, limit ${(this.limits.maxPerAssetFraction * 100).toFixed(1)}%`,
      );
    }

    const totalAfter = state.totalNotionalUsd + req.notionalUsd;
    if (totalAfter / equity > this.limits.maxTotalExposureFraction) {
      return refuse(
        "total_exposure_too_large",
        `total exposure would reach ${((totalAfter / equity) * 100).toFixed(1)}% of equity, ` +
          `limit ${(this.limits.maxTotalExposureFraction * 100).toFixed(1)}%`,
      );
    }

    // Last, because it is the one check that can also fail for a benign reason
    // (the book moved), and its refusal means "re-price", not "stop".
    return this.approveAsMaker(req.intent, req.book);
  }

  /**
   * Reducing or closing a position.
   *
   * Deliberately *not* subject to the halts. When the daily breaker has fired or
   * the kill switch is on, closing a position is exactly what should happen —
   * blocking exits during a halt would trap the position it was trying to
   * protect.
   */
  approveReduce(req: ReduceRequest, state: RiskState): GuardResult {
    if (!req.intent.reduceOnly) {
      return refuse(
        "not_reduce_only",
        "an exit must be reduce-only, so that a sizing bug cannot flip the position",
      );
    }

    const position = state.positions.get(req.intent.asset);
    if (!position) {
      return refuse(
        "no_position_to_reduce",
        `no open position in ${req.intent.asset}`,
      );
    }

    if (req.urgent) {
      // The only path that pays taker fees. Enumerated reason, recorded, and
      // reduce-only was already enforced above.
      return { ok: true, order: approveCrossing(req.intent, req.urgent) };
    }

    return this.approveAsMaker(req.intent, req.book);
  }

  /** Halts that stop new risk being taken. Exits are never blocked by these. */
  private checkHalts(state: RiskState): Refusal | null {
    if (state.killSwitch) {
      return refuse("kill_switch", "the kill switch is engaged; no new positions");
    }

    // Measured from session start, not from intraday peak. Giving back part of a
    // gain is not the doom loop this exists to stop.
    const drawdown = (state.sessionStartEquityUsd - state.equityUsd) / state.sessionStartEquityUsd;
    if (drawdown >= this.limits.maxDailyLossFraction) {
      return refuse(
        "daily_loss_breached",
        `down ${(drawdown * 100).toFixed(2)}% on the session, limit ` +
          `${(this.limits.maxDailyLossFraction * 100).toFixed(1)}%. No new positions until ` +
          `the next session. Exits remain permitted.`,
      );
    }

    const feeFraction = state.feesPaidTodayUsd / state.sessionStartEquityUsd;
    if (feeFraction >= this.limits.maxDailyFeeFraction) {
      return refuse(
        "fee_budget_exhausted",
        `fees today are ${(feeFraction * 100).toFixed(3)}% of equity, budget ` +
          `${(this.limits.maxDailyFeeFraction * 100).toFixed(3)}%. Turnover is a resource.`,
      );
    }

    if (state.inferenceSpentTodayUsd >= this.limits.maxDailyInferenceUsd) {
      return refuse(
        "inference_budget_exhausted",
        `inference spend today is $${state.inferenceSpentTodayUsd.toFixed(2)}, budget ` +
          `$${this.limits.maxDailyInferenceUsd.toFixed(2)}`,
      );
    }

    return null;
  }

  private checkFreshness(book: TopOfBook, decidedAt: number, state: RiskState): Refusal | null {
    const now = this.now();

    if (state.feedDegraded) {
      return refuse("book_stale", "the venue feed is flagged degraded; not trading blind");
    }

    const bookAge = now - book.ts;
    if (bookAge > this.limits.maxBookAgeMs) {
      return refuse(
        "book_stale",
        `book for ${book.asset} is ${bookAge}ms old, limit ${this.limits.maxBookAgeMs}ms`,
      );
    }

    // A decision made against a book that has since moved is a decision about a
    // market that no longer exists.
    const decisionAge = now - decidedAt;
    if (decisionAge > this.limits.maxDecisionAgeMs) {
      return refuse(
        "decision_stale",
        `decision is ${decisionAge}ms old, limit ${this.limits.maxDecisionAgeMs}ms`,
      );
    }

    return null;
  }

  /** Converts a maker violation into a refusal rather than letting it throw. */
  private approveAsMaker(intent: OrderIntent, book: TopOfBook): GuardResult {
    try {
      return { ok: true, order: approveMaker(intent, book) };
    } catch (error) {
      return refuse("would_cross_spread", (error as Error).message);
    }
  }
}

function refuse(code: RefusalCode, detail: string): Refusal {
  return { ok: false, code, detail };
}
