import { describe, expect, it } from "vitest";
import {
  scoreShadowPromotion,
  type PairEvidence,
  type PromotionPolicy,
} from "../src/decide/shadow-promotion.js";

const policy: PromotionPolicy = {
  minimumValidComparisons: 3,
  minimumActionableComparisons: 2,
  minimumValidityRate: 0.99,
  minimumOpeningRecallRatio: 0.5,
  maximumExpectancyDeficitUsd: 0,
  maximumDrawdownRatio: 1,
  minimumEfficiencyImprovement: 0.1,
};

function pair(overrides: Partial<PairEvidence>): PairEvidence {
  return {
    pairId: "p", at: 1, asset: "BTC",
    championAction: "hold", challengerAction: "hold",
    championThesisStatus: "no_position", challengerThesisStatus: "no_position",
    championPositionStatus: null, challengerPositionStatus: null,
    championNetPnlUsd: null, challengerNetPnlUsd: null,
    championLatencyMs: 1_000, challengerLatencyMs: 800,
    championCostUsd: 1, challengerCostUsd: 0.8,
    ...overrides,
  };
}

describe("shadow promotion scoring", () => {
  it("treats holds as zero-PnL baselines and scores resolved openings", () => {
    const result = scoreShadowPromotion([
      pair({ pairId: "one", championAction: "hold", challengerAction: "open_long", challengerPositionStatus: "target", challengerNetPnlUsd: 10 }),
      pair({ pairId: "two", at: 2, championAction: "open_short", challengerAction: "hold", championPositionStatus: "stop", championNetPnlUsd: -5 }),
      pair({ pairId: "three", at: 3 }),
    ], { attempted: 3, valid: 3 }, policy);
    expect(result).toMatchObject({
      resolvedComparisons: 3, actionableComparisons: 2,
      challengerWins: 2, championWins: 0, ties: 1,
      profitability: { championNetPnlUsd: -5, challengerNetPnlUsd: 10, netPnlDeltaUsd: 15 },
    });
  });

  it("keeps a pair pending until every proposed opening resolves", () => {
    const result = scoreShadowPromotion([
      pair({ championAction: "open_long", challengerAction: "hold", championPositionStatus: "open" }),
    ], { attempted: 1, valid: 1 }, policy);
    expect(result).toMatchObject({ resolvedComparisons: 0, pendingComparisons: 1 });
  });

  it("excludes positioned hold/close reviews from opening profitability", () => {
    const result = scoreShadowPromotion([
      pair({ championAction: "hold", challengerAction: "close", championThesisStatus: "intact", challengerThesisStatus: "invalidated" }),
    ], { attempted: 1, valid: 1 }, policy);
    expect(result).toMatchObject({ flatComparisons: 0, resolvedComparisons: 0 });
  });

  it("requires recall on champion opening events, not aggregate opening volume", () => {
    const result = scoreShadowPromotion([
      pair({ pairId: "miss", championAction: "open_long", challengerAction: "hold", championPositionStatus: "target", championNetPnlUsd: 10 }),
      pair({ pairId: "unrelated", at: 2, championAction: "hold", challengerAction: "open_short", challengerPositionStatus: "target", challengerNetPnlUsd: 10 }),
    ], { attempted: 2, valid: 2 }, { ...policy, minimumValidComparisons: 2 });
    expect(result.openingRecall).toMatchObject({ championOpenings: 1, challengerOpenings: 1, recalledChampionOpenings: 0, ratio: 0 });
    expect(result.gates.openingRecall.pass).toBe(false);
  });

  it("only becomes eligible for human review when every conservative gate passes", () => {
    const result = scoreShadowPromotion([
      pair({ pairId: "a", championAction: "open_long", challengerAction: "open_long", championPositionStatus: "target", challengerPositionStatus: "target", championNetPnlUsd: 5, challengerNetPnlUsd: 7 }),
      pair({ pairId: "b", at: 2, championAction: "hold", challengerAction: "open_short", challengerPositionStatus: "target", challengerNetPnlUsd: 4 }),
      pair({ pairId: "c", at: 3 }),
    ], { attempted: 3, valid: 3 }, policy);
    expect(result.recommendation).toBe("eligible_for_human_review");
    expect(result.automaticPromotion).toBe(false);
    expect(Object.values(result.gates).every((gate) => gate.pass)).toBe(true);
  });

  it("blocks readiness when validity or efficiency is insufficient", () => {
    const evidence = [
      pair({ pairId: "a", championAction: "open_long", challengerAction: "open_long", championPositionStatus: "target", challengerPositionStatus: "target", championNetPnlUsd: 5, challengerNetPnlUsd: 7, challengerLatencyMs: 1_000, challengerCostUsd: 1 }),
      pair({ pairId: "b", at: 2, championAction: "hold", challengerAction: "open_short", challengerPositionStatus: "target", challengerNetPnlUsd: 4, challengerLatencyMs: 1_000, challengerCostUsd: 1 }),
      pair({ pairId: "c", at: 3, challengerLatencyMs: 1_000, challengerCostUsd: 1 }),
    ];
    const result = scoreShadowPromotion(evidence, { attempted: 4, valid: 3 }, policy);
    expect(result.recommendation).toBe("collecting_evidence");
    expect(result.gates.validity.pass).toBe(false);
    expect(result.gates.efficiency.pass).toBe(false);
  });
});
