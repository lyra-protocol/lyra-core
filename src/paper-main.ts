#!/usr/bin/env node
/**
 * Paper trading, off chain.
 *
 * The full agent: gate, decision, guard, execution, positions, stops, PnL. She
 * opens and closes real positions against the live Hyperliquid book with no
 * money at risk, and **nothing is written to Arweave**.
 *
 * The distinction matters. This is not a simulation of trading — it is trading,
 * with the ledger withheld. Reasoning ids are prefixed "local:" so nothing here
 * can ever be mistaken for a permanent record.
 *
 * Why the ledger waits: the strategy has never been validated in any form, and
 * the gate and sizing constants were chosen without data behind them. Arweave
 * has no delete, so a ledger begun now would preserve the noise of untuned
 * parameters under her name forever. Watch her earn first; write second.
 */

import { DatabaseSync } from "node:sqlite";
import { Agent, strategyId } from "./agent.js";
import { DecisionClient } from "./decide/client.js";
import { schemaHash, PROMPT_TEMPLATE_ID } from "./decide/schema.js";
import { PaperVenue } from "./execute/paper.js";
import { ExecutionStore } from "./execute/store.js";
import { Recorder } from "./record/recorder.js";
import { DEFAULT_LIMITS } from "./risk/limits.js";
import { DEFAULT_CONFIG } from "./harvest.js";
import { realisedVolatility } from "./volatility.js";
import { ShadowEvaluator } from "./decide/shadow.js";

const UNIVERSE = DEFAULT_CONFIG.universe;
const EQUITY = Number(process.env.LYRA_PAPER_EQUITY ?? 10_000);
const CYCLE_MS = Number(process.env.LYRA_CYCLE_MS ?? 60_000);
const SETTLE_MS = Number(process.env.LYRA_SETTLE_MS ?? 10_000);

function need(name: string): string {
  const v = process.env[name];
  if (!v) { process.stderr.write(`${name} is not set\n`); process.exit(1); }
  return v;
}
const log = (l: string) => process.stdout.write(`[${new Date().toISOString()}] ${l}\n`);

const venueDb = new DatabaseSync(process.env.LYRA_DB ?? DEFAULT_CONFIG.dbPath, { readOnly: true });
const store = new ExecutionStore(process.env.LYRA_EXEC_DB ?? ".lyra/exec.db");

/** Books and trades come from the venue, so paper fills are against real depth. */
const info = async (body: unknown) =>
  (await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).json();

const bookOf = async (asset: string) => {
  const d = (await info({ type: "l2Book", coin: asset })) as { levels?: { px: string }[][] };
  const bid = d.levels?.[0]?.[0]?.px ?? "0";
  const ask = d.levels?.[1]?.[0]?.px ?? "0";
  return { bid, ask, ts: Date.now() };
};

const tradesOf = async (asset: string) => {
  const d = (await info({ type: "recentTrades", coin: asset })) as
    | { px: string; sz: string; time: number }[]
    | undefined;
  return Array.isArray(d) ? d.map((t) => ({ px: t.px, sz: t.sz, time: t.time })) : [];
};

const venue = new PaperVenue(EQUITY, bookOf, tradesOf);
const activeStrategyId = strategyId({
  promptTemplate: PROMPT_TEMPLATE_ID,
  schemaHash: schemaHash(),
  model: need("AZURE_OPENAI_MODEL"),
  limits: DEFAULT_LIMITS,
});
const challengerModel = process.env.AZURE_OPENAI_CHALLENGER_MODEL;
const challengerEnabled = process.env.AZURE_OPENAI_CHALLENGER_ENABLED !== "false";
const shadow = challengerModel && challengerEnabled
  ? new ShadowEvaluator({
      client: new DecisionClient({
        endpoint: need("AZURE_OPENAI_ENDPOINT"), apiKey: need("AZURE_OPENAI_API_KEY"),
        apiVersion: need("AZURE_OPENAI_API_VERSION"), deployment: challengerModel,
        reasoningEffort: "low",
      }),
      store,
      maxDailyUsd: Number(process.env.LYRA_CHALLENGER_DAILY_USD ?? 1),
      maxDailyTokens: Number(process.env.LYRA_CHALLENGER_DAILY_TOKENS ?? 500_000),
      log,
    })
  : undefined;

