import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { createToolCallRepairer } from "./pipeline";

/*
  Regression for the live terminal failure (owner repro, complex prompt):
  the repairer replayed a failed call's RAW STRING args verbatim inside an
  assistant tool-call part; the Google provider encoded that string into
  `function_call.args` (a protobuf Struct), the REPAIR REQUEST ITSELF was
  rejected (AI_APICallError), the repairer threw, and the SDK wrapped it in
  AI_ToolCallRepairError — one bad call became a turn-killing wall of JSON.

  Pinned here:
  1. the replayed assistant tool-call part carries an OBJECT input (never a
     string), so the repair request is always encodable;
  2. an unparseable raw input degrades to `{}` with the raw text quoted in
     the tool-result prose instead;
  3. a provider failure during the re-ask returns null (unrepaired) instead
     of throwing — the SDK then degrades the call to one failure chip and
     the turn continues.
*/

const STRINGIFIED_ENVELOPE = JSON.stringify({
  children: [{ id: "txt_ab12", type: "text" }],
  section: { id: "sec_cd34" },
  index: 0,
  name: "addSection",
});

function buildSchemaOnlyTools(): ToolSet {
  return {
    addSection: tool({
      description: "test tool",
      inputSchema: z.object({ name: z.literal("addSection") }).loose(),
    }),
  };
}

function buildCaptureThenThrowRepairer(capturedPrompts: unknown[]) {
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      capturedPrompts.push(options.prompt);
      throw new Error("simulated provider rejection (APICallError stand-in)");
    },
  });
  return createToolCallRepairer({
    model,
    schemaOnlyTools: buildSchemaOnlyTools(),
    staticInstructions: "test instructions",
    onRepairAttempt: () => {},
    telemetryContext: { operation: "chat.main", traceId: "test-trace", isMock: true },
  });
}

function findReplayedToolCall(prompt: unknown): { input?: unknown } | undefined {
  const messages = prompt as ModelMessage[];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (typeof part === "object" && part !== null && part.type === "tool-call") {
        return part as { input?: unknown };
      }
    }
  }
  return undefined;
}

describe("createToolCallRepairer (repair-request encodability + never-throw)", () => {
  it("replays stringified args as a parsed OBJECT and returns null on provider failure", async () => {
    const capturedPrompts: unknown[] = [];
    const repairer = buildCaptureThenThrowRepairer(capturedPrompts);

    const result = await repairer({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "addSection",
        input: STRINGIFIED_ENVELOPE,
      },
      tools: buildSchemaOnlyTools(),
      inputSchema: async () => ({}),
      system: "test instructions",
      messages: [],
      error: new Error("Invalid input"),
    } as never);

    /*
      Never throws; provider failure degrades to "unrepaired".
    */
    expect(result).toBeNull();

    /*
      The repair request WAS attempted, and its replayed call carried an
      object — the protobuf-encodable form.
    */
    expect(capturedPrompts.length).toBe(1);
    const replayedCall = findReplayedToolCall(capturedPrompts[0]);
    expect(replayedCall).toBeDefined();
    expect(typeof replayedCall!.input).toBe("object");
    expect(replayedCall!.input).toMatchObject({ name: "addSection", index: 0 });
  });

  it("degrades unparseable raw args to {} and quotes them in the error prose", async () => {
    const capturedPrompts: unknown[] = [];
    const repairer = buildCaptureThenThrowRepairer(capturedPrompts);

    await repairer({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "addSection",
        input: '{"truncated": tru',
      },
      tools: buildSchemaOnlyTools(),
      inputSchema: async () => ({}),
      system: "test instructions",
      messages: [],
      error: new Error("Invalid input"),
    } as never);

    const replayedCall = findReplayedToolCall(capturedPrompts[0]);
    expect(replayedCall!.input).toEqual({});
    const promptJson = JSON.stringify(capturedPrompts[0]);
    expect(promptJson).toContain("were not valid JSON");
  });
});
