import {
  applyOperation,
  buildClearContentOperations,
  checkDocumentIntegrity,
  createSampleDocument,
  ROOT_BLOCK_ID,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import type { DispatchProvenance } from "@/lib/editor-store";
import {
  clearContent,
  createClearContentBatchId,
  CLEAR_CONTENT_BATCH_PREFIX,
  CLEAR_CONTENT_BLURB,
  CLEAR_CONTENT_BUTTON_LABEL,
  CLEAR_CONTENT_CANCEL_ACTION,
  CLEAR_CONTENT_CONFIRM_ACTION,
  CLEAR_CONTENT_CONFIRM_BODY,
  CLEAR_CONTENT_CONFIRM_TITLE,
  CLEAR_CONTENT_DONE_MESSAGE,
  CLEAR_CONTENT_FAILED_MESSAGE,
  CLEAR_CONTENT_NOTHING_MESSAGE,
  CLEAR_CONTENT_UNDO_ACTION,
  type ClearContentStore,
} from "./clear-content-client";

/*
  The clear as the editor performs it: which ops leave, under whose name, and
  what the surface is told afterwards. The SDK's own suite owns WHAT a clear
  does to each block type; this one owns the dispatch contract.
*/

interface RecordedDispatch {
  operation: Operation;
  provenance: DispatchProvenance;
}

/*
  A store stub that applies ops for real, so the recorded doc is honest.
*/
function createStoreStub(
  document: EmailDocument = createSampleDocument(),
  options: { failAt?: number } = {},
) {
  const dispatched: RecordedDispatch[] = [];
  let endCoalescingCallCount = 0;
  const store: ClearContentStore = {
    doc: document,
    authorId: "session-abc",
    dispatch: (operation, provenance) => {
      if (options.failAt === dispatched.length) {
        return { isOk: false };
      }
      dispatched.push({ operation, provenance });
      const result = applyOperation(store.doc, operation);
      if (result.isOk) {
        store.doc = result.doc;
      }
      return { isOk: result.isOk };
    },
    endCoalescing: () => {
      endCoalescingCallCount += 1;
    },
  };
  return {
    store,
    dispatched,
    getEndCoalescingCallCount: () => endCoalescingCallCount,
  };
}

describe("what the user reads", () => {
  const allCopy = [
    CLEAR_CONTENT_BUTTON_LABEL,
    CLEAR_CONTENT_BLURB,
    CLEAR_CONTENT_CONFIRM_TITLE,
    CLEAR_CONTENT_CONFIRM_BODY,
    CLEAR_CONTENT_CONFIRM_ACTION,
    CLEAR_CONTENT_CANCEL_ACTION,
    CLEAR_CONTENT_DONE_MESSAGE,
    CLEAR_CONTENT_UNDO_ACTION,
    CLEAR_CONTENT_NOTHING_MESSAGE,
    CLEAR_CONTENT_FAILED_MESSAGE,
  ];

  it("never leaks an internal operation, property or block-model name", () => {
    for (const line of allCopy) {
      for (const internalName of [
        "updateText",
        "updateBlockProperties",
        "properties",
        "blockId",
        "href",
        "src",
        "globals",
        "role",
        "batch",
        "op",
      ]) {
        expect(line.toLowerCase().split(/\W+/)).not.toContain(internalName.toLowerCase());
      }
    }
  });

  it("says what goes and what stays before anything is dispatched", () => {
    for (const goes of ["heading", "paragraph", "button", "link", "code snippet", "image"]) {
      expect(CLEAR_CONTENT_CONFIRM_BODY).toContain(goes);
    }
    for (const stays of ["layout", "colours", "logo"]) {
      expect(CLEAR_CONTENT_CONFIRM_BODY).toContain(stays);
    }
  });

  it("gives the confirmation two clearly-labelled ways out", () => {
    expect(CLEAR_CONTENT_CONFIRM_ACTION).not.toBe(CLEAR_CONTENT_CANCEL_ACTION);
    expect(CLEAR_CONTENT_CANCEL_ACTION.toLowerCase()).not.toBe("cancel");
  });
});

describe("createClearContentBatchId", () => {
  it("prefixes the batch so a clear is recognizable in the op log", () => {
    expect(createClearContentBatchId(() => "1234")).toBe(`${CLEAR_CONTENT_BATCH_PREFIX}:1234`);
  });
});

describe("clearContent", () => {
  it("dispatches the SDK's plan, in order, and reports what it did", () => {
    const { store, dispatched } = createStoreStub();
    const expected = buildClearContentOperations(createSampleDocument());
    const outcome = clearContent({ store, batchId: "clear-content:test" });

    expect(outcome).toEqual({
      kind: "cleared",
      batchId: "clear-content:test",
      operationCount: expected.length,
    });
    expect(dispatched.map((entry) => entry.operation)).toEqual(expected);
  });

  it("authors the ops as the human who clicked, under one batch id", () => {
    const { store, dispatched } = createStoreStub();
    clearContent({ store, batchId: "clear-content:test" });

    expect(dispatched.length).toBeGreaterThan(1);
    for (const entry of dispatched) {
      expect(entry.provenance).toEqual({
        caller: "frontend",
        author: "user",
        authorId: "session-abc",
        batchId: "clear-content:test",
      });
    }
  });

  it("settles the coalescing gesture before the first op and after the last", () => {
    const { store, getEndCoalescingCallCount } = createStoreStub();
    clearContent({ store, batchId: "clear-content:test" });
    expect(getEndCoalescingCallCount()).toBe(2);
  });

  it("leaves a document that still passes the integrity checker", () => {
    const { store } = createStoreStub();
    clearContent({ store, batchId: "clear-content:test" });
    expect(checkDocumentIntegrity(store.doc).isValid).toBe(true);
  });

  it("keeps the theme and the structure the dispatch path saw", () => {
    const original = createSampleDocument();
    const { store } = createStoreStub();
    clearContent({ store, batchId: "clear-content:test" });
    expect(store.doc[ROOT_BLOCK_ID]).toEqual(original[ROOT_BLOCK_ID]);
    expect(Object.keys(store.doc).sort()).toEqual(Object.keys(original).sort());
  });

  it("dispatches nothing on an already-cleared email and says so", () => {
    const { store, dispatched } = createStoreStub();
    clearContent({ store, batchId: "clear-content:first" });
    const dispatchedAfterFirst = dispatched.length;

    const outcome = clearContent({ store, batchId: "clear-content:second" });
    expect(outcome).toEqual({ kind: "nothing-to-clear" });
    expect(dispatched.length).toBe(dispatchedAfterFirst);
  });

  it("dispatches nothing for a document with no content-bearing blocks", () => {
    const structureOnly: EmailDocument = {
      root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_a1b2"], properties: {} },
      sec_a1b2: {
        id: "sec_a1b2",
        type: "section",
        parentId: "root",
        childrenIds: ["spc_a1b2"],
        properties: {},
      },
      spc_a1b2: {
        id: "spc_a1b2",
        type: "spacer",
        parentId: "sec_a1b2",
        childrenIds: [],
        properties: { height: 24 },
      },
    };
    const { store, dispatched } = createStoreStub(structureOnly);
    expect(clearContent({ store, batchId: "clear-content:test" })).toEqual({
      kind: "nothing-to-clear",
    });
    expect(dispatched).toEqual([]);
  });

  it("reports a user-facing failure when a dispatch is rejected", () => {
    const { store } = createStoreStub(createSampleDocument(), { failAt: 2 });
    expect(clearContent({ store, batchId: "clear-content:test" })).toEqual({
      kind: "failed",
      message: CLEAR_CONTENT_FAILED_MESSAGE,
    });
  });

  it("never names an internal operation or property in what the user reads", () => {
    const { store } = createStoreStub();
    const outcome = clearContent({ store, batchId: "clear-content:test" });
    const userFacingText = outcome.kind === "failed" ? outcome.message : CLEAR_CONTENT_FAILED_MESSAGE;
    for (const internalName of [
      "updateText",
      "updateBlockProperties",
      "properties",
      "blockId",
      "href",
      "src",
    ]) {
      expect(userFacingText).not.toContain(internalName);
    }
  });
});
