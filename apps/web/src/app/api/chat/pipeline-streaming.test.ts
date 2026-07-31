import { createSampleDocument } from "@tandem/email-sdk";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it } from "vitest";
import type { TandemChatMessage } from "@/lib/chat-contract";
import { MOCK_MODEL_ID } from "./constants";
import { createMockChatModel, MOCK_COMPOSE_EMAIL_TEMPLATE_IDS } from "./mock-model";
import { runChatPipeline } from "./pipeline";

/**
 * Per-section streaming (the perceived-latency contract): when a model
 * composes a full email as N per-section tool calls, the pipeline must
 * deliver each VALIDATED call to the client as it completes — never buffer
 * the step and flush all calls at the end. The client applies each content
 * op at input-available (use-tandem-chat onToolCall), so "call k delivered
 * before call k+1 starts generating" IS "section k painted before section
 * k+1 exists".
 *
 * Driven end-to-end through the real pipeline (streamText → validation →
 * toUIMessageStream) with the mock model's compose script: four sequential
 * scaffoldSection calls streamed with real inter-chunk delays.
 */

interface RecordedChunk {
  type: string;
  toolCallId: string | undefined;
  atMs: number;
}

async function runComposeProbe(): Promise<RecordedChunk[]> {
  const recordedChunks: RecordedChunk[] = [];
  let mergedStream: ReadableStream<unknown> | null = null;

  const writer = {
    write: () => {},
    merge: (stream: ReadableStream<unknown>) => {
      mergedStream = stream;
    },
    onError: undefined,
  } as unknown as UIMessageStreamWriter<TandemChatMessage>;

  const lastUserText = "Compose a full email announcing our spring launch.";
  const messages: TandemChatMessage[] = [
    { id: "msg-1", role: "user", parts: [{ type: "text", text: lastUserText }] },
  ];

  await runChatPipeline({
    model: createMockChatModel({ lastUserText }),
    modelId: MOCK_MODEL_ID,
    isUsingMockModel: true,
    messages,
    doc: createSampleDocument(),
    sessionId: null,
    writer,
  });

  expect(mergedStream).not.toBeNull();
  const reader = (mergedStream as unknown as ReadableStream<unknown>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value as { type: string; toolCallId?: string };
    recordedChunks.push({
      type: chunk.type,
      toolCallId: chunk.toolCallId,
      atMs: performance.now(),
    });
  }
  return recordedChunks;
}

describe("per-section streaming through the chat pipeline", () => {
  it("delivers each validated section call before the next section starts generating", async () => {
    const recordedChunks = await runComposeProbe();

    const inputStarts = recordedChunks.filter((chunk) => chunk.type === "tool-input-start");
    const inputAvailables = recordedChunks.filter(
      (chunk) => chunk.type === "tool-input-available",
    );
    expect(inputStarts).toHaveLength(MOCK_COMPOSE_EMAIL_TEMPLATE_IDS.length);
    expect(inputAvailables).toHaveLength(MOCK_COMPOSE_EMAIL_TEMPLATE_IDS.length);

    // Interleaving: section k's call is fully validated and delivered BEFORE
    // section k+1's input begins streaming — the no-buffering guarantee.
    for (let sectionIndex = 0; sectionIndex < inputAvailables.length - 1; sectionIndex++) {
      const availableAt = recordedChunks.indexOf(inputAvailables[sectionIndex]!);
      const nextStartAt = recordedChunks.indexOf(inputStarts[sectionIndex + 1]!);
      expect(availableAt).toBeLessThan(nextStartAt);
    }

    // Pacing: with the mock's 20ms inter-chunk delay, successive sections
    // must land measurably apart (a buffered flush would record ~0ms gaps).
    const gapsMs = inputAvailables
      .slice(1)
      .map((chunk, index) => chunk.atMs - inputAvailables[index]!.atMs);
    for (const gapMs of gapsMs) {
      expect(gapMs).toBeGreaterThan(20);
    }
    // Evidence line for the latency report (inter-section paint gaps).
    console.log(
      JSON.stringify({
        tag: "tandem.test.sectionStreamGaps",
        gapsMs: gapsMs.map((gapMs) => Math.round(gapMs)),
      }),
    );
  });
});
