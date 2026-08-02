#!/usr/bin/env node
/**
 * Entry point for the harvester.
 *
 * Runs until stopped. Stopping loses data permanently, so it handles SIGINT and
 * SIGTERM by closing the database cleanly rather than dying mid-write.
 */

import { Harvester, DEFAULT_CONFIG } from "./harvest.js";

const harvester = new Harvester({
  ...DEFAULT_CONFIG,
  dbPath: process.env.LYRA_DB ?? DEFAULT_CONFIG.dbPath,
});

harvester.start();
process.stdout.write(
  `[${new Date().toISOString()}] harvester started — universe: ${DEFAULT_CONFIG.universe.join(", ")}\n`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stdout.write(`\n[${new Date().toISOString()}] ${signal} — closing cleanly\n`);
    void harvester.stop().then(() => process.exit(0));
  });
}
