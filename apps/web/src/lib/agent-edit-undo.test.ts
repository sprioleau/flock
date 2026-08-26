// @vitest-environment edge-runtime
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import { emailDocumentSchema } from "@flock/email-sdk";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { buildDispatchContext } from "./editor-store";

/*
  THE PROOF that an agent's edit lands on the user's undo stack.

  The owner's report: "make the text green" → the agent applied
  updateDocumentSettings → "undo" → the agent said it undid the change and the
  text stayed green. The inverse in the SDK was never the problem; the op row
  was invisible to `history.undo`, because undo is scoped per author and the
  chat panel writes agent ops under the CHAT's id while both the toolbar
  button and the agent's own undo tool ask `history.undo` for the BROWSER
  SESSION's id. The two ids never match, undo answered "nothing_to_undo", and
  nothing was applied.

  So these tests drive the real Convex functions in convex-test's in-memory
  backend — real applyOperations, real canUndoRedo, real history.undo — with
  the exact provenance the chat panel builds, and re-READ the stored document
  rather than trusting a return value. A history mutation that returns isOk
  while the document is unchanged is precisely the failure being fixed.
*/
const modules = import.meta.glob([
  "../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

function createBackend() {
  const backend = convexTest(schema, modules);
  registerProsemirrorSync(backend);
  return backend;
}

type Backend = ReturnType<typeof createBackend>;

/** The browser's localStorage UUID — `authorId` for every history call. */
const BROWSER_SESSION_ID = "3f6b1c94-51a7-4a2e-9c3d-8b0e2f7a4d15";
/** The AI SDK `Chat` instance id the chat panel stamps on agent ops. */
const CHAT_ID = "chat_7c1d";
const GREEN = "#16a34a";

/**
 * Exactly the provenance `use-flock-chat.ts` hands `store.dispatch` for a
 * content tool call, run through the store's own context builder — so this
 * test breaks if the chat panel's ops ever stop being owned by the session
 * that prompted them.
 */
const AGENT_TURN_CONTEXT = buildDispatchContext({
  sessionAuthorId: BROWSER_SESSION_ID,
  provenance: {
    caller: "tool",
    author: "agent",
    authorId: CHAT_ID,
    batchId: "batch_9f2a",
    threadId: CHAT_ID,
  },
});

async function seedDocument(t: Backend) {
  const { documentId } = await t.mutation(api.documents.createDocument, {
    sessionId: BROWSER_SESSION_ID,
    shouldSeedSample: true,
  });
  return documentId;
}

/** `root.properties.globals.paragraphTextColor` as the backend currently stores it. */
async function readParagraphColor({
  t,
  documentId,
}: {
  t: Backend;
  documentId: Id<"documents">;
}): Promise<string | undefined> {
  const payload = await t.query(api.documents.getDocument, { documentId });
  expect(payload).not.toBeNull();
  const doc = emailDocumentSchema.parse(payload!.doc);
  const root = doc.root;
  if (root === undefined || root.type !== "root") {
    throw new Error("The seeded document has no root block.");
  }
  return root.properties.globals?.paragraphTextColor;
}

async function makeTheTextGreen(t: Backend, documentId: Id<"documents">) {
  const result = await t.mutation(api.documents.applyOperations, {
    documentId,
    ops: [{ name: "updateDocumentSettings", globals: { paragraphTextColor: GREEN } }],
    context: AGENT_TURN_CONTEXT,
  });
  expect(result.isOk).toBe(true);
  return result;
}

describe("an agent edit is on the prompting session's undo stack", () => {
  it("undoes an agent updateDocumentSettings — the document, not just the return value", async () => {
    const t = createBackend();
    const documentId = await seedDocument(t);
    const colorBefore = await readParagraphColor({ t, documentId });

    await makeTheTextGreen(t, documentId);
    expect(await readParagraphColor({ t, documentId })).toBe(GREEN);

    const undone = await t.mutation(api.history.undo, {
      documentId,
      authorId: BROWSER_SESSION_ID,
    });
    expect(undone.isOk).toBe(true);
    /*
      The reported bug in one assertion: before the fix undo returned
      "nothing_to_undo" and the paragraphs stayed green.
    */
    expect(await readParagraphColor({ t, documentId })).toBe(colorBefore);
  });

  it("re-greens on redo, so the agent edit is a full history step and not a one-way erase", async () => {
    const t = createBackend();
    const documentId = await seedDocument(t);

    await makeTheTextGreen(t, documentId);
    await t.mutation(api.history.undo, { documentId, authorId: BROWSER_SESSION_ID });

    const redone = await t.mutation(api.history.redo, {
      documentId,
      authorId: BROWSER_SESSION_ID,
    });
    expect(redone.isOk).toBe(true);
    expect(await readParagraphColor({ t, documentId })).toBe(GREEN);
  });

  it("lights the toolbar's Undo button for the session that prompted the agent", async () => {
    const t = createBackend();
    const documentId = await seedDocument(t);
    expect(
      await t.query(api.history.canUndoRedo, { documentId, authorId: BROWSER_SESSION_ID }),
    ).toEqual({ canUndo: false, canRedo: false });

    await makeTheTextGreen(t, documentId);

    /*
      The agent's `undo` tool and the toolbar button run the same mutation, so
      an enabled button and a working prompt are the same guarantee. A
      disabled button after the agent edits is the same defect wearing a
      different hat.
    */
    expect(
      await t.query(api.history.canUndoRedo, { documentId, authorId: BROWSER_SESSION_ID }),
    ).toEqual({ canUndo: true, canRedo: false });
  });

  it("still refuses to undo another browser session's agent edit", async () => {
    const t = createBackend();
    const documentId = await seedDocument(t);
    await makeTheTextGreen(t, documentId);

    /*
      Ownership widened to "the session that prompted the turn", NOT to
      everyone. A collaborator in another browser must not be able to step
      through this session's history.
    */
    const otherSession = await t.mutation(api.history.undo, {
      documentId,
      authorId: "8d2e5b60-9f14-4c7a-b1d3-6e0a5c92f847",
    });
    expect(otherSession).toEqual({ isOk: false, reason: "nothing_to_undo" });
  });
});
