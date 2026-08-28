import type { Telemetry } from "ai";
import {
  createTraceId,
  logFailure,
  logRecord,
  summarizeError,
  truncateJson,
} from "./log";

/**
 * ONE record per LLM provider call, everywhere, without hand-instrumenting
 * each call site's try/catch.
 *
 * AI SDK v7 replaced the v5-era OpenTelemetry `experimental_telemetry`
 * (functionId + metadata attached to OTel spans) with a provider-agnostic
 * lifecycle interface: `Telemetry` (exported from "ai"), whose callbacks the
 * SDK invokes around every generateText / streamText / generateObject /
 * streamObject / embed / rerank call. Integrations can be registered globally
 * (`registerTelemetry`) or handed to a SINGLE call via
 * `telemetry: { integrations: [...] }`.
 *
 * This module uses the PER-CALL form on purpose. It is what lets one
 * integration instance close over the request's `traceId`, route, and
 * mock-ness with no global mutable state, no AsyncLocalStorage, and no
 * assumption that async context survives a streamed response being drained by
 * the runtime after the handler returned.
 *
 * NOT covered here: `generateImage`. Image generation is not one of the SDK's
 * telemetry-instrumented operations, so api/generate-image/generation.ts logs
 * its own `flock.model.call` record through {@link logModelCall}.
 */

/**
 * Which call site produced a record. Low-cardinality and stable — the field
 * you group by to answer "which operation fails most".
 */
export type ModelOperation =
  | "chat.main"
  | "chat.repair"
  | "personas.review"
  | "savedSections.enrich"
  | "brandKit.extract"
  | "ingest.webSearch"
  | "ingest.classifyPage"
  | "image.generate";

export interface ModelTelemetryContext {
  /** The call site. */
  operation: ModelOperation;
  /** Ties every record from one request together. See createTraceId(). */
  traceId: string;
  /** Whether this run used a deterministic mock instead of a provider. */
  isMock: boolean;
  /**
   * Short hash of the caller's anonymous session id, or null. Hashed, not
   * verbatim — no diagnostic question needs the raw id.
   */
  sessionHash?: string | null;
}

// ---------------------------------------------------------------------------
// Record emitters (also used directly by the non-SDK-instrumented image path)
// ---------------------------------------------------------------------------

export interface ModelCallOutcome {
  /** Provider id as the SDK reports it, e.g. "google.generative-ai". */
  provider: string;
  modelId: string;
  /** Provider-call wall time. */
  latencyMs: number;
  finishReason?: string;
  /** Token counts, when the provider reported them. */
  usage?: unknown;
  /** The SDK's per-generation id, for stitching multi-step turns. */
  callId?: string;
}

/** `flock.model.call` — one successful provider call. */
export function logModelCall(
  context: ModelTelemetryContext,
  outcome: ModelCallOutcome,
): void {
  logRecord({
    tag: "flock.model.call",
    operation: context.operation,
    traceId: context.traceId,
    isMock: context.isMock,
    sessionHash: context.sessionHash ?? null,
    provider: outcome.provider,
    model: outcome.modelId,
    latencyMs: Math.round(outcome.latencyMs),
    callId: outcome.callId,
    finishReason: outcome.finishReason,
    usage: outcome.usage,
  });
}

/** `flock.model.failed` — one provider call that threw. */
export function logModelFailure(
  context: ModelTelemetryContext,
  error: unknown,
): void {
  const summary = summarizeError(error);
  logFailure({
    tag: "flock.model.failed",
    operation: context.operation,
    traceId: context.traceId,
    isMock: context.isMock,
    sessionHash: context.sessionHash ?? null,
    errorCode: summary.code,
    errorName: summary.name,
    statusCode: summary.statusCode,
    message: summary.message,
    // The provider's own words about WHICH field it rejected. Absent for
    // everything that is not an APICallError with a body.
    providerDetail: summary.providerDetail,
  });
}

// ---------------------------------------------------------------------------
// The integration
// ---------------------------------------------------------------------------

/**
 * Build the per-call telemetry integration. Pass it as
 * `telemetry: { functionId, integrations: [createModelTelemetry(context)] }`.
 *
 * Records emitted:
 *   flock.model.call      — every provider round-trip that returned
 *   flock.model.failed    — every provider round-trip that threw
 *   flock.model.toolFailed— every client-side tool execute() that threw
 */
