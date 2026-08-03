#!/usr/bin/env node
/**
 * Dry mode.
 *
 * She observes, computes the Pain Map, decides whether the world moved enough to
 * be worth thinking about, consults the model, and sizes and prices the trade
 * she *would* place — then stops.
 *
 * Nothing is written to Arweave. No order is constructed. No position exists.
 *
 * ── Why this runs before the permanent record ───────────────────────────────
 *
 * The strategy has never been validated in any form. It cannot be backtested —
 * the model already knows what happened in any historical window (DESIGN.md
 * §3.7) — and it has not yet been forward tested. On top of that, the gate and
 * sizing constants were chosen in one sitting with no data behind them.
 *
 * Starting the permanent ledger now would mean the first entries are noise from
 * untuned parameters, written under her name, forever. Arweave has no delete.
 *
 * So this run answers the cheap questions first: does the gate fire sensibly or
 * 400 times a day, what does she actually cost in tokens, are her decisions
 * coherent, and does she ever clear the coverage floor on the thinner assets.
 *
 * Decisions ARE persisted locally, so the terminal shows her real reasoning
 * while this runs. What is withheld is permanence, not visibility.
 */

import { DatabaseSync } from "node:sqlite";
import { buildPainMap } from "./painmap.js";
import { assessMateriality, DEFAULT_MATERIALITY, type LastSeen } from "./decide/materiality.js";
import { DecisionClient } from "./decide/client.js";
import {
  buildUserPrompt,
  DEFAULT_QUESTION,
  painMapObservations,
  SYSTEM_PROMPT,
} from "./decide/prompt.js";
import { makerPrice, sizePosition } from "./decide/sizing.js";
import { DEFAULT_LIMITS } from "./risk/limits.js";
import { ExecutionStore } from "./execute/store.js";
import { DEFAULT_CONFIG } from "./harvest.js";
import { randomUUID } from "node:crypto";

const UNIVERSE = DEFAULT_CONFIG.universe;
const PAPER_EQUITY = Number(process.env.LYRA_DRY_EQUITY ?? 10_000);
const CYCLE_MS = Number(process.env.LYRA_DRY_CYCLE_MS ?? 60_000);

const venueDb = new DatabaseSync(process.env.LYRA_DB ?? DEFAULT_CONFIG.dbPath, { readOnly: true });
const store = new ExecutionStore(process.env.LYRA_EXEC_DB ?? ".lyra/exec.db");

const client = new DecisionClient({
  endpoint: required("AZURE_OPENAI_ENDPOINT"),
  apiKey: required("AZURE_OPENAI_API_KEY"),
  apiVersion: required("AZURE_OPENAI_API_VERSION"),
  deployment: required("AZURE_OPENAI_MODEL"),
});

const lastSeen = new Map<string, LastSeen>();
const tally = {
  cycles: 0,
  gateSkips: 0,
  consultations: 0,
  holds: 0,
  wouldOpen: 0,
  refusals: 0,
  costUsd: 0,
  byReason: new Map<string, number>(),
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`${name} is not set. Dry mode still needs the model.\n`);
    process.exit(1);
  }
  return v;
}

function log(line: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

async function mids(): Promise<Record<string, string>> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  return (await res.json()) as Record<string, string>;
}

async function openInterest(): Promise<Record<string, number>> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  const [meta, ctxs] = (await res.json()) as [
    { universe: { name: string }[] },
    { openInterest: string; markPx: string }[],
  ];
  const out: Record<string, number> = {};
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (c) out[u.name] = Number(c.openInterest) * Number(c.markPx);
  });
  return out;
}

async function book(asset: string): Promise<{ bid: string; ask: string } | null> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: asset }),
  });
  const d = (await res.json()) as { levels?: { px: string }[][] };
  const bid = d.levels?.[0]?.[0]?.px;
  const ask = d.levels?.[1]?.[0]?.px;
  return bid && ask ? { bid, ask } : null;
}

