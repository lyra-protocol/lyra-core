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

If the evidence does not support a clear read, hold and say why.

When you open, name target_px: the price that would prove the hypothesis right,
normally the liquidation cluster you are trading toward. A claim about where
price goes is not a claim until it names where.

If you already hold a position, you are reading a decision you have already
made, not making a fresh one. Set thesis_status:
- intact       — the reasoning that opened it still holds and has not played out
- invalidated  — the forced flow you traded toward is gone, or the losing side
                 has changed
- played_out   — the target was reached, or the mechanism has finished

An adverse price move is NOT invalidation. A stop rests at the venue and closes
the position if the trade is genuinely wrong, and the size was chosen so that
loss is affordable. Closing early because a position is currently red converts a
bounded, planned loss into an unplanned one, and forfeits the move you predicted
before it has had time to happen. You may only close on invalidated or
played_out; if the thesis is intact, hold it.

Where you are given your own past results, they are your measured record, not a
suggestion. Read them as evidence about your own behaviour.`;

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
/**
 * What she is holding, and why she opened it.
 *
 * The version this replaces said only what the position was and that she "may
 * close it, or hold it as long as you judge necessary" — nothing about the
 * reasoning that opened it, no target, no stop. She re-decided blind every
 * cycle, which is why the first ten trades cut winners at 11 minutes and
 * nursed losers to 34.
 *
 * A position is a claim already made. Re-reading it fresh every ninety seconds
 * turns each cycle into an independent opportunity to lose nerve, so the
 * original thesis, the price that would prove it, and the distance to the stop
 * all travel with it.
 */
export function positionObservations(position: {
  asset: string;
  side: "long" | "short";
  entryPx: string;
  markPx?: string;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  liquidationPx: string | null;
  stopPx?: string | null;
  targetPx?: string | null;
  openedAt: number;
  thesis?: {
    losing_side: string;
    forced_orders_are: string;
    hypothesis: string;
    reasoning: string;
  } | null;
}): Observation[] {
  const held = Math.round((Date.now() - position.openedAt) / 60000);
  const entry = Number(position.entryPx);
  const mark = position.markPx ? Number(position.markPx) : entry;
  const movePct = entry > 0 ? ((mark - entry) / entry) * 100 : 0;

  const out: Observation[] = [
    {
      id: "own_position",
      text:
        `You hold a ${position.side} in ${position.asset}: ` +
        `${Math.round(position.notionalUsd).toLocaleString("en-US")} USD notional, ` +
        `entered ${position.entryPx}, now ${position.markPx ?? position.entryPx} ` +
        `(${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% from entry), ` +
        `open ${held} minute${held === 1 ? "" : "s"}, ` +
        `unrealised ${position.unrealizedPnlUsd.toFixed(2)} USD.`,
    },
  ];

  if (position.thesis) {
    out.push({
      id: "own_thesis",
      text:
        `You opened it on this reasoning: losing side was ${position.thesis.losing_side}, ` +
        `forced orders ${position.thesis.forced_orders_are}, mechanism ` +
        `${position.thesis.hypothesis}. You wrote: "${position.thesis.reasoning.slice(0, 400)}" ` +
        `Ask whether THAT is still true. Whether the position is currently up or down is not ` +
        `the question and does not answer it.`,
    });
  }

  if (position.targetPx) {
    const target = Number(position.targetPx);
    const total = Math.abs(target - entry);
    const done = Math.abs(mark - entry);
    const progress = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const movingRight = position.side === "long" ? mark >= entry : mark <= entry;
    out.push({
      id: "own_target",
      text:
        `Your stated target is ${position.targetPx} — the price you said would prove the ` +
        `hypothesis. Price has covered ${movingRight ? progress.toFixed(0) : "0"}% of that ` +
        `distance${movingRight ? "" : " and is currently on the wrong side of entry"}. ` +
        `The trade has not played out until the target is reached or the mechanism is gone.`,
    });
  }

  if (position.stopPx) {
    const stop = Number(position.stopPx);
    const room = entry > 0 ? Math.abs((stop - mark) / mark) * 100 : 0;
    out.push({
      id: "own_stop",
      text:
        `A stop rests at the venue at ${position.stopPx}, ${room.toFixed(1)}% away from the ` +
        `current price. It closes this position automatically if the trade is genuinely ` +
        `wrong, so you do not need to close early to limit the loss — that is already ` +
        `handled, and the size was chosen so this loss is affordable.`,
    });
  }

  return out;
}

/**
 * Her own measured record, fed back to her.
 *
 * Not advice and not simulation — these are her closed trades, counted. The
 * grounding rule forbids inventing evidence; it does not forbid her reading
 * what she has actually done, and a decision component with no access to its
 * own outcomes cannot improve on them.
 */
export function performanceObservations(trades: readonly {
  netUsd: number;
  heldMs: number;
  hypothesis?: string | null;
}[]): Observation[] {
  if (trades.length < 3) return [];

  const wins = trades.filter((t) => t.netUsd > 0);
  const losses = trades.filter((t) => t.netUsd <= 0);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const avgWin = avg(wins.map((t) => t.netUsd));
  const avgLoss = avg(losses.map((t) => t.netUsd));
  const holdWin = avg(wins.map((t) => t.heldMs)) / 60000;
  const holdLoss = avg(losses.map((t) => t.heldMs)) / 60000;
  const rate = wins.length / trades.length;

  const out: Observation[] = [{
    id: "own_record",
    text:
      `Your last ${trades.length} closed trades: ${wins.length} won, ${losses.length} lost ` +
      `(${(rate * 100).toFixed(0)}%). Average winner ${avgWin.toFixed(2)} USD held ` +
      `${holdWin.toFixed(0)} minutes; average loser ${avgLoss.toFixed(2)} USD held ` +
      `${holdLoss.toFixed(0)} minutes. ` +
      (holdWin < holdLoss
        ? `You are holding losers ${(holdLoss / Math.max(1, holdWin)).toFixed(1)}x longer than ` +
          `winners, which is the opposite of what makes a strategy profitable. ` +
          `At a ${(rate * 100).toFixed(0)}% win rate your winners must be at least ` +
          `${((1 - rate) / Math.max(0.01, rate)).toFixed(1)}x your losers to break even; ` +
          `they are currently ${(avgWin / Math.abs(avgLoss || 1)).toFixed(2)}x.`
        : `Winners are being held longer than losers, which is the right way round.`),
  }];

  // Which mechanisms have actually worked for her, by name.
  const byHypothesis = new Map<string, { n: number; net: number }>();
  for (const t of trades) {
    if (!t.hypothesis) continue;
    const e = byHypothesis.get(t.hypothesis) ?? { n: 0, net: 0 };
    e.n += 1; e.net += t.netUsd;
    byHypothesis.set(t.hypothesis, e);
  }
  if (byHypothesis.size > 0) {
    out.push({
      id: "own_record_by_hypothesis",
      text:
        "By mechanism, net across your own closed trades: " +
        [...byHypothesis.entries()]
          .map(([h, e]) => `${h} ${e.n} trade${e.n === 1 ? "" : "s"} ${e.net >= 0 ? "+" : ""}${e.net.toFixed(2)} USD`)
          .join(", ") +
        ". Weight these as evidence about which mechanisms you read well.",
    });
  }

  return out;
}

/** Renders observations into the user prompt, one id per line. */
export function buildUserPrompt(observations: Observation[], question: string): string {
  const lines = observations.map((o) => `[${o.id}] ${o.text}`);
  return `OBSERVATIONS\n${lines.join("\n")}\n\nQUESTION\n${question}`;
}

export const DEFAULT_QUESTION =
  "Given only the observations above, what should be done with this asset right now?";
