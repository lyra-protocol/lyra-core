import type { DatabaseSync } from "node:sqlite";

/** Counts observed position disappearances in the append-only venue history. */
export function closureCountBetween(
  venueDb: DatabaseSync,
  asset: string,
  afterExclusive: number,
  throughInclusive: number,
): number {
  const row = venueDb.prepare(
    `SELECT COUNT(*) AS n FROM position
      WHERE coin = ? AND szi = '0' AND ts > ? AND ts <= ?`,
  ).get(asset, afterExclusive, throughInclusive) as { n: number | bigint };
  return Number(row.n);
}