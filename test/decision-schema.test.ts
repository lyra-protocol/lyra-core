import { describe, expect, it } from "vitest";
import { decisionJsonSchema, validateDecision } from "../src/decide/schema.js";

describe("branched decision schema", () => {
  it("uses a nested union rather than an unsupported root anyOf", () => {
    const schema = decisionJsonSchema({ kind: "flat" }).schema as any;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties.decision.anyOf).toHaveLength(3);
  });

  it("flat hold cannot declare target or expected move", () => {
    const branches = (decisionJsonSchema({ kind: "flat" }).schema as any).properties.decision.anyOf;
    const hold = branches.find((b: any) => b.properties.action.enum[0] === "hold");
    expect(hold.properties.target_px).toBeUndefined();
    expect(hold.properties.expected_move).toBeUndefined();
    expect(hold.properties.hypothesis.enum).toEqual(["none"]);
  });

  it("flat openings declare a target but not redundant expected move", () => {
    const branches = (decisionJsonSchema({ kind: "flat" }).schema as any).properties.decision.anyOf;
    for (const opening of branches.filter((b: any) => b.properties.action.enum[0].startsWith("open_"))) {
      expect(opening.properties.target_px).toBeDefined();
      expect(opening.properties.expected_move).toBeUndefined();
    }
  });

  it("positioned branches pin the opening hypothesis", () => {
    const branches = (decisionJsonSchema({ kind: "positioned", originalHypothesis: "cascade" }).schema as any).properties.decision.anyOf;
    expect(branches).toHaveLength(2);
    expect(branches.every((b: any) => b.properties.hypothesis.enum[0] === "cascade")).toBe(true);
    expect(branches.every((b: any) => b.properties.target_px === undefined)).toBe(true);
  });

  it("normalizes a wire hold to internal zero fields", () => {
    const result = validateDecision(JSON.stringify({ decision: {
      observed: "x", losing_side: "neither", forced_orders_are: "mixed",
      hypothesis: "none", action: "hold", thesis_status: "no_position",
      conviction: 0.2, reasoning: "wait", evidence_event_ids: [],
    } }), []);
    expect(result).toMatchObject({ ok: true, decision: { target_px: 0, expected_move: 0 } });
  });

  it("rejects opening-only fields on a hold even outside Azure strict mode", () => {
    const result = validateDecision(JSON.stringify({ decision: {
      observed: "x", losing_side: "neither", forced_orders_are: "mixed",
      hypothesis: "none", action: "hold", thesis_status: "no_position",
      target_px: 10, expected_move: 0.1, conviction: 0.2,
      reasoning: "wait", evidence_event_ids: [],
    } }), []);
    expect(result.ok).toBe(false);
  });

  it("normalizes bracket decoration only for genuinely supplied citations", () => {
    const raw = (evidence: string[]) => JSON.stringify({ decision: {
      observed: "x", losing_side: "shorts", forced_orders_are: "buys_above_spot",
      hypothesis: "magnet", action: "open_long", target_px: 101,
      thesis_status: "no_position", conviction: 0.6, reasoning: "x",
      evidence_event_ids: evidence,
    } });
    expect(validateDecision(raw(["[mid]"]), ["mid"])).toMatchObject({
      ok: true, decision: { evidence_event_ids: ["mid"], expected_move: 0 },
    });
    expect(validateDecision(raw(["[invented]"]), ["mid"])).toMatchObject({
      ok: false, failure: { code: "ungrounded_citation" },
    });
  });
});