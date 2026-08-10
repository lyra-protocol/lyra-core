import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionClient, isReasoningModel, priceUsage, tokenPricing } from "../src/decide/client.js";
import { ExecutionStore } from "../src/execute/store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): ExecutionStore {
  const dir = mkdtempSync(join(tmpdir(), "lyra-inference-"));
  dirs.push(dir);
  return new ExecutionStore(join(dir, "exec.db"));
}

function client(): DecisionClient {
  return new DecisionClient({
    endpoint: "https://example.openai.azure.com",
    apiKey: "test",
    apiVersion: "2026-01-01",
    deployment: "test-model",
    maxCompletionTokens: 100,
  });
}

const input = { systemPrompt: "system", userPrompt: "user", eventIds: ["mid"] };

describe("inference accounting", () => {
  it("prices gpt-4.1-mini at its Global Standard rate", () => {
    const usage = priceUsage(1_000_000, 1_000_000, tokenPricing("gpt-4.1-mini"));
    expect(usage.costUsd).toBeCloseTo(2.0);
  });

  it("prices gpt-5.4-nano at its Global Standard rate", () => {
    const usage = priceUsage(1_000_000, 1_000_000, tokenPricing("gpt-5.4-nano"));
    expect(usage.costUsd).toBeCloseTo(1.45);
  });

  it("classifies GPT-5 reasoning deployments without treating chat models as reasoning", () => {
    expect(isReasoningModel("gpt-5.4-nano")).toBe(true);
    expect(isReasoningModel("gpt-5.6-luna")).toBe(true);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
    expect(isReasoningModel("gpt-5-chat")).toBe(false);
  });

  it("charges the reservation when transport fails without provider usage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const c = client();
    const prepared = c.prepare(input);
    const result = await c.consult(prepared);
    expect(result.ok).toBe(false);
    expect(result.call.usageSource).toBe("reserved");
    expect(result.call.reportedUsage).toBeNull();
    expect(result.call.accountedUsage).toEqual(prepared.reservation);
  });

  it("persists a reservation before transport and completes it with reported usage", async () => {
    const s = store();
    const c = client();
    const prepared = c.prepare(input);
    s.beginInferenceCall({ prepared, decisionId: "d1", asset: "BTC", ...c.metadata() });

    let usage = s.inferenceUsageBetween(prepared.startedAt - 1, prepared.startedAt + 1);
    expect(usage.attempts).toBe(1);
    expect(usage.pending).toBe(1);
    expect(usage.accountedTotalTokens).toBe(prepared.reservation.totalTokens);

    s.finishInferenceCall({
      attemptId: prepared.attemptId,
      startedAt: prepared.startedAt,
      completedAt: prepared.startedAt + 50,
      ...c.metadata(),
      transportOk: true,
      validationOk: true,
      failureCode: null,
      failureDetail: null,
      httpStatus: 200,
      reportedUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUsd: 0.000125 },
      accountedUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUsd: 0.000125 },
      usageSource: "reported",
      latencyMs: 50,
    });

    usage = s.inferenceUsageBetween(prepared.startedAt - 1, prepared.startedAt + 100);
    expect(usage.pending).toBe(0);
    expect(usage.transportSuccesses).toBe(1);
    expect(usage.validationSuccesses).toBe(1);
    expect(usage.reportedPromptTokens).toBe(20);
    expect(usage.accountedTotalTokens).toBe(30);
    expect(usage.accountedCostUsd).toBeCloseTo(0.000125);
    s.close();
  });

  it("keeps a crashed pending attempt charged at its reservation", () => {
    const s = store();
    const c = client();
    const prepared = c.prepare(input);
    s.beginInferenceCall({ prepared, decisionId: null, asset: "ETH", ...c.metadata() });
    const usage = s.inferenceUsageBetween(prepared.startedAt - 1, prepared.startedAt + 1);
    expect(usage.pending).toBe(1);
    expect(usage.accountedCostUsd).toBeCloseTo(prepared.reservation.costUsd);
    s.close();
  });

  it("backfills existing decision audits without changing or duplicating them", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyra-inference-legacy-"));
    dirs.push(dir);
    const path = join(dir, "exec.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE decision (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, asset TEXT NOT NULL, action TEXT NOT NULL,
      conviction REAL NOT NULL, expected_move REAL NOT NULL, audit_json TEXT NOT NULL,
      decision_json TEXT NOT NULL, reasoning_arweave_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending'
    )`);
    const audit = JSON.stringify({
      model: "legacy", provider: "azure:test", apiVersion: "v1",
      promptTokens: 100, completionTokens: 25, costUsd: 0.000375, latencyMs: 50,
    });
    db.prepare(`INSERT INTO decision
      (id,at,asset,action,conviction,expected_move,audit_json,decision_json)
      VALUES (?,?,?,?,?,?,?,?)`).run("d1", 1000, "BTC", "hold", 0, 0, audit, "{}");
    db.close();

    const first = new ExecutionStore(path);
    expect(first.inferenceUsageBetween(0, 2000)).toMatchObject({
      attempts: 1, validationSuccesses: 1, accountedTotalTokens: 125,
    });
    first.close();

    const second = new ExecutionStore(path);
    expect(second.inferenceUsageBetween(0, 2000).attempts).toBe(1);
    second.close();
  });
});