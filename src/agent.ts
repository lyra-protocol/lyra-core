/**
 * The agent.
 *
 * Everything is a reaction to an event. There is no polling loop driving work
 * and no schedule deciding when to trade — market data arrives, the gate decides
 * whether it is worth thinking about, and only then does anything else happen.
 *
 * The order of operations below is not arbitrary. Each step exists because the
 * step before it can fail in a way that must not be inherited:
 *
 *   reconcile   nothing runs until the venue and the store agree
 *   gate        most events die here; thinking is expensive
 *   decide      the model, bounded by a schema that forces its reasoning order
 *   record      reasoning to Arweave BEFORE any order — a prediction, not an excuse
 *   guard       the only thing that can authorise an order
 *   execute     transport only; it has no authority
 *   protect     a stop at the venue, immediately, always
 */

import type { DatabaseSync } from "node:sqlite";
import { buildPainMap, type PainMap } from "./painmap.js";
import { assessMateriality, DEFAULT_MATERIALITY, type LastSeen } from "./decide/materiality.js";
import { closureCountBetween } from "./decide/closure-delta.js";
import { DecisionClient } from "./decide/client.js";
import {
  buildUserPrompt,
  DEFAULT_QUESTION,
  painMapObservations,
  performanceObservations,
  learningObservations,
  positionObservations,
  SYSTEM_PROMPT,
} from "./decide/prompt.js";
import { makerPrice, sizePosition, stopPrice } from "./decide/sizing.js";
import { deriveDecisionMetrics, validateDecisionSemantics } from "./decide/semantics.js";
import type { ShadowEvaluator } from "./decide/shadow.js";
import { Guard } from "./risk/guard.js";
import { DEFAULT_LIMITS, type Limits } from "./risk/limits.js";
import { emptyState, type RiskState } from "./risk/state.js";
import { deriveCloid, type Venue } from "./execute/venue.js";
import { ExecutionStore } from "./execute/store.js";
import { reconcile, repair } from "./execute/reconcile.js";
import { Recorder, ReasoningWriteFailed } from "./record/recorder.js";
import { createHash, randomUUID } from "node:crypto";

export type AgentConfig = {
  universe: readonly string[];
  venue: Venue;
  store: ExecutionStore;
  recorder: Recorder;
  client: DecisionClient;
  shadow?: ShadowEvaluator;
  /** Read-only handle on the harvester database. */
  venueDb: DatabaseSync;
  limits?: Limits;
  /** Fraction of equity risked per trade, which sets the stop distance. */
  riskPerTrade?: number;
  /**
   * Capital the account began with, before any trade.
   *
   * The reference the daily breaker is measured against, reconstructed each
   * cycle as `starting + everything realised before today`. It cannot come from
   * the venue: `equityUsd()` reports equity *now*, and using that as the
   * session baseline makes the drawdown identically zero.
   */
  startingEquityUsd: number;
  /** Immutable identity of the active prompt, schema, model and limits. */
  strategyId?: string;
  book: (asset: string) => Promise<{ bid: string; ask: string; ts: number }>;
  mids: () => Promise<Record<string, string>>;
  openInterestUsd: (asset: string) => Promise<number | null>;
  volatility: (asset: string) => Promise<number>;
  log?: (line: string) => void;
};

export type SettleOutcome =
  | { asset: string; result: "opened"; positionId: number; size: string; px: string }
  | { asset: string; result: "added"; positionId: number; size: string; px: string }
  | { asset: string; result: "closed"; positionId: number; px: string; pnl: string; why: "stop" | "exit" }
  | { asset: string; result: "orphan"; cloid: string; detail: string };

export type CycleOutcome =
  | { asset: string; result: "skipped"; reason: string }
  | { asset: string; result: "held"; reasoning: string }
  | { asset: string; result: "refused"; code: string; detail: string }
  | { asset: string; result: "blocked"; detail: string }
  | { asset: string; result: "placed"; cloid: string; price: string; size: string };

export class Agent {
  private readonly guard: Guard;
  private readonly lastSeen = new Map<string, LastSeen>();
  private readonly limits: Limits;
  private started = false;
  private busy: Promise<void> | null = null;

  constructor(private readonly config: AgentConfig) {
    this.limits = config.limits ?? DEFAULT_LIMITS;
    this.guard = new Guard(this.limits);
  }

  /**
   * Reconciles before anything else, and refuses to start if the venue holds a
   * position this process cannot explain. Starting anyway would mean trading
   * alongside something unknown, which compounds whatever went wrong.
   */
  async start(): Promise<{ ok: boolean; detail: string }> {
    const result = await reconcile(this.config.venue, this.config.store);

    for (const f of result.findings) {
      this.log(`reconcile: ${f.kind} — ${f.detail}`);
    }

    if (!result.safe) {
      return { ok: false, detail: result.haltReason ?? "reconciliation failed" };
    }

    const repaired = await repair(result, this.config.venue, this.config.store, (id, asset) =>
      this.placeProtectiveStop(id, asset),
    );
    if (repaired.repaired > 0) this.log(`reconcile: attached ${repaired.repaired} missing stop(s)`);
    for (const failure of repaired.failed) this.log(`reconcile: REPAIR FAILED — ${failure}`);

    this.started = true;
    return { ok: true, detail: `reconciled: ${result.findings.length} finding(s)` };
  }

