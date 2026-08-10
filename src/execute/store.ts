/**
 * Durable execution state.
 *
 * The failure this exists to prevent is not a rejected order — it is an order
 * that was placed and then forgotten, because on restart the position exists and
 * nothing knows why it is there or what should protect it.
 *
 * So everything is persisted **before** the network call, never after. A crash
 * between writing and placing leaves an intent with no order, which reconciliation
 * can resolve. A crash between placing and writing would leave an order with no
 * intent, which it cannot.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InferenceCallResult, PreparedConsult } from "../decide/client.js";
import type { PairEvidence } from "../decide/shadow-promotion.js";

export type IntentStatus =
  | "intended"
  | "placed"
  | "filled"
  | "cancelled"
  | "rejected"
  | "failed";

export type StoredIntent = {
  cloid: string;
  decisionId: string;
  asset: string;
  side: "long" | "short";
  price: string;
  size: string;
  reduceOnly: boolean;
  tif: string;
  attempt: number;
  status: IntentStatus;
  venueOrderId: string | null;
  filledSize: string;
  avgFillPx: string | null;
  fee: string;
  createdAt: number;
  updatedAt: number;
  detail: string | null;
};

export type StoredPosition = {
  id: number;
  asset: string;
  decisionId: string;
  /** Arweave id of the reasoning written before this position opened. */
  reasoningId: string | null;
  side: "long" | "short";
  size: string;
  entryPx: string;
  openedAt: number;
  /** cloid of the protective stop resting at the venue. Null means unprotected. */
  stopCloid: string | null;
  /** Trigger price of that stop. Null when unprotected. */
  stopPx: string | null;
  /** The price she said would prove the thesis. Null if none was named. */
  targetPx: string | null;
  closedAt: number | null;
  exitPx: string | null;
  pnl: string | null;
  fees: string | null;
  /** Sequence assigned when written to the ledger. Null until recorded. */
  recordedSequence: number | null;
  recordedArweaveId: string | null;
  openAction: string | null;
  hypothesis: string | null;
  conviction: number | null;
  expectedMove: number | null;
  strategyId: string | null;
  closeReason: CloseReason | null;
  closeDecisionId: string | null;
  closeCloid: string | null;
};

export type CloseReason =
  | "target_reached"
  | "stop_triggered"
  | "thesis_invalidated"
  | "thesis_played_out"
  | "reconciliation"
  | "operator"
  | "legacy_unknown";

export type DailyInferenceUsage = {
  attempts: number;
  pending: number;
  transportSuccesses: number;
  transportFailures: number;
  validationSuccesses: number;
  validationFailures: number;
  reportedPromptTokens: number;
  reportedCompletionTokens: number;
  reportedCostUsd: number;
  accountedPromptTokens: number;
  accountedCompletionTokens: number;
  accountedTotalTokens: number;
  accountedCostUsd: number;
};

export type PerformanceStat = {
  dimension: "asset" | "side" | "hypothesis" | "strategy" | "close_reason";
  key: string;
  trades: number;
  wins: number;
  netUsd: number;
  averageNetUsd: number;
  averageHoldMs: number;
};

export type InferenceRole = "champion" | "challenger";
export type ShadowEvaluation = {
  pairId: string; championDecisionId: string; championAttemptId: string;
  challengerAttemptId: string | null; asset: string; createdAt: number;
  completedAt: number | null; promptHash: string; challengerModel: string;
  status: string; championSemanticCode: string | null; challengerSemanticCode: string | null;
  actionAgreement: boolean | null; hypothesisAgreement: boolean | null;
  targetAgreement: boolean | null; convictionAgreement: boolean | null;
  allAgreement: boolean | null; targetRelativeDelta: number | null;
  convictionAbsoluteDelta: number | null; detail: string | null;
  promptTemplate: string | null; schemaHash: string | null; championModel: string | null;
  evaluationVersion: string | null; championDecisionJson: string | null;
  challengerDecisionJson: string | null;
};

export type ShadowOutcomeCandidate = {
  pairId: string; asset: string; promptTemplate: string; schemaHash: string;
  championModel: string; challengerModel: string; evaluationVersion: string;
  championDecisionJson: string; challengerDecisionJson: string;
};

export type ShadowVirtualPosition = {
  id: number; pairId: string; role: InferenceRole; asset: string; side: "long" | "short";
  promptTemplate: string; schemaHash: string; championModel: string; challengerModel: string;
  evaluationVersion: string; decisionJson: string; entryPx: number; targetPx: number;
  stopPx: number; size: number; notionalUsd: number; openedAt: number; expiresAt: number;
  lastSampleAt: number; lastMidPx: number; mfeUsd: number; maeUsd: number;
  status: "open" | "target" | "stop" | "horizon"; resolvedAt: number | null;
  exitPx: number | null; grossPnlUsd: number | null; totalFeesUsd: number | null;
  netPnlUsd: number | null;
};

