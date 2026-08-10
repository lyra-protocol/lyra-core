import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { assessMateriality, DEFAULT_MATERIALITY } from "../src/decide/materiality.js";
import { closureCountBetween } from "../src/decide/closure-delta.js";
import type { PainMap } from "../src/painmap.js";

const map = {
  coin: "BTC", midPx: "100", positionsEnumerated: 10,
  coverage: { fraction: 0.1, venueOpenInterestUsd: 1000, enumeratedNotionalUsd: 100, staleCount: 0 },
  longs: { count: 5, notionalUsd: 50, unrealizedPnlUsd: -10 },
  shorts: { count: 5, notionalUsd: 50, unrealizedPnlUsd: 10 },
  aggregateUnrealizedPnlUsd: 0, losingSide: "longs", meanLeverage: 2,
  concentration: 0.1, forcedLevels: [], largest: [], at: 1000,
} as PainMap;

describe("materiality state", () => {
  it("reviews a newly opened position", () => {
    const r = assessMateriality({
      map, now: 100_000, closuresSinceLast: 0,
      last: { at: 0, aggregateUnrealizedPnlUsd: 0, losingSide: "longs", openPosition: null },
      openPosition: { positionId: 1, notionalUsd: 100, unrealizedPnlUsd: 0, lastReviewedPnlUsd: null },
    }, { ...DEFAULT_MATERIALITY, minIntervalMs: 0 });
    expect(r).toMatchObject({ consult: true });
    if (r.consult) expect(r.triggers).toContain("position_opened");
  });
  it("uses actual position PnL movement", () => {
    const r = assessMateriality({
      map, now: 100_000, closuresSinceLast: 0,
      last: { at: 0, aggregateUnrealizedPnlUsd: 0, losingSide: "longs", openPosition: { positionId: 1, unrealizedPnlUsd: 0 } },
      openPosition: { positionId: 1, notionalUsd: 100, unrealizedPnlUsd: 30, lastReviewedPnlUsd: 0 },
    }, { ...DEFAULT_MATERIALITY, minIntervalMs: 0 });
    expect(r).toMatchObject({ consult: true });
    if (r.consult) expect(r.triggers).toContain("position_review");
  });
  it("counts closures on an exclusive/inclusive interval", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE position (coin TEXT, szi TEXT, ts INTEGER)");
    const insert = db.prepare("INSERT INTO position VALUES (?,?,?)");
    insert.run("BTC", "0", 10); insert.run("BTC", "0", 11); insert.run("BTC", "0", 12);
    expect(closureCountBetween(db, "BTC", 10, 12)).toBe(2);
    db.close();
  });
});