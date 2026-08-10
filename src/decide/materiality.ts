/**
 * The materiality gate: deciding whether to think.
 *
 * The most expensive mistake available in this design is consulting the model on
 * every tick. At 0.5s per asset across 8 assets that is ~1.4 million calls a day
 * — financially absurd, and worse than useless, because nothing meaningful
 * changes in 500ms.
 *
 * So a deterministic gate runs first and most events die here. It is a hot-path
 * concern: pure, cheap, no I/O, no model. It protects the token budget the same
 * way the position cap protects equity.
 *
 * A refusal to think is itself recorded (`decision.skipped`), so the ledger shows
 * that she looked and declined rather than that she was absent.
 */

import type { PainMap } from "../painmap.js";

export type MaterialityConfig = {
  /** Relative change in aggregate crowd uPnL that counts as movement. */
  crowdPnlShiftFraction: number;
  /** Absolute floor, so a tiny book cannot trigger on rounding. */
  crowdPnlShiftMinUsd: number;
  /** Forced-flow cluster this close to spot is worth waking for. */
  clusterProximityPct: number;
  /** Ignore clusters smaller than this. */
  clusterMinNotionalUsd: number;
  /** Position uPnL moving this far, as a fraction of the position, forces a review. */
  positionReviewMoveFraction: number;
  /** Never consult more often than this per asset, whatever else is true. */
  minIntervalMs: number;
  /** Consult at least this often while a position is open, even if quiet. */
  openPositionMaxIntervalMs: number;
  /** Below this share of venue open interest the map is too thin to act on. */
  minCoverageFraction: number;
};

export const DEFAULT_MATERIALITY: MaterialityConfig = {
  crowdPnlShiftFraction: 0.25,
  crowdPnlShiftMinUsd: 50_000,
  clusterProximityPct: 2.0,
  clusterMinNotionalUsd: 1_000_000,
  positionReviewMoveFraction: 0.25,
  minIntervalMs: 60_000,
  openPositionMaxIntervalMs: 15 * 60_000,
  minCoverageFraction: 0.05,
};

export type MaterialityTrigger =
  | "crowd_pnl_shift"
  | "cluster_proximity"
  | "liquidation_burst"
  | "position_review"
  | "position_heartbeat"
  | "position_opened"
  | "losing_side_flipped";

export type SkipReason =
  | "rate_limited"
  | "coverage_too_thin"
  | "nothing_changed";

export type MaterialityResult =
  | { consult: true; triggers: MaterialityTrigger[]; detail: string }
  | { consult: false; reason: SkipReason; detail: string };

/** What the gate remembers between calls, per asset. */
export type LastSeen = {
  at: number;
  aggregateUnrealizedPnlUsd: number;
  losingSide: PainMap["losingSide"];
  openPosition: { positionId: number; unrealizedPnlUsd: number } | null;
};

export type GateInputs = {
  map: PainMap;
  last: LastSeen | null;
  now: number;
  /** Closures observed for this asset since the last consultation. */
  closuresSinceLast: number;
  /** Threshold above which a burst of closures is itself the signal. */
  liquidationBurstThreshold?: number;
  openPosition?: {
    positionId: number;
    notionalUsd: number;
    unrealizedPnlUsd: number;
    /** uPnL at the last consultation, to measure the move against. */
    lastReviewedPnlUsd: number | null;
  };
};

/**
 * Decides whether this asset is worth a model call.
 *
 * Order matters: the two refusals that are unconditional come first, so a
 * rate-limited or under-covered asset does no further work and reports the most
 * fundamental reason rather than whichever check happened to run first.
 */
