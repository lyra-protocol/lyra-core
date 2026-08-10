/**
 * The cold path (DESIGN.md §2.3, §7.3).
 *
 * Serves what Lyra can see, to anyone who asks. Separate process from the agent,
 * opens the database **read-only**, and holds no key of any kind — so a flood of
 * requests cannot starve a decision, and a bug here cannot write state or reach
 * a signing path.
 *
 * ── What this endpoint is, and is not ───────────────────────────────────────
 *
 * The trade record is trustless: it lives on Arweave, and the terminal reads it
 * directly without touching this server. Nothing here can change what the ledger
 * says.
 *
 * The Pain Map is **not** trustless, and the UI says so plainly. It is
 * reconstructed from a dataset only we hold, because Hyperliquid serves no
 * position history and it can only be built by continuous observation. Anyone
 * can verify a trade without us. Nobody can verify the Pain Map without running
 * their own harvester for as long as we have. That asymmetry is the moat, and
 * pretending otherwise would be exactly the kind of overclaim §-1 forbids.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { buildPainMap } from "./painmap.js";
import { resourceSnapshot } from "./telemetry.js";
import { scoreShadowPromotion } from "./decide/shadow-promotion.js";
import type { PairEvidence } from "./decide/shadow-promotion.js";

export type ServeConfig = {
  port: number;
  venueDbPath: string;
  executionDbPath?: string;
  universe: readonly string[];
  /** Origins permitted to read. The data is public; this is hygiene, not secrecy. */
  allowedOrigins: string[];
};

