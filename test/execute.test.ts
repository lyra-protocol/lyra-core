import { describe, expect, it } from "vitest";
import { PaperVenue } from "../src/execute/paper.js";
import { deriveCloid } from "../src/execute/venue.js";
import { approveCrossing, approveMaker, type OrderIntent, type TopOfBook } from "../src/orders.js";

const NOW = 1_785_600_000_000;

function book(bid = "63400.0", ask = "63401.0"): TopOfBook {
  return { asset: "BTC", bid, ask, ts: NOW };
}

function intent(o: Partial<OrderIntent> = {}): OrderIntent {
  return {
    asset: "BTC",
    side: "long",
    price: "63400.0",
    size: "0.01",
    reduceOnly: false,
    cloid: deriveCloid("decision-1", 0),
    ...o,
  };
}

function venue(trades: { px: string; sz: string; time: number }[] = []) {
  return new PaperVenue(
    10_000,
    async () => ({ bid: "63400.0", ask: "63401.0", ts: NOW }),
    async () => trades,
    () => NOW,
  );
}

describe("cloid derivation", () => {
  it("is deterministic, so a retry cannot double-fill", () => {
    // The property that matters: a timeout mid-fill must re-send the same id.
    expect(deriveCloid("decision-1", 0)).toBe(deriveCloid("decision-1", 0));
  });

  it("differs per decision and per attempt", () => {
    // A re-price is genuinely a different order, so it must not share an id.
    expect(deriveCloid("decision-1", 0)).not.toBe(deriveCloid("decision-2", 0));
    expect(deriveCloid("decision-1", 0)).not.toBe(deriveCloid("decision-1", 1));
  });

  it("is 128 bits of hex, the width the venue accepts", () => {
    expect(deriveCloid("d", 0)).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

describe("ALO behaviour matches the venue", () => {
  it("cancels an order that would cross rather than filling it", async () => {
    const v = venue();
    const order = approveMaker(intent({ price: "63400.0" }), book());
    // Force a cross by moving the book against the resting price.
    const crossing = new PaperVenue(
      10_000,
      async () => ({ bid: "63390.0", ask: "63395.0", ts: NOW }),
      async () => [],
      () => NOW,
    );
    const r = await crossing.place(order);
    expect(r.status).toBe("cancelled");
    expect(r.reason).toMatch(/would have crossed/);
    expect(r.filledSize).toBe("0");
    expect(await v.equityUsd()).toBe(10_000);
  });

  it("rests a non-crossing order rather than filling it instantly", async () => {
    // The optimistic-paper-trader lie: assuming a maker order fills. It does not
    // until the market comes to it.
    const v = venue();
    const r = await v.place(approveMaker(intent(), book()));
    expect(r.status).toBe("resting");
    expect(r.filledSize).toBe("0");
    expect((await v.positions()).length).toBe(0);
  });

  it("fills only when the market trades THROUGH the price, not merely to it", async () => {
    const at = venue([{ px: "63400.0", sz: "1", time: NOW + 1000 }]);
    await at.place(approveMaker(intent(), book()));
    expect(await at.settle("BTC")).toHaveLength(0);

    const through = venue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await through.place(approveMaker(intent(), book()));
    const filled = await through.settle("BTC");
    expect(filled).toHaveLength(1);
    expect(filled[0]?.status).toBe("filled");
  });

  it("ignores trades that happened before the order was placed", async () => {
    const v = venue([{ px: "63000.0", sz: "1", time: NOW - 60_000 }]);
    await v.place(approveMaker(intent(), book()));
    expect(await v.settle("BTC")).toHaveLength(0);
  });
});

describe("fees are charged at the real published rates", () => {
  it("charges 1.5 bps on a maker fill", async () => {
    const v = venue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await v.place(approveMaker(intent({ size: "1" }), book()));
    await v.settle("BTC");
    // 1 BTC at 63400 × 1.5bps
    expect(v.stats().feesPaid).toBeCloseTo(63400 * 0.00015, 4);
  });

  it("charges 4.5 bps when an exit crosses", async () => {
    const v = venue();
    await v.place(approveCrossing(intent({ size: "1", reduceOnly: true }), "stop_loss"));
    expect(v.stats().feesPaid).toBeCloseTo(63401 * 0.00045, 4);
  });
});

describe("positions and PnL", () => {
  it("opens a position when a resting order fills", async () => {
    const v = venue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await v.place(approveMaker(intent({ size: "0.5" }), book()));
    await v.settle("BTC");
    const positions = await v.positions();
    expect(positions).toHaveLength(1);
    expect(Number(positions[0]?.szi)).toBeCloseTo(0.5);
  });

  it("realises PnL when a position is closed", async () => {
    const v = new PaperVenue(
      10_000,
      async () => ({ bid: "63400.0", ask: "63401.0", ts: NOW }),
      async () => [{ px: "63399.0", sz: "1", time: NOW + 1000 }],
      () => NOW,
    );
    await v.place(approveMaker(intent({ size: "1" }), book()));
    await v.settle("BTC");
    // Close it by crossing, as a stop would.
    await v.place(
      approveCrossing(intent({ size: "1", side: "short", reduceOnly: true }), "stop_loss"),
    );
    // Entered at 63400, exited at the bid 63400 → flat before fees.
    expect(v.stats().realisedPnl).toBeCloseTo(0, 2);
    expect(await v.positions()).toHaveLength(0);
  });

  it("subtracts fees from equity", async () => {
    const v = venue([{ px: "63399.0", sz: "1", time: NOW + 1000 }]);
    await v.place(approveMaker(intent({ size: "1" }), book()));
    await v.settle("BTC");
    expect(await v.equityUsd()).toBeLessThan(10_000);
  });
});

describe("stops rest at the venue", () => {
  it("appears in open orders as a trigger", async () => {
    const v = venue();
    await v.placeStop({
      asset: "BTC",
      side: "short",
      triggerPx: "62000.0",
      size: "1",
      cloid: deriveCloid("stop-1", 0),
    });
    const orders = await v.openOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.isTrigger).toBe(true);
    expect(orders[0]?.reduceOnly).toBe(true);
  });

  it("triggers when price reaches it", async () => {
    const v = venue([{ px: "61999.0", sz: "1", time: NOW + 1000 }]);
    await v.placeStop({
      asset: "BTC",
      side: "short",
      triggerPx: "62000.0",
      size: "1",
      cloid: deriveCloid("stop-1", 0),
    });
    const filled = await v.settle("BTC");
    expect(filled.some((r) => r.reason === "stop triggered")).toBe(true);
  });

  it("does not trigger while price stays away from it", async () => {
    const v = venue([{ px: "63500.0", sz: "1", time: NOW + 1000 }]);
    await v.placeStop({
      asset: "BTC",
      side: "short",
      triggerPx: "62000.0",
      size: "1",
      cloid: deriveCloid("stop-1", 0),
    });
    expect(await v.settle("BTC")).toHaveLength(0);
  });
});

describe("reconciliation surface", () => {
  it("reports resting orders so a restart can find them", async () => {
    const v = venue();
    await v.place(approveMaker(intent(), book()));
    const orders = await v.openOrders();
    expect(orders[0]?.cloid).toBe(deriveCloid("decision-1", 0));
  });

  it("cancels by cloid", async () => {
    const v = venue();
    await v.place(approveMaker(intent(), book()));
    expect(await v.cancel("BTC", deriveCloid("decision-1", 0))).toBe(true);
    expect(await v.openOrders()).toHaveLength(0);
  });
});
