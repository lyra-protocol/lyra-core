import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reconcile } from "../src/execute/reconcile.js";
import { ExecutionStore } from "../src/execute/store.js";
import type { OpenOrder, Venue, VenuePosition } from "../src/execute/venue.js";

function store(): ExecutionStore {
  return new ExecutionStore(join(mkdtempSync(join(tmpdir(), "lyra-exec-")), "exec.db"));
}

function fakeVenue(positions: VenuePosition[], orders: OpenOrder[] = []): Venue {
  return {
    kind: "paper",
    place: async () => { throw new Error("not used"); },
    placeStop: async () => { throw new Error("not used"); },
    cancel: async () => true,
    openOrders: async () => orders,
    positions: async () => positions,
    equityUsd: async () => 10_000,
  };
}

const position = (asset: string, szi = "1"): VenuePosition => ({
  asset, szi, entryPx: "63000", unrealizedPnl: "0", liquidationPx: "60000", positionValue: "63000",
});

const trigger = (asset: string): OpenOrder => ({
  venueOrderId: "t1", cloid: "0xstop", asset, side: "short",
  limitPx: "60000", size: "1", reduceOnly: true, isTrigger: true,
});

describe("startup reconciliation", () => {
  it("is safe when the venue and the store agree", async () => {
    const s = store();
    s.openPosition({
      asset: "BTC", decisionId: "d1", reasoningId: "r1", side: "long",
      size: "1", entryPx: "63000", openedAt: Date.now(), stopCloid: "0xstop",
    });
    const r = await reconcile(fakeVenue([position("BTC")], [trigger("BTC")]), s);
    expect(r.safe).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("HALTS on a position it cannot explain", async () => {
    // The one finding that must stop everything: something placed an order
    // outside this system, or the store was lost.
    const r = await reconcile(fakeVenue([position("ETH")]), store());
    expect(r.safe).toBe(false);
    expect(r.haltReason).toMatch(/cannot be explained/);
    expect(r.findings[0]?.kind).toBe("unknown_position");
  });

  it("flags a position that never had a stop attached", async () => {
    const s = store();
    s.openPosition({
      asset: "BTC", decisionId: "d1", reasoningId: "r1", side: "long",
      size: "1", entryPx: "63000", openedAt: Date.now(), stopCloid: null,
    });
    const r = await reconcile(fakeVenue([position("BTC")]), s);
    expect(r.findings.some((f) => f.kind === "unprotected_position")).toBe(true);
    // Repairable, so it does not halt.
    expect(r.safe).toBe(true);
  });

  it("flags a stop that is recorded locally but absent at the venue", async () => {
    const s = store();
    s.openPosition({
      asset: "BTC", decisionId: "d1", reasoningId: "r1", side: "long",
      size: "1", entryPx: "63000", openedAt: Date.now(), stopCloid: "0xstop",
    });
    const r = await reconcile(fakeVenue([position("BTC")], []), s);
    expect(r.findings.some((f) => f.kind === "stop_missing_at_venue")).toBe(true);
  });

  it("notices a position that closed while the process was down", async () => {
    const s = store();
    s.openPosition({
      asset: "BTC", decisionId: "d1", reasoningId: "r1", side: "long",
      size: "1", entryPx: "63000", openedAt: Date.now(), stopCloid: "0xstop",
    });
    const r = await reconcile(fakeVenue([]), s);
    expect(r.findings.some((f) => f.kind === "filled_while_down")).toBe(true);
  });

  it("closes out an intent that never reached the venue", async () => {
    const s = store();
    s.createIntent({
      cloid: "0xabc", decisionId: "d1", asset: "BTC", side: "long",
      price: "63000", size: "1", reduceOnly: false, tif: "Alo",
      attempt: 0, createdAt: Date.now(),
    });
    const r = await reconcile(fakeVenue([]), s);
    expect(r.findings.some((f) => f.kind === "orphan_intent")).toBe(true);
    expect(r.safe).toBe(true);
  });
});

describe("the store persists before the network", () => {
  it("keeps an intent that was never placed, so a crash is recoverable", () => {
    const s = store();
    s.createIntent({
      cloid: "0xabc", decisionId: "d1", asset: "BTC", side: "long",
      price: "63000", size: "1", reduceOnly: false, tif: "Alo",
      attempt: 0, createdAt: Date.now(),
    });
    expect(s.unresolvedIntents()).toHaveLength(1);
    expect(s.getIntent("0xabc")?.status).toBe("intended");
  });

  it("lists closures that never reached the ledger", () => {
    const s = store();
    const id = s.openPosition({
      asset: "BTC", decisionId: "d1", reasoningId: "r1", side: "long",
      size: "1", entryPx: "63000", openedAt: 1, stopCloid: null,
    });
    s.closePosition(id, { closedAt: 2, exitPx: "64000", pnl: "1000", fees: "10" });
    expect(s.unrecordedClosures()).toHaveLength(1);
    s.markRecorded(id, 0, "arweave-id");
    expect(s.unrecordedClosures()).toHaveLength(0);
  });
});