  /**
   * One pass over the universe.
   *
   * Driven by the caller on each venue tick rather than by a timer inside, so
   * the agent has no clock of its own and can be exercised deterministically.
   */
  async cycle(): Promise<CycleOutcome[]> {
    if (!this.started) throw new Error("start() must complete before cycle()");
    return this.locked(() => this.runCycle());
  }

  private async runCycle(): Promise<CycleOutcome[]> {
    const outcomes: CycleOutcome[] = [];

    // Reconciled every cycle, not only at startup. Divergence between the venue
    // and the store does not announce itself — a fill missed, a stop rejected,
    // a process restarted mid-order — and a check that runs once catches only
    // the state it happened to start in.
    const agreement = await reconcile(this.config.venue, this.config.store);
    for (const f of agreement.findings) this.log(`reconcile: ${f.kind} — ${f.detail}`);
    if (!agreement.safe) {
      const detail = agreement.haltReason ?? "venue and store disagree";
      this.log(`HALTED — ${detail}`);
      return this.config.universe.map((asset) => ({ asset, result: "blocked" as const, detail }));
    }
    const repaired = await repair(agreement, this.config.venue, this.config.store, (id, asset) =>
      this.placeProtectiveStop(id, asset),
    );
    if (repaired.repaired > 0) this.log(`reconcile: attached ${repaired.repaired} missing stop(s)`);
    for (const failure of repaired.failed) this.log(`reconcile: REPAIR FAILED — ${failure}`);

    // Closures are drained next: a trade that closed but was never recorded is
    // a hole in the ledger, and it must not wait behind new decisions.
    await this.recordClosures();

    const state = await this.readRiskState();
    const mids = await this.config.mids();
    this.config.shadow?.observeMids(mids, Date.now());

    for (const asset of this.config.universe) {
      try {
        outcomes.push(await this.considerAsset(asset, mids[asset], state));
      } catch (error) {
        outcomes.push({
          asset,
          result: "blocked",
          detail: `${(error as Error).name}: ${(error as Error).message}`,
        });
      }
    }
    return outcomes;
  }

  private async considerAsset(
    asset: string,
    mid: string | undefined,
    state: RiskState,
  ): Promise<CycleOutcome> {
    if (!mid) return { asset, result: "skipped", reason: "no mid price published" };

    const map = buildPainMap(this.config.venueDb, asset, mid, {
      venueOpenInterestUsd: await this.config.openInterestUsd(asset),
    });

    const existing = this.config.store.positionByAsset(asset);
    const now = Date.now();
    const last = this.lastSeen.get(asset) ?? null;
    const currentUnrealized = existing ? unrealised(existing, map.midPx) : null;

    // Targets are deterministic exits. They must not wait for coverage, a
    // materiality change, an inference budget, or the consultation interval.
    if (existing?.targetPx) {
      const target = Number(existing.targetPx);
      const mark = Number(map.midPx);
      const reached = existing.side === "long" ? mark >= target : mark <= target;
      if (Number.isFinite(target) && target > 0 && reached) {
        this.log(`${asset}: target ${existing.targetPx} reached at ${map.midPx} — taking it`);
        return await this.closePosition(asset, `${existing.decisionId}:target`, "target_reached");
      }
    }

    const gate = assessMateriality(
      {
        map,
        last,
        now,
        closuresSinceLast: last
          ? closureCountBetween(this.config.venueDb, asset, last.at, now)
          : 0,
        ...(existing
          ? {
              openPosition: {
                positionId: existing.id,
                notionalUsd: Math.abs(Number(existing.size) * Number(map.midPx)),
                unrealizedPnlUsd: currentUnrealized ?? 0,
                lastReviewedPnlUsd:
                  last?.openPosition?.positionId === existing.id
                    ? last.openPosition.unrealizedPnlUsd
                    : null,
              },
            }
          : {}),
      },
      DEFAULT_MATERIALITY,
    );

    if (!gate.consult) {
      return { asset, result: "skipped", reason: `${gate.reason}: ${gate.detail}` };
    }

    // From here a model call is going to happen, so the gate's own state is
    // updated whatever the outcome — a consultation counts as having looked.
    this.lastSeen.set(asset, {
      at: Date.now(),
      aggregateUnrealizedPnlUsd: map.aggregateUnrealizedPnlUsd,
      losingSide: map.losingSide,
      openPosition: existing && currentUnrealized !== null
        ? { positionId: existing.id, unrealizedPnlUsd: currentUnrealized }
        : null,
    });

    return await this.decideAndAct(asset, map, state, existing !== undefined);
  }

