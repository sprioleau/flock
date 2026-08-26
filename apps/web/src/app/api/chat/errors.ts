import { InvalidToolInputError, NoSuchToolError } from "ai";
import { serializeChatError } from "@/lib/chat-contract";
import {
  classifyModelError,
  extractValidationIssues,
  logFailure,
  summarizeError,
  toFailureSignature,
  type ModelErrorCode,
} from "@/lib/observability/log";
import { TerminalChatError } from "./tools";

/**
 * Shape stream-level failures into the structured error-part payload
 * (ChatErrorPayload in chat-contract.ts).
 *
 * Wired into BOTH error funnels — createUIMessageStream({ onError }) for
 * pipeline/setup failures AND toUIMessageStream({ onError }) for errors inside
 * the model stream — because each helper defaults to an opaque
 * "An error occurred." otherwise.
 */

/** Which of the two funnels produced a record. */
export type ChatErrorSource = "model-stream" | "pipeline";

export interface ChatErrorLoggerInput {
  /** The turn's correlation id (see ChatPipelineInput.traceId). */
  traceId: string;
  source: ChatErrorSource;
}

/**
 * Build the funnel's onError handler, bound to the turn's trace id.
 *
 * The previous implementation did `console.error("[flock.chat] stream error:",
 * error)` — a raw Error object, which Vercel renders as a multi-line blob that
 * cannot be searched, filtered, or counted. This emits one JSON line instead,
 * carrying a stable `errorCode` to count on and, for the validation failures
 * that dominate this path, the Zod issue codes and paths.
 */
export function createChatErrorLogger({
  traceId,
  source,
}: ChatErrorLoggerInput): (error: unknown) => string {
  // One failure, one record. The AI SDK invokes a stream funnel's onError
  // TWICE for a single failure — once with the Error object and once with the
  // already-formatted string — which was visible in the first live run as two
  // flock.chat.streamFailed lines for one broken tool call. The handler is
  // built per request, so this set never outlives the turn.
  const loggedSignatures = new Set<string>();

  return (error: unknown) => {
    const summary = summarizeError(error);
    const issues = extractValidationIssues(error);
    const signature = toFailureSignature(error);
    if (loggedSignatures.has(signature)) {
      return toChatErrorText(error);
    }
    loggedSignatures.add(signature);
    logFailure({
      tag: "flock.chat.streamFailed",
      traceId,
      source,
      errorCode: summary.code,
      errorName: summary.name,
      statusCode: summary.statusCode,
      message: summary.message,
      // For a provider rejection this is the only field that says WHICH part of
      // the request was refused — see ErrorSummary.providerDetail.
      providerDetail: summary.providerDetail,
      issueCount: issues.length,
      issueCodes: issues.length === 0 ? undefined : issues.map((issue) => issue.code),
      issuePaths: issues.length === 0 ? undefined : issues.map((issue) => issue.path),
    });
    return toChatErrorText(error);
  };
}

/*
  Which classified error codes mean "the model's tool call did not fit the
  tool's schema" — i.e. the failures that are retryable from the user's
  perspective (rephrase and go again) once the repair round-trip is spent.
*/
const TOOL_CALL_VALIDATION_ERROR_CODES: ReadonlySet<ModelErrorCode> = new Set<ModelErrorCode>([
  "invalid_tool_input",
  "no_such_tool",
]);

/*
  Whether a value handed to a stream funnel describes a tool-input validation
  failure.

  The marker check alone is NOT enough, and that is the bug this exists to
  close. When a tool call fails its inputSchema and the repair round-trip does
  not rescue it, the AI SDK's parseToolCall returns an `invalid: true`
  tool-call part carrying the real InvalidToolInputError, and the stream then
  ALSO emits a `tool-error` part whose `error` has been flattened with
  getErrorMessage() — Error.prototype.toString(), a plain STRING. The chat UI
  renders THAT part (ToolPartChip's "output-error" state), so the value this
  funnel classifies for the chip is a string, and
  `InvalidToolInputError.isInstance` is false for it by construction. Live,
  that turned every rejected scaffoldSection into a terminal "stream_error".

  classifyModelError already reads the name back off the stringified form
  ("AI_InvalidToolInputError: …") — see toFailureSignature, which documents the
  SDK's double report — so routing through it covers both shapes with no
  second copy of the name vocabulary.
*/
function isToolCallValidationFailure(error: unknown): boolean {
  if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
    return true;
  }
  return TOOL_CALL_VALIDATION_ERROR_CODES.has(classifyModelError(error));
}

/**
 * Serialize a stream-level failure into the client's structured payload. The
 * raw error stays server-side; the client gets codes and human sentences only.
 */
export function toChatErrorText(error: unknown): string {
  if (error instanceof TerminalChatError) {
    return serializeChatError({
      kind: "flock-chat-error",
      failureKind: "terminal",
      errors: error.errors.map(({ code, message }) => ({ code, message })),
    });
  }
  const isToolCallValidationError = isToolCallValidationFailure(error);
  return serializeChatError({
    kind: "flock-chat-error",
    failureKind: isToolCallValidationError ? "retryable" : "terminal",
    errors: [
      {
        code: isToolCallValidationError ? "op_validation_failed" : "stream_error",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  });
}