export function createColdServer(config: ServeConfig) {
  // Read-only is enforced by the connection, not by convention.
  const venueDb = new DatabaseSync(config.venueDbPath, { readOnly: true });
  const execDb = config.executionDbPath
    ? new DatabaseSync(config.executionDbPath, { readOnly: true })
    : null;

  const midCache = new Map<string, { px: string; at: number }>();

  async function mids(): Promise<Record<string, string>> {
    const fresh = [...midCache.entries()].every(([, v]) => Date.now() - v.at < 1_000);
    if (midCache.size > 0 && fresh) {
      return Object.fromEntries([...midCache].map(([k, v]) => [k, v.px]));
    }
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    const all = (await res.json()) as Record<string, string>;
    for (const asset of config.universe) {
      const px = all[asset];
      if (px) midCache.set(asset, { px, at: Date.now() });
    }
    return Object.fromEntries([...midCache].map(([k, v]) => [k, v.px]));
  }

  const routes: Record<string, (url: URL) => Promise<unknown>> = {
    /** What the harvester has collected. The evidence that she has been watching. */
    "/api/status": async () => {
      const one = (sql: string) => (venueDb.prepare(sql).get() as { n: number }).n;
      const started = venueDb.prepare(`SELECT value FROM meta WHERE key = 'started_at'`).get() as
        | { value: string }
        | undefined;
      return {
        observingSince: started ? Number(started.value) : null,
        addresses: one(`SELECT COUNT(*) AS n FROM address`),
        openPositions: one(`SELECT COUNT(*) AS n FROM position_current WHERE szi != '0'`),
        changesLogged: one(`SELECT COUNT(*) AS n FROM position`),
        closuresObserved: one(`SELECT COUNT(*) AS n FROM position WHERE szi = '0'`),
        universe: config.universe,
        at: Date.now(),
      };
    },

    /** The Pain Map for one asset. */
    "/api/painmap": async (url) => {
      const asset = url.searchParams.get("asset") ?? "BTC";
      if (!config.universe.includes(asset)) {
        throw new HttpError(400, `${asset} is not in the universe`);
      }
      const px = (await mids())[asset];
      if (!px) throw new HttpError(503, `no mid price for ${asset}`);
      return buildPainMap(venueDb, asset, px);
    },

    /** Every asset at once, for the overview grid. */
    "/api/overview": async () => {
      const px = await mids();
      return config.universe.map((asset) => {
        if (!px[asset]) return { asset, available: false };
        const map = buildPainMap(venueDb, asset, px[asset]);
        return {
          asset,
          available: true,
          midPx: map.midPx,
          positions: map.positionsEnumerated,
          losingSide: map.losingSide,
          aggregateUnrealizedPnlUsd: map.aggregateUnrealizedPnlUsd,
          meanLeverage: map.meanLeverage,
          concentration: map.concentration,
          longs: map.longs,
          shorts: map.shorts,
          nearestCluster: map.forcedLevels[0] ?? null,
        };
      });
    },

    /**
     * Her account, as anyone may see it.
     *
     * Read-only in the strongest sense available: this process opens the
     * database read-only and holds no key, so there is no code path from a
     * request to an order.
     */
    "/api/wallet": async () => {
      if (!execDb) {
        return {
          trading: false, equityUsd: 0, notionalUsd: 0, unrealizedPnlUsd: 0,
          sessionPnlUsd: 0, openPositions: 0, dailyLossUsed: 0, positions: [],
        };
      }
      const open = execDb
        .prepare(`SELECT asset, side, size, entry_px, stop_cloid, stop_px, opened_at
                  FROM position WHERE closed_at IS NULL`)
        .all() as Record<string, unknown>[];
      const px = await mids();
      let notional = 0;
      let unrealised = 0;
      const positions = open.map((p) => {
        const size = Number(p.size);
        const entry = Number(p.entry_px);
        const mark = Number(px[p.asset as string] ?? p.entry_px);
        const signed = (p.side as string) === "long" ? 1 : -1;
        const pnl = (mark - entry) * size * signed;
        notional += Math.abs(size * mark);
        unrealised += pnl;
        return {
          asset: p.asset as string,
          side: p.side as "long" | "short",
          size: p.size as string,
          entryPx: p.entry_px as string,
          stopPx: (p.stop_px as string | null) ?? null,
          openedAt: p.opened_at as number,
          markPx: String(mark),
          // What she actually loses if the stop fills, as a fraction of equity.
          // The figure a trader reads before PnL.
          riskUsd: p.stop_px ? Math.abs((Number(p.stop_px) - entry) * size) : null,
          unrealizedPnlUsd: pnl,
        };
      });

      const since = new Date().setUTCHours(0, 0, 0, 0);
      const sum = (where: string, ...args: unknown[]) =>
        (execDb!
          .prepare(`SELECT COALESCE(SUM(CAST(pnl AS REAL)), 0) AS p,
                           COALESCE(SUM(CAST(fees AS REAL)), 0) AS f
                    FROM position WHERE ${where}`)
          .get(...(args as never[])) as { p: number; f: number });

      const today = sum("closed_at >= ?", since);
      const priorToToday = sum("closed_at IS NOT NULL AND closed_at < ?", since);

      /*
       * Equity is reconstructed rather than read from the venue.
       *
       * This process is deliberately read-only and holds no key, so it cannot
       * ask Hyperliquid anything — which is the property that makes the whole
       * endpoint safe to expose. The cost is that equity is derived: starting
       * capital, plus everything realised, minus fees, plus what is open.
       *
       * It will differ from the venue by funding payments, which are not in
       * this database. Stated here rather than hidden because a figure that
       * silently disagrees with the venue is worse than one known to.
       */
      const startingEquity = Number(process.env.LYRA_PAPER_EQUITY ?? 10_000);
      const realisedAll = today.p + priorToToday.p;
      const feesAll = today.f + priorToToday.f;
      const equity = startingEquity + realisedAll - feesAll + unrealised;

      // The 7% breaker measures the day against the equity the day opened with.
      const sessionStart = startingEquity + priorToToday.p - priorToToday.f;
      const sessionPnl = today.p - today.f + unrealised;
      const dailyLossUsed = sessionStart > 0 ? Math.max(0, -sessionPnl) / sessionStart : 0;

      return {
        trading: open.length > 0 || realisedAll !== 0,
        equityUsd: equity,
        // The breaker measures the day against this, so the dollar value of
        // the 7% floor is derivable rather than a percentage with no anchor.
        sessionStartEquityUsd: sessionStart,
        notionalUsd: notional,
        unrealizedPnlUsd: unrealised,
        sessionPnlUsd: sessionPnl,
        openPositions: open.length,
        dailyLossUsed,
        positions,
      };
    },

    /**
     * What she has actually done: closed trades, newest first.
     *
     * The decision feed shows what she thought. This shows what it was worth.
     * Separated because a terminal that only shows open risk lets a run look
     * good by never closing anything, and one that only shows reasoning never
     * has to be right.
     */
    "/api/trades": async (url) => {
      if (!execDb) return { trades: [], realisedUsd: 0, feesUsd: 0, netUsd: 0, wins: 0, losses: 0 };
      const requested = Number(url.searchParams.get("limit") ?? 200);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(Math.floor(requested), 200))
        : 200;
      const rows = execDb
        .prepare(
            `SELECT id, asset, side, size, entry_px, exit_px, pnl, fees, opened_at, closed_at,
              reasoning_id, recorded_arweave_id, hypothesis, conviction, expected_move,
              target_px, strategy_id, close_reason, close_decision_id, close_cloid
             FROM position WHERE closed_at IS NOT NULL
            ORDER BY closed_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[];

      const totals = execDb
        .prepare(
          `SELECT COALESCE(SUM(CAST(pnl AS REAL)), 0) AS p,
                  COALESCE(SUM(CAST(fees AS REAL)), 0) AS f,
                  SUM(CASE WHEN CAST(pnl AS REAL) > 0 THEN 1 ELSE 0 END) AS w,
                  SUM(CASE WHEN CAST(pnl AS REAL) <= 0 THEN 1 ELSE 0 END) AS l
             FROM position WHERE closed_at IS NOT NULL`,
        )
        .get() as { p: number; f: number; w: number | null; l: number | null };

      return {
        trades: rows.map((r) => ({
          id: Number(r.id),
          asset: r.asset as string,
          side: r.side as "long" | "short",
          size: r.size as string,
          entryPx: r.entry_px as string,
          exitPx: r.exit_px as string,
          // Net is what actually reached the account. Gross and fees are both
          // kept so the figure can be checked rather than trusted.
          pnlUsd: Number(r.pnl),
          feesUsd: Number(r.fees),
          netUsd: Number(r.pnl) - Number(r.fees),
          openedAt: r.opened_at as number,
          closedAt: r.closed_at as number,
          heldMs: (r.closed_at as number) - (r.opened_at as number),
          reasoningId: (r.reasoning_id as string | null) ?? null,
          recordId: (r.recorded_arweave_id as string | null) ?? null,
          hypothesis: (r.hypothesis as string | null) ?? null,
          conviction: r.conviction === null ? null : Number(r.conviction),
          expectedMove: r.expected_move === null ? null : Number(r.expected_move),
          targetPx: (r.target_px as string | null) ?? null,
          strategyId: (r.strategy_id as string | null) ?? null,
          closeReason: (r.close_reason as string | null) ?? "legacy_unknown",
          closeDecisionId: (r.close_decision_id as string | null) ?? null,
          closeCloid: (r.close_cloid as string | null) ?? null,
        })),
        realisedUsd: totals.p,
        feesUsd: totals.f,
        netUsd: totals.p - totals.f,
        wins: totals.w ?? 0,
        losses: totals.l ?? 0,
      };
    },

    /**
     * What she has decided.
     *
     * Empty until the agent loop runs. The UI is required to say so rather than
     * animate something that is not happening.
     */
    "/api/activity": async (url) => {
      if (!execDb) return { available: false, decisions: [], reason: "the agent has not run yet" };
      const requested = Number(url.searchParams.get("limit") ?? 40);
      const limit = Number.isFinite(requested)
        ? Math.max(1, Math.min(Math.floor(requested), 100))
        : 40;
      const rows = execDb
        .prepare(
          `SELECT id, at, asset, action, conviction, expected_move, reasoning_arweave_id, outcome,
                  decision_json
           FROM decision ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[];
      return {
        available: true,
        decisions: rows.map((r) => {
          const d = JSON.parse(r.decision_json as string) as Record<string, unknown>;
          return {
            id: r.id,
            at: r.at,
            asset: r.asset,
            action: r.action,
            conviction: r.conviction,
            expectedMove: r.expected_move,
            reasoningId: r.reasoning_arweave_id,
            outcome: r.outcome,
            losingSide: d.losing_side,
            forcedOrdersAre: d.forced_orders_are,
            hypothesis: d.hypothesis,
            reasoning: d.reasoning,
          };
        }),
      };
    },

    /** Compute is capital too: public, bounded usage accounting with no prompts or secrets. */
    "/api/usage": async (url) => {
      if (!execDb || !hasTable(execDb, "inference_call")) {
        return { available: false, reason: "inference accounting has not started", days: [] };
      }
      const requested = Number(url.searchParams.get("days") ?? 14);
      const days = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 90)) : 14;
      const since = Date.now() - days * 86_400_000;
      const rows = execDb.prepare(
        `SELECT
           date(started_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS attempts,
           SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN transport_ok = 0 THEN 1 ELSE 0 END) AS transport_failures,
           SUM(CASE WHEN validation_ok = 0 THEN 1 ELSE 0 END) AS validation_failures,
           COALESCE(SUM(reported_prompt_tokens), 0) AS reported_prompt_tokens,
           COALESCE(SUM(reported_completion_tokens), 0) AS reported_completion_tokens,
           COALESCE(SUM(accounted_prompt_tokens), 0) AS accounted_prompt_tokens,
           COALESCE(SUM(accounted_completion_tokens), 0) AS accounted_completion_tokens,
           COALESCE(SUM(accounted_cost_usd), 0) AS accounted_cost_usd,
           AVG(latency_ms) AS average_latency_ms
         FROM inference_call WHERE started_at >= ?
         GROUP BY day ORDER BY day DESC`,
      ).all(since) as Record<string, unknown>[];
      return {
        available: true,
        pricing: "application estimate; provider invoice may differ",
        days: rows.map((r) => ({
          day: r.day,
          attempts: Number(r.attempts),
          pending: Number(r.pending),
          transportFailures: Number(r.transport_failures),
          validationFailures: Number(r.validation_failures),
          reportedPromptTokens: Number(r.reported_prompt_tokens),
          reportedCompletionTokens: Number(r.reported_completion_tokens),
          accountedPromptTokens: Number(r.accounted_prompt_tokens),
          accountedCompletionTokens: Number(r.accounted_completion_tokens),
          accountedTotalTokens:
            Number(r.accounted_prompt_tokens) + Number(r.accounted_completion_tokens),
          accountedCostUsd: Number(r.accounted_cost_usd),
          averageLatencyMs: r.average_latency_ms === null ? null : Number(r.average_latency_ms),
        })),
      };
    },

    /** Recomputable learning record; no model interpretation is trusted here. */
    "/api/performance": async () => {
      if (!execDb) return { available: false, lifetime: [], rolling20: [], rolling50: [] };
      const stats = (limit?: number) => performanceStats(execDb, limit);
      return {
        available: true,
        lifetime: stats(),
        rolling20: stats(20),
        rolling50: stats(50),
      };
    },

    "/api/resources": async () => resourceSnapshot({
      venueDb: config.venueDbPath,
      venueWal: `${config.venueDbPath}-wal`,
      executionDb: config.executionDbPath ?? "",
      executionWal: config.executionDbPath ? `${config.executionDbPath}-wal` : "",
    }),

    "/api/shadow": async (url) => {
      if (!execDb || !hasTable(execDb, "shadow_evaluation")) {
        return { available: false, summary: null, evaluations: [] };
      }
      const requested = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 200)) : 50;
      const filters = [
        ["prompt_template", url.searchParams.get("promptTemplate")],
        ["schema_hash", url.searchParams.get("schemaHash")],
        ["champion_model", url.searchParams.get("championModel")],
        ["challenger_model", url.searchParams.get("challengerModel")],
        ["evaluation_version", url.searchParams.get("evaluationVersion")],
      ] as const;
      const clauses = filters.filter(([, value]) => value !== null).map(([column]) => `s.${column}=?`);
      const args = filters.flatMap(([, value]) => value === null ? [] : [value]);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const summary = execDb.prepare(
        `SELECT COUNT(*) total,
         SUM(status='completed') completed,
         SUM(status='skipped_budget') skipped_budget,
         SUM(status='skipped_busy') skipped_busy,
         SUM(challenger_semantic_code IS NOT NULL) semantic_violations,
         SUM(all_agreement=1) full_agreements,
         AVG(all_agreement) agreement_rate
        FROM shadow_evaluation s ${where}`,
      ).get(...(args as never[])) as Record<string, unknown>;
      const rows = execDb.prepare(
        `SELECT s.*, c.model challenger_model_actual, c.latency_ms challenger_latency_ms,
                c.reported_prompt_tokens challenger_prompt_tokens,
                c.reported_completion_tokens challenger_completion_tokens,
                c.reported_cost_usd challenger_cost_usd,
                c.parsed_decision_json challenger_decision_json,
                d.action champion_action, d.decision_json champion_decision_json
         FROM shadow_evaluation s
         LEFT JOIN inference_call c ON c.attempt_id=s.challenger_attempt_id
         LEFT JOIN decision d ON d.id=s.champion_decision_id
         ${where}
         ORDER BY s.created_at DESC LIMIT ?`,
      ).all(...(args as never[]), limit) as Record<string, unknown>[];
      const outcomeWhere = clauses.length
        ? `WHERE ${clauses.map((clause) => clause.replace(/^s\./, "v.")).join(" AND ")}`
        : "";
      const outcomes = hasTable(execDb, "shadow_virtual_position")
        ? execDb.prepare(
          `SELECT role,COUNT(*) total,SUM(status='open') open,SUM(status!='open') resolved,
                  SUM(status='target') targets,SUM(status='stop') stops,SUM(status='horizon') horizons,
                  SUM(CASE WHEN status!='open' AND net_pnl_usd>0 THEN 1 ELSE 0 END) wins,
                  SUM(CASE WHEN status!='open' THEN gross_pnl_usd ELSE 0 END) gross_pnl_usd,
                  SUM(CASE WHEN status!='open' THEN total_fees_usd ELSE 0 END) fees_usd,
                  SUM(CASE WHEN status!='open' THEN net_pnl_usd ELSE 0 END) net_pnl_usd,
                  AVG(CASE WHEN status!='open' THEN net_pnl_usd END) average_net_pnl_usd,
                  AVG(CASE WHEN status!='open' THEN mfe_usd END) average_mfe_usd,
                  AVG(CASE WHEN status!='open' THEN mae_usd END) average_mae_usd
             FROM shadow_virtual_position v ${outcomeWhere} GROUP BY role ORDER BY role`,
        ).all(...(args as never[])) as Record<string, unknown>[]
        : [];
      return {
        available: true,
        filters: Object.fromEntries(filters.filter(([, value]) => value !== null)),
        summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Number(v ?? 0)])),
        outcomes: outcomes.map((r) => ({
          role: r.role, total: Number(r.total), open: Number(r.open), resolved: Number(r.resolved),
          targets: Number(r.targets), stops: Number(r.stops), horizons: Number(r.horizons),
          wins: Number(r.wins), winRate: Number(r.resolved) ? Number(r.wins) / Number(r.resolved) : 0,
          grossPnlUsd: Number(r.gross_pnl_usd), feesUsd: Number(r.fees_usd),
          netPnlUsd: Number(r.net_pnl_usd), averageNetPnlUsd: Number(r.average_net_pnl_usd),
          averageMfeUsd: Number(r.average_mfe_usd), averageMaeUsd: Number(r.average_mae_usd),
        })),
        evaluations: rows.map((r) => ({
          pairId: r.pair_id, at: r.created_at, asset: r.asset, status: r.status,
          championAction: r.champion_action ?? null,
          challengerModel: r.challenger_model_actual ?? r.challenger_model,
          championModel: r.champion_model ?? null,
          promptTemplate: r.prompt_template ?? null,
          schemaHash: r.schema_hash ?? null,
          evaluationVersion: r.evaluation_version ?? null,
          challengerLatencyMs: r.challenger_latency_ms ?? null,
          challengerTokens: Number(r.challenger_prompt_tokens ?? 0) + Number(r.challenger_completion_tokens ?? 0),
          challengerCostUsd: r.challenger_cost_usd ?? null,
          championSemanticCode: r.champion_semantic_code ?? null,
          challengerSemanticCode: r.challenger_semantic_code ?? null,
          actionAgreement: r.action_agreement === null ? null : Boolean(r.action_agreement),
          hypothesisAgreement: r.hypothesis_agreement === null ? null : Boolean(r.hypothesis_agreement),
          targetAgreement: r.target_agreement === null ? null : Boolean(r.target_agreement),
          convictionAgreement: r.conviction_agreement === null ? null : Boolean(r.conviction_agreement),
          allAgreement: r.all_agreement === null ? null : Boolean(r.all_agreement),
          targetRelativeDelta: r.target_relative_delta ?? null,
          convictionAbsoluteDelta: r.conviction_absolute_delta ?? null,
          championDecision: safeJson(r.champion_decision_json),
          challengerDecision: safeJson(r.challenger_decision_json),
          detail: r.detail ?? null,
        })),
      };
    },

    "/api/shadow/readiness": async (url) => {
      if (!execDb || !hasTable(execDb, "shadow_virtual_position")) {
        return { available: false, reason: "shadow outcome evaluation has not started" };
      }
      const filters = [
        ["prompt_template", url.searchParams.get("promptTemplate")],
        ["schema_hash", url.searchParams.get("schemaHash")],
        ["champion_model", url.searchParams.get("championModel")],
        ["challenger_model", url.searchParams.get("challengerModel")],
        ["evaluation_version", url.searchParams.get("evaluationVersion")],
      ] as const;
      const clauses = ["s.status='completed'", "s.champion_semantic_code IS NULL", "s.challenger_semantic_code IS NULL"];
      const args: string[] = [];
      for (const [column, value] of filters) if (value !== null) { clauses.push(`s.${column}=?`); args.push(value); }
      const evidence = (execDb.prepare(
        `SELECT s.pair_id,s.created_at,s.asset,
                json_extract(s.champion_decision_json,'$.action') champion_action,
                json_extract(s.challenger_decision_json,'$.action') challenger_action,
                json_extract(s.champion_decision_json,'$.thesis_status') champion_thesis_status,
                json_extract(s.challenger_decision_json,'$.thesis_status') challenger_thesis_status,
                cv.status champion_position_status,cv.net_pnl_usd champion_net_pnl_usd,
                xv.status challenger_position_status,xv.net_pnl_usd challenger_net_pnl_usd,
                ci.latency_ms champion_latency_ms,xi.latency_ms challenger_latency_ms,
                ci.accounted_cost_usd champion_cost_usd,xi.accounted_cost_usd challenger_cost_usd
         FROM shadow_evaluation s
         LEFT JOIN shadow_virtual_position cv ON cv.pair_id=s.pair_id AND cv.role='champion'
         LEFT JOIN shadow_virtual_position xv ON xv.pair_id=s.pair_id AND xv.role='challenger'
         LEFT JOIN inference_call ci ON ci.attempt_id=s.champion_attempt_id
         LEFT JOIN inference_call xi ON xi.attempt_id=s.challenger_attempt_id
         WHERE ${clauses.join(" AND ")} ORDER BY s.created_at`,
      ).all(...(args as never[])) as Record<string, unknown>[]).map(rowToPairEvidence);
      const qualityClauses = ["status NOT IN ('skipped_busy','skipped_budget')"];
      const qualityArgs: string[] = [];
      for (const [column, value] of filters) if (value !== null) { qualityClauses.push(`${column}=?`); qualityArgs.push(value); }
      const qualityRow = execDb.prepare(
        `SELECT COUNT(*) attempted,
                SUM(status='completed' AND champion_semantic_code IS NULL AND challenger_semantic_code IS NULL) valid
         FROM shadow_evaluation WHERE ${qualityClauses.join(" AND ")}`,
      ).get(...(qualityArgs as never[])) as Record<string, unknown>;
      return {
        available: true,
        filters: Object.fromEntries(filters.filter(([, value]) => value !== null)),
        ...scoreShadowPromotion(evidence, {
          attempted: Number(qualityRow.attempted ?? 0), valid: Number(qualityRow.valid ?? 0),
        }),
      };
    },

    "/api/shadow/failures": async (url) => {
      if (!execDb || !hasTable(execDb, "shadow_evaluation")) {
        return { available: false, reason: "shadow evaluation has not started" };
      }
      const filters = [
        ["prompt_template", url.searchParams.get("promptTemplate")],
        ["schema_hash", url.searchParams.get("schemaHash")],
        ["champion_model", url.searchParams.get("championModel")],
        ["challenger_model", url.searchParams.get("challengerModel")],
        ["evaluation_version", url.searchParams.get("evaluationVersion")],
      ] as const;
      const clauses: string[] = []; const args: string[] = [];
      for (const [column, value] of filters) if (value !== null) { clauses.push(`s.${column}=?`); args.push(value); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const statuses = execDb.prepare(
        `SELECT status code,COUNT(*) count FROM shadow_evaluation s ${where} GROUP BY status ORDER BY count DESC`,
      ).all(...(args as never[])) as Record<string, unknown>[];
      const semantics = execDb.prepare(
        `SELECT role,code,COUNT(*) count FROM (
           SELECT 'champion' role,champion_semantic_code code FROM shadow_evaluation s ${where}
           UNION ALL
           SELECT 'challenger' role,challenger_semantic_code code FROM shadow_evaluation s ${where}
         ) WHERE code IS NOT NULL GROUP BY role,code ORDER BY count DESC`,
      ).all(...(args as never[]), ...(args as never[])) as Record<string, unknown>[];
      const inference = execDb.prepare(
        `SELECT i.role,i.failure_code code,COUNT(*) count
         FROM shadow_evaluation s JOIN inference_call i
           ON i.attempt_id=s.champion_attempt_id OR i.attempt_id=s.challenger_attempt_id
         ${where}${where ? " AND" : " WHERE"} i.failure_code IS NOT NULL
         GROUP BY i.role,i.failure_code ORDER BY count DESC`,
      ).all(...(args as never[])) as Record<string, unknown>[];
      return {
        available: true,
        filters: Object.fromEntries(filters.filter(([, value]) => value !== null)),
        statuses: statuses.map((r) => ({ code: r.code, count: Number(r.count) })),
        semanticFailures: semantics.map((r) => ({ role: r.role, code: r.code, count: Number(r.count) })),
        inferenceFailures: inference.map((r) => ({ role: r.role, code: r.code, count: Number(r.count) })),
      };
    },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
    } else if (config.allowedOrigins.includes("*")) {
      res.setHeader("access-control-allow-origin", "*");
    }
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("vary", "origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "read only" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const handler = routes[url.pathname];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", routes: Object.keys(routes) }));
      return;
    }

    void handler(url)
      .then((body) => {
        res.writeHead(200, {
          "content-type": "application/json",
          // Account state must never be replayed from an intermediary cache.
          "cache-control": "no-store, max-age=0",
        });
        res.end(JSON.stringify(body));
      })
      .catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      });
  });

  return {
    listen: () =>
      new Promise<void>((resolve) => server.listen(config.port, "0.0.0.0", () => resolve())),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function rowToPairEvidence(r: Record<string, unknown>): PairEvidence {
  const nullableNumber = (value: unknown) => value === null ? null : Number(value);
  return {
    pairId: String(r.pair_id), at: Number(r.created_at), asset: String(r.asset),
    championAction: String(r.champion_action), challengerAction: String(r.challenger_action),
    championThesisStatus: String(r.champion_thesis_status), challengerThesisStatus: String(r.challenger_thesis_status),
    championPositionStatus: r.champion_position_status as string | null,
    challengerPositionStatus: r.challenger_position_status as string | null,
    championNetPnlUsd: nullableNumber(r.champion_net_pnl_usd),
    challengerNetPnlUsd: nullableNumber(r.challenger_net_pnl_usd),
    championLatencyMs: nullableNumber(r.champion_latency_ms), challengerLatencyMs: nullableNumber(r.challenger_latency_ms),
    championCostUsd: nullableNumber(r.champion_cost_usd), challengerCostUsd: nullableNumber(r.challenger_cost_usd),
  };
}

function performanceStats(db: DatabaseSync, limit?: number) {
  const window = limit && limit > 0
    ? `SELECT * FROM position WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ${Math.floor(limit)}`
    : `SELECT * FROM position WHERE closed_at IS NOT NULL`;
  const dimensions = [
    ["asset", "asset"], ["side", "side"],
    ["hypothesis", "COALESCE(hypothesis, 'legacy_unknown')"],
    ["strategy", "COALESCE(strategy_id, 'legacy_unknown')"],
    ["close_reason", "COALESCE(close_reason, 'legacy_unknown')"],
  ] as const;
  return dimensions.flatMap(([dimension, expression]) =>
    (db.prepare(
      `WITH trades AS (${window}) SELECT ${expression} AS key, COUNT(*) AS trades,
       SUM(CASE WHEN CAST(pnl AS REAL)-CAST(fees AS REAL)>0 THEN 1 ELSE 0 END) AS wins,
       SUM(CAST(pnl AS REAL)-CAST(fees AS REAL)) AS net_usd,
       AVG(CAST(pnl AS REAL)-CAST(fees AS REAL)) AS average_net_usd,
       AVG(closed_at-opened_at) AS average_hold_ms
       FROM trades GROUP BY key ORDER BY net_usd DESC`,
    ).all() as Record<string, unknown>[]).map((r) => ({
      dimension, key: r.key, trades: Number(r.trades), wins: Number(r.wins),
      winRate: Number(r.trades) ? Number(r.wins) / Number(r.trades) : 0,
      netUsd: Number(r.net_usd), averageNetUsd: Number(r.average_net_usd),
      averageHoldMs: Number(r.average_hold_ms),
    })),
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
