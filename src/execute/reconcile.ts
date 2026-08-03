/**
 * Startup reconciliation.
 *
 * Runs before anything else, every time the process starts. Nothing may trade
 * until it has completed (DESIGN.md §9.5), because the alternative is an agent
 * that begins placing orders while holding positions it does not know about.
 *
 * Three findings, in descending order of danger:
 *
 *   1. **A position with no stop.** The worst state the system can be in. It
 *      means a crash landed between a fill and its protection, and the position
 *      is currently naked. Repaired immediately, before anything else.
 *   2. **A position the store does not know about.** Something placed an order
 *      this process cannot explain. Halt — do not guess, do not adopt it, and do
 *      not trade alongside it.
 *   3. **An intent with no order at the venue.** Benign: the crash happened
 *      before placement, or the order was cancelled. Marked resolved.
 */

import type { Venue } from "./venue.js";
import type { ExecutionStore } from "./store.js";

export type ReconcileFinding =
  | { kind: "unprotected_position"; asset: string; positionId: number; detail: string }
  | { kind: "unknown_position"; asset: string; detail: string }
  | { kind: "orphan_intent"; cloid: string; detail: string }
  | { kind: "filled_while_down"; cloid: string; asset: string; detail: string }
  | { kind: "stop_missing_at_venue"; asset: string; positionId: number; detail: string };

export type ReconcileResult = {
  findings: ReconcileFinding[];
  /** True when it is safe to begin trading. */
  safe: boolean;
  /** Set when unsafe, naming the reason a human must resolve. */
  haltReason: string | null;
};

/**
 * Compares venue truth against local belief.
 *
 * The venue is always right about what exists. The store is the only thing that
 * knows *why*. Where they disagree about existence, the venue wins; where the
 * store cannot explain something the venue holds, the system stops.
 */
export async function reconcile(
  venue: Venue,
  store: ExecutionStore,
): Promise<ReconcileResult> {
  const findings: ReconcileFinding[] = [];

  const [venuePositions, venueOrders] = await Promise.all([
    venue.positions(),
    venue.openOrders(),
  ]);

  const storedOpen = store.openPositions();
  const storedByAsset = new Map(storedOpen.map((p) => [p.asset, p]));
  const venueByAsset = new Map(venuePositions.map((p) => [p.asset, p]));
  const triggersByAsset = new Set(venueOrders.filter((o) => o.isTrigger).map((o) => o.asset));

  // 1. Unknown positions. The one finding that halts.
  for (const vp of venuePositions) {
    if (Number(vp.szi) === 0) continue;
    if (!storedByAsset.has(vp.asset)) {
      findings.push({
        kind: "unknown_position",
        asset: vp.asset,
        detail:
          `the venue holds ${vp.szi} ${vp.asset} at ${vp.entryPx} that this process has no record of. ` +
          `Something placed an order outside this system, or the store was lost. ` +
          `Refusing to trade alongside a position that cannot be explained.`,
      });
    }
  }

  // 2. Positions with no protection. Repaired, not halted — the fix is known.
  for (const sp of storedOpen) {
    const atVenue = venueByAsset.get(sp.asset);
    if (!atVenue || Number(atVenue.szi) === 0) {
      // The store thinks it is open, the venue says it is not. It closed while
      // the process was down; the loop's closure handler records it.
      findings.push({
        kind: "filled_while_down",
        cloid: sp.stopCloid ?? "",
        asset: sp.asset,
        detail: `stored position in ${sp.asset} is no longer at the venue; it closed while the process was down`,
      });
      continue;
    }

    if (!sp.stopCloid) {
      findings.push({
        kind: "unprotected_position",
        asset: sp.asset,
        positionId: sp.id,
        detail:
          `position in ${sp.asset} has never had a stop attached. ` +
          `A crash landed between the fill and its protection.`,
      });
    } else if (!triggersByAsset.has(sp.asset)) {
      findings.push({
        kind: "stop_missing_at_venue",
        asset: sp.asset,
        positionId: sp.id,
        detail:
          `position in ${sp.asset} records stop ${sp.stopCloid}, but no trigger order rests at the venue. ` +
          `It was filled, cancelled, or never arrived.`,
      });
    }
  }

  // 3. Intents that never resolved. Benign.
  const liveCloids = new Set(venueOrders.map((o) => o.cloid).filter((c): c is string => c !== null));
  for (const intent of store.unresolvedIntents()) {
    if (liveCloids.has(intent.cloid)) continue;
    findings.push({
      kind: "orphan_intent",
      cloid: intent.cloid,
      detail:
        `intent ${intent.cloid} for ${intent.asset} is ${intent.status} locally but absent at the venue. ` +
        `Either it was never placed, or it was cancelled or filled while the process was down.`,
    });
  }

  const unknown = findings.filter((f) => f.kind === "unknown_position");
  return {
    findings,
    safe: unknown.length === 0,
    haltReason:
      unknown.length > 0
        ? `${unknown.length} position(s) at the venue cannot be explained by this process: ` +
          unknown.map((f) => f.asset).join(", ")
        : null,
  };
}

/**
 * Repairs what can be repaired automatically.
 *
 * Only the unprotected-position findings are acted on, and only by *adding*
 * protection. Reconciliation never closes a position, never opens one, and never
 * cancels anything a human might have placed deliberately — repairing by
 * removing risk it does not understand would be its own failure mode.
 */
export async function repair(
  result: ReconcileResult,
  venue: Venue,
  store: ExecutionStore,
  placeStopFor: (positionId: number, asset: string) => Promise<string | null>,
): Promise<{ repaired: number; failed: string[] }> {
  let repaired = 0;
  const failed: string[] = [];

  for (const finding of result.findings) {
    if (finding.kind !== "unprotected_position" && finding.kind !== "stop_missing_at_venue") {
      continue;
    }
    try {
      const cloid = await placeStopFor(finding.positionId, finding.asset);
      if (cloid) {
        store.attachStop(finding.positionId, cloid);
        repaired++;
      } else {
        failed.push(`${finding.asset}: stop could not be priced`);
      }
    } catch (error) {
      failed.push(`${finding.asset}: ${(error as Error).message}`);
    }
  }

  // Orphaned intents are simply closed out; they hold no risk.
  for (const finding of result.findings) {
    if (finding.kind === "orphan_intent") {
      store.updateIntent(finding.cloid, { status: "cancelled", detail: finding.detail });
    }
  }

  return { repaired, failed };
}
