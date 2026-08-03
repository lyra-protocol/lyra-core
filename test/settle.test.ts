/**
 * Adopting fills for orders that were already resting.
 *
 * These tests exist because their absence cost six hours of live paper trading.
 * Every order Lyra places is maker-only, so `place()` returns `resting` and the
 * fill arrives later. The original code only opened a position when `place()`
 * itself came back `filled` — a branch that, for a maker-only strategy, can
 * never run. The consequence was not a cosmetic one: 157 fills produced zero
 * stored positions, so no protective stop was ever attached, the guard saw a
 * flat account, and the ledger would have been empty.
 *
 * The suite that shipped alongside that bug passed. It tested `place()` and it
 * tested `settle()`, but never the seam between them, which is where the whole
 * safety chain hangs.
 */

import { describe, expect, it } from "vitest";
import { PaperVenue } from "../src/execute/paper.js";
import { ExecutionStore } from "../src/execute/store.js";
import { approveMaker, type OrderIntent } from "../src/orders.js";
import { deriveCloid } from "../src/execute/venue.js";
import { Agent, restingExitFor } from "../src/agent.js";
import { DatabaseSync } from "node:sqlite";

const NOW = 1_785_600_000_000;
const BID = "63400.0";
const ASK = "63401.0";

/** A store that lives only for the test. */
function store(): ExecutionStore {
  return new ExecutionStore(":memory:");
}

function paperVenue(trades: { px: string; sz: string; time: number }[] = []) {
  return new PaperVenue(
    10_000,
    async () => ({ bid: BID, ask: ASK, ts: NOW }),
    async () => trades,
    () => NOW,
  );
}

/** A venue whose tape can be advanced between settles. */
function tapeVenue() {
  let tape: { px: string; sz: string; time: number }[] = [];
  const v = new PaperVenue(
    10_000,
    async () => ({ bid: BID, ask: ASK, ts: NOW }),
    async () => tape,
    () => NOW,
  );
  return { v, play: (t: typeof tape) => { tape = t; } };
}

/**
 * An agent wired to a paper venue, with the thinking half stubbed out.
 *
 * Only the execution seam is under test here, so the model, the gate and the
 * pain map are never reached — `settle()` does not consult them.
 */
function agentOn(venue: PaperVenue, s: ExecutionStore): Agent {
  return new Agent({
    universe: ["BTC"],
    venue,
    store: s,
    recorder: { writeReasoning: async () => "local:test", writeTrade: async () => ({ arweaveId: "local:t", sequence: -1 }), isRetryable: () => false } as never,
    client: {} as never,
    venueDb: new DatabaseSync(":memory:"),
    riskPerTrade: 0.02,
    book: async () => ({ bid: BID, ask: ASK, ts: NOW }),
    mids: async () => ({ BTC: BID }),
    openInterestUsd: async () => null,
    volatility: async () => 0.02,
    log: () => {},
  });
}

/** Places a maker order and records the intent, exactly as the agent does. */
async function restOrder(
  venue: PaperVenue,
  s: ExecutionStore,
  o: Partial<OrderIntent> & { decisionId?: string } = {},
): Promise<string> {
  const decisionId = o.decisionId ?? "decision-1";
  const cloid = deriveCloid(decisionId, 0);
  const intent: OrderIntent = {
    asset: "BTC", side: "long", price: BID, size: "0.01",
    reduceOnly: false, cloid, ...o,
  };
  s.saveDecision({
    id: decisionId, at: NOW, asset: "BTC", action: "open_long",
    conviction: 0.6, expectedMove: 0.01, auditJson: "{}", decisionJson: "{}",
  });
  s.createIntent({
    cloid, decisionId, asset: "BTC", side: intent.side, price: intent.price,
    size: intent.size, reduceOnly: intent.reduceOnly, tif: "Alo", attempt: 0, createdAt: NOW,
  });
  const placed = await venue.place(approveMaker(intent, { asset: "BTC", bid: BID, ask: ASK, ts: NOW }));
  expect(placed.status).toBe("resting");
  s.updateIntent(cloid, {
    status: "placed", venueOrderId: placed.venueOrderId,
    filledSize: placed.filledSize, avgFillPx: placed.avgFillPx, fee: placed.fee,
  });
  return cloid;
}

