import {
  applyOperations,
  buildComposedDrafts,
  createEmptyDocument,
  createStarterDocument,
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
 * These tests run the REAL pipeline (streamText → editor dispatch →
 * data-editor-command) and then the REAL client-side build (the SDK
 * translation the drafts executor runs), so what they assert is what lands in
 * the new draft.
 */

interface ProbeResult {
  writtenParts: { type: string; data?: unknown }[];
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

  const toolOutputs: unknown[] = [];
  const reader = (mergedStream as unknown as ReadableStream<unknown>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value as { type: string; output?: unknown };
    if (chunk.type === "tool-output-available") {
      toolOutputs.push(chunk.output);
    }
  }
  return { writtenParts, toolOutputs };
}

function getCreateDraftCommand(result: ProbeResult): CreateDraftCommand {
  const commands = result.writtenParts
    .filter((part) => part.type === "data-editor-command")
    .map((part) => (part.data as { command: CreateDraftCommand }).command);
  expect(commands).toHaveLength(1);
  expect(commands[0]!.type).toBe("createDraft");
  return commands[0]!;
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

  it("reports a compact result to the model instead of echoing the whole plan", async () => {
    const result = await runPipelineProbe({
      lastUserText: "Create a new draft about our spring sale",
      doc: createSourceDraft(),
    });
    const output = result.toolOutputs.at(-1) as {
      status: string;
      command: CreateDraftCommand;
      note?: string;
    };
    expect(output.status).toBe("dispatched");
    expect(output.command.drafts).toBeUndefined();
    expect(output.note).toContain("Created 1 new draft");
    expect(output.note).toContain("current draft is untouched");
  });
});
