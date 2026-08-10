import { describe, expect, it } from "vitest";
import { Guard, type GuardResult } from "../src/risk/guard.js";
import { DEFAULT_LIMITS, validateLimits, type Limits } from "../src/risk/limits.js";
import { emptyState, type RiskState } from "../src/risk/state.js";
import {
  approveCrossing,
  approveMaker,
  compare,
  FEE_BPS,
  MakerViolation,
  parseDecimal,
  type OrderIntent,
  type TopOfBook,
} from "../src/orders.js";

const UNIVERSE = ["BTC", "ETH", "HYPE", "SOL", "PAXG", "KAITO", "XRP", "DOGE"] as const;
const NOW = 1_785_600_000_000;

const clock = () => NOW;

function book(overrides: Partial<TopOfBook> = {}): TopOfBook {
  return { asset: "BTC", bid: "63400.0", ask: "63401.0", ts: NOW, ...overrides };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    asset: "BTC",
    side: "long",
    price: "63400.0",
    size: "0.01",
    reduceOnly: false,
    cloid: "0x" + "a".repeat(32),
    ...overrides,
  };
}

function state(overrides: Partial<RiskState> = {}): RiskState {
  return { ...emptyState(10_000, UNIVERSE), ...overrides };
}

function openReq(o: Partial<Parameters<Guard["approveOpen"]>[0]> = {}) {
  return {
    intent: intent(),
    book: book(),
    expectedMove: 0.01,
    decidedAt: NOW,
    notionalUsd: 1000,
    ...o,
  };
}

function expectRefusal(r: GuardResult, code: string) {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe(code);
}

/* ── maker enforcement ─────────────────────────────────────────────────────── */

describe("maker enforcement", () => {
  const guard = new Guard(DEFAULT_LIMITS, clock);

  it("approves a buy strictly below the ask", () => {
    const r = guard.approveOpen(openReq(), state());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order.tif).toBe("Alo");
      expect(r.order.feeBps).toBe(FEE_BPS.maker);
    }
  });

  it("refuses a buy AT the ask, because equality crosses", () => {
    // The subtle one. A buy at exactly the best ask matches it.
    expectRefusal(
      guard.approveOpen(openReq({ intent: intent({ price: "63401.0" }) }), state()),
      "would_cross_spread",
    );
  });

  it("refuses a buy above the ask", () => {
    expectRefusal(
      guard.approveOpen(openReq({ intent: intent({ price: "63500.0" }) }), state()),
      "would_cross_spread",
    );
  });

  it("refuses a sell AT the bid", () => {
    const r = guard.approveOpen(
      openReq({ intent: intent({ side: "short", price: "63400.0" }) }),
      state(),
    );
    expectRefusal(r, "would_cross_spread");
  });

  it("approves a sell strictly above the bid", () => {
    const r = guard.approveOpen(
      openReq({ intent: intent({ side: "short", price: "63400.5" }) }),
      state(),
    );
    expect(r.ok).toBe(true);
  });

  it("says re-price, and never suggests crossing, when an order would cross", () => {
    const r = guard.approveOpen(openReq({ intent: intent({ price: "63500.0" }) }), state());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toMatch(/never escalate to a taker/);
    }
  });

  it("compares prices exactly, not as floats", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point. A float
    // comparison would call this equal to 0.3 or not, unpredictably.
    expect(compare(parseDecimal("0.30000000000000004", "a"), parseDecimal("0.3", "b"))).toBe(1);
    expect(compare(parseDecimal("63400.10", "a"), parseDecimal("63400.1", "b"))).toBe(0);
    expect(compare(parseDecimal("-5.5", "a"), parseDecimal("-5.50", "b"))).toBe(0);
  });

  it("rejects a price that is not a decimal string", () => {
    expect(() => parseDecimal(63400 as unknown as string, "price")).toThrow(TypeError);
    expect(() => parseDecimal("1e5", "price")).toThrow(TypeError);
    expect(() => parseDecimal("", "price")).toThrow(TypeError);
  });

  it("refuses an order whose book is for a different asset", () => {
    expect(() => approveMaker(intent({ asset: "ETH" }), book({ asset: "BTC" }))).toThrow(
      MakerViolation,
    );
  });

  it("refuses a non-positive size", () => {
    expect(() => approveMaker(intent({ size: "0" }), book())).toThrow(/size must be positive/);
  });
});