describe("a maker order that fills after it rests", () => {
  it("becomes a stored position — the case that was silently dropped", async () => {
    const s = store();
    // A trade through the resting bid is what fills a resting buy.
    const v = paperVenue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await restOrder(v, s);

    expect(s.openPositions()).toHaveLength(0);

    const outcomes = await agentOn(v, s).settle();

    expect(outcomes.map((o) => o.result)).toEqual(["opened"]);
    const open = s.openPositions();
    expect(open).toHaveLength(1);
    expect(open[0]!.asset).toBe("BTC");
    expect(open[0]!.side).toBe("long");
    expect(open[0]!.entryPx).toBe(BID);
  });

  it("attaches a protective stop in the same pass", async () => {
    // The reason the previous test matters. An adopted position with no stop is
    // worse than no position, because the guard believes it is protected.
    const s = store();
    const v = paperVenue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await restOrder(v, s);

    await agentOn(v, s).settle();

    const [position] = s.openPositions();
    expect(position!.stopCloid).not.toBeNull();
  });

  it("marks the intent filled, so it stops looking unresolved", async () => {
    const s = store();
    const v = paperVenue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    const cloid = await restOrder(v, s);

    await agentOn(v, s).settle();

    expect(s.getIntent(cloid)!.status).toBe("filled");
  });
});

