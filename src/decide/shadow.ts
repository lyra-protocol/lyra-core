import { randomUUID } from "node:crypto";
import type { DecisionClient, ConsultInput, ConsultResult } from "./client.js";
import type { Decision } from "./schema.js";
import { deriveDecisionMetrics, validateDecisionSemantics, type DecisionContext } from "./semantics.js";
import type { ExecutionStore } from "../execute/store.js";
import {
  advanceVirtualPosition,
  DEFAULT_SHADOW_OUTCOME_CONFIG,
  deriveVirtualOpening,
  SHADOW_OUTCOME_VERSION,
  type ShadowOutcomeConfig,
} from "./shadow-outcome.js";

export type ShadowEvaluatorConfig = {
  client: DecisionClient;
  store: ExecutionStore;
  maxDailyUsd: number;
  maxDailyTokens: number;
  outcome?: Partial<ShadowOutcomeConfig>;
  log?: (line: string) => void;
};

/** Read-only challenger: it has no venue, recorder, guard, or execution callbacks. */
export class ShadowEvaluator {
  private busy = false;
  private readonly outcomeConfig: ShadowOutcomeConfig;
  constructor(private readonly config: ShadowEvaluatorConfig) {
    this.outcomeConfig = { ...DEFAULT_SHADOW_OUTCOME_CONFIG, ...config.outcome };
  }

  evaluate(input: {
    championDecisionId: string;
    championAttemptId: string;
    asset: string;
    request: ConsultInput;
    champion: ConsultResult;
    semanticContext: DecisionContext;
  }): void {
    const pairId = randomUUID();
    const metadata = this.config.client.metadata();
    const championAudit = input.champion.audit;
    const normalizedChampion = input.champion.ok
      ? deriveDecisionMetrics(input.champion.decision, input.semanticContext.entryPx)
      : null;
    this.config.store.beginShadowEvaluation({
      pairId,
      championDecisionId: input.championDecisionId,
      championAttemptId: input.championAttemptId,
      asset: input.asset,
      createdAt: Date.now(),
      promptHash: input.champion.audit?.promptHash ?? "unavailable",
      challengerModel: metadata.model,
      status: this.busy ? "skipped_busy" : "pending",
      promptTemplate: championAudit?.promptTemplate ?? null,
      schemaHash: championAudit?.schemaHash ?? null,
      championModel: championAudit?.model ?? null,
      evaluationVersion: SHADOW_OUTCOME_VERSION,
      championDecisionJson: normalizedChampion ? JSON.stringify(normalizedChampion) : null,
    });
    if (this.busy) return;

    this.busy = true;
    queueMicrotask(() => {
      void this.run(pairId, input, metadata).catch((error) => {
        this.config.store.finishShadowEvaluation(pairId, {
          status: "internal_failure", detail: (error as Error).message,
        });
        this.log(`shadow ${input.asset} failed: ${(error as Error).message}`);
      }).finally(() => { this.busy = false; });
    });
  }

