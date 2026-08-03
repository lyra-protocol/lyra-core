/**
 * The decision schema.
 *
 * ── Why the field order is load-bearing ──────────────────────────────────────
 *
 * Tested against the live gpt-5.4 deployment with real Pain Map figures
 * (DESIGN.md §4.1). Given identical data:
 *
 *   schema asking only for {action, reasoning, confidence}
 *     -> "open_short", confidence 0.78, with reasoning that reads perfectly well
 *        and is wrong: shorts held the loss, so forced flow was BUYING above.
 *
 *   schema requiring losing_side and forced_orders_are BEFORE action
 *     -> "open_long", confidence 0.89, correct.
 *
 * Same model, same data, opposite decision. A schema that asks only for a
 * conclusion gets a plausible conclusion. Forcing the intermediate commitments,
 * in order, removes the step where the reasoning went wrong.
 *
 * So this file is not a serialisation detail — it is part of the strategy, which
 * is why `schema_hash` is an input to `strategy_id` (DESIGN.md §4.4). Changing
 * the order of these fields changes the trades Lyra takes.
 */

import { createHash } from "node:crypto";

export const PROMPT_TEMPLATE_ID = "pain-map-decide/v1";

/**
 * JSON schema sent to the model, with `strict: true`.
 *
 * Property order is the order the model must answer in. `action` appears only
 * after the two observations that determine it.
 */
export const DECISION_JSON_SCHEMA = {
  name: "lyra_decision",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "observed",
      "losing_side",
      "forced_orders_are",
      "hypothesis",
      "action",
      "expected_move",
      "conviction",
      "reasoning",
      "evidence_event_ids",
    ],
    properties: {
      observed: {
        type: "string",
        description:
          "What the enumerated positions show. State the figures you are relying on before interpreting them.",
      },
      losing_side: {
        type: "string",
        enum: ["longs", "shorts", "neither"],
        description: "Which side currently holds the unrealised loss.",
      },
      forced_orders_are: {
        type: "string",
        enum: ["buys_above_spot", "sells_below_spot", "mixed"],
        description:
          "Losing longs are liquidated BELOW spot and must sell. Losing shorts are liquidated ABOVE spot and must buy.",
      },
      hypothesis: {
        type: "string",
        enum: ["magnet", "wall", "cascade", "none"],
        description:
          "Which reading of the cluster this decision bets on. magnet: price is drawn toward it. wall: it absorbs and reverses price. cascade: once breached, forced flow accelerates the move.",
      },
      action: {
        type: "string",
        enum: ["open_long", "open_short", "hold", "close"],
      },
      expected_move: {
        type: "number",
        description: "Expected move as a fraction, e.g. 0.012 for 1.2%. Zero when holding.",
      },
      conviction: {
        type: "number",
        description: "0 to 1. Scales position size; it does not set it.",
      },
      reasoning: { type: "string" },
      evidence_event_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Ids of the observations you used. Every id must be one you were given. Do not invent ids and do not cite facts you were not shown.",
      },
    },
  },
} as const;

export type Decision = {
  observed: string;
  losing_side: "longs" | "shorts" | "neither";
  forced_orders_are: "buys_above_spot" | "sells_below_spot" | "mixed";
  hypothesis: "magnet" | "wall" | "cascade" | "none";
  action: "open_long" | "open_short" | "hold" | "close";
  expected_move: number;
  conviction: number;
  reasoning: string;
  evidence_event_ids: string[];
};

/** Hash of the schema, so a change to it is visible as a change to `strategy_id`. */
export function schemaHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(DECISION_JSON_SCHEMA))
    .digest("hex");
}

export type ValidationFailure = {
  code: "malformed_json" | "schema_mismatch" | "out_of_range" | "ungrounded_citation";
  detail: string;
};

/**
 * Validates a model response, including the grounding check.
 *
 * `strict: true` makes the shape reliable, but two things it cannot enforce are
 * checked here:
 *
 *   1. Numeric ranges — a conviction of 4.2 satisfies `type: number`.
 *   2. **Grounding.** Every cited id must be one the model was actually given.
 *      A decision that references an observation nobody supplied is a
 *      fabrication, and under §-1 it is rejected before execution rather than
 *      discovered later in a post-mortem.
 */
export function validateDecision(
  raw: string,
  suppliedEventIds: readonly string[],
): { ok: true; decision: Decision } | { ok: false; failure: ValidationFailure } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail("malformed_json", `response was not JSON: ${(error as Error).message}`);
  }

  const d = parsed as Partial<Decision>;

  const enums: [keyof Decision, readonly string[]][] = [
    ["losing_side", ["longs", "shorts", "neither"]],
    ["forced_orders_are", ["buys_above_spot", "sells_below_spot", "mixed"]],
    ["hypothesis", ["magnet", "wall", "cascade", "none"]],
    ["action", ["open_long", "open_short", "hold", "close"]],
  ];
  for (const [field, allowed] of enums) {
    if (typeof d[field] !== "string" || !allowed.includes(d[field] as string)) {
      return fail("schema_mismatch", `${field} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(d[field])}`);
    }
  }
  for (const field of ["observed", "reasoning"] as const) {
    if (typeof d[field] !== "string" || d[field]!.length === 0) {
      return fail("schema_mismatch", `${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(d.evidence_event_ids)) {
    return fail("schema_mismatch", "evidence_event_ids must be an array");
  }

  if (typeof d.conviction !== "number" || !(d.conviction >= 0 && d.conviction <= 1)) {
    return fail("out_of_range", `conviction must be between 0 and 1, got ${d.conviction}`);
  }
  if (typeof d.expected_move !== "number" || !Number.isFinite(d.expected_move)) {
    return fail("out_of_range", `expected_move must be a finite number, got ${d.expected_move}`);
  }
  // A model claiming a 60% move has misread the data or the units. Acting on it
  // would size a position against a number nobody should believe.
  if (Math.abs(d.expected_move) > 0.5) {
    return fail("out_of_range", `expected_move of ${d.expected_move} is implausible for a perp`);
  }

  const supplied = new Set(suppliedEventIds);
  const invented = d.evidence_event_ids.filter((id) => !supplied.has(id));
  if (invented.length > 0) {
    return fail(
      "ungrounded_citation",
      `cited ${invented.length} observation(s) that were never supplied: ${invented.slice(0, 5).join(", ")}. ` +
        `A decision may only rest on evidence it was given.`,
    );
  }

  // A trade must rest on something. "hold" may legitimately cite nothing.
  if (d.action !== "hold" && d.evidence_event_ids.length === 0) {
    return fail("ungrounded_citation", "a decision to trade must cite at least one observation");
  }

  return { ok: true, decision: d as Decision };
}

function fail(code: ValidationFailure["code"], detail: string) {
  return { ok: false as const, failure: { code, detail } };
}
