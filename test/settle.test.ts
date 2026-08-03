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
import { Agent } from "../src/agent.js";
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
