import {
  applyOperations,
  buildComposedDrafts,
  createEmptyDocument,
  createStarterDocument,
  dispatchEditorAction,
  emailActionRegistry,
  ROOT_BLOCK_ID,
  type CreateDraftCommand,
  type EmailDocument,
} from "@flock/email-sdk";
import type { UIMessageStreamWriter } from "ai";
import { describe, expect, it } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { MOCK_MODEL_ID } from "./constants";
import { createMockChatModel } from "./mock-model";
import { runChatPipeline } from "./pipeline";

/**
 * "Make me a new draft about X" — end to end, on the deterministic mock model.
 *
 * THE BUG THIS PINS. `createDraft` used to take one argument, `count`. A
 * request carrying content ("a draft about our spring sale", "three ideas for
 * the launch email") reached the client as `{ count: 1 }` with the subject
 * matter thrown away, and every new draft opened on the same generic starter
 * email. Because content actions only ever apply to the draft the turn is
 * pinned to, there was NO way to express "a new draft about X" — so the only
 * way to produce content about X was to rewrite the draft on screen, which is
 * exactly what users saw happen to their work.
 *
 * These tests run the REAL pipeline (streamText → the streamed tool call) and
 * then the REAL client-side path (`dispatchEditorAction` on the call's input,
 * then the SDK translation the drafts executor runs), so what they assert is
 * what lands in the new draft.
 *
 * THE ROUTE THEY TAKE IS ITSELF LOAD-BEARING. `createDraft` is a CLIENT-RESULT
 * editor action: the drafts are built in the browser, so the server streams
 * the call and writes nothing else — no `data-editor-command` verdict and no
 * tool output. The plan therefore reaches the drafts machinery only as the
 * tool call's INPUT. Reading it from anywhere else would be reading something
 * the browser never sees.
 */

interface StreamedToolCall {
  toolName: string;
  input: unknown;
}

interface ProbeResult {
  writtenParts: { type: string; data?: unknown }[];
  streamedChunkTypes: string[];
  toolCalls: StreamedToolCall[];
  toolOutputs: unknown[];
}

async function runPipelineProbe({
  lastUserText,
  doc,
}: {
  lastUserText: string;
  doc: EmailDocument;
}): Promise<ProbeResult> {
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

  await runChatPipeline({
    model: createMockChatModel({ lastUserText }),
    modelId: MOCK_MODEL_ID,
    isUsingMockModel: true,
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: lastUserText }] }],
    doc,
    sessionId: null,
    traceId: "test-trace",
    writer,
  });

  const streamedChunkTypes: string[] = [];
  const toolCalls: StreamedToolCall[] = [];
  const toolOutputs: unknown[] = [];
  const reader = (mergedStream as unknown as ReadableStream<unknown>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value as { type: string; toolName?: string; input?: unknown; output?: unknown };
    streamedChunkTypes.push(chunk.type);
    if (chunk.type === "tool-input-available") {
      toolCalls.push({ toolName: chunk.toolName ?? "", input: chunk.input });
    }
    if (chunk.type === "tool-output-available") {
      toolOutputs.push(chunk.output);
    }
  }
  return { writtenParts, streamedChunkTypes, toolCalls, toolOutputs };
}

/*
  The command as the BROWSER derives it: the streamed call's input, put back
  through the SDK dispatcher exactly as `runClientResultEditorTool` does — same
  registry, same full-schema re-validation, same authorization gate. Anything
  the server wrote instead would be a verdict on drafts it never built, so this
  also pins that it wrote nothing.
*/
function getCreateDraftCommand(result: ProbeResult): CreateDraftCommand {
  expect(result.writtenParts.filter((part) => part.type === "data-editor-command")).toEqual([]);
  const calls = result.toolCalls.filter((call) => call.toolName === "createDraft");
  expect(calls).toHaveLength(1);
  const dispatched = dispatchEditorAction({
    registry: emailActionRegistry,
    name: "createDraft",
    input: calls[0]!.input,
    context: {
      caller: "tool",
      author: "agent",
      authorId: "chat-test",
      batchId: "batch-test",
      threadId: "chat-test",
    },
  });
  if (!dispatched.isOk) {
    throw new Error(`createDraft did not dispatch: ${JSON.stringify(dispatched.errors)}`);
  }
  const { command } = dispatched;
  if (command.type !== "createDraft") {
    throw new Error(`expected a createDraft command, got "${command.type}"`);
  }
  return command;
}

