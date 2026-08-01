import { createSampleDocument, type Block } from "@flock/email-sdk";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { MOCK_MODEL_ID } from "./constants";
import { createMockChatModel } from "./mock-model";
import { runChatPipeline } from "./pipeline";

/**
 * Generative-UI widget tools through the REAL pipeline (streamText → widget
 * execute → `data-*` part writes), driven by the scripted mock:
 *
 * - proposeSectionVariations / proposeEdits execute server-side, write ONE
 *   widget data part (id = toolCallId), and return a compact model-facing
 *   summary — the full payload never rides the model loop.
 * - askForClarification has NO execute: the turn ends on the validated call
 *   (no output chunk, no data part) so the widget can wait for the answer.
 * - listAssets without a session resolves to an empty library: a clean tool
 *   output for the model, and no table part (nothing to draw).
 */

interface PipelineProbeResult {
  /** Every part the pipeline wrote directly (widget data parts, errors). */
  writtenParts: { type: string; id?: string; data?: unknown }[];
  /** Every chunk on the merged UI-message stream. */
  streamedChunks: { type: string; [key: string]: unknown }[];
}

async function runPipelineProbe(lastUserText: string): Promise<PipelineProbeResult> {
  const writtenParts: PipelineProbeResult["writtenParts"] = [];
  let mergedStream: ReadableStream<unknown> | null = null;

  const writer = {
    write: (part: { type: string; id?: string; data?: unknown }) => {
      writtenParts.push(part);
    },
    merge: (stream: ReadableStream<unknown>) => {
      mergedStream = stream;
    },
    onError: undefined,
  } as unknown as UIMessageStreamWriter<FlockChatMessage>;

  const messages: FlockChatMessage[] = [
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
  const streamedChunks: PipelineProbeResult["streamedChunks"] = [];
  const reader = (mergedStream as unknown as ReadableStream<unknown>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    streamedChunks.push(value as PipelineProbeResult["streamedChunks"][number]);
  }
  return { writtenParts, streamedChunks };
}

function getChunkTypes(result: PipelineProbeResult): string[] {
  return result.streamedChunks.map((chunk) => chunk.type);
}

function getToolOutputs(result: PipelineProbeResult): unknown[] {
  return result.streamedChunks
    .filter((chunk) => chunk.type === "tool-output-available")
    .map((chunk) => chunk.output);
}

describe("generative-UI widget tools through the chat pipeline", () => {
  it("proposeSectionVariations writes ONE picker data part and a compact model summary", async () => {
    const result = await runPipelineProbe("Show me a few variations of this section");

    const variationParts = result.writtenParts.filter(
      (part) => part.type === "data-section-variations",
    );
    expect(variationParts).toHaveLength(1);
    const data = variationParts[0]!.data as {
      toolCallId: string;
      intent?: string;
      variations: { id: string; title: string; templateId: string; blocks: Block[] }[];
    };
    // Reconciliation contract: the data part's stream id IS the toolCallId.
    expect(variationParts[0]!.id).toBe(data.toolCallId);
    expect(data.variations).toHaveLength(3);
    for (const variation of data.variations) {
      expect(variation.blocks[0]!.type).toBe("section");
      expect(variation.blocks.length).toBeGreaterThan(1);
    }
    expect(data.variations.map((variation) => variation.id)).toEqual(["v1", "v2", "v3"]);

    // Model loop stays compact: a presented summary, never the block payload.
    expect(getToolOutputs(result)).toContainEqual(
      expect.objectContaining({ status: "presented", variationCount: 3 }),
    );
    expect(getChunkTypes(result)).toContain("finish");
  });

  it("proposeEdits dry-runs against the request document and writes Apply cards", async () => {
    const result = await runPipelineProbe("How can I improve this email?");

    const suggestionParts = result.writtenParts.filter(
      (part) => part.type === "data-edit-suggestions",
    );
    expect(suggestionParts).toHaveLength(1);
    const data = suggestionParts[0]!.data as {
      toolCallId: string;
      suggestions: { id: string; title: string; ops: { name: string }[] }[];
      droppedCount: number;
    };
    expect(suggestionParts[0]!.id).toBe(data.toolCallId);
    expect(data.suggestions).toHaveLength(2);
    expect(data.droppedCount).toBe(0);
    for (const suggestion of data.suggestions) {
      expect(suggestion.ops.every((op) => op.name === "updateBlockProperties")).toBe(true);
    }

    expect(getToolOutputs(result)).toContainEqual(
      expect.objectContaining({ status: "presented", suggestionCount: 2, droppedCount: 0 }),
    );
  });

  it("askForClarification ends the turn on the validated call — no execute, no data part", async () => {
    const result = await runPipelineProbe("Can you make it pop?");

    expect(result.writtenParts.filter((part) => part.type.startsWith("data-"))).toEqual([]);
    const chunkTypes = getChunkTypes(result);
    expect(chunkTypes).toContain("tool-input-available");
    expect(chunkTypes).not.toContain("tool-output-available");
    expect(chunkTypes).not.toContain("tool-output-error");
    expect(chunkTypes).toContain("finish");
  });

  it("listAssets without a session reports an empty library and draws no table", async () => {
    const result = await runPipelineProbe("What images do I have?");

    expect(result.writtenParts.filter((part) => part.type === "data-table")).toEqual([]);
    expect(getToolOutputs(result)).toContainEqual(
      expect.objectContaining({ isFound: true, data: { assets: [], totalCount: 0 } }),
    );
  });
});