  private async run(
    pairId: string,
    input: Parameters<ShadowEvaluator["evaluate"]>[0],
    metadata: ReturnType<DecisionClient["metadata"]>,
  ): Promise<void> {
    const midnight = new Date().setUTCHours(0, 0, 0, 0);
    const used = this.config.store.inferenceUsageBetween(midnight, midnight + 86_400_000, "challenger");
    const prepared = this.config.client.prepare(input.request);
    if (
      used.accountedCostUsd + prepared.reservation.costUsd > this.config.maxDailyUsd ||
      used.accountedTotalTokens + prepared.reservation.totalTokens > this.config.maxDailyTokens
    ) {
      this.config.store.finishShadowEvaluation(pairId, { status: "skipped_budget" });
      return;
    }

    this.config.store.beginInferenceCall({
      prepared, decisionId: input.championDecisionId, asset: input.asset,
      ...metadata, role: "challenger", pairId,
    });
    const challenger = await this.config.client.consult(prepared);
    this.config.store.finishInferenceCall(
      challenger.call,
      challenger.audit?.rawOutput ?? null,
      challenger.ok ? JSON.stringify(challenger.decision) : null,
    );

    if (!challenger.ok) {
      this.config.store.finishShadowEvaluation(pairId, {
        challengerAttemptId: challenger.call.attemptId,
        status: challenger.failure.code === "transport"
          ? "challenger_transport_failed"
          : "challenger_validation_failed",
        detail: challenger.failure.detail,
      });
      return;
    }

    const champion = input.champion;
    const championDecision = champion.ok
      ? deriveDecisionMetrics(champion.decision, input.semanticContext.entryPx)
      : null;
    const challengerDecision = deriveDecisionMetrics(challenger.decision, input.semanticContext.entryPx);
    const championSemantic = championDecision
      ? validateDecisionSemantics(championDecision, input.semanticContext)
      : null;
    const challengerSemantic = validateDecisionSemantics(challengerDecision, input.semanticContext);
    const comparable = champion.ok && championSemantic?.ok && challengerSemantic.ok;
    const comparison = comparable && championDecision
      ? compare(championDecision, challengerDecision, input.semanticContext.entryPx)
      : null;
    this.config.store.finishShadowEvaluation(pairId, {
      challengerAttemptId: challenger.call.attemptId,
      status: "completed",
      championSemanticCode: championSemantic && !championSemantic.ok ? championSemantic.failure.code : null,
      challengerSemanticCode: !challengerSemantic.ok ? challengerSemantic.failure.code : null,
      actionAgreement: comparison?.action ?? null,
      hypothesisAgreement: comparison?.hypothesis ?? null,
      targetAgreement: comparison?.target ?? null,
      convictionAgreement: comparison?.conviction ?? null,
      allAgreement: comparison?.all ?? null,
      targetRelativeDelta: comparison?.targetDelta ?? null,
      convictionAbsoluteDelta: comparison?.convictionDelta ?? null,
      challengerDecisionJson: JSON.stringify(challengerDecision),
    });
    this.log(
      `shadow ${input.asset}: champion=${champion.ok ? champion.decision.action : "invalid"} ` +
      `challenger=${challenger.decision.action} agreement=${comparison?.all ?? "n/a"}`,
    );
  }

  private log(line: string): void { this.config.log?.(line); }

  /** Outcome tracking is observational only: persisted mids in, no venue handle out. */
  observeMids(mids: Record<string, string>, sampledAt = Date.now()): void {
    for (const candidate of this.config.store.shadowOutcomeCandidates()) {
      const entryPx = Number(mids[candidate.asset]);
      if (!Number.isFinite(entryPx) || entryPx <= 0) continue;
      try {
        for (const role of ["champion", "challenger"] as const) {
          const raw = role === "champion"
            ? candidate.championDecisionJson
            : candidate.challengerDecisionJson;
          const opening = deriveVirtualOpening({
            candidate, role, decision: JSON.parse(raw) as Decision,
            entryPx, openedAt: sampledAt, config: this.outcomeConfig,
          });
          if (opening) this.config.store.createShadowVirtualPosition(opening);
        }
        this.config.store.markShadowOutcomeMaterialized(candidate.pairId, sampledAt);
      } catch (error) {
        this.log(`shadow outcome ${candidate.pairId} invalid: ${(error as Error).message}`);
        this.config.store.markShadowOutcomeMaterialized(candidate.pairId, sampledAt);
      }
    }

    for (const position of this.config.store.openShadowVirtualPositions()) {
      const midPx = Number(mids[position.asset]);
      const update = advanceVirtualPosition(position, midPx, sampledAt, this.outcomeConfig);
      if (update) this.config.store.updateShadowVirtualPosition(position.id, update);
    }
  }
}

export function compare(champion: Decision, challenger: Decision, entryPx: number) {
  const targetDelta = entryPx > 0 ? Math.abs(champion.target_px - challenger.target_px) / entryPx : 0;
  const convictionDelta = Math.abs(champion.conviction - challenger.conviction);
  const action = champion.action === challenger.action;
  const hypothesis = champion.hypothesis === challenger.hypothesis;
  const target = targetDelta <= 0.001;
  const conviction = convictionDelta <= 0.05;
  return { action, hypothesis, target, conviction, all: action && hypothesis && target && conviction, targetDelta, convictionDelta };
}
