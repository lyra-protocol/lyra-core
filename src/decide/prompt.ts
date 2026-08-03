/**
 * Building the prompt.
 *
 * Every fact given to the model carries an id, and the schema requires it to
 * cite the ids it used. A decision citing an id it was never given is rejected
 * before execution. That is how §-1's "never fabricate" stops being a request
 * and becomes a mechanism: the model cannot introduce a fact, because a fact
 * without an id is not evidence.
 *
 * The system prompt states the liquidation semantics explicitly. This is not
 * padding — DESIGN.md §4.1 measured the same model reaching the opposite
 * conclusion when it was left to infer which side's forced orders sat where.
 */

import type { PainMap } from "../painmap.js";

export const SYSTEM_PROMPT = `You are the decision component of an autonomous trading agent.

You may use ONLY the observations supplied below. Each carries an id. Cite the id
of every observation you rely on. If you refer to something you were not given,
your decision is discarded — so do not estimate, do not recall, and do not assume
anything about the wider market.

Mechanics you must apply, not infer:
- A LONG is liquidated BELOW spot. Liquidating it forces a SELL.
- A SHORT is liquidated ABOVE spot. Liquidating it forces a BUY.
- Therefore: if losing positions are shorts, forced flow is BUYING above spot,
  and pressure is upward. If losing positions are longs, forced flow is SELLING
  below spot, and pressure is downward.

State which side is losing and where its forced orders sit BEFORE you choose an
action. Those two answers determine the direction; do not choose first and
justify afterwards.

Name the hypothesis you are betting on:
- magnet  — price is drawn toward the cluster
- wall    — the cluster absorbs and reverses price
- cascade — once breached, forced flow accelerates the move
- none    — no cluster is relevant here

These are competing readings and none is established. Your record is the test.

Costs are real: entering and exiting as a maker costs about 3 basis points round
trip. A move smaller than that is not a trade. "hold" is a legitimate and often
correct answer — you are not required to find an opportunity.

If the evidence does not support a clear read, hold and say why.`;

export type Observation = { id: string; text: string };

/**
 * Turns a Pain Map into numbered observations.
 *
 * Ids are stable and derived from what they describe, so the same fact always
 * carries the same id within a decision and the citation check is meaningful.
 *
 * Deliberately included: aggregates, the forced-supply curve, concentration, and
 * the largest individual positions. Aggregates alone would lose the fact that
 * one whale and ten thousand retail accounts behave completely differently at
 * the same notional — a single holder can choose to close, a crowd cannot
 * coordinate.
 */
export function painMapObservations(map: PainMap): Observation[] {
  const o: Observation[] = [];
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const m = (n: number) => `$${(n / 1e6).toFixed(2)}M`;

  o.push({ id: "mid", text: `${map.coin} mid price is ${map.midPx}.` });
  o.push({
    id: "sample",
    text:
      `${map.positionsEnumerated} open positions enumerated directly from the venue` +
      (map.coverage.fraction !== null
        ? `, covering ${(map.coverage.fraction * 100).toFixed(1)}% of open interest`
        : "") +
      `. ${map.coverage.staleCount} stale positions were excluded.`,
  });
  o.push({
    id: "longs",
    text: `Longs: ${map.longs.count} positions, ${m(map.longs.notionalUsd)} notional, unrealised PnL ${usd(map.longs.unrealizedPnlUsd)}.`,
  });
  o.push({
    id: "shorts",
    text: `Shorts: ${map.shorts.count} positions, ${m(map.shorts.notionalUsd)} notional, unrealised PnL ${usd(map.shorts.unrealizedPnlUsd)}.`,
  });
  o.push({
    id: "aggregate",
    text: `Aggregate unrealised PnL across all enumerated positions is ${usd(map.aggregateUnrealizedPnlUsd)}. The side holding the loss is: ${map.losingSide}.`,
  });
  o.push({
    id: "leverage",
    text: `Mean leverage across enumerated positions is ${map.meanLeverage.toFixed(1)}x.`,
  });
  o.push({
    id: "concentration",
    text:
      `The largest single position is ${(map.concentration * 100).toFixed(1)}% of enumerated notional. ` +
      (map.concentration > 0.2
        ? `This is concentrated: one holder can choose to close, where a crowd cannot coordinate.`
        : `This is dispersed across many holders.`),
  });

  map.forcedLevels.slice(0, 8).forEach((l, i) => {
    o.push({
      id: `cluster_${i}`,
      text:
        `At ${l.pctFromMid > 0 ? "+" : ""}${l.pctFromMid.toFixed(1)}% from mid, ` +
        `${m(l.notionalUsd)} across ${l.positions} positions becomes ${l.direction.replace("_", " ")} if price reaches it.`,
    });
  });

  map.largest.slice(0, 3).forEach((p, i) => {
    const size = Number(p.szi);
    o.push({
      id: `largest_${i}`,
      text:
        `A ${size > 0 ? "long" : "short"} of ${Math.abs(Number(p.positionValue)).toLocaleString("en-US", { maximumFractionDigits: 0 })} USD ` +
        `entered at ${p.entryPx ?? "unknown"}, liquidation at ${p.liquidationPx ?? "none"}, ` +
        `unrealised PnL ${p.unrealizedPnl}, leverage ${p.leverage ?? "unknown"}x.`,
    });
  });

  return o;
}

/** Observations describing an open position, when there is one to review. */
export function positionObservations(position: {
  asset: string;
  side: "long" | "short";
  entryPx: string;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  liquidationPx: string | null;
  openedAt: number;
}): Observation[] {
  const held = Math.round((Date.now() - position.openedAt) / 60000);
  return [
    {
      id: "own_position",
      text:
        `You currently hold a ${position.side} in ${position.asset}, ` +
        `${Math.round(position.notionalUsd).toLocaleString("en-US")} USD notional, ` +
        `entered at ${position.entryPx}, open for ${held} minutes, ` +
        `unrealised PnL ${Math.round(position.unrealizedPnlUsd).toLocaleString("en-US")} USD` +
        (position.liquidationPx ? `, liquidation at ${position.liquidationPx}` : "") +
        `. You may close it, or hold it as long as you judge necessary.`,
    },
  ];
}

/** Renders observations into the user prompt, one id per line. */
export function buildUserPrompt(observations: Observation[], question: string): string {
  const lines = observations.map((o) => `[${o.id}] ${o.text}`);
  return `OBSERVATIONS\n${lines.join("\n")}\n\nQUESTION\n${question}`;
}

export const DEFAULT_QUESTION =
  "Given only the observations above, what should be done with this asset right now?";
