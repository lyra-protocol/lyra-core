import type { Decision } from "./schema.js";

export type DecisionContext = {
  entryPx: number;
  stopPx?: number;
  existingPosition?: {
    side: "long" | "short";
    hypothesis: Decision["hypothesis"] | null;
  };
  minExpectedMove: number;
  minRewardRisk: number;
};

export type SemanticFailureCode =
  | "action_position_mismatch"
  | "hypothesis_action_mismatch"
  | "target_direction_mismatch"
  | "expected_move_mismatch"
  | "expected_move_too_small"
  | "reward_risk_too_small"
  | "thesis_status_mismatch";

export type SemanticResult =
  | { ok: true }
  | { ok: false; failure: { code: SemanticFailureCode; detail: string } };

export function validateDecisionSemantics(
  decision: Decision,
  context: DecisionContext,
): SemanticResult {
  const opening = decision.action === "open_long" || decision.action === "open_short";
  const position = context.existingPosition;

  if (opening) {
    if (position) {
      return fail("action_position_mismatch", "cannot open while a position in this asset is already active");
    }
    if (decision.thesis_status !== "no_position") {
      return fail("thesis_status_mismatch", "an opening decision must declare thesis_status no_position");
    }
    if (decision.hypothesis === "none") {
      return fail("hypothesis_action_mismatch", "an opening decision must name a testable hypothesis");
    }
    if (decision.expected_move <= 0) {
      return fail("expected_move_mismatch", "an opening expected_move must be a positive magnitude");
    }
    const long = decision.action === "open_long";
    if ((long && decision.target_px <= context.entryPx) || (!long && decision.target_px >= context.entryPx)) {
      return fail(
        "target_direction_mismatch",
        `${decision.action} target ${decision.target_px} is on the wrong side of entry ${context.entryPx}`,
      );
    }
    const derived = Math.abs(decision.target_px - context.entryPx) / context.entryPx;
    const tolerance = Math.max(0.0001, derived * 0.1);
    if (Math.abs(decision.expected_move - derived) > tolerance) {
      return fail(
        "expected_move_mismatch",
        `declared move ${(decision.expected_move * 100).toFixed(2)}% does not match ` +
          `target distance ${(derived * 100).toFixed(2)}%`,
      );
    }
    if (decision.expected_move < context.minExpectedMove) {
      return fail(
        "expected_move_too_small",
        `expected move ${(decision.expected_move * 100).toFixed(2)}% is below ` +
          `${(context.minExpectedMove * 100).toFixed(2)}%`,
      );
    }
    if (context.stopPx !== undefined) {
      const risk = Math.abs(context.entryPx - context.stopPx);
      const reward = Math.abs(decision.target_px - context.entryPx);
      const rr = risk > 0 ? reward / risk : Number.POSITIVE_INFINITY;
      if (rr < context.minRewardRisk) {
        return fail(
          "reward_risk_too_small",
          `reward/risk ${rr.toFixed(2)} is below ${context.minRewardRisk.toFixed(2)}`,
        );
      }
    }
    return { ok: true };
  }

  if (decision.target_px !== 0 || decision.expected_move !== 0) {
    return fail("expected_move_mismatch", "hold and close decisions must use target_px 0 and expected_move 0");
  }

  if (decision.action === "hold") {
    if (!position && (decision.thesis_status !== "no_position" || decision.hypothesis !== "none")) {
      return fail("thesis_status_mismatch", "a flat hold must use no_position and hypothesis none");
    }
    if (position) {
      if (decision.thesis_status !== "intact") {
        return fail("thesis_status_mismatch", "holding an open position requires an intact thesis");
      }
      if (position.hypothesis && decision.hypothesis !== position.hypothesis) {
        return fail("hypothesis_action_mismatch", "a hold cannot silently replace the opening hypothesis");
      }
    }
    return { ok: true };
  }

  if (!position) return fail("action_position_mismatch", "close requires an open position");
  if (decision.thesis_status !== "invalidated" && decision.thesis_status !== "played_out") {
    return fail("thesis_status_mismatch", "close requires an invalidated or played-out thesis");
  }
  if (position.hypothesis && decision.hypothesis !== position.hypothesis) {
    return fail("hypothesis_action_mismatch", "a close must evaluate the hypothesis that opened the position");
  }
  return { ok: true };
}

/** Arithmetic fields are computed from authoritative prices, never trusted to the model. */
export function deriveDecisionMetrics(decision: Decision, entryPx: number): Decision {
  const opening = decision.action === "open_long" || decision.action === "open_short";
  return {
    ...decision,
    expected_move: opening && Number.isFinite(entryPx) && entryPx > 0
      ? Math.abs(decision.target_px - entryPx) / entryPx
      : 0,
  };
}

function fail(code: SemanticFailureCode, detail: string): SemanticResult {
  return { ok: false, failure: { code, detail } };
}