  private async decideAndAct(
    asset: string,
    map: PainMap,
    state: RiskState,
    holdsPosition: boolean,
  ): Promise<CycleOutcome> {
    const observations = painMapObservations(map);
    if (holdsPosition) {
      const p = this.config.store.positionByAsset(asset);
      if (p) {
        observations.push(
          ...positionObservations({
            asset,
            side: p.side,
            entryPx: p.entryPx,
            markPx: map.midPx,
            notionalUsd: Number(p.size) * Number(p.entryPx),
            // Real, not zero. She was previously told every open position was
            // flat, which made "is this working?" unanswerable.
            unrealizedPnlUsd: unrealised(p, map.midPx),
            liquidationPx: null,
            stopPx: p.stopPx,
            targetPx: p.targetPx,
            openedAt: p.openedAt,
            thesis: this.config.store.decisionById(p.decisionId),
          }),
        );
      }
    }

    observations.push(...performanceObservations(this.config.store.recentClosures(20)));
    observations.push(...learningObservations(this.config.store.performanceStats()));

    const decisionId = randomUUID();
    const generationExisting = this.config.store.positionByAsset(asset);
    const generationOpening = generationExisting
      ? this.config.store.rawDecision(generationExisting.decisionId)
      : null;
    const originalHypothesis = generationOpening?.hypothesis;
    if (generationExisting && !["magnet", "wall", "cascade"].includes(String(originalHypothesis))) {
      return { asset, result: "blocked", detail: "open position has no valid opening hypothesis" };
    }
    const request = {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(observations, DEFAULT_QUESTION),
      eventIds: observations.map((o) => o.id),
      generationContext: generationExisting
        ? { kind: "positioned" as const, originalHypothesis: originalHypothesis as "magnet" | "wall" | "cascade" }
        : { kind: "flat" as const },
    };
    const prepared = this.config.client.prepare(request);
    const budget = this.guard.approveInference(prepared.reservation, state);
    if (!budget.ok) {
      return { asset, result: "refused", code: budget.code, detail: budget.detail };
    }

    const metadata = this.config.client.metadata();
    this.config.store.beginInferenceCall({
      prepared, decisionId, asset, ...metadata,
    });

    const consult = await this.config.client.consult(prepared);
    try {
      this.config.store.finishInferenceCall(
        consult.call,
        consult.audit?.rawOutput ?? null,
        consult.ok ? JSON.stringify(consult.decision) : null,
      );
    } catch (error) {
      // The reserved call remains durable and charged. Acting without completing
      // its audit would separate a decision from the compute that produced it.
      return {
        asset,
        result: "blocked",
        detail: `could not finish inference accounting: ${(error as Error).message}`,
      };
    }
    state.inferenceSpentTodayUsd += consult.call.accountedUsage.costUsd;
    state.inferenceTokensToday += consult.call.accountedUsage.totalTokens;
    state.inferenceAttemptsToday += 1;

    const existingForShadow = this.config.store.positionByAsset(asset);
    const openingForShadow = existingForShadow
      ? this.config.store.rawDecision(existingForShadow.decisionId)
      : null;
    this.config.shadow?.evaluate({
      championDecisionId: decisionId,
      championAttemptId: consult.call.attemptId,
      asset,
      request,
      champion: consult,
      semanticContext: {
        entryPx: existingForShadow ? Number(existingForShadow.entryPx) : Number(map.midPx),
        existingPosition: existingForShadow ? {
          side: existingForShadow.side,
          hypothesis: typeof openingForShadow?.hypothesis === "string"
            ? openingForShadow.hypothesis as "magnet" | "wall" | "cascade" | "none"
            : null,
        } : undefined,
        minExpectedMove: this.limits.minExpectedMove,
        minRewardRisk: this.limits.minRewardRisk,
      },
    });

    if (!consult.ok) {
      // Every failure is "no trade". Fail closed: the absence of a decision is a
      // safe state, a guessed one is not.
      return {
        asset,
        result: "refused",
        code: consult.failure.code,
        detail: consult.failure.detail,
      };
    }

    const { audit } = consult;
    const decision = deriveDecisionMetrics(consult.decision, Number(map.midPx));
    this.config.store.saveDecision({
      id: decisionId,
      at: audit.at,
      asset,
      action: decision.action,
      conviction: decision.conviction,
      expectedMove: decision.expected_move,
      auditJson: JSON.stringify(audit),
      decisionJson: JSON.stringify(decision),
    });

    const existing = this.config.store.positionByAsset(asset);
    if (decision.action === "hold" || decision.action === "close") {
      const original = existing ? this.config.store.rawDecision(existing.decisionId) : null;
      const semantics = validateDecisionSemantics(decision, {
        entryPx: existing ? Number(existing.entryPx) : Number(map.midPx),
        existingPosition: existing
          ? {
              side: existing.side,
              hypothesis: typeof original?.hypothesis === "string"
                ? original.hypothesis as typeof decision.hypothesis
                : null,
            }
          : undefined,
        minExpectedMove: this.limits.minExpectedMove,
        minRewardRisk: this.limits.minRewardRisk,
      });
      if (!semantics.ok) {
        this.config.store.setDecisionOutcome(decisionId, `refused:semantic:${semantics.failure.code}`);
        return {
          asset, result: "refused", code: semantics.failure.code, detail: semantics.failure.detail,
        };
      }
    }

    if (decision.action === "hold") {
      this.config.store.setDecisionOutcome(decisionId, "hold");
      return { asset, result: "held", reasoning: decision.reasoning };
    }
    if (decision.action === "close") {
      this.config.store.setDecisionOutcome(decisionId, "close_requested");
      return await this.closePosition(
        asset,
        decisionId,
        decision.thesis_status === "played_out" ? "thesis_played_out" : "thesis_invalidated",
      );
    }

    const plan = await this.prepareOpeningPlan(asset, decision, state);
    if (!plan.ok) {
      this.config.store.setDecisionOutcome(decisionId, `refused:semantic:${plan.code}`);
      return { asset, result: "refused", code: plan.code, detail: plan.detail };
    }

    // The blocking rule (§8.7). Reasoning goes to Arweave before any order, and
    // if it cannot be written the trade does not happen.
    let reasoningId: string;
    try {
      reasoningId = await this.config.recorder.writeReasoning(decisionId, asset, decision, audit);
      this.config.store.setReasoningId(decisionId, reasoningId);
    } catch (error) {
      if (error instanceof ReasoningWriteFailed) {
        this.config.store.setDecisionOutcome(decisionId, "blocked_no_reasoning");
        return { asset, result: "blocked", detail: error.message };
      }
      throw error;
    }

    return await this.openPosition(asset, decisionId, reasoningId, decision, state, plan);
  }

