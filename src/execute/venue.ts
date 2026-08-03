/**
 * The venue interface.
 *
 * Two implementations satisfy it: `PaperVenue`, which fills against the real
 * live book with no money at risk, and the Hyperliquid client, which does not.
 * Everything upstream — the guard, the audit, the recorder — is identical for
 * both, so paper trading exercises the actual execution path rather than a
 * parallel one that might diverge from it (DESIGN.md §9.2).
 *
 * Note what this interface deliberately cannot express: constructing an order.
 * Every method takes an `ApprovedOrder`, which cannot be forged outside
 * `orders.ts`. Execution is a transport; it has no authority.
 */

import { createHash } from "node:crypto";
import type { ApprovedOrder } from "../orders.js";

export type OrderStatus = "resting" | "filled" | "partially_filled" | "cancelled" | "rejected";

export type PlaceResult = {
  status: OrderStatus;
  /** The venue's own order id, when it issued one. */
  venueOrderId: string | null;
  cloid: string;
  /** Filled size so far, as the venue reported it. Decimal string. */
  filledSize: string;
  /** Average fill price, as the venue reported it. Null while unfilled. */
  avgFillPx: string | null;
  /** Fee paid so far, venue string. */
  fee: string;
  /**
   * Why an order was cancelled or rejected.
   *
   * For an ALO order this is routinely "would have crossed", which is a
   * re-price signal and not an error (§9.5): the response is a new price, never
   * a taker order.
   */
  reason?: string;
  at: number;
};

export type StopOrder = {
  asset: string;
  /** Side of the *closing* order: opposite the position. */
  side: "long" | "short";
  triggerPx: string;
  size: string;
  cloid: string;
};

export type VenuePosition = {
  asset: string;
  /** Signed size. Positive long, negative short. Venue string. */
  szi: string;
  entryPx: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
  positionValue: string;
};

export type OpenOrder = {
  venueOrderId: string;
  cloid: string | null;
  asset: string;
  side: "long" | "short";
  limitPx: string;
  size: string;
  reduceOnly: boolean;
  isTrigger: boolean;
};

export interface Venue {
  readonly kind: "paper" | "hyperliquid";

  /** Places an order that the guard has already approved. */
  place(order: ApprovedOrder): Promise<PlaceResult>;

  /**
   * Places a reduce-only trigger order that rests **at the venue**.
   *
   * A stop held in Lyra's memory protects nothing — it dies with the process.
   * This one survives the process, the network and the model endpoint (§9.4).
   */
  placeStop(stop: StopOrder): Promise<PlaceResult>;

  cancel(asset: string, cloid: string): Promise<boolean>;

  /** Everything currently open, for startup reconciliation (§9.3). */
  openOrders(): Promise<OpenOrder[]>;
  positions(): Promise<VenuePosition[]>;
  equityUsd(): Promise<number>;
}

/**
 * Deterministic client order id.
 *
 * `sha256(decisionId + ":" + attempt)` truncated to 128 bits, which is the width
 * Hyperliquid accepts. Determinism is the point: a retry after a timeout sends
 * the *same* id and the venue de-duplicates it, so a network hiccup during a
 * fill cannot turn one intended position into two real ones.
 *
 * A re-price is a different order at a different price, so it takes a new
 * attempt number and therefore a new id. Reusing the id would ask the venue to
 * de-duplicate two orders that genuinely differ.
 */
export function deriveCloid(decisionId: string, attempt: number): string {
  const digest = createHash("sha256").update(`${decisionId}:${attempt}`, "utf8").digest("hex");
  return `0x${digest.slice(0, 32)}`;
}