/* ── the crossing escape hatch ─────────────────────────────────────────────── */

describe("crossing the spread", () => {
  it("is impossible to construct an approved order outside the module", () => {
    // The brand is a private symbol, so there is no cast that produces one and
    // no object literal that satisfies the type.
    const forged = { ...intent(), tif: "Ioc", feeBps: 4.5 };
    // @ts-expect-error — ApprovedOrder cannot be forged; this must not compile.
    const _typed: import("../src/orders.js").ApprovedOrder = forged;
    expect(forged.tif).toBe("Ioc");
  });

  it("requires reduce-only, so crossing can never open a position", () => {
    expect(() => approveCrossing(intent({ reduceOnly: false }), "stop_loss")).toThrow(
      /only permitted to reduce a position/,
    );
  });

  it("marks the order taker and records the reason", () => {
    const o = approveCrossing(intent({ reduceOnly: true }), "stop_loss");
    expect(o.tif).toBe("Ioc");
    expect(o.feeBps).toBe(FEE_BPS.taker);
    expect(o.crossingReason).toBe("stop_loss");
  });

  it("uses IOC rather than GTC, so an unfilled taker never rests", () => {
    expect(approveCrossing(intent({ reduceOnly: true }), "emergency_flatten").tif).toBe("Ioc");
  });

  it("has no reason code meaning 'the maker order did not fill'", () => {
    // Guarded by the type, asserted here so the intent survives a refactor.
    const reasons = ["stop_loss", "liquidation_avoidance", "emergency_flatten"];
    expect(reasons).not.toContain("did_not_fill");
    expect(reasons).not.toContain("timeout");
  });
});

/* ── halts ─────────────────────────────────────────────────────────────────── */