  private async prepareOpeningPlan(
    asset: string,
    decision: { action: string; conviction: number; expected_move: number; target_px?: number; hypothesis?: string; thesis_status?: string },
    state: RiskState,
  ): Promise<
    | { ok: true; side: "long" | "short"; book: { bid: string; ask: string; ts: number }; price: string; notionalUsd: number; size: string; stopPx: string }
    | { ok: false; code: string; detail: string }
  > {
    const side = decision.action === "open_long" ? "long" : "short";
    const book = await this.config.book(asset);
    const price = makerPrice({ side, bid: book.bid, ask: book.ask, tickSize: "0.1" });
    if (!price) return { ok: false, code: "book_crossed", detail: "book is crossed or inverted" };
    const notionalUsd = sizePosition({
      equityUsd: state.equityUsd,
      conviction: decision.conviction,
      volatility: await this.config.volatility(asset),
      limits: this.limits,
    });
    if (notionalUsd <= 0) return { ok: false, code: "size_zero", detail: "sizing produced no position" };
    const stop = stopPrice({
      side, entryPx: price, notionalUsd, equityUsd: state.equityUsd,
      riskFraction: this.config.riskPerTrade ?? 0.02,
      targetPx: typeof decision.target_px === "number" ? String(decision.target_px) : null,
      minRewardRisk: this.limits.minRewardRisk,
    });
    if (!stop) return { ok: false, code: "stop_invalid", detail: "could not derive a protective stop" };
    const semantics = validateDecisionSemantics(decision as Parameters<typeof validateDecisionSemantics>[0], {
      entryPx: Number(price),
      stopPx: Number(stop),
      minExpectedMove: this.limits.minExpectedMove,
      minRewardRisk: this.limits.minRewardRisk,
    });
    if (!semantics.ok) return { ok: false, code: semantics.failure.code, detail: semantics.failure.detail };
    return { ok: true, side, book, price, notionalUsd, size: String(notionalUsd / Number(price)), stopPx: stop };
  }

