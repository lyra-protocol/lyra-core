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

import { createHash, randomUUID } from "node:crypto";
import {
  PROMPT_TEMPLATE_ID,
  decisionJsonSchema,
  schemaHash,
  validateDecision,
  type Decision,
  type ValidationFailure,
  type DecisionGenerationContext,
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
  /** Explicit reasoning budget for GPT-5 reasoning deployments. */
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
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
  params: { temperature: number | null; reasoningEffort: string | null; maxCompletionTokens: number };
  /** Ids of the observations supplied — never the values, which live in events. */
  inputEventIds: string[];
  rawOutput: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  at: number;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type ConsultInput = {
  systemPrompt: string;
  userPrompt: string;
  eventIds: readonly string[];
  generationContext?: DecisionGenerationContext;
};

export type PreparedConsult = {
  attemptId: string;
  input: ConsultInput;
  startedAt: number;
  reservation: TokenUsage;
  promptHash: string;
};

export type InferenceCallResult = {
  attemptId: string;
  startedAt: number;
  completedAt: number;
  model: string;
  provider: string;
  apiVersion: string;
  transportOk: boolean;
  validationOk: boolean | null;
  failureCode: string | null;
  failureDetail: string | null;
  httpStatus: number | null;
  reportedUsage: TokenUsage | null;
  accountedUsage: TokenUsage;
  usageSource: "reported" | "reserved";
  latencyMs: number;
};

export type ConsultResult =
  | { ok: true; decision: Decision; audit: DecisionAudit; call: InferenceCallResult }
  | {
      ok: false;
      failure: ValidationFailure | { code: "transport"; detail: string };
      audit: DecisionAudit | null;
      call: InferenceCallResult;
    };

/**
 * Azure token pricing, USD per million tokens.
 *
 * Approximate and configurable: the point of recording cost is to enforce the
 * daily inference budget, not to reconcile an invoice to the cent.
 */
export type TokenPricing = { inputPerMillion: number; outputPerMillion: number };

/** Global Standard list prices; unknown deployments use a conservative fallback. */
export function tokenPricing(model: string): TokenPricing {
  if (model.includes("gpt-4.1-mini")) return { inputPerMillion: 0.4, outputPerMillion: 1.6 };
  if (model.includes("gpt-4.1-nano")) return { inputPerMillion: 0.1, outputPerMillion: 0.4 };
  if (model.includes("gpt-5.6-luna")) return { inputPerMillion: 1.0, outputPerMillion: 6.0 };
  if (model.includes("gpt-5.4-mini")) return { inputPerMillion: 0.75, outputPerMillion: 4.5 };
  if (model.includes("gpt-5.4-nano")) return { inputPerMillion: 0.2, outputPerMillion: 1.25 };
  return { inputPerMillion: 2.5, outputPerMillion: 15.0 };
}

export class DecisionClient {
  constructor(private readonly config: ModelConfig) {}

  metadata(): { model: string; provider: string; apiVersion: string } {
    return {
      model: this.config.deployment,
      provider: `azure:${hostOf(this.config.endpoint)}`,
      apiVersion: this.config.apiVersion,
    };
  }

  /**
   * Reserves a conservative upper bound before transport begins. A crash or a
   * provider response without usage is therefore never mistaken for a free call.
   */
  prepare(input: ConsultInput): PreparedConsult {
    const body = this.requestBody(input);
    const promptTokens = Buffer.byteLength(JSON.stringify(body), "utf8");
    const completionTokens = this.config.maxCompletionTokens ?? 900;
    return {
      attemptId: randomUUID(),
      input,
      startedAt: Date.now(),
      reservation: priceUsage(promptTokens, completionTokens, tokenPricing(this.config.deployment)),
      promptHash: sha256(input.systemPrompt + "\n" + input.userPrompt),
    };
  }

  /**
   * Consults the model.
   *
   * Never throws for a bad answer. A timeout, a malformed response or an
   * ungrounded citation are all *results* — the caller treats every one as "no
   * trade", and the audit records what happened. Fail closed, always: the
   * absence of a decision is a safe state, a guessed one is not.
   */
  async consult(input: ConsultInput | PreparedConsult): Promise<ConsultResult> {
    const prepared = "attemptId" in input ? input : this.prepare(input);
    const request = prepared.input;
    const temperature = this.config.temperature ?? 0;
    const maxCompletionTokens = this.config.maxCompletionTokens ?? 900;
    const startedAt = prepared.startedAt;
    const body = this.requestBody(request);

    const url =
      `${this.config.endpoint}/openai/deployments/${this.config.deployment}` +
      `/chat/completions?api-version=${this.config.apiVersion}`;

    let raw = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let usageReported = false;
    let httpStatus: number | null = null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": this.config.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });
      httpStatus = res.status;

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return {
          ok: false,
          failure: { code: "transport", detail: `HTTP ${res.status}: ${detail}` },
          audit: null,
          call: finishCall(prepared, this.config, {
            transportOk: false, validationOk: null, failureCode: "transport",
            failureDetail: `HTTP ${res.status}: ${detail}`, httpStatus,
          }),
        };
      }

      const json = (await res.json()) as {
        choices: { message: { content: string }; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = json.choices?.[0];
      if (!choice) {
        return {
          ok: false,
          failure: { code: "transport", detail: "no choices returned" },
          audit: null,
          call: finishCall(prepared, this.config, {
            transportOk: true, validationOk: null, failureCode: "transport",
            failureDetail: "no choices returned", httpStatus,
          }),
        };
      }
      // A truncated response may be valid JSON while missing the reasoning that
      // justifies it, so it is refused rather than parsed.
      if (choice.finish_reason !== "stop") {
        return {
          ok: false,
          failure: { code: "transport", detail: `finish_reason was ${choice.finish_reason}, not stop` },
          audit: null,
          call: finishCall(prepared, this.config, {
            transportOk: true, validationOk: null, failureCode: "transport",
            failureDetail: `finish_reason was ${choice.finish_reason}, not stop`, httpStatus,
          }),
        };
      }

      raw = choice.message.content;
      promptTokens = json.usage?.prompt_tokens ?? 0;
      completionTokens = json.usage?.completion_tokens ?? 0;
      usageReported = json.usage !== undefined;
    } catch (error) {
      const detail = (error as Error).message;
      return {
        ok: false,
        failure: { code: "transport", detail },
        audit: null,
        call: finishCall(prepared, this.config, {
          transportOk: false, validationOk: null, failureCode: "transport",
          failureDetail: detail, httpStatus,
        }),
      };
    }

    const reportedUsage = usageReported
      ? priceUsage(promptTokens, completionTokens, tokenPricing(this.config.deployment))
      : null;

    const audit: DecisionAudit = {
      model: this.config.deployment,
      provider: `azure:${hostOf(this.config.endpoint)}`,
      apiVersion: this.config.apiVersion,
      promptTemplate: PROMPT_TEMPLATE_ID,
      promptHash: prepared.promptHash,
      prompt: request.userPrompt,
      systemPrompt: request.systemPrompt,
      schemaHash: schemaHash(decisionJsonSchema(request.generationContext ?? { kind: "flat" })),
      params: {
        temperature: isReasoningModel(this.config.deployment) ? null : temperature,
        reasoningEffort: isReasoningModel(this.config.deployment)
          ? this.config.reasoningEffort ?? "low"
          : null,
        maxCompletionTokens,
      },
      inputEventIds: [...request.eventIds],
      rawOutput: raw,
      latencyMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      costUsd: reportedUsage?.costUsd ?? 0,
      at: startedAt,
    };

    const validated = validateDecision(raw, request.eventIds);
    if (!validated.ok) {
      // The audit is returned even on failure: a model that fabricated a citation
      // is exactly the event most worth keeping a record of.
      return {
        ok: false,
        failure: validated.failure,
        audit,
        call: finishCall(prepared, this.config, {
          transportOk: true, validationOk: false,
          failureCode: validated.failure.code, failureDetail: validated.failure.detail,
          httpStatus, reportedUsage,
        }),
      };
    }

    return {
      ok: true,
      decision: validated.decision,
      audit,
      call: finishCall(prepared, this.config, {
        transportOk: true, validationOk: true, failureCode: null,
        failureDetail: null, httpStatus, reportedUsage,
      }),
    };
  }

  private requestBody(input: ConsultInput) {
    const schema = decisionJsonSchema(input.generationContext ?? { kind: "flat" });
    const reasoning = isReasoningModel(this.config.deployment);
    return {
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: schema },
      ...(!reasoning ? { temperature: this.config.temperature ?? 0 } : {}),
      ...(reasoning ? { reasoning_effort: this.config.reasoningEffort ?? "low" } : {}),
      max_completion_tokens: this.config.maxCompletionTokens ?? 900,
    };
  }

}

