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
    const fresh = [...midCache.entries()].every(([, v]) => Date.now() - v.at < 10_000);
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
     * What she has decided.
     *
     * Empty until the agent loop runs. The UI is required to say so rather than
     * animate something that is not happening.
     */
    "/api/activity": async (url) => {
      if (!execDb) return { available: false, decisions: [], reason: "the agent has not run yet" };
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), 100);
      const rows = execDb
        .prepare(
          `SELECT id, at, asset, action, conviction, expected_move, reasoning_arweave_id, outcome,
                  decision_json
           FROM decision ORDER BY at DESC LIMIT ?`,
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
          // Short cache: the data changes constantly and staleness is misleading.
          "cache-control": "public, max-age=5",
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