/** Build the new drafts exactly as the client executor does. */
function buildDraftDocuments({
  command,
  sourceDoc,
}: {
  command: CreateDraftCommand;
  sourceDoc: EmailDocument;
}): { name?: string; doc: EmailDocument }[] {
  return buildComposedDrafts({ sourceDoc, command }).map((composed) => {
    const applied = applyOperations(createEmptyDocument(), composed.ops);
    expect(applied.isOk).toBe(true);
    if (!applied.isOk) {
      throw new Error("composed draft ops did not apply");
    }
    return { ...(composed.name === undefined ? {} : { name: composed.name }), doc: applied.doc };
  });
}

function getPlainText(doc: EmailDocument): string {
  const collect = (node: unknown): string => {
    if (typeof node !== "object" || node === null) return "";
    const candidate = node as { text?: unknown; content?: unknown };
    if (typeof candidate.text === "string") return candidate.text;
    if (Array.isArray(candidate.content)) return candidate.content.map(collect).join(" ");
    return "";
  };
  return Object.values(doc)
    .map((block) => {
      const properties = block.properties as Record<string, unknown>;
      if (block.type === "text") return collect(properties.text);
      if (block.type === "button") return String(properties.label ?? "");
      if (block.type === "image") return String(properties.alt ?? "");
      return "";
    })
    .join(" ");
}

/** The user's draft: a themed spring-sale email with its own voice. */
function createSourceDraft(): EmailDocument {
  const doc = createStarterDocument();
  doc[ROOT_BLOCK_ID] = {
    ...doc[ROOT_BLOCK_ID]!,
    properties: { globals: { emailBackgroundColor: "#0f172a", contentWidth: 600 } },
  } as EmailDocument[string];
  doc.img_lg01 = {
    ...doc.img_lg01!,
    properties: { ...doc.img_lg01!.properties, alt: "Petal Studio logo" },
  } as EmailDocument[string];
  doc.btn_ct01 = {
    ...doc.btn_ct01!,
    properties: {
      ...doc.btn_ct01!.properties,
      label: "Shop the spring drop",
      href: "https://petal.example/spring",
    },
  } as EmailDocument[string];
  return doc;
}