export class ExecutionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL"); // Execution state must survive power loss.
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision (
        id            TEXT PRIMARY KEY,
        at            INTEGER NOT NULL,
        asset         TEXT NOT NULL,
        action        TEXT NOT NULL,
        conviction    REAL NOT NULL,
        expected_move REAL NOT NULL,
        audit_json    TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        reasoning_arweave_id TEXT,
        outcome       TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS intent (
        cloid          TEXT PRIMARY KEY,
        decision_id    TEXT NOT NULL,
        asset          TEXT NOT NULL,
        side           TEXT NOT NULL,
        price          TEXT NOT NULL,
        size           TEXT NOT NULL,
        reduce_only    INTEGER NOT NULL,
        tif            TEXT NOT NULL,
        attempt        INTEGER NOT NULL,
        status         TEXT NOT NULL,
        venue_order_id TEXT,
        filled_size    TEXT NOT NULL DEFAULT '0',
        avg_fill_px    TEXT,
        fee            TEXT NOT NULL DEFAULT '0',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        detail         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_intent_status ON intent(status);
      CREATE INDEX IF NOT EXISTS idx_intent_decision ON intent(decision_id);

      CREATE TABLE IF NOT EXISTS position (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        asset         TEXT NOT NULL,
        decision_id   TEXT NOT NULL,
        reasoning_id  TEXT,
        side          TEXT NOT NULL,
        size          TEXT NOT NULL,
        entry_px      TEXT NOT NULL,
        opened_at     INTEGER NOT NULL,
        stop_cloid    TEXT,
        stop_px       TEXT,
        target_px     TEXT,
        closed_at     INTEGER,
        exit_px       TEXT,
        pnl           TEXT,
        fees          TEXT,
        recorded_sequence   INTEGER,
        recorded_arweave_id TEXT,
        open_action       TEXT,
        hypothesis        TEXT,
        conviction        REAL,
        expected_move     REAL,
        strategy_id       TEXT,
        close_reason      TEXT,
        close_decision_id TEXT,
        close_cloid       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_position_open ON position(closed_at);

      CREATE TABLE IF NOT EXISTS inference_call (
        attempt_id                  TEXT PRIMARY KEY,
        decision_id                 TEXT,
        asset                       TEXT,
        started_at                  INTEGER NOT NULL,
        completed_at                INTEGER,
        model                       TEXT NOT NULL,
        provider                    TEXT NOT NULL,
        api_version                 TEXT NOT NULL,
        transport_ok                INTEGER,
        validation_ok               INTEGER,
        failure_code                TEXT,
        failure_detail              TEXT,
        http_status                 INTEGER,
        reported_prompt_tokens      INTEGER,
        reported_completion_tokens  INTEGER,
        reported_cost_usd           REAL,
        accounted_prompt_tokens     INTEGER NOT NULL,
        accounted_completion_tokens INTEGER NOT NULL,
        accounted_cost_usd          REAL NOT NULL,
        usage_source                TEXT NOT NULL CHECK (usage_source IN ('reported','reserved')),
        latency_ms                  INTEGER,
        role                        TEXT NOT NULL DEFAULT 'champion',
        pair_id                     TEXT,
        prompt_hash                 TEXT,
        event_ids_json              TEXT,
        raw_output                  TEXT,
        parsed_decision_json        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_inference_call_started
        ON inference_call(started_at);
      CREATE INDEX IF NOT EXISTS idx_inference_call_decision
        ON inference_call(decision_id);

      CREATE TABLE IF NOT EXISTS shadow_evaluation (
        pair_id TEXT PRIMARY KEY, champion_decision_id TEXT NOT NULL,
        champion_attempt_id TEXT NOT NULL, challenger_attempt_id TEXT,
        asset TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER,
        prompt_hash TEXT NOT NULL, challenger_model TEXT NOT NULL, status TEXT NOT NULL,
        champion_semantic_code TEXT, challenger_semantic_code TEXT,
        action_agreement INTEGER, hypothesis_agreement INTEGER, target_agreement INTEGER,
        conviction_agreement INTEGER, all_agreement INTEGER,
        target_relative_delta REAL, conviction_absolute_delta REAL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_created ON shadow_evaluation(created_at);

      CREATE TABLE IF NOT EXISTS shadow_virtual_position (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair_id TEXT NOT NULL, role TEXT NOT NULL, asset TEXT NOT NULL, side TEXT NOT NULL,
        prompt_template TEXT NOT NULL, schema_hash TEXT NOT NULL,
        champion_model TEXT NOT NULL, challenger_model TEXT NOT NULL,
        evaluation_version TEXT NOT NULL, decision_json TEXT NOT NULL,
        entry_px REAL NOT NULL, target_px REAL NOT NULL, stop_px REAL NOT NULL,
        size REAL NOT NULL, notional_usd REAL NOT NULL,
        opened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        last_sample_at INTEGER NOT NULL, last_mid_px REAL NOT NULL,
        mfe_usd REAL NOT NULL DEFAULT 0, mae_usd REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER, exit_px REAL,
        gross_pnl_usd REAL, total_fees_usd REAL, net_pnl_usd REAL,
        UNIQUE(pair_id, role)
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_virtual_open ON shadow_virtual_position(status, asset);
      CREATE INDEX IF NOT EXISTS idx_shadow_virtual_version ON shadow_virtual_position(prompt_template,schema_hash,champion_model,challenger_model,evaluation_version,role);

      INSERT OR IGNORE INTO inference_call (
        attempt_id, decision_id, asset, started_at, completed_at, model, provider,
        api_version, transport_ok, validation_ok, reported_prompt_tokens,
        reported_completion_tokens, reported_cost_usd, accounted_prompt_tokens,
        accounted_completion_tokens, accounted_cost_usd, usage_source, latency_ms
      )
      SELECT
        'legacy:' || id,
        id,
        asset,
        at,
        at + COALESCE(CAST(json_extract(audit_json, '$.latencyMs') AS INTEGER), 0),
        COALESCE(json_extract(audit_json, '$.model'), 'unknown'),
        COALESCE(json_extract(audit_json, '$.provider'), 'unknown'),
        COALESCE(json_extract(audit_json, '$.apiVersion'), 'unknown'),
        1,
        1,
        COALESCE(CAST(json_extract(audit_json, '$.promptTokens') AS INTEGER), 0),
        COALESCE(CAST(json_extract(audit_json, '$.completionTokens') AS INTEGER), 0),
        COALESCE(CAST(json_extract(audit_json, '$.costUsd') AS REAL), 0),
        COALESCE(CAST(json_extract(audit_json, '$.promptTokens') AS INTEGER), 0),
        COALESCE(CAST(json_extract(audit_json, '$.completionTokens') AS INTEGER), 0),
        COALESCE(CAST(json_extract(audit_json, '$.costUsd') AS REAL), 0),
        'reported',
        COALESCE(CAST(json_extract(audit_json, '$.latencyMs') AS INTEGER), 0)
      FROM decision
      WHERE json_valid(audit_json);
    `);

    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
    // so a column added after a database is in the field needs this. Cheap,
    // idempotent, and it runs before anything reads the column.
    for (const [table, column, type] of [
      ["position", "stop_px", "TEXT"], ["position", "target_px", "TEXT"],
      ["position", "open_action", "TEXT"], ["position", "hypothesis", "TEXT"],
      ["position", "conviction", "REAL"], ["position", "expected_move", "REAL"],
      ["position", "strategy_id", "TEXT"], ["position", "close_reason", "TEXT"],
      ["position", "close_decision_id", "TEXT"], ["position", "close_cloid", "TEXT"],
      ["inference_call", "role", "TEXT NOT NULL DEFAULT 'champion'"],
      ["inference_call", "pair_id", "TEXT"], ["inference_call", "prompt_hash", "TEXT"],
      ["inference_call", "event_ids_json", "TEXT"], ["inference_call", "raw_output", "TEXT"],
      ["inference_call", "parsed_decision_json", "TEXT"],
      ["shadow_evaluation", "prompt_template", "TEXT"],
      ["shadow_evaluation", "schema_hash", "TEXT"],
      ["shadow_evaluation", "champion_model", "TEXT"],
      ["shadow_evaluation", "evaluation_version", "TEXT"],
      ["shadow_evaluation", "champion_decision_json", "TEXT"],
      ["shadow_evaluation", "challenger_decision_json", "TEXT"],
      ["shadow_evaluation", "outcome_materialized_at", "INTEGER"],
    ] as const) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }

  /** Persisted before transport. Failure here means the provider is not called. */
  beginInferenceCall(input: {
    prepared: PreparedConsult;
    decisionId: string | null;
    asset: string | null;
    model: string;
    provider: string;
    apiVersion: string;
    role?: InferenceRole;
    pairId?: string | null;
  }): void {
    const r = input.prepared.reservation;
    this.db.prepare(
      `INSERT INTO inference_call
         (attempt_id, decision_id, asset, started_at, model, provider, api_version,
          accounted_prompt_tokens, accounted_completion_tokens, accounted_cost_usd,
           usage_source, role, pair_id, prompt_hash, event_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
    ).run(
      input.prepared.attemptId,
      input.decisionId,
      input.asset,
      input.prepared.startedAt,
      input.model,
      input.provider,
      input.apiVersion,
      r.promptTokens,
      r.completionTokens,
      r.costUsd,
      input.role ?? "champion",
      input.pairId ?? null,
      input.prepared.promptHash,
      JSON.stringify(input.prepared.input.eventIds),
    );
  }

  /** Completes an existing attempt without replacing its crash-safe reservation. */
  finishInferenceCall(call: InferenceCallResult, rawOutput?: string | null, decisionJson?: string | null): void {
    const reported = call.reportedUsage;
    const accounted = call.accountedUsage;
    this.db.prepare(
      `UPDATE inference_call SET
         completed_at = ?, transport_ok = ?, validation_ok = ?, failure_code = ?,
         failure_detail = ?, http_status = ?, reported_prompt_tokens = ?,
         reported_completion_tokens = ?, reported_cost_usd = ?,
         accounted_prompt_tokens = ?, accounted_completion_tokens = ?,
         accounted_cost_usd = ?, usage_source = ?, latency_ms = ?, raw_output = ?,
         parsed_decision_json = ?
       WHERE attempt_id = ? AND completed_at IS NULL`,
    ).run(
      call.completedAt,
      call.transportOk ? 1 : 0,
      call.validationOk === null ? null : call.validationOk ? 1 : 0,
      call.failureCode,
      call.failureDetail,
      call.httpStatus,
      reported?.promptTokens ?? null,
      reported?.completionTokens ?? null,
      reported?.costUsd ?? null,
      accounted.promptTokens,
      accounted.completionTokens,
      accounted.costUsd,
      call.usageSource,
      call.latencyMs,
      rawOutput ?? null,
      decisionJson ?? null,
      call.attemptId,
    );
  }

  inferenceUsageBetween(
    fromMs: number,
    toMs: number,
    role: InferenceRole = "champion",
  ): DailyInferenceUsage {
    const r = this.db.prepare(
      `SELECT
         COUNT(*) AS attempts,
         SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN transport_ok = 1 THEN 1 ELSE 0 END) AS transport_successes,
         SUM(CASE WHEN transport_ok = 0 THEN 1 ELSE 0 END) AS transport_failures,
         SUM(CASE WHEN validation_ok = 1 THEN 1 ELSE 0 END) AS validation_successes,
         SUM(CASE WHEN validation_ok = 0 THEN 1 ELSE 0 END) AS validation_failures,
         COALESCE(SUM(reported_prompt_tokens), 0) AS reported_prompt_tokens,
         COALESCE(SUM(reported_completion_tokens), 0) AS reported_completion_tokens,
         COALESCE(SUM(reported_cost_usd), 0) AS reported_cost_usd,
         COALESCE(SUM(accounted_prompt_tokens), 0) AS accounted_prompt_tokens,
         COALESCE(SUM(accounted_completion_tokens), 0) AS accounted_completion_tokens,
         COALESCE(SUM(accounted_prompt_tokens + accounted_completion_tokens), 0) AS accounted_total_tokens,
         COALESCE(SUM(accounted_cost_usd), 0) AS accounted_cost_usd
       FROM inference_call WHERE started_at >= ? AND started_at < ? AND role = ?`,
     ).get(fromMs, toMs, role) as Record<string, number | bigint>;
    return {
      attempts: Number(r.attempts),
      pending: Number(r.pending),
      transportSuccesses: Number(r.transport_successes),
      transportFailures: Number(r.transport_failures),
      validationSuccesses: Number(r.validation_successes),
      validationFailures: Number(r.validation_failures),
      reportedPromptTokens: Number(r.reported_prompt_tokens),
      reportedCompletionTokens: Number(r.reported_completion_tokens),
      reportedCostUsd: Number(r.reported_cost_usd),
      accountedPromptTokens: Number(r.accounted_prompt_tokens),
      accountedCompletionTokens: Number(r.accounted_completion_tokens),
      accountedTotalTokens: Number(r.accounted_total_tokens),
      accountedCostUsd: Number(r.accounted_cost_usd),
    };
  }

  beginShadowEvaluation(e: {
    pairId: string; championDecisionId: string; championAttemptId: string;
    asset: string; createdAt: number; promptHash: string; challengerModel: string; status: string;
    promptTemplate?: string | null; schemaHash?: string | null; championModel?: string | null;
    evaluationVersion?: string | null; championDecisionJson?: string | null;
  }): void {
    this.db.prepare(
      `INSERT INTO shadow_evaluation
       (pair_id,champion_decision_id,champion_attempt_id,asset,created_at,prompt_hash,challenger_model,status,
        prompt_template,schema_hash,champion_model,evaluation_version,champion_decision_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.pairId,e.championDecisionId,e.championAttemptId,e.asset,e.createdAt,e.promptHash,e.challengerModel,e.status,
      e.promptTemplate??null,e.schemaHash??null,e.championModel??null,e.evaluationVersion??null,e.championDecisionJson??null);
  }

  finishShadowEvaluation(pairId: string, patch: Partial<ShadowEvaluation>): void {
    this.db.prepare(
      `UPDATE shadow_evaluation SET completed_at=?, challenger_attempt_id=?, status=?,
       champion_semantic_code=?, challenger_semantic_code=?, action_agreement=?,
       hypothesis_agreement=?, target_agreement=?, conviction_agreement=?, all_agreement=?,
      target_relative_delta=?, conviction_absolute_delta=?, detail=?, challenger_decision_json=? WHERE pair_id=?`,
    ).run(
      patch.completedAt ?? Date.now(), patch.challengerAttemptId ?? null, patch.status ?? "completed",
      patch.championSemanticCode ?? null, patch.challengerSemanticCode ?? null,
      boolDb(patch.actionAgreement), boolDb(patch.hypothesisAgreement), boolDb(patch.targetAgreement),
      boolDb(patch.convictionAgreement), boolDb(patch.allAgreement), patch.targetRelativeDelta ?? null,
      patch.convictionAbsoluteDelta ?? null, patch.detail ?? null,
      patch.challengerDecisionJson ?? null,
      pairId,
    );
  }

  shadowEvaluations(limit = 100): ShadowEvaluation[] {
    const rows = this.db.prepare(`SELECT * FROM shadow_evaluation ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map(rowToShadow);
  }

  shadowOutcomeCandidates(): ShadowOutcomeCandidate[] {
    return this.db.prepare(
      `SELECT pair_id,asset,prompt_template,schema_hash,champion_model,challenger_model,
              evaluation_version,champion_decision_json,challenger_decision_json
       FROM shadow_evaluation e
       WHERE status='completed'
         AND outcome_materialized_at IS NULL
         AND champion_semantic_code IS NULL AND challenger_semantic_code IS NULL
         AND prompt_template IS NOT NULL AND schema_hash IS NOT NULL
         AND champion_model IS NOT NULL AND evaluation_version IS NOT NULL
         AND champion_decision_json IS NOT NULL AND challenger_decision_json IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM (SELECT 'champion' role UNION ALL SELECT 'challenger') roles
           WHERE NOT EXISTS (
             SELECT 1 FROM shadow_virtual_position v
             WHERE v.pair_id=e.pair_id AND v.role=roles.role
           )
         )
       ORDER BY completed_at`,
    ).all().map((r) => {
      const row = r as Record<string, unknown>;
      return {
        pairId: String(row.pair_id), asset: String(row.asset),
        promptTemplate: String(row.prompt_template), schemaHash: String(row.schema_hash),
        championModel: String(row.champion_model), challengerModel: String(row.challenger_model),
        evaluationVersion: String(row.evaluation_version),
        championDecisionJson: String(row.champion_decision_json),
        challengerDecisionJson: String(row.challenger_decision_json),
      };
    });
  }

  markShadowOutcomeMaterialized(pairId: string, at: number): void {
    this.db.prepare(
      `UPDATE shadow_evaluation SET outcome_materialized_at=?
       WHERE pair_id=? AND outcome_materialized_at IS NULL`,
    ).run(at, pairId);
  }

  createShadowVirtualPosition(p: Omit<ShadowVirtualPosition, "id" | "mfeUsd" | "maeUsd" | "status" | "resolvedAt" | "exitPx" | "grossPnlUsd" | "totalFeesUsd" | "netPnlUsd">): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO shadow_virtual_position
       (pair_id,role,asset,side,prompt_template,schema_hash,champion_model,challenger_model,
        evaluation_version,decision_json,entry_px,target_px,stop_px,size,notional_usd,
        opened_at,expires_at,last_sample_at,last_mid_px)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(p.pairId,p.role,p.asset,p.side,p.promptTemplate,p.schemaHash,p.championModel,p.challengerModel,
      p.evaluationVersion,p.decisionJson,p.entryPx,p.targetPx,p.stopPx,p.size,p.notionalUsd,
      p.openedAt,p.expiresAt,p.lastSampleAt,p.lastMidPx);
  }

  openShadowVirtualPositions(): ShadowVirtualPosition[] {
    return (this.db.prepare(`SELECT * FROM shadow_virtual_position WHERE status='open'`).all() as Record<string,unknown>[]).map(rowToVirtual);
  }

  updateShadowVirtualPosition(id: number, p: { sampledAt: number; midPx: number; mfeUsd: number; maeUsd: number; status?: "open"|"target"|"stop"|"horizon"; exitPx?: number; grossPnlUsd?: number; totalFeesUsd?: number; netPnlUsd?: number }): void {
    this.db.prepare(
      `UPDATE shadow_virtual_position SET last_sample_at=?,last_mid_px=?,mfe_usd=?,mae_usd=?,
       status=?,resolved_at=CASE WHEN ?='open' THEN resolved_at ELSE ? END,
       exit_px=COALESCE(?,exit_px),gross_pnl_usd=COALESCE(?,gross_pnl_usd),
       total_fees_usd=COALESCE(?,total_fees_usd),net_pnl_usd=COALESCE(?,net_pnl_usd)
       WHERE id=? AND status='open' AND last_sample_at<=?`,
    ).run(p.sampledAt,p.midPx,p.mfeUsd,p.maeUsd,p.status??"open",p.status??"open",p.sampledAt,
      p.exitPx??null,p.grossPnlUsd??null,p.totalFeesUsd??null,p.netPnlUsd??null,id,p.sampledAt);
  }

  shadowOutcomeReport(filters: { promptTemplate?: string; schemaHash?: string; championModel?: string; challengerModel?: string } = {}) {
    const where: string[] = ["status!='open'"]; const args: string[] = [];
    for (const [column,key] of [["prompt_template","promptTemplate"],["schema_hash","schemaHash"],["champion_model","championModel"],["challenger_model","challengerModel"]] as const) {
      const value=filters[key]; if(value){where.push(`${column}=?`);args.push(value);}
    }
    return this.db.prepare(
      `SELECT role,COUNT(*) resolved,SUM(net_pnl_usd>0) wins,AVG(net_pnl_usd) average_net_usd,
       SUM(net_pnl_usd) net_usd,AVG(mfe_usd) average_mfe_usd,AVG(mae_usd) average_mae_usd,
       SUM(status='target') targets,SUM(status='stop') stops,SUM(status='horizon') horizons
       FROM shadow_virtual_position WHERE ${where.join(" AND ")} GROUP BY role`,
    ).all(...args);
  }

  shadowPairEvidence(filters: {
    promptTemplate?: string; schemaHash?: string; championModel?: string;
    challengerModel?: string; evaluationVersion?: string;
  } = {}): PairEvidence[] {
    const where = ["s.status='completed'", "s.champion_semantic_code IS NULL", "s.challenger_semantic_code IS NULL"];
    const args: string[] = [];
    for (const [column,key] of [["prompt_template","promptTemplate"],["schema_hash","schemaHash"],["champion_model","championModel"],["challenger_model","challengerModel"],["evaluation_version","evaluationVersion"]] as const) {
      const value = filters[key]; if (value) { where.push(`s.${column}=?`); args.push(value); }
    }
    return (this.db.prepare(
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
       WHERE ${where.join(" AND ")} ORDER BY s.created_at`,
    ).all(...args) as Record<string, unknown>[]).map((r) => ({
      pairId: String(r.pair_id), at: Number(r.created_at), asset: String(r.asset),
      championAction: String(r.champion_action), challengerAction: String(r.challenger_action),
      championThesisStatus: String(r.champion_thesis_status), challengerThesisStatus: String(r.challenger_thesis_status),
      championPositionStatus: r.champion_position_status as string | null,
      challengerPositionStatus: r.challenger_position_status as string | null,
      championNetPnlUsd: r.champion_net_pnl_usd === null ? null : Number(r.champion_net_pnl_usd),
      challengerNetPnlUsd: r.challenger_net_pnl_usd === null ? null : Number(r.challenger_net_pnl_usd),
      championLatencyMs: r.champion_latency_ms === null ? null : Number(r.champion_latency_ms),
      challengerLatencyMs: r.challenger_latency_ms === null ? null : Number(r.challenger_latency_ms),
      championCostUsd: r.champion_cost_usd === null ? null : Number(r.champion_cost_usd),
      challengerCostUsd: r.challenger_cost_usd === null ? null : Number(r.challenger_cost_usd),
    }));
  }

  shadowQuality(filters: {
    promptTemplate?: string; schemaHash?: string; championModel?: string;
    challengerModel?: string; evaluationVersion?: string;
  } = {}): { attempted: number; valid: number } {
    const where = ["status NOT IN ('skipped_busy','skipped_budget')"];
    const args: string[] = [];
    for (const [column,key] of [["prompt_template","promptTemplate"],["schema_hash","schemaHash"],["champion_model","championModel"],["challenger_model","challengerModel"],["evaluation_version","evaluationVersion"]] as const) {
      const value = filters[key]; if (value) { where.push(`${column}=?`); args.push(value); }
    }
    const r = this.db.prepare(
      `SELECT COUNT(*) attempted,
       SUM(status='completed' AND champion_semantic_code IS NULL AND challenger_semantic_code IS NULL) valid
       FROM shadow_evaluation WHERE ${where.join(" AND ")}`,
    ).get(...args) as Record<string, number | bigint>;
    return { attempted: Number(r.attempted), valid: Number(r.valid) };
  }

  /** Persisted before the model result is acted on, so nothing is lost on a crash. */
  saveDecision(d: {
    id: string;
    at: number;
    asset: string;
    action: string;
    conviction: number;
    expectedMove: number;
    auditJson: string;
    decisionJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decision
           (id, at, asset, action, conviction, expected_move, audit_json, decision_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.at, d.asset, d.action, d.conviction, d.expectedMove, d.auditJson, d.decisionJson);
  }

  setReasoningId(decisionId: string, arweaveId: string): void {
    this.db
      .prepare(`UPDATE decision SET reasoning_arweave_id = ? WHERE id = ?`)
      .run(arweaveId, decisionId);
  }

  setDecisionOutcome(decisionId: string, outcome: string): void {
    this.db.prepare(`UPDATE decision SET outcome = ? WHERE id = ?`).run(outcome, decisionId);
  }

  /** Written before the order is sent. The ordering is the whole point. */
  createIntent(i: Omit<StoredIntent, "status" | "venueOrderId" | "filledSize" | "avgFillPx" | "fee" | "updatedAt" | "detail">): void {
    this.db
      .prepare(
        `INSERT INTO intent
           (cloid, decision_id, asset, side, price, size, reduce_only, tif, attempt,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
      )
      .run(
        i.cloid, i.decisionId, i.asset, i.side, i.price, i.size,
        i.reduceOnly ? 1 : 0, i.tif, i.attempt, i.createdAt, i.createdAt,
      );
  }

  updateIntent(
    cloid: string,
    patch: Partial<Pick<StoredIntent, "status" | "venueOrderId" | "filledSize" | "avgFillPx" | "fee" | "detail">>,
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [Date.now()];
    const map: Record<string, string> = {
      status: "status",
      venueOrderId: "venue_order_id",
      filledSize: "filled_size",
      avgFillPx: "avg_fill_px",
      fee: "fee",
      detail: "detail",
    };
    for (const [key, column] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[key];
      if (v !== undefined) {
        sets.push(`${column} = ?`);
        values.push(v as string | number | null);
      }
    }
    values.push(cloid);
    this.db.prepare(`UPDATE intent SET ${sets.join(", ")} WHERE cloid = ?`).run(...values);
  }

  getIntent(cloid: string): StoredIntent | undefined {
    const r = this.db.prepare(`SELECT * FROM intent WHERE cloid = ?`).get(cloid) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToIntent(r) : undefined;
  }

  /** Intents that were never resolved — the crash-recovery set. */
  unresolvedIntents(): StoredIntent[] {
    return (
      this.db
        .prepare(`SELECT * FROM intent WHERE status IN ('intended','placed') ORDER BY created_at`)
        .all() as Record<string, unknown>[]
    ).map(rowToIntent);
  }

  openPosition(p: Omit<StoredPosition, "id" | "closedAt" | "exitPx" | "pnl" | "recordedSequence" | "recordedArweaveId" | "stopPx" | "targetPx" | "closeReason" | "closeDecisionId" | "closeCloid"> & { targetPx?: string | null }): number {
    const info = this.db
      .prepare(
        `INSERT INTO position
           (asset, decision_id, reasoning_id, side, size, entry_px, opened_at, stop_cloid,
            fees, target_px, open_action, hypothesis, conviction, expected_move, strategy_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.asset, p.decisionId, p.reasoningId, p.side, p.size, p.entryPx, p.openedAt,
           p.stopCloid, p.fees ?? "0", p.targetPx ?? null, p.openAction ?? null, p.hypothesis ?? null,
           p.conviction ?? null, p.expectedMove ?? null, p.strategyId ?? null);
    return Number(info.lastInsertRowid);
  }

  /** The reasoning record written before this decision's order was placed. */
  reasoningIdFor(decisionId: string): string | null {
    const r = this.db
      .prepare(`SELECT reasoning_arweave_id AS id FROM decision WHERE id = ?`)
      .get(decisionId) as { id: string | null } | undefined;
    return r?.id ?? null;
  }

  /**
   * The open position a resting stop belongs to.
   *
   * A triggered stop arrives as a fill whose cloid is the stop's, not the
   * entry's, so without this lookup a stop fill is indistinguishable from an
   * unknown position — the one finding that halts the agent.
   */
  positionByStopCloid(stopCloid: string): StoredPosition | undefined {
    const r = this.db
      .prepare(`SELECT * FROM position WHERE stop_cloid = ? AND closed_at IS NULL`)
      .get(stopCloid) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : undefined;
  }

  /**
   * Averages a further fill into an open position.
   *
   * She scales into a level rather than taking it in one order, so a second
   * fill on the same side is an addition, not a second position. Inserting a
   * second row would make `positionByAsset` ambiguous and double-count the
   * notional the guard sees.
   */
  resizePosition(positionId: number, next: { size: string; entryPx: string; fees: string }): void {
    this.db
      .prepare(`UPDATE position SET size = ?, entry_px = ?, fees = ? WHERE id = ?`)
      .run(next.size, next.entryPx, next.fees, positionId);
  }

  /**
   * Records the stop resting at the venue.
   *
   * The trigger price is stored alongside the id because the id alone cannot
   * answer the only question anyone asks of a position — how much of this is
   * at risk. Reconstructing it later would mean re-deriving a number the venue
   * already accepted, which is a different number the moment sizing changes.
   */
  attachStop(positionId: number, stopCloid: string, stopPx: string | null): void {
    this.db
      .prepare(`UPDATE position SET stop_cloid = ?, stop_px = ? WHERE id = ?`)
      .run(stopCloid, stopPx, positionId);
  }

  closePosition(
    positionId: number,
    close: { closedAt: number; exitPx: string; pnl: string; fees: string },
  ): void {
    this.db
      .prepare(`UPDATE position SET closed_at = ?, exit_px = ?, pnl = ?, fees = ? WHERE id = ?`)
      .run(close.closedAt, close.exitPx, close.pnl, close.fees, positionId);
  }

  setCloseAttribution(
    positionId: number,
    close: { reason: CloseReason; decisionId: string | null; cloid: string | null },
  ): void {
    this.db.prepare(
      `UPDATE position SET close_reason = ?, close_decision_id = ?, close_cloid = ? WHERE id = ?`,
    ).run(close.reason, close.decisionId, close.cloid, positionId);
  }

  markRecorded(positionId: number, sequence: number, arweaveId: string): void {
    this.db
      .prepare(`UPDATE position SET recorded_sequence = ?, recorded_arweave_id = ? WHERE id = ?`)
      .run(sequence, arweaveId, positionId);
  }

  openPositions(): StoredPosition[] {
    return (
      this.db.prepare(`SELECT * FROM position WHERE closed_at IS NULL`).all() as Record<string, unknown>[]
    ).map(rowToPosition);
  }

  /**
   * Closed positions not yet on the ledger.
   *
   * A trade that closed but was never recorded is a hole in the record, so this
   * list is drained on every loop rather than only on the happy path.
   */
  unrecordedClosures(): StoredPosition[] {
    return (
      this.db
        .prepare(`SELECT * FROM position WHERE closed_at IS NOT NULL AND recorded_arweave_id IS NULL ORDER BY closed_at`)
        .all() as Record<string, unknown>[]
    ).map(rowToPosition);
  }

  /**
   * Realised pnl and fees, split either side of a moment.
   *
   * The daily breaker needs the equity the session *opened* with, which is not
   * a number any venue reports — it has to be reconstructed from what closed
   * before today. Getting this from `equityUsd()` at the time of the call is
   * what made the breaker measure zero drawdown forever.
   */
  realisedAround(sinceMs: number): { beforePnl: number; beforeFees: number; sincePnl: number; sinceFees: number } {
    const q = (where: string) =>
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CAST(pnl AS REAL)), 0) AS p,
                  COALESCE(SUM(CAST(fees AS REAL)), 0) AS f
             FROM position WHERE closed_at IS NOT NULL AND ${where}`,
        )
        .get(sinceMs) as { p: number; f: number };
    const before = q("closed_at < ?");
    const since = q("closed_at >= ?");
    return { beforePnl: before.p, beforeFees: before.f, sincePnl: since.p, sinceFees: since.f };
  }

  /** The decision behind a position, so she can be reminded what she argued. */
  decisionById(id: string): { losing_side: string; forced_orders_are: string; hypothesis: string; reasoning: string } | null {
    const r = this.db
      .prepare(`SELECT decision_json FROM decision WHERE id = ?`)
      .get(id) as { decision_json: string } | undefined;
    if (!r) return null;
    try {
      const d = JSON.parse(r.decision_json);
      return {
        losing_side: String(d.losing_side ?? ""),
        forced_orders_are: String(d.forced_orders_are ?? ""),
        hypothesis: String(d.hypothesis ?? ""),
        reasoning: String(d.reasoning ?? ""),
      };
    } catch { return null; }
  }

  /** The decision as stored, for fields the typed accessor does not expose. */
  rawDecision(id: string): Record<string, unknown> | null {
    const r = this.db.prepare(`SELECT decision_json FROM decision WHERE id = ?`).get(id) as
      { decision_json: string } | undefined;
    if (!r) return null;
    try { return JSON.parse(r.decision_json) as Record<string, unknown>; } catch { return null; }
  }

  /** Her own closed trades, newest first — the material she learns from. */
  recentClosures(limit = 20): { netUsd: number; heldMs: number; hypothesis: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT p.pnl, p.fees, p.opened_at, p.closed_at,
                json_extract(d.decision_json, '$.hypothesis') AS hypothesis
           FROM position p LEFT JOIN decision d ON d.id = p.decision_id
          WHERE p.closed_at IS NOT NULL
          ORDER BY p.closed_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      netUsd: Number(r.pnl) - Number(r.fees),
      heldMs: Number(r.closed_at) - Number(r.opened_at),
      hypothesis: (r.hypothesis as string | null) ?? null,
    }));
  }

  recentStopsSince(since: number): { asset: string; side: "long" | "short"; at: number }[] {
    return (this.db.prepare(
      `SELECT asset,side,MAX(closed_at) at FROM position
       WHERE close_reason='stop_triggered' AND closed_at>=? GROUP BY asset,side`,
    ).all(since) as Record<string, unknown>[]).map((r) => ({
      asset: String(r.asset), side: r.side as "long" | "short", at: Number(r.at),
    }));
  }

  /** Durable measured record, grouped without asking the model to remember it. */
  performanceStats(limit?: number): PerformanceStat[] {
    const window = limit && limit > 0
      ? `SELECT * FROM position WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ${Math.floor(limit)}`
      : `SELECT * FROM position WHERE closed_at IS NOT NULL`;
    const dimensions = [
      ["asset", "asset"],
      ["side", "side"],
      ["hypothesis", "COALESCE(hypothesis, 'legacy_unknown')"],
      ["strategy", "COALESCE(strategy_id, 'legacy_unknown')"],
      ["close_reason", "COALESCE(close_reason, 'legacy_unknown')"],
    ] as const;
    return dimensions.flatMap(([dimension, expression]) => {
      const rows = this.db.prepare(
        `WITH trades AS (${window})
         SELECT ${expression} AS key, COUNT(*) AS trades,
                SUM(CASE WHEN CAST(pnl AS REAL) - CAST(fees AS REAL) > 0 THEN 1 ELSE 0 END) AS wins,
                SUM(CAST(pnl AS REAL) - CAST(fees AS REAL)) AS net_usd,
                AVG(CAST(pnl AS REAL) - CAST(fees AS REAL)) AS average_net_usd,
                AVG(closed_at - opened_at) AS average_hold_ms
           FROM trades GROUP BY key ORDER BY net_usd DESC`,
      ).all() as Record<string, unknown>[];
      return rows.map((r) => ({
        dimension,
        key: String(r.key),
        trades: Number(r.trades),
        wins: Number(r.wins),
        netUsd: Number(r.net_usd),
        averageNetUsd: Number(r.average_net_usd),
        averageHoldMs: Number(r.average_hold_ms),
      }));
    });
  }

  positionByAsset(asset: string): StoredPosition | undefined {
    const r = this.db
      .prepare(`SELECT * FROM position WHERE asset = ? AND closed_at IS NULL`)
      .get(asset) as Record<string, unknown> | undefined;
    return r ? rowToPosition(r) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

function rowToIntent(r: Record<string, unknown>): StoredIntent {
  return {
    cloid: r.cloid as string,
    decisionId: r.decision_id as string,
    asset: r.asset as string,
    side: r.side as "long" | "short",
    price: r.price as string,
    size: r.size as string,
    reduceOnly: Boolean(r.reduce_only),
    tif: r.tif as string,
    attempt: r.attempt as number,
    status: r.status as IntentStatus,
    venueOrderId: (r.venue_order_id as string) ?? null,
    filledSize: r.filled_size as string,
    avgFillPx: (r.avg_fill_px as string) ?? null,
    fee: r.fee as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    detail: (r.detail as string) ?? null,
  };
}

function rowToPosition(r: Record<string, unknown>): StoredPosition {
  return {
    id: r.id as number,
    asset: r.asset as string,
    decisionId: r.decision_id as string,
    reasoningId: (r.reasoning_id as string) ?? null,
    side: r.side as "long" | "short",
    size: r.size as string,
    entryPx: r.entry_px as string,
    openedAt: r.opened_at as number,
    stopCloid: (r.stop_cloid as string) ?? null,
    stopPx: (r.stop_px as string) ?? null,
    targetPx: (r.target_px as string) ?? null,
    closedAt: (r.closed_at as number) ?? null,
    exitPx: (r.exit_px as string) ?? null,
    pnl: (r.pnl as string) ?? null,
    fees: (r.fees as string) ?? null,
    recordedSequence: (r.recorded_sequence as number) ?? null,
    recordedArweaveId: (r.recorded_arweave_id as string) ?? null,
    openAction: (r.open_action as string) ?? null,
    hypothesis: (r.hypothesis as string) ?? null,
    conviction: r.conviction === null || r.conviction === undefined ? null : Number(r.conviction),
    expectedMove: r.expected_move === null || r.expected_move === undefined ? null : Number(r.expected_move),
    strategyId: (r.strategy_id as string) ?? null,
    closeReason: (r.close_reason as CloseReason) ?? null,
    closeDecisionId: (r.close_decision_id as string) ?? null,
    closeCloid: (r.close_cloid as string) ?? null,
  };
}

function boolDb(value: boolean | null | undefined): number | null {
  return value === undefined || value === null ? null : value ? 1 : 0;
}

function rowToShadow(r: Record<string, unknown>): ShadowEvaluation {
  const bool = (v: unknown) => v === null || v === undefined ? null : Boolean(v);
  return {
    pairId: String(r.pair_id), championDecisionId: String(r.champion_decision_id),
    championAttemptId: String(r.champion_attempt_id), challengerAttemptId: r.challenger_attempt_id as string | null,
    asset: String(r.asset), createdAt: Number(r.created_at),
    completedAt: r.completed_at === null ? null : Number(r.completed_at),
    promptHash: String(r.prompt_hash), challengerModel: String(r.challenger_model), status: String(r.status),
    championSemanticCode: r.champion_semantic_code as string | null,
    challengerSemanticCode: r.challenger_semantic_code as string | null,
    actionAgreement: bool(r.action_agreement), hypothesisAgreement: bool(r.hypothesis_agreement),
    targetAgreement: bool(r.target_agreement), convictionAgreement: bool(r.conviction_agreement),
    allAgreement: bool(r.all_agreement),
    targetRelativeDelta: r.target_relative_delta === null ? null : Number(r.target_relative_delta),
    convictionAbsoluteDelta: r.conviction_absolute_delta === null ? null : Number(r.conviction_absolute_delta),
    detail: r.detail as string | null,
    promptTemplate: r.prompt_template as string | null,
    schemaHash: r.schema_hash as string | null,
    championModel: r.champion_model as string | null,
    evaluationVersion: r.evaluation_version as string | null,
    championDecisionJson: r.champion_decision_json as string | null,
    challengerDecisionJson: r.challenger_decision_json as string | null,
  };
}

function rowToVirtual(r: Record<string, unknown>): ShadowVirtualPosition {
  return {
    id: Number(r.id), pairId: String(r.pair_id), role: r.role as InferenceRole,
    asset: String(r.asset), side: r.side as "long" | "short",
    promptTemplate: String(r.prompt_template), schemaHash: String(r.schema_hash),
    championModel: String(r.champion_model), challengerModel: String(r.challenger_model),
    evaluationVersion: String(r.evaluation_version), decisionJson: String(r.decision_json),
    entryPx: Number(r.entry_px), targetPx: Number(r.target_px), stopPx: Number(r.stop_px),
    size: Number(r.size), notionalUsd: Number(r.notional_usd), openedAt: Number(r.opened_at),
    expiresAt: Number(r.expires_at), lastSampleAt: Number(r.last_sample_at), lastMidPx: Number(r.last_mid_px),
    mfeUsd: Number(r.mfe_usd), maeUsd: Number(r.mae_usd), status: r.status as ShadowVirtualPosition["status"],
    resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
    exitPx: r.exit_px === null ? null : Number(r.exit_px),
    grossPnlUsd: r.gross_pnl_usd === null ? null : Number(r.gross_pnl_usd),
    totalFeesUsd: r.total_fees_usd === null ? null : Number(r.total_fees_usd),
    netPnlUsd: r.net_pnl_usd === null ? null : Number(r.net_pnl_usd),
  };
}
