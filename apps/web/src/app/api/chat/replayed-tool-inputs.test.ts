import { convertToModelMessages, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { sanitizeReplayedToolInputs } from "./replayed-tool-inputs";

/**
 * Regression for the live turn-level failure (owner repro, 2026-08-13): a
 * design-variation turn died with Gemini's "Request contains an invalid
 * argument.", and so did every later send in the thread. The server log carried
 * the real reason —
 *
 *   Invalid value at 'contents[1].parts[0].function_call.args'
 *   (type.googleapis.com/google.protobuf.Struct), "{\"name\":\"addSection\", …
 *
 * — a REJECTED tool call whose raw argument TEXT was replayed into a slot the
 * wire format requires to be an object.
 *
 * The assertions that matter are the ones about what
 * `convertToModelMessages` produces: the invariant is not "the part was
 * rewritten", it is "no assistant tool-call reaches the provider with a
 * non-object input".
 */

/** Truncated addSection args, exactly the shape the provider hands back. */
const TRUNCATED_ARGS =
  '{"name":"addSection","parentId":"root","section":{"id":"sec_a1b2","type":"section","parentId":"root","childrenIds":[],"properties":{}},"children":[';

/** The same mangle, once removed: the whole object as one JSON string. */
const STRINGIFIED_ARGS = JSON.stringify(
  JSON.stringify({ name: "removeBlock", blockId: "txt_a1b2" }),
);

function buildHistory(failedPart: Record<string, unknown>): FlockChatMessage[] {
  return [
    {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Add a hero section." }],
    },
    {
      id: "m2",
      role: "assistant",
      parts: [{ type: "step-start" }, failedPart],
    },
    {
      id: "m3",
      role: "user",
      parts: [{ type: "text", text: "Now add a footer." }],
    },
  ] as unknown as FlockChatMessage[];
}

function readToolCallInputs(messages: ModelMessage[]): unknown[] {
  return messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content
          .filter((part) => part.type === "tool-call")
          .map((part) => (part as { input: unknown }).input)
      : [],
  );
}

describe("sanitizeReplayedToolInputs", () => {
  it("keeps a rejected call's raw text off the provider's tool-call slot", async () => {
    const history = buildHistory({
      type: "tool-addSection",
      toolCallId: "call_1",
      state: "output-error",
      rawInput: TRUNCATED_ARGS,
      errorText: "Invalid input: expected object, received string",
    });

    /* The unsanitized history is what Gemini rejected — pin that. */
    const unsanitized = await convertToModelMessages(history, {
      ignoreIncompleteToolCalls: true,
    });
    expect(readToolCallInputs(unsanitized)).toEqual([TRUNCATED_ARGS]);

    const sanitized = await convertToModelMessages(sanitizeReplayedToolInputs(history), {
      ignoreIncompleteToolCalls: true,
    });
    for (const input of readToolCallInputs(sanitized)) {
      expect(input).toBeInstanceOf(Object);
      expect(Array.isArray(input)).toBe(false);
    }
  });

  it("quotes the unparseable text into the error the model reads", () => {
    const [, assistantMessage] = sanitizeReplayedToolInputs(
      buildHistory({
        type: "tool-addSection",
        toolCallId: "call_1",
        state: "output-error",
        rawInput: TRUNCATED_ARGS,
        errorText: "Invalid input: expected object, received string",
      }),
    );
    const [, failedPart] = assistantMessage?.parts ?? [];
    const part = failedPart as unknown as { input: unknown; errorText: string };

    expect(part.input).toEqual({});
    /* The raw text is the only record of what the model tried to send. */
    expect(part.errorText).toContain('"name":"addSection"');
    expect(part.errorText).toContain("Invalid input: expected object");
  });

  it("replays a double-encoded envelope as the object the model meant", () => {
    const [, assistantMessage] = sanitizeReplayedToolInputs(
      buildHistory({
        type: "tool-removeBlock",
        toolCallId: "call_1",
        state: "output-error",
        rawInput: STRINGIFIED_ARGS,
        errorText: "Invalid input: expected object, received string",
      }),
    );
    const [, failedPart] = assistantMessage?.parts ?? [];

    /* Not `{}`: the arguments were recoverable, so the model sees its own. */
    expect((failedPart as unknown as { input: unknown }).input).toEqual({
      name: "removeBlock",
      blockId: "txt_a1b2",
    });
  });

  it("repairs an ARRAY input, which a protobuf Struct also cannot hold", () => {
    const [, assistantMessage] = sanitizeReplayedToolInputs(
      buildHistory({
        type: "tool-addSection",
        toolCallId: "call_1",
        state: "output-error",
        rawInput: [{ name: "addSection" }],
        errorText: "Invalid input: expected object, received array",
      }),
    );
    const [, failedPart] = assistantMessage?.parts ?? [];

    expect((failedPart as unknown as { input: unknown }).input).toEqual({});
  });

  it("returns an untouched history by identity", () => {
    const history = buildHistory({
      type: "tool-addSection",
      toolCallId: "call_1",
      state: "output-available",
      input: { name: "addSection", parentId: "root" },
      output: { status: "applied" },
    });

    expect(sanitizeReplayedToolInputs(history)).toBe(history);
  });

  it("leaves a failed call whose input is already an object alone", () => {
    /* The client-side apply gate reports failures with a VALID input object —
       that call is informative to the model exactly as it stands. */
    const history = buildHistory({
      type: "tool-addSection",
      toolCallId: "call_1",
      state: "output-error",
      input: { name: "addSection", parentId: "sec_gone" },
      errorText: "unknown_block: sec_gone",
    });

    expect(sanitizeReplayedToolInputs(history)).toBe(history);
  });
});
