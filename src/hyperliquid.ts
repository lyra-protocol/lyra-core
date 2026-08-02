/**
 * Hyperliquid public API client.
 *
 * Read-only. This module never signs, never places an order and holds no key —
 * it exists purely to observe. Order placement lives elsewhere behind the key
 * boundary (DESIGN.md D4, §7.3).
 *
 * Rate limits, from the venue's documentation rather than guessed:
 *   - 1200 weight per minute per IP, aggregated across all REST requests
 *   - clearinghouseState, l2Book, allMids cost weight 2
 *   - most other info requests cost weight 20
 *
 * So the ceiling is 600 clearinghouseState calls/minute. The default here is
 * deliberately half of that: being throttled would create a gap in a dataset
 * that cannot be backfilled, which is a far worse outcome than harvesting
 * slowly.
 */

const INFO_URL = "https://api.hyperliquid.xyz/info";

export const WEIGHT_LIMIT_PER_MIN = 1200;
export const WEIGHT_CLEARINGHOUSE = 2;

export type RawPosition = {
  coin: string;
  szi: string;
  entryPx?: string | null;
  liquidationPx?: string | null;
  unrealizedPnl: string;
  positionValue: string;
  marginUsed: string;
  leverage?: { type?: string; value?: number } | null;
};

export type ClearinghouseState = {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
  assetPositions: { position: RawPosition }[];
  time?: number;
};

/**
 * A token bucket over the venue's published weight budget.
 *
 * Weight is refilled continuously rather than in per-minute steps, so a burst
 * at the start of a minute cannot exhaust the budget and stall the rest of it.
 */
export class RateLimiter {
  private available: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.available = capacity;
  }

  /** Weight-per-minute budget, e.g. 600 of the venue's 1200. */
  static perMinute(weightPerMinute: number): RateLimiter {
    return new RateLimiter(weightPerMinute, weightPerMinute / 60_000);
  }

  async take(weight: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.available = Math.min(
        this.capacity,
        this.available + (now - this.lastRefill) * this.refillPerMs,
      );
      this.lastRefill = now;
      if (this.available >= weight) {
        this.available -= weight;
        return;
      }
      const deficit = weight - this.available;
      await sleep(Math.ceil(deficit / this.refillPerMs) + 5);
    }
  }
}

export class HyperliquidPublic {
  constructor(private readonly limiter: RateLimiter) {}

  private async post<T>(body: unknown, weight: number): Promise<T> {
    await this.limiter.take(weight);
    const res = await fetch(INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      // Back off hard. A gap costs more than a delay.
      await sleep(10_000);
      throw new Error("rate limited by Hyperliquid (429)");
    }
    if (!res.ok) throw new Error(`Hyperliquid info returned ${res.status}`);
    return (await res.json()) as T;
  }

  /** Current positions and margin for one address. Weight 2. */
  clearinghouseState(user: string): Promise<ClearinghouseState> {
    return this.post<ClearinghouseState>(
      { type: "clearinghouseState", user },
      WEIGHT_CLEARINGHOUSE,
    );
  }

  /** Mid price of every listed asset. Weight 2. */
  allMids(): Promise<Record<string, string>> {
    return this.post<Record<string, string>>({ type: "allMids" }, WEIGHT_CLEARINGHOUSE);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The zero address and other burn-like addresses appear as counterparties on
 * some fills. They hold no position and polling them wastes weight.
 */
export function isRealAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(addr) && !/^0x0{30,}/i.test(addr);
}
