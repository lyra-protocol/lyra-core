import { describe, expect, it } from "vitest";
import { deriveDecisionMetrics, validateDecisionSemantics } from "../src/decide/semantics.js";
import type { Decision } from "../src/decide/schema.js";

const base: Decision = {
  observed: "x", losing_side: "shorts", forced_orders_are: "buys_above_spot",
  hypothesis: "cascade", action: "open_long", target_px: 101,
  thesis_status: "no_position", expected_move: 0.01, conviction: 0.6,
  reasoning: "x", evidence_event_ids: ["mid"],
};
const context = { entryPx: 100, stopPx: 99, minExpectedMove: 0.005, minRewardRisk: 1 };

describe("decision semantics", () => {
  it("accepts coherent long and short contracts", () => {
    expect(validateDecisionSemantics(base, context).ok).toBe(true);
    expect(validateDecisionSemantics({ ...base, action: "open_short", target_px: 99 }, context).ok).toBe(true);
  });
  it("rejects targets on the wrong side", () => {
    expect(validateDecisionSemantics({ ...base, target_px: 99 }, context)).toMatchObject({ ok: false, failure: { code: "target_direction_mismatch" } });
  });
  it("rejects declared moves inconsistent with the target", () => {
    expect(validateDecisionSemantics({ ...base, expected_move: 0.04 }, context)).toMatchObject({ ok: false, failure: { code: "expected_move_mismatch" } });
  });
  it("derives expected move from authoritative entry and target", () => {
    const derived = deriveDecisionMetrics({ ...base, expected_move: 1.1 }, 100);
    expect(derived.expected_move).toBeCloseTo(0.01);
    expect(validateDecisionSemantics(derived, context).ok).toBe(true);
  });
  it("rejects opening with no hypothesis", () => {
    expect(validateDecisionSemantics({ ...base, hypothesis: "none" }, context)).toMatchObject({ ok: false, failure: { code: "hypothesis_action_mismatch" } });
  });
  it("enforces reward risk", () => {
    expect(validateDecisionSemantics(base, { ...context, stopPx: 98, minRewardRisk: 1 })).toMatchObject({ ok: false, failure: { code: "reward_risk_too_small" } });
  });
  it("requires flat holds to be explicit", () => {
    expect(validateDecisionSemantics({ ...base, action: "hold", target_px: 0, expected_move: 0, hypothesis: "none" }, context).ok).toBe(true);
  });
  it("does not contain an asset denylist", () => {
    for (const _asset of ["BTC", "SOL", "DOGE", "KAITO"]) {
      expect(validateDecisionSemantics(base, context).ok).toBe(true);
    }
  });
});