export function assessMateriality(
  inputs: GateInputs,
  config: MaterialityConfig = DEFAULT_MATERIALITY,
): MaterialityResult {
  const { map, last, now } = inputs;

  // A thin sample is not a quiet market — it is an unknown one. Acting on 2% of
  // open interest would be reading the crowd from a handful of accounts.
  const coverage = map.coverage.fraction;
  if (coverage !== null && coverage < config.minCoverageFraction) {
    return {
      consult: false,
      reason: "coverage_too_thin",
      detail:
        `${map.coin} coverage is ${(coverage * 100).toFixed(1)}% of venue open interest, ` +
        `below the ${(config.minCoverageFraction * 100).toFixed(0)}% floor. ` +
        `The map is a sample, and this one is too small to describe the crowd.`,
    };
  }

  if (last && now - last.at < config.minIntervalMs) {
    return {
      consult: false,
      reason: "rate_limited",
      detail: `last consulted ${Math.round((now - last.at) / 1000)}s ago, minimum interval ${config.minIntervalMs / 1000}s`,
    };
  }

  const triggers: MaterialityTrigger[] = [];
  const notes: string[] = [];

  // First look at an asset is always material — there is no prior to compare to.
  if (!last) {
    triggers.push("crowd_pnl_shift");
    notes.push("first observation of this asset");
  } else {
    const prior = Math.abs(last.aggregateUnrealizedPnlUsd);
    const change = Math.abs(map.aggregateUnrealizedPnlUsd - last.aggregateUnrealizedPnlUsd);
    const relative = prior > 0 ? change / prior : Number.POSITIVE_INFINITY;

    if (change >= config.crowdPnlShiftMinUsd && relative >= config.crowdPnlShiftFraction) {
      triggers.push("crowd_pnl_shift");
      notes.push(
        `crowd uPnL moved $${Math.round(change).toLocaleString()} (${(relative * 100).toFixed(0)}%)`,
      );
    }

    // The most informative single change available: the crowd changed sides, so
    // forced flow has reversed direction.
    if (map.losingSide !== last.losingSide && map.losingSide !== "neither") {
      triggers.push("losing_side_flipped");
      notes.push(`losing side flipped ${last.losingSide} -> ${map.losingSide}`);
    }
  }

  const cluster = map.forcedLevels.find(
    (l) =>
      l.notionalUsd >= config.clusterMinNotionalUsd &&
      Math.abs(l.pctFromMid) <= config.clusterProximityPct,
  );
  if (cluster) {
    triggers.push("cluster_proximity");
    notes.push(
      `$${(cluster.notionalUsd / 1e6).toFixed(1)}M of ${cluster.direction} ` +
        `${cluster.pctFromMid > 0 ? "+" : ""}${cluster.pctFromMid.toFixed(1)}% away`,
    );
  }

  const burstThreshold = inputs.liquidationBurstThreshold ?? 10;
  if (inputs.closuresSinceLast >= burstThreshold) {
    triggers.push("liquidation_burst");
    notes.push(`${inputs.closuresSinceLast} positions closed since the last look`);
  }

  if (inputs.openPosition) {
    const p = inputs.openPosition;
    if (last?.openPosition?.positionId !== p.positionId) {
      triggers.push("position_opened");
      notes.push("new position has not been reviewed");
    } else if (p.lastReviewedPnlUsd !== null) {
      const move = Math.abs(p.unrealizedPnlUsd - p.lastReviewedPnlUsd);
      if (p.notionalUsd > 0 && move / p.notionalUsd >= config.positionReviewMoveFraction) {
        triggers.push("position_review");
        notes.push(`open position moved $${Math.round(move).toLocaleString()}`);
      } else if (last && now - last.at >= config.openPositionMaxIntervalMs) {
        triggers.push("position_heartbeat");
        notes.push(`open position unreviewed for ${Math.round((now - last.at) / 60000)}m`);
      }
    } else if (last && now - last.at >= config.openPositionMaxIntervalMs) {
      triggers.push("position_heartbeat");
      notes.push(`open position unreviewed for ${Math.round((now - last.at) / 60000)}m`);
    }
  }

  if (triggers.length === 0) {
    return {
      consult: false,
      reason: "nothing_changed",
      detail: `${map.coin} is materially unchanged since the last look`,
    };
  }

  return { consult: true, triggers, detail: notes.join("; ") };
}
