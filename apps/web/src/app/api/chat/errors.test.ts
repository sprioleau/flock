import { InvalidToolInputError, NoSuchToolError } from "ai";
import { describe, expect, it } from "vitest";
import { parseChatErrorText } from "@/lib/chat-contract";
import { toChatErrorText } from "./errors";

/*
  The captured live failure, verbatim: the model called scaffoldSection with
  two invented hero params ("subheadline", "brandName"). parseToolCall
  rejected the call, the repair round-trip did not rescue it, and the SDK
  emitted BOTH an `invalid: true` tool-call part (carrying the Error object)
  and a `tool-error` part whose `error` had been flattened with
  getErrorMessage() — i.e. Error.prototype.toString(), which prefixes the
  error name. The chat UI renders the second one, so the STRING is the value
  this funnel actually has to classify.
*/
const CAPTURED_VALIDATION_FAILURE_MESSAGE =
  'Invalid input for tool scaffoldSection: AI_TypeValidationError: Type validation failed: ' +
  'Value: {"position":"bottom","name":"scaffoldSection","params":{"subheadline":"Welcome to Flock.",' +
  '"brandName":"Flock","ctaLabel":"Shop the Sale","headline":"Labor Day Sale: 20% Off All Merch!",' +
  '"ctaHref":"https://example.com/get-started"},"templateId":"hero"}.\n' +
  'Error message: [{"origin":"string","code":"invalid_format","format":"regex",' +
  '"pattern":"/^saved:.+$/","path":["templateId"],"message":"Invalid string: must match pattern /^saved:.+$/"}]';

function createCapturedToolInputError(): InvalidToolInputError {
  return new InvalidToolInputError({
    toolName: "scaffoldSection",
    toolInput: "{}",
    cause: null,
    message: CAPTURED_VALIDATION_FAILURE_MESSAGE,
  });
}

describe("toChatErrorText", () => {
  it("classifies a tool-input validation failure as retryable when the SDK hands it the Error", () => {
    const payload = parseChatErrorText(toChatErrorText(createCapturedToolInputError()));
    expect(payload?.failureKind).toBe("retryable");
    expect(payload?.errors[0]?.code).toBe("op_validation_failed");
  });

  it("classifies the SAME failure as retryable when the SDK hands it the STRINGIFIED error", () => {
    /*
      This is the exact value the AI SDK passes to a tool-error part's
      onError: getErrorMessage(error) === error.toString().
    */
    const stringifiedError = createCapturedToolInputError().toString();
    expect(stringifiedError).toBe(
      `AI_InvalidToolInputError: ${CAPTURED_VALIDATION_FAILURE_MESSAGE}`,
    );

    const payload = parseChatErrorText(toChatErrorText(stringifiedError));
    expect(payload?.failureKind).toBe("retryable");
    expect(payload?.errors[0]?.code).toBe("op_validation_failed");
    expect(payload?.errors[0]?.message).toBe(stringifiedError);
  });

  it("classifies a stringified no-such-tool failure as retryable too", () => {
    const stringifiedError = new NoSuchToolError({ toolName: "nope" }).toString();
    const payload = parseChatErrorText(toChatErrorText(stringifiedError));
    expect(payload?.failureKind).toBe("retryable");
    expect(payload?.errors[0]?.code).toBe("op_validation_failed");
  });

  it("leaves an ordinary stream failure terminal", () => {
    const payload = parseChatErrorText(toChatErrorText(new Error("upstream exploded")));
    expect(payload?.failureKind).toBe("terminal");
    expect(payload?.errors[0]?.code).toBe("stream_error");
  });

  it("leaves a stringified NON-validation failure terminal", () => {
    const payload = parseChatErrorText(toChatErrorText("AI_APICallError: 503 upstream"));
    expect(payload?.failureKind).toBe("terminal");
    expect(payload?.errors[0]?.code).toBe("stream_error");
  });
});
