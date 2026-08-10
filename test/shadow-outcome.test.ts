import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceVirtualPosition,
  DEFAULT_SHADOW_OUTCOME_CONFIG,
  deriveVirtualOpening,
  type ShadowOutcomeConfig,
} from "../src/decide/shadow-outcome.js";
import type { Decision } from "../src/decide/schema.js";
import { ExecutionStore, type ShadowOutcomeCandidate, type ShadowVirtualPosition } from "../src/execute/store.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const candidate: ShadowOutcomeCandidate = {
  pairId: "pair", asset: "BTC", promptTemplate: "prompt/v1", schemaHash: "schema",
  championModel: "champion", challengerModel: "challenger", evaluationVersion: "outcome/v1",
  championDecisionJson: "{}", challengerDecisionJson: "{}",
};
const long: Decision = {
  observed: "x", losing_side: "shorts", forced_orders_are: "buys_above_spot",
  hypothesis: "cascade", action: "open_long", target_px: 110,
  thesis_status: "no_position", expected_move: 0.1, conviction: 0.6,
  reasoning: "x", evidence_event_ids: ["mid"],
};
const config: ShadowOutcomeConfig = {
  ...DEFAULT_SHADOW_OUTCOME_CONFIG,
  notionalUsd: 1_000, virtualEquityUsd: 1_000, riskFraction: 0.02,
  horizonMs: 1_000, makerFeeBps: 1.5, takerFeeBps: 4.5,
};

function position(decision: Decision = long): ShadowVirtualPosition {
  const created = deriveVirtualOpening({ candidate, role: "champion", decision, entryPx: 100, openedAt: 1_000, config });
  if (!created) throw new Error("expected opening");
  return {
    id: 1, ...created, mfeUsd: 0, maeUsd: 0, status: "open",
    resolvedAt: null, exitPx: null, grossPnlUsd: null, totalFeesUsd: null, netPnlUsd: null,
  };
}

describe("shadow virtual outcomes", () => {
  it("creates only opening actions with fixed notional and a deterministic stop", () => {
    expect(position()).toMatchObject({ side: "long", entryPx: 100, targetPx: 110, stopPx: 98, size: 10, notionalUsd: 1_000 });
    expect(deriveVirtualOpening({ candidate, role: "champion", decision: { ...long, action: "hold", target_px: 0, expected_move: 0 }, entryPx: 100, openedAt: 1_000, config })).toBeNull();
  });

  it("settles long and short targets after maker fees", () => {
    const target = advanceVirtualPosition(position(), 111, 1_100, config)!;
    expect(target).toMatchObject({ status: "target", exitPx: 110, grossPnlUsd: 100 });
    expect(target.totalFeesUsd).toBeCloseTo(0.315);
    expect(target.netPnlUsd).toBeCloseTo(99.685);

    const short = position({ ...long, action: "open_short", target_px: 90, forced_orders_are: "sells_below_spot", losing_side: "longs" });
    expect(advanceVirtualPosition(short, 89, 1_100, config)).toMatchObject({ status: "target", exitPx: 90, grossPnlUsd: 100 });
  });

  it("conservatively resolves stop when target and stop cross in one interval", () => {
    const p = position();
    p.lastMidPx = 111;
    const result = advanceVirtualPosition(p, 97, 1_100, config)!;
    expect(result.status).toBe("stop");
    expect(result.exitPx).toBe(98);
    expect(result.grossPnlUsd).toBeCloseTo(-20);
    expect(result.mfeUsd).toBeCloseTo(110);
    expect(result.maeUsd).toBeCloseTo(-30);
  });

  it("settles at sampled price on horizon and tracks MFE and MAE", () => {
    const p = position();
    const first = advanceVirtualPosition(p, 105, 1_500, config)!;
    Object.assign(p, first, { lastSampleAt: first.sampledAt, lastMidPx: first.midPx });
    const final = advanceVirtualPosition(p, 99, 2_000, config)!;
    expect(final).toMatchObject({ status: "horizon", exitPx: 99, mfeUsd: 50, maeUsd: -10, grossPnlUsd: -10 });
    expect(final.totalFeesUsd).toBeCloseTo(0.5955);
  });

  it("persists idempotently and reports resolved results by role", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyra-outcome-")); dirs.push(dir);
    const store = new ExecutionStore(join(dir, "exec.db"));
    const created = deriveVirtualOpening({ candidate, role: "champion", decision: long, entryPx: 100, openedAt: 1_000, config })!;
    store.createShadowVirtualPosition(created);
    store.createShadowVirtualPosition(created);
    expect(store.openShadowVirtualPositions()).toHaveLength(1);
    const update = advanceVirtualPosition(store.openShadowVirtualPositions()[0], 111, 1_100, config)!;
    store.updateShadowVirtualPosition(1, update);
    expect(store.openShadowVirtualPositions()).toHaveLength(0);
    expect(store.shadowOutcomeReport({ championModel: "champion" })).toEqual([
      expect.objectContaining({ role: "champion", resolved: 1, wins: 1, targets: 1 }),
    ]);
    expect(store.shadowOutcomeReport({ championModel: "other" })).toEqual([]);
    store.close();
  });
});
