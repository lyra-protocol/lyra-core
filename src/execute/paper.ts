/**
 * Paper execution, filled against the real live book.
 *
 * Not a simulator with invented prices. It reads the same Hyperliquid book the
 * real venue would fill against, and applies the same rules — an ALO order that
 * would cross is cancelled, a resting order fills only when the market actually
 * trades through it.
 *
 * ── The two lies a paper trader usually tells ───────────────────────────────
 *
 * Most paper trading is optimistic in ways that make the results meaningless,
 * and both are avoided here deliberately:
 *
 * 1. **Assuming maker orders fill.** A resting limit order fills only if price
 *    comes to it, and often it simply does not. Filling instantly at the limit
 *    would report an edge that does not exist. Here an order rests until the
 *    real book trades through its price.
 * 2. **Ignoring queue position.** A real resting order sits behind everything
 *    already at that price. Modelled here by requiring the market to trade
 *    *through* the price rather than merely touch it — pessimistic, and
 *    pessimistic is the correct direction to be wrong in when the output is a
 *    permanent public record.
 *
 * Fees are charged at the venue's real published rates.
 */

import type { ApprovedOrder } from "../orders.js";
import { compare, parseDecimal } from "../orders.js";
import type {
  OpenOrder,
  PlaceResult,
  StopOrder,
  Venue,
  VenuePosition,
} from "./venue.js";

export type BookSource = (asset: string) => Promise<{ bid: string; ask: string; ts: number }>;
export type TradeSource = (asset: string) => Promise<{ px: string; sz: string; time: number }[]>;

type RestingOrder = {
  order: ApprovedOrder;
  placedAt: number;
  filledSize: string;
};

type PaperPosition = {
  asset: string;
  /** Signed size as a JS number. Paper accounting only; never recorded. */
  size: number;
  entryPx: number;
  openedAt: number;
};

export class PaperVenue implements Venue {
  readonly kind = "paper" as const;

  private readonly resting = new Map<string, RestingOrder>();
  private readonly stops = new Map<string, StopOrder>();
  private readonly open = new Map<string, PaperPosition>();
  private realisedPnl = 0;
  private feesPaid = 0;

