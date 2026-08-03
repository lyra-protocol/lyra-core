#!/usr/bin/env node
/**
 * Entry point for the cold path.
 *
 * Runs beside the harvester, reads its database read-only, and holds no key.
 */

import { existsSync } from "node:fs";
import { createColdServer } from "./serve.js";
import { DEFAULT_CONFIG } from "./harvest.js";

const server = createColdServer({
  port: Number(process.env.LYRA_SERVE_PORT ?? 8788),
  venueDbPath: process.env.LYRA_DB ?? DEFAULT_CONFIG.dbPath,
  // Present only once the agent has run; the endpoints degrade honestly without it.
  ...(process.env.LYRA_EXEC_DB && existsSync(process.env.LYRA_EXEC_DB)
    ? { executionDbPath: process.env.LYRA_EXEC_DB }
    : {}),
  universe: DEFAULT_CONFIG.universe,
  allowedOrigins: (process.env.LYRA_ALLOWED_ORIGINS ?? "*").split(","),
});

await server.listen();
process.stdout.write(
  `[${new Date().toISOString()}] cold path listening on ${process.env.LYRA_SERVE_PORT ?? 8788}\n`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
