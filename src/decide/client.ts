/**
 * The model call, and the audit block that makes it evidence.
 *
 * Determinism is off the table once an LLM decides. Auditability is not. Every
 * consultation records the exact model, the exact prompt, the exact schema, the
 * parameters, the observations it was given by id, and the raw output before
 * parsing — enough that a stranger in a year can reconstruct what she was told
 * and what she said (DESIGN.md §4.2).
 *
 * On connection reuse: a cold TLS handshake to eastus2 was measured at
 * 210–350ms — comparable to the model's entire 190ms of engine time. Node's
 * built-in fetch already pools and keeps connections alive, so a repeated call
 * to the same host does not pay that again. An explicit undici Agent would let
 * us tune the idle timeout, which is not worth a dependency in a package that
 * currently has none.
 */

import { createHash } from "node:crypto";
import {
  DECISION_JSON_SCHEMA,
  PROMPT_TEMPLATE_ID,
  schemaHash,
  validateDecision,
  type Decision,
  type ValidationFailure,
} from "./schema.js";

export type ModelConfig = {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
  /**
   * Zero, so the decision is as close to reproducible as an LLM allows.
   *
   * Not actually reproducible — deployments change underneath a name — which is
   * exactly why the audit block records the deployment rather than relying on
   * temperature to guarantee anything.
   */
  temperature?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
};

/** Everything needed to reconstruct a decision. Written to Arweave verbatim. */
export type DecisionAudit = {
  model: string;
  provider: string;
  apiVersion: string;
  promptTemplate: string;
  promptHash: string;
  prompt: string;
  systemPrompt: string;
  schemaHash: string;
  params: { temperature: number; maxCompletionTokens: number };
  /** Ids of the observations supplied — never the values, which live in events. */
  inputEventIds: string[];
  rawOutput: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  at: number;
};

export type ConsultResult =
  | { ok: true; decision: Decision; audit: DecisionAudit }
  | { ok: false; failure: ValidationFailure | { code: "transport"; detail: string }; audit: DecisionAudit | null };

/**
 * Azure token pricing, USD per million tokens.
 *
 * Approximate and configurable: the point of recording cost is to enforce the
 * daily inference budget, not to reconcile an invoice to the cent.
 */
export const TOKEN_PRICING = { inputPerMillion: 1.25, outputPerMillion: 10.0 };

export class DecisionClient {
  constructor(private readonly config: ModelConfig) {}

  /**
   * Consults the model.
   *
   * Never throws for a bad answer. A timeout, a malformed response or an
   * ungrounded citation are all *results* — the caller treats every one as "no
   * trade", and the audit records what happened. Fail closed, always: the
   * absence of a decision is a safe state, a guessed one is not.
   */
  async consult(input: {
    systemPrompt: string;
    userPrompt: string;
    eventIds: readonly string[];
  }): Promise<ConsultResult> {
    const temperature = this.config.temperature ?? 0;
    const maxCompletionTokens = this.config.maxCompletionTokens ?? 900;
    const startedAt = Date.now();

    const body = {
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: DECISION_JSON_SCHEMA },
      temperature,
      max_completion_tokens: maxCompletionTokens,
    };

    const url =
      `${this.config.endpoint}/openai/deployments/${this.config.deployment}` +
      `/chat/completions?api-version=${this.config.apiVersion}`;

    let raw = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": this.config.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return {
          ok: false,
          failure: { code: "transport", detail: `HTTP ${res.status}: ${detail}` },
          audit: null,
        };
      }

      const json = (await res.json()) as {
        choices: { message: { content: string }; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = json.choices?.[0];
      if (!choice) {
        return { ok: false, failure: { code: "transport", detail: "no choices returned" }, audit: null };
      }
      // A truncated response may be valid JSON while missing the reasoning that
      // justifies it, so it is refused rather than parsed.
      if (choice.finish_reason !== "stop") {
        return {
          ok: false,
          failure: { code: "transport", detail: `finish_reason was ${choice.finish_reason}, not stop` },
          audit: null,
        };
      }

      raw = choice.message.content;
      promptTokens = json.usage?.prompt_tokens ?? 0;
      completionTokens = json.usage?.completion_tokens ?? 0;
    } catch (error) {
      return {
        ok: false,
        failure: { code: "transport", detail: (error as Error).message },
        audit: null,
      };
    }

    const audit: DecisionAudit = {
      model: this.config.deployment,
      provider: `azure:${hostOf(this.config.endpoint)}`,
      apiVersion: this.config.apiVersion,
      promptTemplate: PROMPT_TEMPLATE_ID,
      promptHash: sha256(input.systemPrompt + "\n" + input.userPrompt),
      prompt: input.userPrompt,
      systemPrompt: input.systemPrompt,
      schemaHash: schemaHash(),
      params: { temperature, maxCompletionTokens },
      inputEventIds: [...input.eventIds],
      rawOutput: raw,
      latencyMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      costUsd:
        (promptTokens / 1e6) * TOKEN_PRICING.inputPerMillion +
        (completionTokens / 1e6) * TOKEN_PRICING.outputPerMillion,
      at: startedAt,
    };

    const validated = validateDecision(raw, input.eventIds);
    if (!validated.ok) {
      // The audit is returned even on failure: a model that fabricated a citation
      // is exactly the event most worth keeping a record of.
      return { ok: false, failure: validated.failure, audit };
    }

    return { ok: true, decision: validated.decision, audit };
  }

}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}