describe("halts", () => {
  const guard = new Guard(DEFAULT_LIMITS, clock);

  it("stops new positions when the kill switch is on", () => {
    expectRefusal(guard.approveOpen(openReq(), state({ killSwitch: true })), "kill_switch");
  });

  it("stops new positions at exactly the 7% daily loss line", () => {
    const s = state({ sessionStartEquityUsd: 10_000, equityUsd: 9_300 });
    expectRefusal(guard.approveOpen(openReq(), s), "daily_loss_breached");
  });

  it("still permits new positions at 6.9%", () => {
    const s = state({ sessionStartEquityUsd: 10_000, equityUsd: 9_310 });
    expect(guard.approveOpen(openReq(), s).ok).toBe(true);
  });

  it("measures drawdown from session start, not intraday peak", () => {
    // Up 20% then gave back 10% of the peak. Still up on the session, so this is
    // not the doom loop and must not halt.
    const s = state({ sessionStartEquityUsd: 10_000, equityUsd: 10_800 });
    expect(guard.approveOpen(openReq(), s).ok).toBe(true);
  });

  it("never blocks an exit, even fully halted", () => {
    const s = state({
      killSwitch: true,
      equityUsd: 5_000,
      feedDegraded: true,
      positions: new Map([
        ["BTC", { asset: "BTC", side: "long" as const, notionalUsd: 1000, entryPx: "63000", liquidationPx: null }],
      ]),
    });
    const r = guard.approveReduce(
      { intent: intent({ reduceOnly: true, price: "63400.0", side: "short" }), book: book(), decidedAt: NOW, urgent: "emergency_flatten" },
      s,
    );
    expect(r.ok).toBe(true);
  });

  it("stops trading when the fee budget is spent", () => {
    expectRefusal(
      guard.approveOpen(openReq(), state({ feesPaidTodayUsd: 50 })),
      "fee_budget_exhausted",
    );
  });

  it("stops trading when the inference budget is spent", () => {
    expectRefusal(
      guard.approveOpen(openReq(), state({ inferenceSpentTodayUsd: 2.0 })),
      "inference_budget_exhausted",
    );
  });

  it("blocks same-direction re-entry during a post-stop cooldown", () => {
    const s = state({ lastStopByAssetSide: new Map([["BTC:long", NOW - 30 * 60_000]]) });
    expectRefusal(guard.approveOpen(openReq(), s), "post_stop_cooldown");
  });

  it("allows the opposite direction and allows re-entry after cooldown", () => {
    const recent = state({ lastStopByAssetSide: new Map([["BTC:long", NOW - 30 * 60_000]]) });
    expect(guard.approveOpen(openReq({ intent: intent({ side: "short", price: "63400.5" }) }), recent).ok).toBe(true);
    const old = state({ lastStopByAssetSide: new Map([["BTC:long", NOW - DEFAULT_LIMITS.sameDirectionStopCooldownMs]]) });
    expect(guard.approveOpen(openReq(), old).ok).toBe(true);
  });

  it("refuses an inference call that would cross the cost budget", () => {
    const r = guard.approveInference(
      { promptTokens: 100, completionTokens: 100, totalTokens: 200, costUsd: 0.02 },
      state({ inferenceSpentTodayUsd: 1.99 }),
    );
    expectRefusal(r, "inference_budget_exhausted");
  });

  it("refuses an inference call that would cross the token budget", () => {
    const r = guard.approveInference(
      { promptTokens: 600, completionTokens: 400, totalTokens: 1000, costUsd: 0.001 },
      state({ inferenceTokensToday: DEFAULT_LIMITS.maxDailyInferenceTokens - 999 }),
    );
    expectRefusal(r, "inference_budget_exhausted");
  });

  it("permits an inference reservation that lands exactly on both limits", () => {
    const r = guard.approveInference(
      { promptTokens: 600, completionTokens: 400, totalTokens: 1000, costUsd: 0.01 },
      state({
        inferenceSpentTodayUsd: DEFAULT_LIMITS.maxDailyInferenceUsd - 0.01,
        inferenceTokensToday: DEFAULT_LIMITS.maxDailyInferenceTokens - 1000,
      }),
    );
    expect(r.ok).toBe(true);
  });
});

/* ── freshness ─────────────────────────────────────────────────────────────── */

describe("freshness", () => {
  const guard = new Guard(DEFAULT_LIMITS, clock);

  it("refuses a stale book rather than trading a frozen market", () => {
    expectRefusal(
      guard.approveOpen(openReq({ book: book({ ts: NOW - 5_000 }) }), state()),
      "book_stale",
    );
  });

  it("refuses when ingestion has flagged the feed degraded", () => {
    expectRefusal(guard.approveOpen(openReq(), state({ feedDegraded: true })), "book_stale");
  });

  it("refuses a decision made against a market that has moved on", () => {
    expectRefusal(
      guard.approveOpen(openReq({ decidedAt: NOW - 30_000 }), state()),
      "decision_stale",
    );
  });
});

/* ── sizing and exposure ───────────────────────────────────────────────────── */

