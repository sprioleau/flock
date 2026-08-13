import { InvalidToolInputError, NoSuchToolError } from "ai";
import { serializeChatError } from "@/lib/chat-contract";
import {
  extractValidationIssues,
  logFailure,
  summarizeError,
  toFailureSignature,
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
  // Tool-call validation failures that survived the one repair round-trip are
  // retryable from the user's perspective (rephrase and go again).
  const isToolCallValidationError =
    InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error);
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