  private async openPosition(
    asset: string,
    decisionId: string,
    reasoningId: string,
    decision: { action: string; conviction: number; expected_move: number },
    state: RiskState,
    plan: { ok: true; side: "long" | "short"; book: { bid: string; ask: string; ts: number }; price: string; notionalUsd: number; size: string; stopPx: string },
  ): Promise<CycleOutcome> {
    const { side, book: b, price, notionalUsd, size } = plan;
    const cloid = deriveCloid(decisionId, 0);

    const approval = this.guard.approveOpen(
      {
        intent: { asset, side, price, size, reduceOnly: false, cloid },
        book: { asset, ...b },
        expectedMove: Math.abs(decision.expected_move),
        decidedAt: Date.now(),
        notionalUsd,
      },
      state,
    );
    if (!approval.ok) {
      this.config.store.setDecisionOutcome(decisionId, `refused:${approval.code}`);
      return { asset, result: "refused", code: approval.code, detail: approval.detail };
    }

    // Persisted before the network call, always.
    this.config.store.createIntent({
      cloid, decisionId, asset, side, price, size,
      reduceOnly: false, tif: approval.order.tif, attempt: 0, createdAt: Date.now(),
    });

    const placed = await this.config.venue.place(approval.order);
    this.config.store.updateIntent(cloid, {
      status: placed.status === "resting" ? "placed" : placed.status === "filled" ? "filled" : "cancelled",
      venueOrderId: placed.venueOrderId,
      filledSize: placed.filledSize,
      avgFillPx: placed.avgFillPx,
      fee: placed.fee,
      detail: placed.reason ?? null,
    });

    if (placed.status === "cancelled") {
      // An ALO order that would have crossed. Re-price next cycle; never escalate.
      return { asset, result: "refused", code: "would_cross_spread", detail: placed.reason ?? "" };
    }

    // An immediate fill is unusual — every order is maker-only — but if the
    // venue reports one it goes through the same adoption path as a later fill.
    // Two routes from a fill to a position is how one of them ends up untested.
    if (placed.status === "filled" && placed.avgFillPx) {
      await this.adoptFill(asset, {
        cloid, filledSize: placed.filledSize, avgFillPx: placed.avgFillPx,
        fee: placed.fee, at: placed.at,
      });
    }

    this.config.store.setDecisionOutcome(decisionId, "placed");
    return { asset, result: "placed", cloid, price, size };
  }

  /**
   * Adopts fills for orders that were already resting.
   *
   * Every order she places is maker-only, so `place()` returns `resting` and
   * the fill lands seconds or hours later. Until this runs, the fill exists
   * only at the venue: the store has no position, so no stop is attached, the
   * guard sees a flat account and the recorder has nothing to write. The whole
   * safety chain hangs off this method being called.
   *
   * Runs under the same lock as `cycle()`. Both place orders and both write the
   * store, and a fill adopted halfway through a decision would be sized against
   * an account state that no longer exists.
   */
  async settle(): Promise<SettleOutcome[]> {
    return this.locked(async () => {
      const outcomes: SettleOutcome[] = [];
      for (const asset of this.config.universe) {
        let fills: Awaited<ReturnType<Venue["settle"]>>;
        try {
          fills = await this.config.venue.settle(asset);
        } catch (error) {
          // A settle failure must not stop the others; reconciliation is the
          // backstop for anything missed here.
          this.log(`settle ${asset} FAILED: ${(error as Error).message}`);
          continue;
        }
        for (const fill of fills) {
          if (fill.status !== "filled" || !fill.avgFillPx) continue;
          try {
            outcomes.push(await this.adoptFill(asset, fill));
          } catch (error) {
            this.log(`adopt ${asset} ${fill.cloid} FAILED: ${(error as Error).message}`);
          }
        }
      }
      return outcomes;
    });
  }

