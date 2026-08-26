import { createSampleDocument } from "@flock/email-sdk";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { MOCK_MODEL_ID } from "./constants";
import { createMockChatModel } from "./mock-model";
import { runChatPipeline } from "./pipeline";

/**
 * Agent-parity UI actions through the REAL pipeline (streamText → editor
 * dispatch → data-editor-command writes), driven by the scripted mock:
 *
 * - openPanel / undo / redo / createDraft execute server-side and write one
 *   typed `data-editor-command` part for the client dispatcher.
 * - goToVersion is approval-gated: the turn halts with a tool-approval
 *   request and NO command is written until the human approves.
 *
 * (createPersona's executor needs a Convex deployment, so its dispatch is
 * covered by the SDK builtins tests + browser verification instead.)
 */

interface PipelineProbeResult {
  /** Every part the pipeline wrote directly (data-editor-command, errors). */
  writtenParts: { type: string; data?: unknown }[];
  /** Every chunk type on the merged UI-message stream. */
  streamedChunkTypes: string[];
}

async function runPipelineProbe(lastUserText: string): Promise<PipelineProbeResult> {
  const writtenParts: { type: string; data?: unknown }[] = [];
  let mergedStream: ReadableStream<unknown> | null = null;

  const writer = {
    write: (part: { type: string; data?: unknown }) => {
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
    traceId: "test-trace",
    writer,
  });

  expect(mergedStream).not.toBeNull();
  const streamedChunkTypes: string[] = [];
  const reader = (mergedStream as unknown as ReadableStream<unknown>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    streamedChunkTypes.push((value as { type: string }).type);
  }
  return { writtenParts, streamedChunkTypes };
}

function getEditorCommands(result: PipelineProbeResult): unknown[] {
  return result.writtenParts
    .filter((part) => part.type === "data-editor-command")
    .map((part) => (part.data as { command: unknown }).command);
}

describe("agent-parity UI actions through the chat pipeline", () => {
  it("openPanel executes server-side and streams the typed command", async () => {
    const result = await runPipelineProbe("Please open the theme picker.");
    expect(getEditorCommands(result)).toEqual([{ type: "openPanel", panel: "theme" }]);
    expect(result.streamedChunkTypes).toContain("tool-output-available");
  });

  it("maps each panel keyword script to its enum value", async () => {
    const casesByText: Record<string, string> = {
      "Open the brand kit": "brand-kit",
      "Open my library": "library",
      "Open the version history": "history",
      "Show me the recommendations": "recommendations",
      "Open the properties tab": "properties",
    };
    for (const [text, panel] of Object.entries(casesByText)) {
      const result = await runPipelineProbe(text);
      expect(getEditorCommands(result)).toEqual([{ type: "openPanel", panel }]);
    }
  });

  /*
    THE HONESTY PROPERTY, at the seam where the lie was written.

    undo/redo are CLIENT-RESULT editor actions: the server advertises them and
    streams the call, and that is all it is entitled to do, because only the
    browser knows whether a history step existed to take. So the server must
    produce NO verdict — no `data-editor-command` part asserting the step
    happened, and no successful tool output closing the call. Before this
    change the server wrote both, unconditionally, which is exactly how the
    agent came to say "I've undone that change for you" over an unchanged
    draft.
  */
  it("never answers for an undo or redo the server did not perform", async () => {
    const undone = await runPipelineProbe("Undo that last change please");
    expect(getEditorCommands(undone)).toEqual([]);
    expect(undone.streamedChunkTypes).toContain("tool-input-available");
    expect(undone.streamedChunkTypes).not.toContain("tool-output-available");
    /* Silence is not a hang: the turn still ends, awaiting the client's report. */
    expect(undone.streamedChunkTypes).toContain("finish");

    const redone = await runPipelineProbe("Actually, redo it");
    expect(getEditorCommands(redone)).toEqual([]);
    expect(redone.streamedChunkTypes).toContain("tool-input-available");
    expect(redone.streamedChunkTypes).not.toContain("tool-output-available");
  });

  it("goToVersion halts for approval — no command until the human approves", async () => {
    const result = await runPipelineProbe("Roll back to version 3");
    expect(getEditorCommands(result)).toEqual([]);
    expect(result.streamedChunkTypes).toContain("tool-approval-request");
  });

  it("createDraft resolves its count and streams the command", async () => {
    const single = await runPipelineProbe("Create a new blank draft");
    expect(getEditorCommands(single)).toEqual([
      { type: "createDraft", count: 1, shouldInheritTheme: true },
    ]);

    const several = await runPipelineProbe("Create 3 new blank drafts to compare");
    expect(getEditorCommands(several)).toEqual([
      { type: "createDraft", count: 3, shouldInheritTheme: true },
    ]);
  });

  it("createPersona without a Convex deployment fails the tool call, not the turn", async () => {
    const result = await runPipelineProbe('Create a persona called "Tone Checker"');
    // The executor refused (no session/deployment in tests) → tool error
    // round-trips to the model; no command part is written and the turn
    // still finishes (the mock's continuation step closes it).
    expect(getEditorCommands(result)).toEqual([]);
    expect(result.streamedChunkTypes).toContain("tool-output-error");
    expect(result.streamedChunkTypes).toContain("finish");
  });
});