async function cycle(): Promise<void> {
  tally.cycles++;
  const px = await mids();
  const oi = await openInterest();

  for (const asset of UNIVERSE) {
    const mid = px[asset];
    if (!mid) continue;

    const map = buildPainMap(venueDb, asset, mid, { venueOpenInterestUsd: oi[asset] ?? null });
    const gate = assessMateriality(
      { map, last: lastSeen.get(asset) ?? null, now: Date.now(), closuresSinceLast: 0 },
      DEFAULT_MATERIALITY,
    );

    if (!gate.consult) {
      tally.gateSkips++;
      bump(tally.byReason, `gate:${gate.reason}`);
      continue;
    }

    lastSeen.set(asset, {
      at: Date.now(),
      aggregateUnrealizedPnlUsd: map.aggregateUnrealizedPnlUsd,
      losingSide: map.losingSide,
    });

    const observations = painMapObservations(map);
    const consult = await client.consult({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(observations, DEFAULT_QUESTION),
      eventIds: observations.map((o) => o.id),
    });
    tally.consultations++;

    if (!consult.ok) {
      tally.refusals++;
      bump(tally.byReason, `model:${consult.failure.code}`);
      log(`${asset}  REFUSED  ${consult.failure.code}: ${consult.failure.detail.slice(0, 120)}`);
      continue;
    }

    const { decision, audit } = consult;
    tally.costUsd += audit.costUsd;

    const decisionId = randomUUID();
    store.saveDecision({
      id: decisionId,
      at: audit.at,
      asset,
      action: decision.action,
      conviction: decision.conviction,
      expectedMove: decision.expected_move,
      auditJson: JSON.stringify(audit),
      decisionJson: JSON.stringify(decision),
    });

    if (decision.action === "hold" || decision.action === "close") {
      tally.holds++;
      store.setDecisionOutcome(decisionId, `dry:${decision.action}`);
      log(
        `${asset}  ${decision.action.toUpperCase()}  ` +
          `losing=${decision.losing_side} forced=${decision.forced_orders_are} ` +
          `hyp=${decision.hypothesis} conv=${decision.conviction.toFixed(2)}  ` +
          `[${gate.triggers.join(",")}]`,
      );
      continue;
    }

    // What she WOULD have done. Sized and priced, then discarded.
    const side = decision.action === "open_long" ? "long" : "short";
    const b = await book(asset);
    const price = b ? makerPrice({ side, bid: b.bid, ask: b.ask, tickSize: "0.1" }) : null;
    const notional = sizePosition({
      equityUsd: PAPER_EQUITY,
      conviction: decision.conviction,
      volatility: 0.02,
      limits: DEFAULT_LIMITS,
    });

    tally.wouldOpen++;
    store.setDecisionOutcome(decisionId, "dry:would_open");
    log(
      `${asset}  WOULD ${decision.action.toUpperCase()}  ` +
        `${price ?? "?"} size $${notional.toFixed(0)} ` +
        `move=${(decision.expected_move * 100).toFixed(2)}% conv=${decision.conviction.toFixed(2)} ` +
        `hyp=${decision.hypothesis}  [${gate.triggers.join(",")}]`,
    );
    log(`         ${decision.reasoning.slice(0, 200)}`);
  }
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function report(): void {
  const perDay = tally.cycles > 0 ? (tally.costUsd / tally.cycles) * (86_400_000 / CYCLE_MS) : 0;
  log(
    `TALLY cycles=${tally.cycles} gate_skips=${tally.gateSkips} consults=${tally.consultations} ` +
      `holds=${tally.holds} would_open=${tally.wouldOpen} refusals=${tally.refusals} ` +
      `cost=$${tally.costUsd.toFixed(4)} (~$${perDay.toFixed(2)}/day at this rate)`,
  );
  const reasons = [...tally.byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (reasons.length) log(`      ${reasons.map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

log(`dry mode — ${UNIVERSE.length} assets, cycle ${CYCLE_MS / 1000}s, no writes to Arweave, no orders`);

let running = true;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    running = false;
    report();
    store.close();
    process.exit(0);
  });
}

while (running) {
  try {
    await cycle();
  } catch (error) {
    log(`cycle error: ${(error as Error).message}`);
  }
  if (tally.cycles % 5 === 0) report();
  await new Promise((r) => setTimeout(r, CYCLE_MS));
}