  /**
   * The clock is injected for the same reason it is in `Guard`: a component
   * that reads the wall clock internally cannot be tested deterministically,
   * and "did this trade happen after the order was placed" is exactly the kind
   * of comparison that must be exercised at known times.
   */
  constructor(
    private readonly startingEquityUsd: number,
    private readonly book: BookSource,
    private readonly recentTrades: TradeSource,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Places an order.
   *
   * ALO orders are checked against the live book exactly as the venue would:
   * one that would cross is cancelled, not filled and not converted. IOC orders
   * — which only reach here via `approveCrossing`, and are therefore always
   * reduce-only exits under duress — fill immediately at the touch.
   */
  async place(order: ApprovedOrder): Promise<PlaceResult> {
    const now = this.now();
    const b = await this.book(order.asset);

    if (order.tif === "Alo") {
      const px = parseDecimal(order.price, "price");
      const crosses =
        order.side === "long"
          ? compare(px, parseDecimal(b.ask, "ask")) >= 0
          : compare(px, parseDecimal(b.bid, "bid")) <= 0;

      if (crosses) {
        // Exactly what Hyperliquid does. The correct response upstream is to
        // re-price, never to escalate to a taker.
        return {
          status: "cancelled",
          venueOrderId: null,
          cloid: order.cloid,
          filledSize: "0",
          avgFillPx: null,
          fee: "0",
          reason: "ALO order would have crossed the spread and was cancelled",
          at: now,
        };
      }

      this.resting.set(order.cloid, { order, placedAt: now, filledSize: "0" });
      return {
        status: "resting",
        venueOrderId: `paper-${order.cloid.slice(2, 10)}`,
        cloid: order.cloid,
        filledSize: "0",
        avgFillPx: null,
        fee: "0",
        at: now,
      };
    }

    // IOC: crossing an exit under duress. Fills at the opposing touch.
    const fillPx = order.side === "long" ? b.ask : b.bid;
    this.applyFill(order.asset, order.side, order.size, fillPx, order.feeBps);
    return {
      status: "filled",
      venueOrderId: `paper-${order.cloid.slice(2, 10)}`,
      cloid: order.cloid,
      filledSize: order.size,
      avgFillPx: fillPx,
      fee: String(this.feeFor(order.size, fillPx, order.feeBps)),
      at: now,
    };
  }

  /**
   * Advances resting orders against real trades.
   *
   * Called by the execution loop on each venue tick. An order fills only when
   * the market actually trades *through* its price — a conservative stand-in for
   * queue position, since a real resting order sits behind everything already
   * there.
   */
  async settle(asset: string): Promise<PlaceResult[]> {
    const trades = await this.recentTrades(asset);
    if (trades.length === 0) return [];

    const results: PlaceResult[] = [];

    for (const [cloid, resting] of [...this.resting]) {
      if (resting.order.asset !== asset) continue;
      const limit = parseDecimal(resting.order.price, "price");

      const traded = trades.some((t) => {
        if (t.time < resting.placedAt) return false;
        const px = parseDecimal(t.px, "px");
        // Strictly through, not merely touching.
        return resting.order.side === "long" ? compare(px, limit) < 0 : compare(px, limit) > 0;
      });
      if (!traded) continue;

      this.applyFill(
        resting.order.asset,
        resting.order.side,
        resting.order.size,
        resting.order.price,
        resting.order.feeBps,
      );
      this.resting.delete(cloid);
      results.push({
        status: "filled",
        venueOrderId: `paper-${cloid.slice(2, 10)}`,
        cloid,
        filledSize: resting.order.size,
        avgFillPx: resting.order.price,
        fee: String(this.feeFor(resting.order.size, resting.order.price, resting.order.feeBps)),
        at: this.now(),
      });
    }

    // Stops trigger on the same real trades.
    for (const [cloid, stop] of [...this.stops]) {
      if (stop.asset !== asset) continue;
      const trigger = parseDecimal(stop.triggerPx, "triggerPx");
      const hit = trades.some((t) => {
        const px = parseDecimal(t.px, "px");
        // A stop on a long triggers when price falls to it; on a short, rises.
        return stop.side === "short" ? compare(px, trigger) <= 0 : compare(px, trigger) >= 0;
      });
      if (!hit) continue;

      const b = await this.book(asset);
      const fillPx = stop.side === "long" ? b.ask : b.bid;
      this.applyFill(asset, stop.side, stop.size, fillPx, 4.5);
      this.stops.delete(cloid);
      results.push({
        status: "filled",
        venueOrderId: `paper-stop-${cloid.slice(2, 10)}`,
        cloid,
        filledSize: stop.size,
        avgFillPx: fillPx,
        fee: String(this.feeFor(stop.size, fillPx, 4.5)),
        reason: "stop triggered",
        at: this.now(),
      });
    }

    return results;
  }

  async placeStop(stop: StopOrder): Promise<PlaceResult> {
    this.stops.set(stop.cloid, stop);
    return {
      status: "resting",
      venueOrderId: `paper-stop-${stop.cloid.slice(2, 10)}`,
      cloid: stop.cloid,
      filledSize: "0",
      avgFillPx: null,
      fee: "0",
      at: this.now(),
    };
  }

  async cancel(_asset: string, cloid: string): Promise<boolean> {
    return this.resting.delete(cloid) || this.stops.delete(cloid);
  }

  async openOrders(): Promise<OpenOrder[]> {
    const out: OpenOrder[] = [];
    for (const r of this.resting.values()) {
      out.push({
        venueOrderId: `paper-${r.order.cloid.slice(2, 10)}`,
        cloid: r.order.cloid,
        asset: r.order.asset,
        side: r.order.side,
        limitPx: r.order.price,
        size: r.order.size,
        reduceOnly: r.order.reduceOnly,
        isTrigger: false,
      });
    }
    for (const s of this.stops.values()) {
      out.push({
        venueOrderId: `paper-stop-${s.cloid.slice(2, 10)}`,
        cloid: s.cloid,
        asset: s.asset,
        side: s.side,
        limitPx: s.triggerPx,
        size: s.size,
        reduceOnly: true,
        isTrigger: true,
      });
    }
    return out;
  }

  async positions(): Promise<VenuePosition[]> {
    const out: VenuePosition[] = [];
    for (const p of this.open.values()) {
      if (p.size === 0) continue;
      const b = await this.book(p.asset);
      const mark = Number(p.size > 0 ? b.bid : b.ask);
      const unrealised = (mark - p.entryPx) * p.size;
      out.push({
        asset: p.asset,
        szi: String(p.size),
        entryPx: String(p.entryPx),
        unrealizedPnl: String(unrealised),
        liquidationPx: null, // Paper trading is unlevered; nothing is liquidated.
        positionValue: String(Math.abs(p.size) * mark),
      });
    }
    return out;
  }

  async equityUsd(): Promise<number> {
    const positions = await this.positions();
    const unrealised = positions.reduce((s, p) => s + Number(p.unrealizedPnl), 0);
    return this.startingEquityUsd + this.realisedPnl - this.feesPaid + unrealised;
  }

  /** Paper accounting, for reporting. Never written to the ledger. */
  stats() {
    return {
      realisedPnl: this.realisedPnl,
      feesPaid: this.feesPaid,
      restingOrders: this.resting.size,
      stops: this.stops.size,
      openPositions: this.open.size,
    };
  }

  private applyFill(
    asset: string,
    side: "long" | "short",
    size: string,
    px: string,
    feeBps: number,
  ): void {
    const qty = Number(size) * (side === "long" ? 1 : -1);
    const price = Number(px);
    this.feesPaid += this.feeFor(size, px, feeBps);

    const existing = this.open.get(asset);
    if (!existing || existing.size === 0) {
      this.open.set(asset, { asset, size: qty, entryPx: price, openedAt: this.now() });
      return;
    }

    // Reducing or flipping: realise PnL on the portion closed.
    if (Math.sign(qty) !== Math.sign(existing.size)) {
      const closed = Math.min(Math.abs(qty), Math.abs(existing.size));
      this.realisedPnl += (price - existing.entryPx) * closed * Math.sign(existing.size);
      const remaining = existing.size + qty;
      if (Math.abs(remaining) < 1e-12) {
        this.open.delete(asset);
      } else {
        this.open.set(asset, {
          ...existing,
          size: remaining,
          // A flip starts a new position at this price.
          entryPx: Math.sign(remaining) === Math.sign(existing.size) ? existing.entryPx : price,
        });
      }
      return;
    }

    // Adding: volume-weighted entry.
    const total = existing.size + qty;
    this.open.set(asset, {
      ...existing,
      size: total,
      entryPx: (existing.entryPx * existing.size + price * qty) / total,
    });
  }

  private feeFor(size: string, px: string, feeBps: number): number {
    return Math.abs(Number(size)) * Number(px) * (feeBps / 10_000);
  }
}