export function createModelTelemetry(context: ModelTelemetryContext): Telemetry {
  return {
    onLanguageModelCallEnd: (event) => {
      logModelCall(context, {
        provider: event.provider,
        modelId: event.modelId,
        latencyMs: event.performance.responseTimeMs,
        finishReason: event.finishReason,
        usage: event.usage,
        callId: event.callId,
      });
    },

    onError: (error) => {
      logModelFailure(context, error);
    },

    onToolExecutionEnd: (event) => {
      // Only failures. A successful tool execution is already implied by the
      // turn's flock.chat.request toolNames — logging both would double every
      // turn's line count against Vercel's 256-lines-per-request ceiling.
      if (event.toolOutput.type !== "tool-error") {
        return;
      }
      const summary = summarizeError(event.toolOutput.error);
      logFailure({
        tag: "flock.model.toolFailed",
        operation: context.operation,
        traceId: context.traceId,
        isMock: context.isMock,
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        toolExecutionMs: Math.round(event.toolExecutionMs),
        errorCode: summary.code,
        errorName: summary.name,
        message: summary.message,
      });
    },
  };
}

/**
 * The whole telemetry option object for a call site, so a call site reads as
 * one line instead of four. `functionId` is the SDK's own grouping key and is
 * kept identical to `operation` so the two never drift.
 */
export function modelTelemetryFor(context: ModelTelemetryContext): {
  functionId: string;
  integrations: [Telemetry];
} {
  return {
    functionId: context.operation,
    integrations: [createModelTelemetry(context)],
  };
}

/**
 * A context for a route that has no upstream trace id of its own. Convenience
 * so a one-model-call route is a single line at the call site.
 */
export function newModelContext(
  operation: ModelOperation,
  options: { isMock: boolean; sessionHash?: string | null } = { isMock: false },
): ModelTelemetryContext {
  return {
    operation,
    traceId: createTraceId(),
    isMock: options.isMock,
    sessionHash: options.sessionHash ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tool-input validation failures (the chat pipeline's blind spot)
// ---------------------------------------------------------------------------

/** Why a rejected tool call was never repaired. */
export type UnrepairedReason =
  | "no_such_tool"
  | "repair_budget_exhausted"
  | "repair_produced_no_call"
  | "repair_request_failed";

export interface ToolInputRejectedInput {
  context: ModelTelemetryContext;
  toolName: string;
  toolCallId: string;
  /** Validation issue list pulled off the error (codes + paths). */
  issues: ReadonlyArray<{ code: string; path: string; message: string }>;
  /** The offending payload, ALREADY truncated by the caller. */
  rejectedInput: unknown;
  /** How many repair attempts this tool call had already consumed. */
  previousAttemptCount: number;
}

/**
 * `flock.chat.toolInputRejected` — the record that did not exist before.
 *
 * Fires the moment the SDK hands a failed tool call to the repairer, i.e. on
 * EVERY InvalidToolInputError, whether or not the repair later succeeds. It
 * carries the two things the previous logging threw away: the validation issue
 * codes and paths, and a truncated copy of what the model actually sent.
 */
export function logToolInputRejected({
  context,
  toolName,
  toolCallId,
  issues,
  rejectedInput,
  previousAttemptCount,
}: ToolInputRejectedInput): void {
  logFailure({
    tag: "flock.chat.toolInputRejected",
    operation: context.operation,
    traceId: context.traceId,
    isMock: context.isMock,
    toolName,
    toolCallId,
    previousAttemptCount,
    issueCount: issues.length,
    issueCodes: issues.map((issue) => issue.code),
    issuePaths: issues.map((issue) => issue.path),
    issues,
    rejectedInput: truncateJson(rejectedInput),
  });
}

/**
 * `flock.chat.toolInputUnrepaired` — the previously SILENT outcome.
 *
 * Before this record, "tried, re-asked, and failed again" produced exactly the
 * same log output as "never tried at all": the repairer just returned null.
 * `reason` is what distinguishes them.
 */
export function logToolInputUnrepaired({
  context,
  toolName,
  toolCallId,
  reason,
}: {
  context: ModelTelemetryContext;
  toolName: string;
  toolCallId: string;
  reason: UnrepairedReason;
}): void {
  logFailure({
    tag: "flock.chat.toolInputUnrepaired",
    operation: context.operation,
    traceId: context.traceId,
    isMock: context.isMock,
    toolName,
    toolCallId,
    reason,
  });
}