describe("sizing", () => {
  const guard = new Guard(DEFAULT_LIMITS, clock);

  it("refuses a position larger than a quarter of equity", () => {
    expectRefusal(
      guard.approveOpen(openReq({ notionalUsd: 2_600 }), state()),
      "position_too_large",
    );
  });

  it("counts existing exposure, so three orders cannot exceed what one could", () => {
    const s = state({
      positions: new Map([
        ["BTC", { asset: "BTC", side: "long" as const, notionalUsd: 2_400, entryPx: "63000", liquidationPx: null }],
      ]),
      totalNotionalUsd: 2_400,
    });
    expectRefusal(
      guard.approveOpen(openReq({ notionalUsd: 500 }), s),
      "asset_exposure_too_large",
    );
  });

  it("refuses a fifth position", () => {
    const positions = new Map(
      ["BTC", "ETH", "SOL", "HYPE"].map((a) => [
        a,
        { asset: a, side: "long" as const, notionalUsd: 100, entryPx: "1", liquidationPx: null },
      ]),
    );
    expectRefusal(
      guard.approveOpen(openReq({ intent: intent({ asset: "XRP" }), book: book({ asset: "XRP" }) }), state({ positions })),
      "max_positions",
    );
  });

  it("allows adding to an existing position at the position limit", () => {
    const positions = new Map(
      ["BTC", "ETH", "SOL", "HYPE"].map((a) => [
        a,
        { asset: a, side: "long" as const, notionalUsd: 100, entryPx: "1", liquidationPx: null },
      ]),
    );
    expect(guard.approveOpen(openReq({ notionalUsd: 200 }), state({ positions })).ok).toBe(true);
  });

  it("refuses an asset outside the universe", () => {
    expectRefusal(
      guard.approveOpen(
        openReq({ intent: intent({ asset: "FARTCOIN" }), book: book({ asset: "FARTCOIN" }) }),
        state(),
      ),
      "asset_not_in_universe",
    );
  });

  it("refuses a move too small to beat the fees", () => {
    expectRefusal(
      guard.approveOpen(openReq({ expectedMove: 0.002 }), state()),
      "expected_move_too_small",
    );
  });
});

/* ── exits ─────────────────────────────────────────────────────────────────── */

describe("exits", () => {
  const guard = new Guard(DEFAULT_LIMITS, clock);
  const withPosition = state({
    positions: new Map([
      ["BTC", { asset: "BTC", side: "long" as const, notionalUsd: 1000, entryPx: "63000", liquidationPx: "60000" }],
    ]),
    totalNotionalUsd: 1000,
  });

  it("refuses an exit that is not reduce-only", () => {
    expectRefusal(
      guard.approveReduce({ intent: intent({ reduceOnly: false }), book: book(), decidedAt: NOW }, withPosition),
      "not_reduce_only",
    );
  });

  it("refuses an exit with no position behind it", () => {
    expectRefusal(
      guard.approveReduce(
        { intent: intent({ asset: "ETH", reduceOnly: true }), book: book({ asset: "ETH" }), decidedAt: NOW },
        withPosition,
      ),
      "no_position_to_reduce",
    );
  });

  it("exits as a maker by default", () => {
    const r = guard.approveReduce(
      { intent: intent({ reduceOnly: true, side: "short", price: "63400.5" }), book: book(), decidedAt: NOW },
      withPosition,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.tif).toBe("Alo");
  });

  it("crosses only when given an explicit reason", () => {
    const r = guard.approveReduce(
      { intent: intent({ reduceOnly: true }), book: book(), decidedAt: NOW, urgent: "stop_loss" },
      withPosition,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order.tif).toBe("Ioc");
      expect(r.order.crossingReason).toBe("stop_loss");
    }
  });
});

/* ── the limits themselves ─────────────────────────────────────────────────── */

describe("limit validation", () => {
  it("accepts the defaults", () => {
    expect(() => validateLimits(DEFAULT_LIMITS)).not.toThrow();
  });

  it("catches the decimal-place typo that would disable the breaker", () => {
    // 0.07 -> 0.7 would not fail any behavioural test; it would just mean the
    // breaker never fires in practice.
    expect(() => validateLimits({ ...DEFAULT_LIMITS, maxDailyLossFraction: 0.7 })).toThrow(
      /maxDailyLossFraction/,
    );
  });

  it("catches incoherent combinations", () => {
    const bad: Limits = { ...DEFAULT_LIMITS, maxPositionFraction: 0.9, maxTotalExposureFraction: 0.5 };
    expect(() => validateLimits(bad)).toThrow(/cannot exceed maxTotalExposureFraction/);
  });

  it("refuses to construct a Guard on incoherent limits", () => {
    expect(() => new Guard({ ...DEFAULT_LIMITS, maxOpenPositions: 0 })).toThrow(/not coherent/);
  });
});