describe("scaling into a level", () => {
  it("averages a second same-side fill instead of opening a second position", async () => {
    // She places several orders into one level. Two rows for one asset would
    // make positionByAsset ambiguous and halve the notional the guard sees.
    const s = store();
    const { v, play } = tapeVenue();
    const agent = agentOn(v, s);

    await restOrder(v, s, { decisionId: "d1", price: "63400.0", size: "0.01" });
    play([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    expect((await agent.settle()).map((o) => o.result)).toEqual(["opened"]);

    await restOrder(v, s, { decisionId: "d2", price: "63300.0", size: "0.03" });
    play([{ px: "63299.0", sz: "1", time: NOW + 2000 }]);
    const outcomes = await agent.settle();

    expect(outcomes.map((o) => o.result)).toEqual(["added"]);
    const open = s.openPositions();
    expect(open).toHaveLength(1);
    expect(open[0]!.size).toBe("0.04");
    // Size-weighted: (0.01*63400 + 0.03*63300) / 0.04 = 63325
    expect(Number(open[0]!.entryPx)).toBeCloseTo(63325, 4);
  });

  it("moves the stop when the position grows", async () => {
    // A stop sized for the old position would close less than she now holds.
    const s = store();
    const { v, play } = tapeVenue();
    const agent = agentOn(v, s);

    await restOrder(v, s, { decisionId: "d1", price: "63400.0", size: "0.01" });
    play([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await agent.settle();
    const firstStop = s.openPositions()[0]!.stopCloid;

    await restOrder(v, s, { decisionId: "d2", price: "63300.0", size: "0.03" });
    play([{ px: "63299.0", sz: "1", time: NOW + 2000 }]);
    await agent.settle();

    const position = s.openPositions()[0]!;
    expect(position.stopCloid).not.toBeNull();
    expect(position.stopCloid).not.toBe(firstStop);
  });
});

describe("closing", () => {
  it("a triggered stop closes the position and books the loss", async () => {
    const s = store();
    const v = paperVenue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await restOrder(v, s);
    const agent = agentOn(v, s);
    await agent.settle();

    const [position] = s.openPositions();
    expect(position!.stopCloid).not.toBeNull();

    // Price collapses through the stop.
    const stopped = new PaperVenue(
      10_000,
      async () => ({ bid: "60000.0", ask: "60001.0", ts: NOW }),
      async () => [{ px: "60000.0", sz: "5", time: NOW + 3000 }],
      () => NOW + 3000,
    );
    // Re-rest the stop on the venue that will trigger it.
    await stopped.placeStop({
      asset: "BTC", side: "short", triggerPx: "62000.0",
      size: position!.size, cloid: position!.stopCloid!,
    });

    const outcomes = await agentOn(stopped, s).settle();

    expect(outcomes.map((o) => o.result)).toEqual(["closed"]);
    expect(s.openPositions()).toHaveLength(0);
    const closed = s.unrecordedClosures();
    expect(closed).toHaveLength(1);
    expect(Number(closed[0]!.pnl)).toBeLessThan(0);
  });
});

describe("fills that belong to nothing", () => {
  it("are reported rather than swallowed", async () => {
    // Reconciliation halts on an unexplained position. That halt needs a cause,
    // so an orphan fill is surfaced instead of being ignored.
    const s = store();
    const v = paperVenue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await restOrder(v, s);
    // The intent is removed, leaving the venue fill with nothing to match.
    new DatabaseSync(":memory:");
    const s2 = store();

    const outcomes = await agentOn(v, s2).settle();

    expect(outcomes.map((o) => o.result)).toEqual(["orphan"]);
  });
});

describe("a position can only be exited once", () => {
  it("cancels the stop when a maker exit fills", async () => {
    // The stop is reduce-only. Left resting on a flat account it does not
    // expire — it opens the opposite side at full size the moment it triggers.
    const s = store();
    const { v, play } = tapeVenue();
    const agent = agentOn(v, s);

    await restOrder(v, s, { decisionId: "d1", price: "63400.0", size: "0.01" });
    play([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await agent.settle();
    const stopCloid = s.openPositions()[0]!.stopCloid!;
    expect(await v.cancel("BTC", stopCloid)).toBe(true); // it is resting

    // Re-attach and exit through a reduce-only maker order.
    await v.placeStop({
      asset: "BTC", side: "short", triggerPx: "60000.0", size: "0.01", cloid: stopCloid,
    });
    await restOrder(v, s, {
      decisionId: "d2", side: "short", price: "63500.0", size: "0.01", reduceOnly: true,
    });
    play([{ px: "63501.0", sz: "1", time: NOW + 2000 }]);
    const outcomes = await agent.settle();

    expect(outcomes.map((o) => o.result)).toEqual(["closed"]);
    expect(s.openPositions()).toHaveLength(0);
    // Nothing left behind: cancelling again finds nothing to cancel.
    expect(await v.cancel("BTC", stopCloid)).toBe(false);
  });

  it("refuses a second close while one is already resting", async () => {
    // Observed live on ETH: two reduce-only orders for one position filled in
    // the same pass. The first flattened her, the second opened the opposite
    // side — 0.70 ETH long that no decision asked for.
    const s = store();
    const { v, play } = tapeVenue();
    const agent = agentOn(v, s);

    await restOrder(v, s, { decisionId: "d1", price: "63400.0", size: "0.01" });
    play([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await agent.settle();

    // No exit working yet, so a close is allowed.
    expect(restingExitFor(s.unresolvedIntents(), "BTC")).toBeUndefined();

    await restOrder(v, s, {
      decisionId: "d2", side: "short", price: "63500.0", size: "0.01", reduceOnly: true,
    });

    // Now one is working, and a second must be refused.
    const blocking = restingExitFor(s.unresolvedIntents(), "BTC");
    expect(blocking).toBeDefined();
    expect(blocking!.price).toBe("63500.0");
  });

  it("does not confuse an entry for an exit, or another asset's exit", async () => {
    const s = store();
    const { v } = tapeVenue();
    await restOrder(v, s, { decisionId: "e1", price: "63400.0", size: "0.01" });

    // An entry is not an exit.
    expect(restingExitFor(s.unresolvedIntents(), "BTC")).toBeUndefined();
    // Nor is another asset's.
    expect(restingExitFor([{ asset: "ETH", reduceOnly: true }], "BTC")).toBeUndefined();
    expect(restingExitFor([{ asset: "BTC", reduceOnly: true }], "BTC")).toBeDefined();
  });
});

describe("the daily loss breaker has a real baseline", () => {
  it("measures the day against what the session opened with, not against now", () => {
    // The bug this replaces: readRiskState called emptyState(currentEquity),
    // which sets sessionStartEquityUsd = equityUsd. The guard then computes
    // (E - E) / E, so the 7% breaker read exactly 0% drawdown forever and
    // could never fire. It was dead from the day it was written.
    const s = store();
    const midnight = new Date().setUTCHours(0, 0, 0, 0);

    // Yesterday: +200 realised, 10 in fees. Today: -500 realised, 5 in fees.
    const seed = (closedAt: number, pnl: string, fees: string) => {
      const id = s.openPosition({
        asset: "BTC", decisionId: `d${closedAt}`, reasoningId: null, side: "long",
        size: "0.01", entryPx: "63000", openedAt: closedAt - 1000, stopCloid: null, fees,
      });
      s.closePosition(id, { closedAt, exitPx: "63000", pnl, fees });
    };
    seed(midnight - 3_600_000, "200", "10");
    seed(midnight + 3_600_000, "-500", "5");

    const r = s.realisedAround(midnight);
    expect(r.beforePnl).toBe(200);
    expect(r.beforeFees).toBe(10);
    expect(r.sincePnl).toBe(-500);
    expect(r.sinceFees).toBe(5);

    // Session opened at 10,000 + 200 - 10 = 10,190.
    const sessionStart = 10_000 + r.beforePnl - r.beforeFees;
    expect(sessionStart).toBe(10_190);

    // Equity now, after today's loss: 10,190 - 500 - 5 = 9,685.
    const equityNow = sessionStart + r.sincePnl - r.sinceFees;
    const drawdown = (sessionStart - equityNow) / sessionStart;

    // ~4.96% — a real figure, and one that will cross 7% if the day worsens.
    expect(drawdown).toBeGreaterThan(0.049);
    expect(drawdown).toBeLessThan(0.05);
    // The old code produced this instead, for any loss of any size.
    expect(drawdown).not.toBe(0);
  });
});

describe("a restart does not invent or lose positions", () => {
  it("restores the venue from the store, so nothing reads as closed-while-down", async () => {
    // The paper venue keeps its book in memory. Without adopt(), a restart left
    // the store holding four open positions the venue had never heard of, and
    // equity snapped back to its starting figure. Observed live.
    const s = store();
    const { v, play } = tapeVenue();
    await restOrder(v, s, { decisionId: "d1", price: "63400.0", size: "0.01" });
    play([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await agentOn(v, s).settle();

    const before = s.openPositions();
    expect(before).toHaveLength(1);

    // The process restarts: a fresh venue, the same store.
    const fresh = paperVenue();
    expect(await fresh.positions()).toHaveLength(0);

    fresh.adopt({ positions: before, realisedPnl: 0, feesPaid: 0 });

    const after = await fresh.positions();
    expect(after).toHaveLength(1);
    expect(after[0]!.asset).toBe("BTC");
    // Long is a positive signed size; getting this backwards would flip her.
    expect(Number(after[0]!.szi)).toBeGreaterThan(0);
    expect(Number(after[0]!.entryPx)).toBeCloseTo(63400, 4);
  });

  it("carries realised pnl and fees across, so equity does not reset", async () => {
    const s = store();
    const fresh = paperVenue();
    const startEquity = await fresh.equityUsd();

    fresh.adopt({ positions: [], realisedPnl: -250, feesPaid: 30 });

    expect(await fresh.equityUsd()).toBeCloseTo(startEquity - 280, 6);
    void s;
  });
});

describe("a repaired stop keeps its trigger price", () => {
  it("does not lose stop_px when reconciliation re-attaches it", async () => {
    // repair() used to call attachStop(id, cloid) with the trigger omitted, so
    // the optional third argument defaulted to null and erased the price that
    // placeProtectiveStop had just written. Live effect: four protected
    // positions all displaying STOP NONE.
    const s = store();
    const { v, play } = tapeVenue();
    await restOrder(v, s, { decisionId: "d1", price: "63400.0", size: "0.01" });
    play([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await agentOn(v, s).settle();

    const p = s.openPositions()[0]!;
    expect(p.stopCloid).not.toBeNull();
    // The number a position exists to answer: where does this end.
    expect(p.stopPx).not.toBeNull();
    expect(Number(p.stopPx)).toBeGreaterThan(0);
  });
});