const agent = new Agent({
  universe: UNIVERSE,
  venue,
  store,
  startingEquityUsd: EQUITY,
  recorder: new Recorder({
    // Off chain: the key is never used to sign anything in this mode.
    key: { publicKey: "paper", seed: new Uint8Array(32), irysWallet: "paper" },
    venueAddress: "paper",
    strategyId: activeStrategyId,
    mode: "offchain",
  }),
  client: new DecisionClient({
    endpoint: need("AZURE_OPENAI_ENDPOINT"),
    apiKey: need("AZURE_OPENAI_API_KEY"),
    apiVersion: need("AZURE_OPENAI_API_VERSION"),
    deployment: need("AZURE_OPENAI_MODEL"),
  }),
  shadow,
  venueDb,
  book: bookOf,
  mids: async () => (await info({ type: "allMids" })) as Record<string, string>,
  openInterestUsd: async (asset) => {
    const [meta, ctxs] = (await info({ type: "metaAndAssetCtxs" })) as [
      { universe: { name: string }[] },
      { openInterest: string; markPx: string }[],
    ];
    const i = meta.universe.findIndex((u) => u.name === asset);
    const c = i >= 0 ? ctxs[i] : undefined;
    return c ? Number(c.openInterest) * Number(c.markPx) : null;
  },
  volatility: (asset) => realisedVolatility(asset),
  log,
  strategyId: activeStrategyId,
});

/*
 * Restore the venue before reconciling.
 *
 * The store survived the restart and the in-memory venue did not, so without
 * this every open position reads as closed-while-down and equity resets to its
 * starting figure. Neither happened; the process simply stopped.
 */
{
  const open = store.openPositions();
  const totals = store.realisedAround(0);
  venue.adopt({
    positions: open,
    realisedPnl: totals.sincePnl,
    feesPaid: totals.sinceFees + open.reduce((t, p) => t + Number(p.fees ?? 0), 0),
  });
  if (open.length > 0) log(`restored ${open.length} open position(s) from the store`);
}

const started = await agent.start();
if (!started.ok) {
  log(`REFUSED TO START: ${started.detail}`);
  process.exit(1);
}
log(`paper trading, OFF CHAIN — ${UNIVERSE.length} assets, $${EQUITY} notional equity`);
log(started.detail);

let running = true;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { running = false; store.close(); process.exit(0); });
}

/**
 * Resting orders are advanced against real trades between decision cycles.
 *
 * The agent owns what happens to a fill — it opens the position, attaches the
 * stop and drives the ledger. This loop only decides *when* to look, which is
 * the one thing that differs between paper and live.
 */
setInterval(() => {
  void (async () => {
    try {
      for (const o of await agent.settle()) {
        if (o.result === "opened") log(`FILL ${o.asset} opened ${o.size} @ ${o.px}`);
        else if (o.result === "added") log(`FILL ${o.asset} added → ${o.size} @ ${o.px}`);
        else if (o.result === "closed") log(`FILL ${o.asset} closed @ ${o.px} pnl ${o.pnl} (${o.why})`);
        else log(`FILL ${o.asset} ORPHAN ${o.cloid} — ${o.detail}`);
      }
    } catch (error) { log(`settle FAILED: ${(error as Error).message}`); }
  })();
}, SETTLE_MS);

while (running) {
  try {
    for (const o of await agent.cycle()) {
      if (o.result === "skipped") continue;
      if (o.result === "held") log(`${o.asset}  HOLD  ${o.reasoning.slice(0, 150)}`);
      else if (o.result === "placed") log(`${o.asset}  PLACED ${o.size} @ ${o.price}`);
      else if (o.result === "refused") log(`${o.asset}  refused ${o.code}: ${o.detail.slice(0, 110)}`);
      else log(`${o.asset}  BLOCKED ${o.detail.slice(0, 140)}`);
    }
    const s = venue.stats();
    const eq = await venue.equityUsd();
    log(
      `equity $${eq.toFixed(2)} | realised $${s.realisedPnl.toFixed(2)} | fees $${s.feesPaid.toFixed(2)} ` +
        `| open ${s.openPositions} | resting ${s.restingOrders} | stops ${s.stops}`,
    );
  } catch (error) {
    log(`cycle error: ${(error as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, CYCLE_MS));
}
