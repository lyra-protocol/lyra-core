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
    });
    // The most dangerous window in the system is between here and the stop.
    await this.placeProtectiveStop(positionId, asset);
    this.log(`${asset}: opened ${intent.side} ${fill.filledSize} at ${px}`);
    return { asset, result: "opened", positionId, size: fill.filledSize, px };
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