  /** Routes one fill to open, add, or close. */
  private async adoptFill(
    asset: string,
    fill: { cloid: string; filledSize: string; avgFillPx: string | null; fee: string; at: number },
  ): Promise<SettleOutcome> {
    const px = fill.avgFillPx!;

    // A triggered stop arrives under the stop's cloid, not the entry's.
    const stopped = this.config.store.positionByStopCloid(fill.cloid);
    if (stopped) {
      const pnl = realisedPnl(stopped, px);
      const fees = String(Number(stopped.fees ?? "0") + Number(fill.fee));
      this.config.store.closePosition(stopped.id, { closedAt: fill.at, exitPx: px, pnl, fees });
      this.config.store.setCloseAttribution(stopped.id, {
        reason: "stop_triggered", decisionId: null, cloid: fill.cloid,
      });
      await this.cancelRestingFor(asset, stopped, fill.cloid);
      this.log(`${asset}: STOPPED OUT at ${px}, pnl ${pnl}`);
      return { asset, result: "closed", positionId: stopped.id, px, pnl, why: "stop" };
    }

    const intent = this.config.store.getIntent(fill.cloid);
    if (!intent) {
      // Neither a known order nor a known stop. Reconciliation halts on this;
      // it is recorded rather than swallowed so the halt has a cause.
      return { asset, result: "orphan", cloid: fill.cloid, detail: "fill for an unknown order" };
    }

    this.config.store.updateIntent(fill.cloid, {
      status: "filled",
      venueOrderId: intent.venueOrderId,
      filledSize: fill.filledSize,
      avgFillPx: px,
      fee: fill.fee,
    });

    const open = this.config.store.positionByAsset(asset);

    if (intent.reduceOnly) {
      if (!open) return { asset, result: "orphan", cloid: fill.cloid, detail: "reduce with nothing open" };
      const pnl = realisedPnl(open, px);
      const fees = String(Number(open.fees ?? "0") + Number(fill.fee));
      this.config.store.closePosition(open.id, { closedAt: fill.at, exitPx: px, pnl, fees });
      this.config.store.setCloseAttribution(open.id, {
        reason: closeReasonFor(this.config.store, intent.decisionId),
        decisionId: intent.decisionId,
        cloid: fill.cloid,
      });
      await this.cancelRestingFor(asset, open, fill.cloid);
      this.log(`${asset}: closed at ${px}, pnl ${pnl}`);
      return { asset, result: "closed", positionId: open.id, px, pnl, why: "exit" };
    }

    // She scales into a level across several orders, so a same-side fill on an
    // open position is an addition. A second row would make positionByAsset
    // ambiguous and halve the notional the guard sees.
    if (open && open.side === intent.side) {
      const size = String(Number(open.size) + Number(fill.filledSize));
      const entryPx = String(
        (Number(open.size) * Number(open.entryPx) + Number(fill.filledSize) * Number(px)) /
          Number(size),
      );
      const fees = String(Number(open.fees ?? "0") + Number(fill.fee));
      this.config.store.resizePosition(open.id, { size, entryPx, fees });
      // The stop was sized for the old position; it has to move with it.
      await this.placeProtectiveStop(open.id, asset);
      this.log(`${asset}: added ${fill.filledSize} at ${px} → ${size} @ ${entryPx}`);
      return { asset, result: "added", positionId: open.id, size, px };
    }

    if (open) {
      return { asset, result: "orphan", cloid: fill.cloid, detail: "fill opposes an open position" };
    }

    const opening = this.config.store.rawDecision(intent.decisionId);
    const positionId = this.config.store.openPosition({
      asset,
      decisionId: intent.decisionId,
      reasoningId: this.config.store.reasoningIdFor(intent.decisionId),
      side: intent.side,
      size: fill.filledSize,
      entryPx: px,
      openedAt: fill.at,
      stopCloid: null,
      fees: fill.fee,
      // The price she said would prove her right. Without it the position has
      // no exit but the model's nerve, which is what cut winners at +0.05%.
      targetPx: targetPxFor(this.config.store, intent.decisionId),
      openAction: typeof opening?.action === "string" ? opening.action : null,
      hypothesis: typeof opening?.hypothesis === "string" ? opening.hypothesis : null,
      conviction: typeof opening?.conviction === "number" ? opening.conviction : null,
      expectedMove: typeof opening?.expected_move === "number" ? opening.expected_move : null,
      strategyId: this.config.strategyId ?? null,
    });
    // The most dangerous window in the system is between here and the stop.
    await this.placeProtectiveStop(positionId, asset);
    this.log(`${asset}: opened ${intent.side} ${fill.filledSize} at ${px}`);
    return { asset, result: "opened", positionId, size: fill.filledSize, px };
  }

  /**
   * Cancels everything still resting for an asset she is no longer in.
   *
   * A position closes by one route, but it can be *closed by* three: the stop
   * triggers, a maker exit fills, or reconciliation flattens it. Whichever one
   * wins, the other orders are still live at the venue — and a reduce-only
   * order with nothing to reduce does not expire harmlessly, it opens the
   * opposite side at full size.
   *
   * This is the same failure that put her long 0.70 ETH at 1847 with no
   * decision behind it, reached from a different direction, so it is cleaned up
   * where every close converges rather than at each call site.
   */
  private async cancelRestingFor(
    asset: string,
    position: { stopCloid: string | null },
    exceptCloid: string,
  ): Promise<void> {
    const cancel = async (cloid: string, what: string) => {
      try {
        await this.config.venue.cancel(asset, cloid);
        this.log(`${asset}: cancelled ${what}`);
      } catch (error) {
        // Worth shouting about: a stop left resting on a flat account is the
        // exact condition this method exists to prevent.
        this.log(`${asset}: COULD NOT CANCEL ${what} — ${(error as Error).message}`);
      }
    };

    if (position.stopCloid && position.stopCloid !== exceptCloid) {
      await cancel(position.stopCloid, "protective stop");
    }
    for (const i of this.config.store.unresolvedIntents()) {
      if (i.asset !== asset || !i.reduceOnly || i.cloid === exceptCloid) continue;
      await cancel(i.cloid, `resting exit at ${i.price}`);
      this.config.store.updateIntent(i.cloid, {
        status: "cancelled",
        venueOrderId: i.venueOrderId,
        filledSize: i.filledSize,
        avgFillPx: i.avgFillPx,
        fee: i.fee,
        detail: "position already closed",
      });
    }
  }

