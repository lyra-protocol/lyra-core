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
import { DecisionClient } from "./decide/client.js";
import {
  buildUserPrompt,
  DEFAULT_QUESTION,
  painMapObservations,
  positionObservations,
  SYSTEM_PROMPT,
} from "./decide/prompt.js";
import { makerPrice, sizePosition, stopPrice } from "./decide/sizing.js";
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
  /** Read-only handle on the harvester database. */
  venueDb: DatabaseSync;
  limits?: Limits;
  /** Fraction of equity risked per trade, which sets the stop distance. */
  riskPerTrade?: number;
  book: (asset: string) => Promise<{ bid: string; ask: string; ts: number }>;
  mids: () => Promise<Record<string, string>>;
  openInterestUsd: (asset: string) => Promise<number | null>;
  volatility: (asset: string) => Promise<number>;
  log?: (line: string) => void;
};

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

    const outcomes: CycleOutcome[] = [];
    // Closures are drained first: a trade that closed but was never recorded is
    // a hole in the ledger, and it must not wait behind new decisions.
    await this.recordClosures();

    const state = await this.readRiskState();
    const mids = await this.config.mids();

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
    const gate = assessMateriality(
      {
        map,
        last: this.lastSeen.get(asset) ?? null,
        now: Date.now(),
        closuresSinceLast: 0,
        ...(existing
          ? {
              openPosition: {
                notionalUsd: Number(existing.size) * Number(existing.entryPx),
                unrealizedPnlUsd: 0,
                lastReviewedPnlUsd: 0,
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
            notionalUsd: Number(p.size) * Number(p.entryPx),
            unrealizedPnlUsd: 0,
            liquidationPx: null,
            openedAt: p.openedAt,
          }),
        );
      }
    }

    const decisionId = randomUUID();
    const consult = await this.config.client.consult({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(observations, DEFAULT_QUESTION),
      eventIds: observations.map((o) => o.id),
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

    const { decision, audit } = consult;
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

    if (decision.action === "hold") {
      this.config.store.setDecisionOutcome(decisionId, "hold");
      return { asset, result: "held", reasoning: decision.reasoning };
    }
    if (decision.action === "close") {
      this.config.store.setDecisionOutcome(decisionId, "close_requested");
      return await this.closePosition(asset, decisionId);
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

    return await this.openPosition(asset, decisionId, reasoningId, decision, state);
  }

  private async openPosition(
    asset: string,
    decisionId: string,
    reasoningId: string,
    decision: { action: string; conviction: number; expected_move: number },
    state: RiskState,
  ): Promise<CycleOutcome> {
    const side = decision.action === "open_long" ? "long" : "short";
    const b = await this.config.book(asset);

    const price = makerPrice({ side, bid: b.bid, ask: b.ask, tickSize: "0.1" });
    if (!price) {
      return { asset, result: "refused", code: "book_crossed", detail: "book is crossed or inverted" };
    }

    const notionalUsd = sizePosition({
      equityUsd: state.equityUsd,
      conviction: decision.conviction,
      volatility: await this.config.volatility(asset),
      limits: this.limits,
    });
    if (notionalUsd <= 0) {
      return { asset, result: "refused", code: "size_zero", detail: "sizing produced no position" };
    }

    const size = String(notionalUsd / Number(price));
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

    if (placed.status === "filled" && placed.avgFillPx) {
      const positionId = this.config.store.openPosition({
        asset, decisionId, reasoningId, side,
        size: placed.filledSize, entryPx: placed.avgFillPx, openedAt: placed.at, stopCloid: null,
      });
      // The most dangerous window in the system is between here and the stop.
      await this.placeProtectiveStop(positionId, asset);
    }

    this.config.store.setDecisionOutcome(decisionId, "placed");
    return { asset, result: "placed", cloid, price, size };
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
    });
    if (!trigger) return null;

    const cloid = deriveCloid(`${position.decisionId}:stop`, 0);
    await this.config.venue.placeStop({
      asset,
      side: position.side === "long" ? "short" : "long",
      triggerPx: trigger,
      size: position.size,
      cloid,
    });
    this.config.store.attachStop(positionId, cloid);
    this.log(`${asset}: stop resting at ${trigger}`);
    return cloid;
  }

  private async closePosition(asset: string, decisionId: string): Promise<CycleOutcome> {
    const position = this.config.store.positionByAsset(asset);
    if (!position) {
      return { asset, result: "refused", code: "no_position_to_reduce", detail: "nothing open" };
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
