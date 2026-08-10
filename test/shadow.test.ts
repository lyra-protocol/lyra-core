import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compare } from "../src/decide/shadow.js";
import type { Decision } from "../src/decide/schema.js";
import { DecisionClient } from "../src/decide/client.js";
import { ExecutionStore } from "../src/execute/store.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const decision: Decision = {
  observed: "x", losing_side: "shorts", forced_orders_are: "buys_above_spot",
  hypothesis: "cascade", action: "open_long", target_px: 101,
  thesis_status: "no_position", expected_move: 0.01, conviction: 0.6,
  reasoning: "x", evidence_event_ids: ["mid"],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lyra-shadow-")); dirs.push(dir);
  const store = new ExecutionStore(join(dir, "exec.db"));
  const client = new DecisionClient({ endpoint: "https://example.test", apiKey: "x", apiVersion: "v", deployment: "gpt-4.1-mini" });
  return { store, client };
}

describe("shadow evaluation", () => {
  it("compares actions, hypotheses, targets and conviction", () => {
    expect(compare(decision, { ...decision }, 100).all).toBe(true);
    expect(compare(decision, { ...decision, action: "hold" }, 100).all).toBe(false);
    expect(compare(decision, { ...decision, conviction: 0.7 }, 100).conviction).toBe(false);
  });

  it("isolates challenger usage from champion budget", () => {
    const { store, client } = setup();
    const prepared = client.prepare({ systemPrompt: "s", userPrompt: "u", eventIds: [] });
    store.beginInferenceCall({ prepared, decisionId: "d", asset: "BTC", ...client.metadata(), role: "challenger", pairId: "p" });
    const from = prepared.startedAt - 1, to = prepared.startedAt + 1;
    expect(store.inferenceUsageBetween(from, to, "champion").attempts).toBe(0);
    expect(store.inferenceUsageBetween(from, to, "challenger").attempts).toBe(1);
    store.close();
  });

  it("persists paired evaluation results", () => {
    const { store } = setup();
    store.beginShadowEvaluation({ pairId: "p", championDecisionId: "d", championAttemptId: "a", asset: "BTC", createdAt: 1, promptHash: "h", challengerModel: "m", status: "pending", promptTemplate: "pt", schemaHash: "sh", championModel: "cm", evaluationVersion: "ev", championDecisionJson: JSON.stringify(decision) });
    store.finishShadowEvaluation("p", { status: "completed", challengerAttemptId: "b", actionAgreement: true, allAgreement: false, challengerSemanticCode: "target_direction_mismatch", challengerDecisionJson: JSON.stringify(decision) });
    expect(store.shadowEvaluations(1)[0]).toMatchObject({ pairId: "p", status: "completed", actionAgreement: true, allAgreement: false, challengerSemanticCode: "target_direction_mismatch", promptTemplate: "pt", schemaHash: "sh", championModel: "cm", evaluationVersion: "ev", challengerDecisionJson: JSON.stringify(decision) });
    store.close();
  });
});