describe("a new draft with content, through the chat pipeline", () => {
  it("carries the request's subject matter instead of discarding it", async () => {
    const sourceDoc = createSourceDraft();
    const result = await runPipelineProbe({
      lastUserText: "Create a new draft about our spring sale",
      doc: sourceDoc,
    });
    const command = getCreateDraftCommand(result);
    // Before the fix this command was exactly { type, count: 1 } — the words
    // "about our spring sale" had nowhere to go.
    expect(command.count).toBe(1);
    expect(command.drafts).toHaveLength(1);
    expect(getPlainText(buildDraftDocuments({ command, sourceDoc })[0]!.doc)).toContain(
      "spring sale",
    );
  });

  it("makes a complete, ready-to-send email: header, body, footer", async () => {
    const sourceDoc = createSourceDraft();
    const command = getCreateDraftCommand(
      await runPipelineProbe({
        lastUserText: "Create a new draft about our spring sale",
        doc: sourceDoc,
      }),
    );
    const [draft] = buildDraftDocuments({ command, sourceDoc });
    const sectionIds = draft!.doc[ROOT_BLOCK_ID]!.childrenIds;
    expect(sectionIds.length).toBeGreaterThanOrEqual(3);
    // A header's brand logo at the top, an unsubscribe link at the bottom —
    // the two ends of an email that could actually be sent.
    const text = getPlainText(draft!.doc);
    expect(text).toContain("logo");
    expect(text.toLowerCase()).toContain("unsubscribe");
    // Every section is a real section with content in it.
    for (const sectionId of sectionIds) {
      expect(draft!.doc[sectionId]!.type).toBe("section");
      expect(draft!.doc[sectionId]!.childrenIds.length).toBeGreaterThan(0);
    }
  });

  it("keeps the theme the user already applied", async () => {
    const sourceDoc = createSourceDraft();
    const command = getCreateDraftCommand(
      await runPipelineProbe({ lastUserText: "Create a new draft", doc: sourceDoc }),
    );
    const [draft] = buildDraftDocuments({ command, sourceDoc });
    const root = draft!.doc[ROOT_BLOCK_ID]!;
    expect(root.type === "root" && root.properties.globals).toEqual({
      emailBackgroundColor: "#0f172a",
      contentWidth: 600,
    });
  });

  it("carries the current draft's brand and call to action into the new one", async () => {
    const sourceDoc = createSourceDraft();
    const command = getCreateDraftCommand(
      await runPipelineProbe({
        lastUserText: "Create a new draft about our spring sale",
        doc: sourceDoc,
      }),
    );
    const text = getPlainText(buildDraftDocuments({ command, sourceDoc })[0]!.doc);
    expect(text).toContain("Petal Studio");
    expect(text).toContain("Shop the spring drop");
    // …and not the section catalog's placeholder brand.
    expect(text).not.toContain("Acme");
  });

  it("leaves the user's current draft completely untouched", async () => {
    const sourceDoc = createSourceDraft();
    const before = JSON.stringify(sourceDoc);
    const result = await runPipelineProbe({
      lastUserText: "Create a new draft about our spring sale",
      doc: sourceDoc,
    });
    buildDraftDocuments({ command: getCreateDraftCommand(result), sourceDoc });
    expect(JSON.stringify(sourceDoc)).toBe(before);
    // The turn produced NO content ops against the current document — the old
    // failure mode was exactly a stream of them (removeBlock/addSection/…).
    const contentToolParts = result.writtenParts.filter((part) =>
      part.type.startsWith("tool-"),
    );
    expect(contentToolParts).toHaveLength(0);
  });

  it("creates several genuinely different drafts from one request", async () => {
    const sourceDoc = createSourceDraft();
    const command = getCreateDraftCommand(
      await runPipelineProbe({
        lastUserText: "Make me 3 new drafts exploring ideas for a launch email",
        doc: sourceDoc,
      }),
    );
    expect(command.count).toBe(3);
    const drafts = buildDraftDocuments({ command, sourceDoc });
    expect(drafts).toHaveLength(3);
    // Different shapes…
    const shapes = drafts.map((draft) =>
      draft.doc[ROOT_BLOCK_ID]!.childrenIds.map(
        (sectionId) =>
          `${draft.doc[sectionId]!.childrenIds.length}:${draft.doc[sectionId]!.childrenIds
            .map((childId) => draft.doc[childId]!.type)
            .join(",")}`,
      ).join(" / "),
    );
    expect(new Set(shapes).size).toBe(3);
    // …each named for its angle, and each still about the launch email.
    expect(new Set(drafts.map((draft) => draft.name)).size).toBe(3);
    for (const draft of drafts) {
      expect(getPlainText(draft.doc)).toContain("launch email");
    }
  });

  it("still creates plain starter drafts when the user asks for blank ones", async () => {
    const sourceDoc = createSourceDraft();
    const command = getCreateDraftCommand(
      await runPipelineProbe({ lastUserText: "Create 2 new blank drafts", doc: sourceDoc }),
    );
    expect(command).toEqual({ type: "createDraft", count: 2, shouldInheritTheme: true });
    // No plan → no ops; the host falls back to its starter-draft path.
    expect(buildComposedDrafts({ sourceDoc, command })).toEqual([]);
  });

  /*
    THE HONESTY PROPERTY, at the seam where the lie was written.

    The server used to answer this call itself, with a note composed from the
    PLAN it had just received — accurate about what the model MEANT to build
    and structurally incapable of being wrong about it. That is how the agent
    came to say "built directly from your website, with your portrait image
    and background included" over the section catalog's sample email.

    So the server now produces NO verdict: it streams the call and stops. The
    only thing that may answer is the browser that built the drafts, from what
    it observed (see lib/create-draft-report.ts).
  */
  it("never answers for a draft the server did not create", async () => {
    const result = await runPipelineProbe({
      lastUserText: "Create a new draft about our spring sale",
      doc: createSourceDraft(),
    });
    expect(result.streamedChunkTypes).toContain("tool-input-available");
    expect(result.streamedChunkTypes).not.toContain("tool-output-available");
    expect(result.writtenParts.filter((part) => part.type === "data-editor-command")).toEqual([]);
    expect(result.toolOutputs).toEqual([]);
    /* Silence is not a hang: the turn still ends, awaiting the browser's report. */
    expect(result.streamedChunkTypes).toContain("finish");
  });
});
