/**
 * Realised volatility, per asset.
 *
 * Sizing divides by this, so a single number applied to every asset would size
 * BTC and a memecoin identically for the same conviction — which is not one
 * decision applied twice, it is two very different bets.
 *
 * Computed from the venue's own hourly candles as the standard deviation of log
 * returns, scaled to a daily figure. Cached, because it moves slowly and the
 * rate limit is worth more elsewhere.
 */

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { value: number; at: number }>();

/** Fallback used when candles are unavailable: assume the riskiest case. */
const CONSERVATIVE = 0.08;

export async function realisedVolatility(asset: string, now = Date.now()): Promise<number> {
  const hit = cache.get(asset);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin: asset, interval: "1h", startTime: now - 7 * 24 * 3_600_000, endTime: now },
      }),
    });
    const candles = (await res.json()) as { c: string }[];
    if (!Array.isArray(candles) || candles.length < 24) {
      cache.set(asset, { value: CONSERVATIVE, at: now });
      return CONSERVATIVE;
    }

    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = Number(candles[i - 1]!.c);
      const curr = Number(candles[i]!.c);
      if (prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
    }
    if (returns.length < 12) {
      cache.set(asset, { value: CONSERVATIVE, at: now });
      return CONSERVATIVE;
    }

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    // Hourly sigma scaled to daily by root-time.
    const daily = Math.sqrt(variance) * Math.sqrt(24);

    // Bounded: a degenerate reading must not produce an enormous position.
    const value = Math.min(0.5, Math.max(0.005, daily));
    cache.set(asset, { value, at: now });
    return value;
  } catch {
    cache.set(asset, { value: CONSERVATIVE, at: now });
    return CONSERVATIVE;
  }
}
