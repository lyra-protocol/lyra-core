import type { Decision } from "./schema.js";
import type {
  InferenceRole,
  ShadowOutcomeCandidate,
  ShadowVirtualPosition,
} from "../execute/store.js";

export const SHADOW_OUTCOME_VERSION = "shadow-outcome/v1";

export type ShadowOutcomeConfig = {
  notionalUsd: number;
  virtualEquityUsd: number;
  riskFraction: number;
  minRewardRisk: number;
  minStopDistanceFraction: number;
  horizonMs: number;
  makerFeeBps: number;
  takerFeeBps: number;
};

export const DEFAULT_SHADOW_OUTCOME_CONFIG: ShadowOutcomeConfig = {
  notionalUsd: 2_500,
  virtualEquityUsd: 10_000,
  riskFraction: 0.02,
  minRewardRisk: 1.5,
  minStopDistanceFraction: 0.003,
  horizonMs: 24 * 60 * 60 * 1_000,
  makerFeeBps: 1.5,
  takerFeeBps: 4.5,
};

type NewVirtualPosition = Omit<
  ShadowVirtualPosition,
  "id" | "mfeUsd" | "maeUsd" | "status" | "resolvedAt" | "exitPx" |
  "grossPnlUsd" | "totalFeesUsd" | "netPnlUsd"
>;

export function deriveVirtualOpening(input: {
  candidate: ShadowOutcomeCandidate;
  role: InferenceRole;
  decision: Decision;
  entryPx: number;
  openedAt: number;
  config?: ShadowOutcomeConfig;
}): NewVirtualPosition | null {
  const { decision, entryPx, candidate, role, openedAt } = input;
  const config = input.config ?? DEFAULT_SHADOW_OUTCOME_CONFIG;
  if (decision.action !== "open_long" && decision.action !== "open_short") return null;
  if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(decision.target_px)) return null;

  const side = decision.action === "open_long" ? "long" : "short";
  const rewardDistance = Math.abs(decision.target_px - entryPx) / entryPx;
  const riskBudgetDistance = config.virtualEquityUsd * config.riskFraction / config.notionalUsd;
  const distanceFraction = Math.max(
    config.minStopDistanceFraction,
    Math.min(riskBudgetDistance, rewardDistance / config.minRewardRisk),
  );
  const stopPx = side === "long"
    ? entryPx * (1 - distanceFraction)
    : entryPx * (1 + distanceFraction);
  if (!Number.isFinite(stopPx) || stopPx <= 0) return null;

  return {
    pairId: candidate.pairId,
    role,
    asset: candidate.asset,
    side,
    promptTemplate: candidate.promptTemplate,
    schemaHash: candidate.schemaHash,
    championModel: candidate.championModel,
    challengerModel: candidate.challengerModel,
    evaluationVersion: candidate.evaluationVersion,
    decisionJson: JSON.stringify(decision),
    entryPx,
    targetPx: decision.target_px,
    stopPx,
    size: config.notionalUsd / entryPx,
    notionalUsd: config.notionalUsd,
    openedAt,
    expiresAt: openedAt + config.horizonMs,
    lastSampleAt: openedAt,
    lastMidPx: entryPx,
  };
}

export type VirtualAdvance = {
  sampledAt: number;
  midPx: number;
  mfeUsd: number;
  maeUsd: number;
  status: "open" | "target" | "stop" | "horizon";
  exitPx?: number;
  grossPnlUsd?: number;
  totalFeesUsd?: number;
  netPnlUsd?: number;
};

export function advanceVirtualPosition(
  position: ShadowVirtualPosition,
  midPx: number,
  sampledAt: number,
  config: ShadowOutcomeConfig = DEFAULT_SHADOW_OUTCOME_CONFIG,
): VirtualAdvance | null {
  if (position.status !== "open" || sampledAt < position.lastSampleAt) return null;
  if (!Number.isFinite(midPx) || midPx <= 0) return null;

  const low = Math.min(position.lastMidPx, midPx);
  const high = Math.max(position.lastMidPx, midPx);
  const favorablePx = position.side === "long" ? high : low;
  const adversePx = position.side === "long" ? low : high;
  const favorablePnl = directionalPnl(position.side, position.entryPx, favorablePx, position.size);
  const adversePnl = directionalPnl(position.side, position.entryPx, adversePx, position.size);
  const mfeUsd = Math.max(position.mfeUsd, favorablePnl);
  const maeUsd = Math.min(position.maeUsd, adversePnl);

  const hitStop = position.side === "long" ? low <= position.stopPx : high >= position.stopPx;
  const hitTarget = position.side === "long" ? high >= position.targetPx : low <= position.targetPx;
  const status: VirtualAdvance["status"] = hitStop
    ? "stop"
    : hitTarget
      ? "target"
      : sampledAt >= position.expiresAt
        ? "horizon"
        : "open";
  if (status === "open") return { sampledAt, midPx, mfeUsd, maeUsd, status };

  const exitPx = status === "stop"
    ? position.stopPx
    : status === "target"
      ? position.targetPx
      : midPx;
  const grossPnlUsd = directionalPnl(position.side, position.entryPx, exitPx, position.size);
  const exitFeeBps = status === "target" ? config.makerFeeBps : config.takerFeeBps;
  const totalFeesUsd = fee(position.entryPx * position.size, config.makerFeeBps) +
    fee(exitPx * position.size, exitFeeBps);
  return {
    sampledAt, midPx, mfeUsd, maeUsd, status, exitPx, grossPnlUsd,
    totalFeesUsd, netPnlUsd: grossPnlUsd - totalFeesUsd,
  };
}

export function directionalPnl(
  side: "long" | "short",
  entryPx: number,
  exitPx: number,
  size: number,
): number {
  return (side === "long" ? exitPx - entryPx : entryPx - exitPx) * size;
}

function fee(notionalUsd: number, bps: number): number {
  return notionalUsd * bps / 10_000;
}