  /** Serialises settle and cycle; they both write the store and place orders. */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await this.busy.catch(() => {});
    let release!: () => void;
    this.busy = new Promise<void>((r) => { release = r; });
    try {
      return await fn();
    } finally {
      release();
      this.busy = null;
    }
  }

  /** Attaches a stop at the venue. Called on fill, and by reconciliation on repair. */
  private async placeProtectiveStop(positionId: number, asset: string): Promise<string | null> {
    const position = this.config.store
      .openPositions()
      .find((p) => p.id === positionId);
    if (!position) return null;

    const equityUsd = await this.config.venue.equityUsd();
    const notionalUsd = Number(position.size) * Number(position.entryPx);
    const trigger = stopPrice({
      side: position.side,
      entryPx: position.entryPx,
      notionalUsd,
      equityUsd,
      riskFraction: this.config.riskPerTrade ?? 0.02,
      targetPx: position.targetPx,
      minRewardRisk: this.limits.minRewardRisk,
    });
    if (!trigger) return null;

    // Re-stopping after a size change: the old trigger is for a size that no
    // longer exists, and leaving it resting would close more than she holds.
    if (position.stopCloid) {
      try { await this.config.venue.cancel(asset, position.stopCloid); }
      catch (error) { this.log(`${asset}: could not cancel old stop — ${(error as Error).message}`); }
    }

    const cloid = deriveCloid(`${position.decisionId}:stop`, position.stopCloid ? 1 : 0);
    await this.config.venue.placeStop({
      asset,
      side: position.side === "long" ? "short" : "long",
      triggerPx: trigger,
      size: position.size,
      cloid,
    });
    this.config.store.attachStop(positionId, cloid, trigger);
    this.log(`${asset}: stop resting at ${trigger}`);
    return cloid;
  }

  private async closePosition(
    asset: string,
    decisionId: string,
    reason: "target_reached" | "thesis_invalidated" | "thesis_played_out" = "thesis_invalidated",
  ): Promise<CycleOutcome> {
    const position = this.config.store.positionByAsset(asset);
    if (!position) {
      return { asset, result: "refused", code: "no_position_to_reduce", detail: "nothing open" };
    }

    /*
     * One exit at a time.
     *
     * An exit is maker-only like everything else, so it rests — and she may
     * reach the same conclusion again on the next cycle while it is still
     * resting. Two reduce-only orders for one position do not cancel each
     * other: the first flattens her and the second opens the opposite side at
     * full size. Observed live, on ETH: closed at 1847, then immediately long
     * 0.70 ETH that no decision asked for.
     *
     * Nothing downstream can undo this. The venue applies both fills before
     * anything here sees either, so the only place it can be prevented is
     * before the second order is sent.
     */
    const exiting = restingExitFor(this.config.store.unresolvedIntents(), asset);
    if (exiting) {
      return {
        asset, result: "refused", code: "exit_already_resting",
        detail: `a close for ${asset} is already resting at ${exiting.price}`,
      };
    }
    const b = await this.config.book(asset);
    const side = position.side === "long" ? "short" : "long";
    const price = makerPrice({ side, bid: b.bid, ask: b.ask, tickSize: "0.1" });
    if (!price) {
      return { asset, result: "refused", code: "book_crossed", detail: "book is crossed" };
    }

    const cloid = deriveCloid(`${decisionId}:close`, 0);
    const approval = this.guard.approveReduce(
      {
        intent: { asset, side, price, size: position.size, reduceOnly: true, cloid },
        book: { asset, ...b },
        decidedAt: Date.now(),
      },
      await this.readRiskState(),
    );
    if (!approval.ok) {
      return { asset, result: "refused", code: approval.code, detail: approval.detail };
    }

    this.config.store.createIntent({
      cloid, decisionId, asset, side, price, size: position.size,
      reduceOnly: true, tif: approval.order.tif, attempt: 0, createdAt: Date.now(),
    });
    this.config.store.setCloseAttribution(position.id, { reason, decisionId, cloid });
    const placed = await this.config.venue.place(approval.order);
    this.config.store.updateIntent(cloid, {
      status: placed.status === "filled" ? "filled" : "placed",
      venueOrderId: placed.venueOrderId,
      filledSize: placed.filledSize,
      avgFillPx: placed.avgFillPx,
      fee: placed.fee,
    });

    return { asset, result: "placed", cloid, price, size: position.size };
  }

  /**
   * Writes closed trades to the ledger.
   *
   * `recordTrade` is idempotent on sequence, so retrying an already-written
   * trade returns the existing record rather than duplicating it. Drained every
   * cycle because a closure that never reaches Arweave is a permanent gap.
   */
  private async recordClosures(): Promise<void> {
    for (const position of this.config.store.unrecordedClosures()) {
      try {
        const written = await this.config.recorder.writeTrade({
          pair: position.asset,
          side: position.side,
          entryPrice: position.entryPx,
          exitPrice: position.exitPx ?? "0",
          size: position.size,
          pnl: position.pnl ?? "0",
          fees: position.fees ?? "0",
          openTimestamp: position.openedAt,
          closeTimestamp: position.closedAt ?? Date.now(),
          venueOpenId: position.decisionId,
          venueCloseId: `${position.decisionId}:close`,
          reasoningId: position.reasoningId,
        });
        this.config.store.markRecorded(position.id, written.sequence, written.arweaveId);
        this.log(`recorded ${position.asset} #${written.sequence} → ${written.arweaveId}`);
      } catch (error) {
        // Never dropped. It stays in the unrecorded set and is retried next cycle.
        this.log(`record FAILED for ${position.asset}: ${(error as Error).message}`);
      }
    }
  }

  private async readRiskState(): Promise<RiskState> {
    const equity = await this.config.venue.equityUsd();
    const state = emptyState(equity, this.config.universe);

    // Sessions roll at UTC midnight. Measuring from the session's opening
    // equity rather than the intraday peak means a profitable but volatile day
    // is not halted for giving back part of a gain — but it only works if the
    // opening figure is genuinely from this morning, not from this instant.
    const midnight = new Date().setUTCHours(0, 0, 0, 0);
    const r = this.config.store.realisedAround(midnight);
    state.sessionStartEquityUsd = this.config.startingEquityUsd + r.beforePnl - r.beforeFees;
    state.feesPaidTodayUsd = r.sinceFees;
    const inference = this.config.store.inferenceUsageBetween(midnight, midnight + 86_400_000);
    state.inferenceSpentTodayUsd = inference.accountedCostUsd;
    state.inferenceTokensToday = inference.accountedTotalTokens;
    state.inferenceAttemptsToday = inference.attempts;
    const stopWindowStart = Date.now() - this.limits.sameDirectionStopCooldownMs;
    for (const stop of this.config.store.recentStopsSince(stopWindowStart)) {
      state.lastStopByAssetSide.set(`${stop.asset}:${stop.side}`, stop.at);
    }
    for (const p of this.config.store.openPositions()) {
      const notional = Number(p.size) * Number(p.entryPx);
      state.positions.set(p.asset, {
        asset: p.asset,
        side: p.side,
        notionalUsd: notional,
        entryPx: p.entryPx,
        liquidationPx: null,
      });
      state.totalNotionalUsd += notional;
    }
    return state;
  }

  private log(line: string): void {
    (this.config.log ?? ((l: string) => process.stdout.write(`${l}\n`)))(line);
  }
}