export function isReasoningModel(model: string): boolean {
  return /^gpt-5(?:\.|-|$)/.test(model) && !model.includes("-chat");
}

export function priceUsage(
  promptTokens: number,
  completionTokens: number,
  pricing: TokenPricing = tokenPricing("unknown"),
): TokenUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd:
      (promptTokens / 1e6) * pricing.inputPerMillion +
      (completionTokens / 1e6) * pricing.outputPerMillion,
  };
}

function finishCall(
  prepared: PreparedConsult,
  config: ModelConfig,
  result: {
    transportOk: boolean;
    validationOk: boolean | null;
    failureCode: string | null;
    failureDetail: string | null;
    httpStatus: number | null;
    reportedUsage?: TokenUsage | null;
  },
): InferenceCallResult {
  const completedAt = Date.now();
  const reportedUsage = result.reportedUsage ?? null;
  return {
    attemptId: prepared.attemptId,
    startedAt: prepared.startedAt,
    completedAt,
    model: config.deployment,
    provider: `azure:${hostOf(config.endpoint)}`,
    apiVersion: config.apiVersion,
    transportOk: result.transportOk,
    validationOk: result.validationOk,
    failureCode: result.failureCode,
    failureDetail: result.failureDetail,
    httpStatus: result.httpStatus,
    reportedUsage,
    accountedUsage: reportedUsage ?? prepared.reservation,
    usageSource: reportedUsage ? "reported" : "reserved",
    latencyMs: completedAt - prepared.startedAt,
  };
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
