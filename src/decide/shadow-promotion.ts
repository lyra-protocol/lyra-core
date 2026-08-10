export const SHADOW_PROMOTION_POLICY_VERSION = "shadow-promotion/v1";

export type PairEvidence = {
  pairId: string;
  at: number;
  asset: string;
  championAction: string;
  challengerAction: string;
  championThesisStatus: string;
  challengerThesisStatus: string;
  championPositionStatus: string | null;
  challengerPositionStatus: string | null;
  championNetPnlUsd: number | null;
  challengerNetPnlUsd: number | null;
  championLatencyMs: number | null;
  challengerLatencyMs: number | null;
  championCostUsd: number | null;
  challengerCostUsd: number | null;
};

export type PromotionPolicy = {
  minimumValidComparisons: number;
  minimumActionableComparisons: number;
  minimumValidityRate: number;
  minimumOpeningRecallRatio: number;
  maximumExpectancyDeficitUsd: number;
  maximumDrawdownRatio: number;
  minimumEfficiencyImprovement: number;
};

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minimumValidComparisons: 500,
  minimumActionableComparisons: 100,
  minimumValidityRate: 0.99,
  minimumOpeningRecallRatio: 0.95,
  maximumExpectancyDeficitUsd: 0,
  maximumDrawdownRatio: 1,
  minimumEfficiencyImprovement: 0.1,
};

