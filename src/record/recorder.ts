/**
 * Writing to the permanent record.
 *
 * Two records per trade, and the ordering between them is the entire point
 * (DESIGN.md §8.5):
 *
 *   t0  decide   →  reasoning record  →  Arweave id + Irys receipt
 *   t1  place order
 *   t2  fill
 *   …   position runs
 *   t3  close    →  trade record { reasoning_id }
 *
 * A reasoning record written when the trade closes is an explanation. Written
 * before the position opens and timestamped by a third party, it is a
 * falsifiable prediction. That difference is the whole reason anyone should care
 * about this ledger, and it survives only if the write genuinely happens first.
 *
 * ── The blocking rule ───────────────────────────────────────────────────────
 *
 * If the reasoning record cannot be written, **the trade does not happen.**
 *
 * The consequence is accepted deliberately: an Irys outage stops Lyra opening
 * new positions. The record is the asset; any individual trade is not. A trade
 * taken without its reasoning provably timestamped beforehand would, in a year,
 * be indistinguishable from one explained after the fact — and once that class
 * of trade exists it grows every time it is convenient.
 *
 * Existing positions are unaffected: stops rest at the venue, so an outage
 * cannot leave a position unprotected. It blocks new risk, exactly like every
 * other halt.
 */

import {
  nextSequence,
  recordTrade,
  RecordUploadError,
  type OwnerKey,
  type TradeRecord,
} from "@lyra-protocol/record";
import type { DecisionAudit } from "../decide/client.js";
import type { Decision } from "../decide/schema.js";

export type ReasoningPayload = {
  schema: "lyra-reasoning/v1";
  decisionId: string;
  asset: string;
  at: number;
  decision: Decision;
  audit: DecisionAudit;
};

export type RecorderConfig = {
  key: OwnerKey;
  venueAddress: string;
  strategyId: string;
  /**
   * How permanent this run is.
   *
   *   "offchain" — she trades, but nothing reaches Arweave. Reasoning ids are
   *                prefixed "local:" so they can never be mistaken for a real
   *                record. Used while the parameters are still guesses: Arweave
   *                has no delete, and a ledger of noise is a permanent liability.
   *   "paper"    — real records, separate owner key, no money at risk.
   *   "live"     — real records, real money.
   */
  mode: "offchain" | "paper" | "live";
  dataDir?: string;
};

export class ReasoningWriteFailed extends Error {
  constructor(
    message: string,
    readonly decisionId: string,
    readonly payload: ReasoningPayload,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReasoningWriteFailed";
  }
}

export class Recorder {
  constructor(private readonly config: RecorderConfig) {}

  /**
   * Writes the reasoning behind a decision, before any order is placed.
   *
   * Throws on failure. The caller must treat that as "no trade" — the blocking
   * rule above is enforced here rather than left to a caller's discretion,
   * because a rule that depends on every call site remembering it is not a rule.
   */
  async writeReasoning(
    decisionId: string,
    asset: string,
    decision: Decision,
    audit: DecisionAudit,
  ): Promise<string> {
    const payload: ReasoningPayload = {
      schema: "lyra-reasoning/v1",
      decisionId,
      asset,
      at: Date.now(),
      decision,
      audit,
    };

    // Off-chain runs skip the upload entirely and say so in the id. The blocking
    // rule does not apply here because there is nothing being claimed: no record
    // exists to be missing.
    if (this.config.mode === "offchain") {
      return `local:${decisionId}`;
    }

    try {
      const { uploadJson } = await import("./upload.js");
      return await uploadJson(payload, this.config.key, [
        { name: "App-Name", value: "lyra-reasoning" },
        { name: "Schema-Version", value: "1" },
        { name: "Owner", value: this.config.key.publicKey },
        { name: "Asset", value: asset },
        { name: "Decision-Id", value: decisionId },
        { name: "Action", value: decision.action },
        { name: "Mode", value: this.config.mode },
        { name: "Content-Type", value: "application/json" },
      ]);
    } catch (cause) {
      throw new ReasoningWriteFailed(
        `could not write the reasoning for decision ${decisionId}: ${(cause as Error).message}. ` +
          `The trade is blocked. A position opened without its reasoning timestamped ` +
          `beforehand cannot later be distinguished from one explained afterwards.`,
        decisionId,
        payload,
        { cause },
      );
    }
  }

  /**
   * Writes a closed trade, linking back to the reasoning written before it.
   *
   * Every monetary value is passed through as the venue's own string. Nothing is
   * recomputed here — if Lyra reports a fill price, it is Hyperliquid's bytes.
   */
  async writeTrade(trade: {
    pair: string;
    side: "long" | "short";
    entryPrice: string;
    exitPrice: string;
    size: string;
    pnl: string;
    fees: string;
    openTimestamp: number;
    closeTimestamp: number;
    venueOpenId: string;
    venueCloseId: string;
    reasoningId: string | null;
  }): Promise<{ arweaveId: string; sequence: number }> {
    if (this.config.mode === "offchain") {
      // Recorded in the local store by the caller; nothing permanent is written.
      return { arweaveId: `local:${trade.venueOpenId}`, sequence: -1 };
    }
    const owner = this.config.key.publicKey;
    const record: TradeRecord = {
      schema_version: 2,
      owner,
      venue: "hyperliquid",
      venue_address: this.config.venueAddress,
      pair: trade.pair,
      side: trade.side,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      size: trade.size,
      pnl: trade.pnl,
      fees: trade.fees,
      open_timestamp: trade.openTimestamp,
      close_timestamp: trade.closeTimestamp,
      venue_open_id: trade.venueOpenId,
      venue_close_id: trade.venueCloseId,
      strategy_id: this.config.strategyId,
      sequence: nextSequence(owner, { dataDir: this.config.dataDir }),
      reasoning_id: trade.reasoningId,
    };

    const result = await recordTrade(record, this.config.key, {
      ...(this.config.dataDir ? { dataDir: this.config.dataDir } : {}),
    });
    return { arweaveId: result.arweaveId, sequence: result.sequence };
  }

  /**
   * Retries trades that closed but were never recorded.
   *
   * `recordTrade` is idempotent on sequence, so a retry of an already-written
   * trade returns the existing record rather than duplicating it. A closure that
   * is never recorded is a hole in the ledger, which is why this is drained on
   * every loop rather than only when a write happens to fail.
   */
  isRetryable(error: unknown): error is RecordUploadError {
    return error instanceof RecordUploadError;
  }
}
