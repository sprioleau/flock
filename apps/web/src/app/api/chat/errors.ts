import { InvalidToolInputError, NoSuchToolError } from "ai";
import { serializeChatError } from "@/lib/chat-contract";
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
export function toChatErrorText(error: unknown): string {
  // The raw error stays server-side; the client gets the structured payload.
  console.error("[flock.chat] stream error:", error);

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