export function scoreShadowPromotion(
  evidence: PairEvidence[],
  quality: { attempted: number; valid: number },
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
) {
  const flat = evidence
    .filter((p) => p.championThesisStatus === "no_position" && p.challengerThesisStatus === "no_position")
    .sort((a, b) => a.at - b.at);
  const championOpenings = flat.filter((p) => isOpening(p.championAction)).length;
  const challengerOpenings = flat.filter((p) => isOpening(p.challengerAction)).length;
  const recalledChampionOpenings = flat.filter(
    (p) => isOpening(p.championAction) && isOpening(p.challengerAction),
  ).length;
  const openingRecallRatio = championOpenings === 0
    ? 1
    : recalledChampionOpenings / championOpenings;

  const resolved = flat.flatMap((pair) => {
    const champion = roleOutcome(pair.championAction, pair.championPositionStatus, pair.championNetPnlUsd);
    const challenger = roleOutcome(pair.challengerAction, pair.challengerPositionStatus, pair.challengerNetPnlUsd);
    if (champion === null || challenger === null) return [];
    const delta = challenger - champion;
    return [{ ...pair, championNetPnlUsd: champion, challengerNetPnlUsd: challenger, delta }];
  });
  const pending = flat.length - resolved.length;
  const actionable = resolved.filter((p) => isOpening(p.championAction) || isOpening(p.challengerAction));
  const championNetPnlUsd = sum(resolved.map((p) => p.championNetPnlUsd));
  const challengerNetPnlUsd = sum(resolved.map((p) => p.challengerNetPnlUsd));
  const championAverageNetPnlUsd = average(resolved.map((p) => p.championNetPnlUsd));
  const challengerAverageNetPnlUsd = average(resolved.map((p) => p.challengerNetPnlUsd));
  const championMaxDrawdownUsd = maxDrawdown(resolved.map((p) => p.championNetPnlUsd));
  const challengerMaxDrawdownUsd = maxDrawdown(resolved.map((p) => p.challengerNetPnlUsd));
  const validityRate = quality.attempted === 0 ? 0 : quality.valid / quality.attempted;

  const championAverageLatencyMs = averageDefined(flat.map((p) => p.championLatencyMs));
  const challengerAverageLatencyMs = averageDefined(flat.map((p) => p.challengerLatencyMs));
  const championAverageCostUsd = averageDefined(flat.map((p) => p.championCostUsd));
  const challengerAverageCostUsd = averageDefined(flat.map((p) => p.challengerCostUsd));
  const latencyImprovement = fractionalImprovement(championAverageLatencyMs, challengerAverageLatencyMs);
  const costImprovement = fractionalImprovement(championAverageCostUsd, challengerAverageCostUsd);

  const gates = {
    validComparisons: gate(resolved.length >= policy.minimumValidComparisons, resolved.length, policy.minimumValidComparisons),
    actionableComparisons: gate(actionable.length >= policy.minimumActionableComparisons, actionable.length, policy.minimumActionableComparisons),
    validity: gate(validityRate >= policy.minimumValidityRate, validityRate, policy.minimumValidityRate),
    openingRecall: gate(openingRecallRatio >= policy.minimumOpeningRecallRatio, openingRecallRatio, policy.minimumOpeningRecallRatio),
    expectancy: gate(
      challengerAverageNetPnlUsd >= championAverageNetPnlUsd - policy.maximumExpectancyDeficitUsd,
      challengerAverageNetPnlUsd - championAverageNetPnlUsd,
      -policy.maximumExpectancyDeficitUsd,
    ),
    drawdown: gate(
      challengerMaxDrawdownUsd <= championMaxDrawdownUsd * policy.maximumDrawdownRatio,
      challengerMaxDrawdownUsd,
      championMaxDrawdownUsd * policy.maximumDrawdownRatio,
    ),
    efficiency: gate(
      costImprovement >= policy.minimumEfficiencyImprovement || latencyImprovement >= policy.minimumEfficiencyImprovement,
      Math.max(costImprovement, latencyImprovement),
      policy.minimumEfficiencyImprovement,
    ),
  };
  const ready = Object.values(gates).every((g) => g.pass);

  return {
    policyVersion: SHADOW_PROMOTION_POLICY_VERSION,
    recommendation: ready ? "eligible_for_human_review" : "collecting_evidence",
    automaticPromotion: false,
    flatComparisons: flat.length,
    resolvedComparisons: resolved.length,
    pendingComparisons: pending,
    actionableComparisons: actionable.length,
    championWins: resolved.filter((p) => p.delta < 0).length,
    challengerWins: resolved.filter((p) => p.delta > 0).length,
    ties: resolved.filter((p) => p.delta === 0).length,
    quality: { ...quality, validityRate },
    openingRecall: { championOpenings, challengerOpenings, recalledChampionOpenings, ratio: openingRecallRatio },
    profitability: {
      championNetPnlUsd, challengerNetPnlUsd,
      netPnlDeltaUsd: challengerNetPnlUsd - championNetPnlUsd,
      championAverageNetPnlUsd, challengerAverageNetPnlUsd,
      averageNetPnlDeltaUsd: challengerAverageNetPnlUsd - championAverageNetPnlUsd,
      championMaxDrawdownUsd, challengerMaxDrawdownUsd,
    },
    efficiency: {
      championAverageLatencyMs, challengerAverageLatencyMs, latencyImprovement,
      championAverageCostUsd, challengerAverageCostUsd, costImprovement,
    },
    gates,
  };
}

function roleOutcome(action: string, positionStatus: string | null, netPnlUsd: number | null): number | null {
  if (action === "hold") return 0;
  if (!isOpening(action)) return null;
  return positionStatus && positionStatus !== "open" && netPnlUsd !== null ? netPnlUsd : null;
}

function isOpening(action: string): boolean {
  return action === "open_long" || action === "open_short";
}

function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function average(values: number[]): number { return values.length === 0 ? 0 : sum(values) / values.length; }
function averageDefined(values: (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return defined.length === 0 ? null : average(defined);
}
function fractionalImprovement(baseline: number | null, candidate: number | null): number {
  return baseline !== null && baseline > 0 && candidate !== null ? (baseline - candidate) / baseline : 0;
}
function maxDrawdown(values: number[]): number {
  let equity = 0, peak = 0, drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}
function gate(pass: boolean, value: number, required: number) { return { pass, value, required }; }
