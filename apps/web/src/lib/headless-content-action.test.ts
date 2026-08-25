// @vitest-environment edge-runtime
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import {
  createTextDoc,
  emailDocumentSchema,
  type ActionContext,
  type TextDoc,
} from "@flock/email-sdk";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { runStoredContentAction, type StoredDocumentBackend } from "@/lib/headless-content-action";

/*
  THE PROOF that a content action can run with no browser in the loop.

  Every assertion below is against the REAL Convex functions in convex-test's
  in-memory backend — real createDocument, real applyOperations, real
  history.undo. Nothing about the write path is mocked, because the claim
  being tested is precisely that the write path accepts a caller it has never
  had: `documents.applyOperations` has accepted `caller: "cli" | "mcp" |
  "http"` in its validator since it was written, and until this module nothing
  ever sent one.

  What makes these load-bearing rather than decorative: a headless write that
  "returns ok" while leaving the stored document, the op log, or the history
  spine wrong is worse than no headless write at all — it is a silent
  corruption path with no editor open to notice. So each test re-READS from
  the backend instead of trusting a return value, and the invertibility test
  drives the real undo/redo mutations rather than inspecting the inverse.

  NOTE: convex-test's documented `!(*.*.*)` extglob matches nothing under
  vitest 4 (tinyglobby has no extglob support) — the array form with negative
  patterns is the equivalent that works.
*/
const modules = import.meta.glob([
  "../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

/**
 * The prosemirror-sync component has to be registered or every headless text
 * write dies with "Component prosemirrorSync is not registered".
 *
 * That is not harness noise — it is the routing decision showing up in the
 * test. `documents.applyOperations` sets `shouldForceTextSyncDocs` for any
 * non-frontend caller, so a `caller: "cli"` updateText reaches into the
 * component to force the block's live ProseMirror doc to match what was just
 * committed. A headless text write is therefore never purely a row write, and
 * anything that hosts this path needs the component wired up.
 */
function createBackend() {
  const backend = convexTest(schema, modules);
  registerProsemirrorSync(backend);
  return backend;
}

/*
  `ReturnType<typeof convexTest>` drops the schema generic — ctx.db falls back
  to system tables and every withIndex breaks at typecheck while the tests
  still pass. Deriving the type from the factory keeps the generic.
*/
type Backend = ReturnType<typeof createBackend>;

/** A pre-auth browser's localStorage UUID — what `documents.sessionId` holds. */
const BROWSER_SESSION_ID = "9a41b7d0-6c22-4f18-b3e5-1d8a7c04e2b6";

/**
 * The provenance a headless caller asserts. `caller: "cli"` because that is
 * what this module is: server-side code with no request and no editor, which
 * is also the case `commitVersions` names when it decides to force the
 * committed text back into the block's sync doc.
 *
 * `authorId` is self-asserted here exactly as it is in production — the
 * module's doc comment says so, and this test does not pretend otherwise. It
 * is asserted below only to prove the value the caller supplied is the value
 * the op row carries.
 */
const CLI_CONTEXT: ActionContext = {
  caller: "cli",
  author: "user",
  authorId: "headless-operator-7f3c",
};

function createStoredDocumentBackend(t: Backend): StoredDocumentBackend {
  return {
    getDocument: (args) => t.query(api.documents.getDocument, args),
    applyOperations: (args) => t.mutation(api.documents.applyOperations, args),
  };
}

/** The stored text of one block, read back through the real query. */
async function readStoredText({
  t,
  documentId,
  blockId,
}: {
  t: Backend;
  documentId: Id<"documents">;
  blockId: string;
}) {
  const payload = await t.query(api.documents.getDocument, { documentId });
  expect(payload).not.toBeNull();
  const doc = emailDocumentSchema.parse(payload!.doc);
  const block = doc[blockId];
  if (block === undefined || block.type !== "text") {
    throw new Error(`Block ${blockId} is not a text block.`);
  }
  return { text: block.properties.text, headVersion: payload!.headVersion };
}

/**
 * A seeded draft plus the first text block in it. The sample document is the
 * deterministic every-block-type fixture, so "the first text block" is a
 * stable target without hard-coding an id the fixture is free to change.
 */
async function seedDocumentWithTextBlock(t: Backend) {
  const { documentId } = await t.mutation(api.documents.createDocument, {
    sessionId: BROWSER_SESSION_ID,
    shouldSeedSample: true,
  });
  const payload = await t.query(api.documents.getDocument, { documentId });
  const doc = emailDocumentSchema.parse(payload!.doc);
  const textEntry = Object.entries(doc).find(([, block]) => block.type === "text");
  if (textEntry === undefined) {
    throw new Error("The sample document seeded no text block.");
  }
  const [blockId, block] = textEntry;
  if (block.type !== "text") {
    throw new Error("Unreachable: the entry was selected by type.");
  }
  return { documentId, blockId, originalText: block.properties.text };
}

/** The updateText payload a headless caller sends: whole-doc replacement. */
function buildUpdateTextInput(blockId: string, text: TextDoc) {
  return { name: "updateText", blockId, text };
}

const HEADLESS_TEXT = createTextDoc("Rewritten by a caller that never opened the editor.");

describe("runStoredContentAction — updateText without a browser", () => {
  it("changes the STORED document, not just its return value", async () => {
    const t = createBackend();
    const { documentId, blockId, originalText } = await seedDocumentWithTextBlock(t);

    const result = await runStoredContentAction({
      backend: createStoredDocumentBackend(t),
      documentId,
      name: "updateText",
      input: buildUpdateTextInput(blockId, HEADLESS_TEXT),
      context: CLI_CONTEXT,
    });

    expect(result.isOk).toBe(true);
    /*
      The point of the whole slice: go back to the backend and look. A
      returned `isOk` proves the dispatcher ran; only a re-read proves the
      document moved.
    */
    const stored = await readStoredText({ t, documentId, blockId });
    expect(stored.text).toEqual(HEADLESS_TEXT);
    expect(stored.text).not.toEqual(originalText);
  });

  it("records ONE op row carrying the headless caller's provenance", async () => {
    const t = createBackend();
    const { documentId, blockId } = await seedDocumentWithTextBlock(t);
    const before = await readStoredText({ t, documentId, blockId });

    await runStoredContentAction({
      backend: createStoredDocumentBackend(t),
      documentId,
      name: "updateText",
      input: buildUpdateTextInput(blockId, HEADLESS_TEXT),
      context: CLI_CONTEXT,
    });

    const { operations } = await t.query(api.documents.getOperations, {
      documentId,
      sinceVersion: before.headVersion,
    });
    expect(operations).toHaveLength(1);
    const entry = operations[0]!;
    /*
      Provenance is the reason the op log exists. If a headless write landed
      as `caller: "frontend"` or with a borrowed authorId, the history panel
      and per-author undo would both attribute it to a person who was not
      there — and per-author undo would then let that person undo it.
    */
    expect(entry.caller).toBe("cli");
    expect(entry.author).toBe("user");
    expect(entry.authorId).toBe(CLI_CONTEXT.authorId);
    expect(entry.kind).toBe("edit");
    expect(entry.op.name).toBe("updateText");
    expect(entry.op.blockId).toBe(blockId);
  });

  it("writes an INVERTIBLE op — real undo restores the text, real redo reapplies it", async () => {
    const t = createBackend();
    const { documentId, blockId, originalText } = await seedDocumentWithTextBlock(t);

    await runStoredContentAction({
      backend: createStoredDocumentBackend(t),
      documentId,
      name: "updateText",
      input: buildUpdateTextInput(blockId, HEADLESS_TEXT),
      context: CLI_CONTEXT,
    });

    /*
      Driving the real history mutations rather than inspecting the recorded
      inverse is the whole value of this test, because the inverse that
      matters is not the one this module computed. `dispatchContentAction`
      returns an inverse against the document it was HANDED; the one that ends
      up on the spine is recomputed by commitVersions against the authoritative
      document and, for updateText specifically, re-anchored to the op-log text
      (withOpLogTextInverses). Only exercising undo — and then redo, since a
      spine that cannot go forward again is equally broken — shows the headless
      write left the history usable in both directions.
    */
    const undone = await t.mutation(api.history.undo, {
      documentId,
      authorId: CLI_CONTEXT.authorId,
    });
    expect(undone.isOk).toBe(true);
    const afterUndo = await readStoredText({ t, documentId, blockId });
    expect(afterUndo.text).toEqual(originalText);

    const redone = await t.mutation(api.history.redo, {
      documentId,
      authorId: CLI_CONTEXT.authorId,
    });
    expect(redone.isOk).toBe(true);
    const afterRedo = await readStoredText({ t, documentId, blockId });
    expect(afterRedo.text).toEqual(HEADLESS_TEXT);
  });
});

describe("runStoredContentAction — failures are structured, never thrown", () => {
  it("refuses a name that is not a content action, and writes nothing", async () => {
    const t = createBackend();
    const { documentId, blockId } = await seedDocumentWithTextBlock(t);
    const before = await readStoredText({ t, documentId, blockId });

    /*
      `showPreview` is a real registered action of kind "editor" — it produces
      a client command, not a document change. A headless caller has no client
      to send it to, so the dispatcher's kind check is the guard, and it is
      terminal: no repair round can turn an editor action into a content one.
    */
    const result = await runStoredContentAction({
      backend: createStoredDocumentBackend(t),
      documentId,
      name: "showPreview",
      input: { mode: "mobile" },
      context: CLI_CONTEXT,
    });

    expect(result.isOk).toBe(false);
    if (result.isOk) {
      throw new Error("Unreachable: the assertion above already failed.");
    }
    expect(result.stage).toBe("dispatch");
    expect(result.failureKind).toBe("terminal");
    expect(result.errors.map((error) => error.code)).toEqual(["wrong_action_kind"]);

    const after = await readStoredText({ t, documentId, blockId });
    expect(after.headVersion).toBe(before.headVersion);
  });

  it("refuses an input that fails the action's full schema, and writes nothing", async () => {
    const t = createBackend();
    const { documentId, blockId } = await seedDocumentWithTextBlock(t);
    const before = await readStoredText({ t, documentId, blockId });

    /*
      An empty `content` array — textDocSchema requires at least one node. The
      model-facing schema is the compact one; this is the FULL schema catching
      it, which is what the dispatcher exists to guarantee on every surface.
    */
    const result = await runStoredContentAction({
      backend: createStoredDocumentBackend(t),
      documentId,
      name: "updateText",
      input: { name: "updateText", blockId, text: { type: "doc", content: [] } },
      context: CLI_CONTEXT,
    });

    expect(result.isOk).toBe(false);
    if (result.isOk) {
      throw new Error("Unreachable: the assertion above already failed.");
    }
    expect(result.stage).toBe("dispatch");
    expect(result.failureKind).toBe("retryable");
    expect(result.errors.map((error) => error.code)).toEqual(["op_validation_failed"]);

    const after = await readStoredText({ t, documentId, blockId });
    expect(after.headVersion).toBe(before.headVersion);
  });

  it("surfaces a server-side rejection when the document moved between the read and the write", async () => {
    const t = createBackend();
    const { documentId, blockId } = await seedDocumentWithTextBlock(t);
    const realBackend = createStoredDocumentBackend(t);

    /*
      The read is a query and the write is a separate mutation, so the
      document this module dispatches against is a SNAPSHOT, not a
      transaction. This backend makes that window real rather than theoretical
      by deleting the target block — through the same real applyOperations —
      after the read returns. The local dispatch then succeeds against a
      document that no longer exists, and the server is the one that says no.

      That is the correct division of labour, and it is worth pinning: the
      module must not treat its own successful dispatch as authority, and the
      server's refusal must arrive as a structured failure a headless caller
      can act on.
    */
    const racingBackend: StoredDocumentBackend = {
      getDocument: async (args) => {
        const payload = await realBackend.getDocument(args);
        await realBackend.applyOperations({
          documentId,
          ops: [{ name: "removeBlock", blockId, shouldRemoveEmptyAncestors: true }],
          context: { caller: "frontend", author: "user", authorId: BROWSER_SESSION_ID },
        });
        return payload;
      },
      applyOperations: realBackend.applyOperations,
    };

    const result = await runStoredContentAction({
      backend: racingBackend,
      documentId,
      name: "updateText",
      input: buildUpdateTextInput(blockId, HEADLESS_TEXT),
      context: CLI_CONTEXT,
    });

    expect(result.isOk).toBe(false);
    if (result.isOk) {
      throw new Error("Unreachable: the assertion above already failed.");
    }
    expect(result.stage).toBe("persist");
    expect(result.failureKind).toBe("retryable");
    expect(result.errors.map((error) => error.code)).toEqual(["target_not_found"]);
  });
});