/** Unrealised PnL on an open position at the current mark. */
function unrealised(p: { side: "long" | "short"; size: string; entryPx: string }, markPx?: string): number {
  if (!markPx) return 0;
  const move = Number(markPx) - Number(p.entryPx);
  return (p.side === "long" ? move : -move) * Number(p.size);
}

/** The target named by the decision that opened a position, as a string. */
function targetPxFor(store: ExecutionStore, decisionId: string): string | null {
  const d = store.rawDecision(decisionId);
  const t = d?.target_px;
  return typeof t === "number" && t > 0 ? String(t) : null;
}

function closeReasonFor(
  store: ExecutionStore,
  decisionId: string,
): "target_reached" | "thesis_invalidated" | "thesis_played_out" | "legacy_unknown" {
  if (decisionId.endsWith(":target")) return "target_reached";
  const d = store.rawDecision(decisionId);
  if (d?.thesis_status === "played_out") return "thesis_played_out";
  if (d?.thesis_status === "invalidated") return "thesis_invalidated";
  return "legacy_unknown";
}

/**
 * The exit already working for an asset, if there is one.
 *
 * Exported because it is the whole of a rule that cost a real position: two
 * reduce-only orders for one position do not net off, they reverse it. A rule
 * that can only be reached through a full decision cycle is a rule that is
 * never tested directly.
 */
export function restingExitFor<T extends { asset: string; reduceOnly: boolean }>(
  intents: readonly T[],
  asset: string,
): T | undefined {
  return intents.find((i) => i.asset === asset && i.reduceOnly);
}

/**
 * Realised PnL on a closed position, before fees.
 *
 * Fees are added by the caller rather than netted here, because the ledger
 * reports pnl and fees as separate fields and a figure that silently includes
 * costs cannot be checked against the venue's own numbers.
 */
function realisedPnl(p: { side: "long" | "short"; size: string; entryPx: string }, exitPx: string): string {
  const move = Number(exitPx) - Number(p.entryPx);
  return String((p.side === "long" ? move : -move) * Number(p.size));
}

/** Strategy identity: the full decision configuration, not just "which rules ran". */
export function strategyId(parts: {
  promptTemplate: string;
  schemaHash: string;
  model: string;
  limits: Limits;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        promptTemplate: parts.promptTemplate,
        schemaHash: parts.schemaHash,
        model: parts.model,
        limits: parts.limits,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
