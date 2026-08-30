import { createStarterDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import {
  acquireEditorStore,
  buildDispatchContext,
  createEditorStore,
  getActiveEditorStore,
  peekEditorStore,
  releaseEditorStore,
  setActiveEditorStore,
  useEditorStore,
} from "./editor-store";

/*
  Drafts v2 — the per-document store factory. These tests pin the structural
  guarantees the multi-frame editing seam depends on: instance isolation
  (two stores never share document state), the refcounted per-documentId
  registry, and the active-instance delegation that keeps the historical
  `useEditorStore.getState()/.subscribe()` consumer surface working across
  instance swaps.
*/

const DOCUMENT_A = "doc_factory_a" as Id<"documents">;

describe("createEditorStore isolation", () => {
  it("keeps two instances' documents and overlays fully independent", () => {
    const storeA = createEditorStore();
    const storeB = createEditorStore();
    storeA.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 3 });
    storeB.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 7 });

    const result = storeA.getState().dispatch({
      name: "updateDocumentSettings",
      globals: { emailBackgroundColor: "#112233" },
    });
    expect(result.isOk).toBe(true);

    const readGlobals = (properties: unknown) =>
      (properties as { globals?: { emailBackgroundColor?: string } }).globals;
    const globalsA = readGlobals(storeA.getState().doc.root!.properties);
    const globalsB = readGlobals(storeB.getState().doc.root!.properties);
    expect(globalsA?.emailBackgroundColor).toBe("#112233");
    expect(globalsB?.emailBackgroundColor).toBeUndefined();
    expect(storeA.getState().pendingOps).toHaveLength(1);
    expect(storeB.getState().pendingOps).toHaveLength(0);
    expect(storeA.getState().serverHeadVersion).toBe(3);
    expect(storeB.getState().serverHeadVersion).toBe(7);
  });

  it("keeps selection and viewport per instance", () => {
    const storeA = createEditorStore();
    const storeB = createEditorStore();
    storeA.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 1 });
    storeB.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 1 });

    storeA.getState().selectBlock("root");
    storeA.getState().setViewport("mobile");
    expect(storeA.getState().selectedBlockId).toBe("root");
    expect(storeA.getState().viewport).toBe("mobile");
    expect(storeB.getState().selectedBlockId).toBeNull();
    expect(storeB.getState().viewport).toBe("desktop");
  });
});

describe("per-document registry", () => {
  it("caches one instance per documentId and refcounts holders", () => {
    const firstHold = acquireEditorStore(DOCUMENT_A);
    const secondHold = acquireEditorStore(DOCUMENT_A);
    expect(secondHold).toBe(firstHold);

    releaseEditorStore(DOCUMENT_A);
    /*
      One holder remains: still cached.
    */
    expect(peekEditorStore(DOCUMENT_A)).toBe(firstHold);

    releaseEditorStore(DOCUMENT_A);
    /*
      Last holder gone: evicted; the next acquire builds a fresh instance.
    */
    expect(peekEditorStore(DOCUMENT_A)).toBeNull();
    const freshHold = acquireEditorStore(DOCUMENT_A);
    expect(freshHold).not.toBe(firstHold);
    releaseEditorStore(DOCUMENT_A);
  });

  it("ignores a release without a matching acquire", () => {
    expect(() => releaseEditorStore("doc_never_acquired" as Id<"documents">)).not.toThrow();
  });
});

describe("active-instance delegation (the compat surface)", () => {
  it("getState follows the active instance across swaps", () => {
    const storeA = createEditorStore();
    const storeB = createEditorStore();
    storeA.getState().setViewport("mobile");
    storeB.getState().showNotice("only B has a notice");

    setActiveEditorStore(storeA);
    expect(getActiveEditorStore()).toBe(storeA);
    expect(useEditorStore.getState().viewport).toBe("mobile");
    expect(useEditorStore.getState().notice).toBeNull();

    setActiveEditorStore(storeB);
    expect(useEditorStore.getState().viewport).toBe("desktop");
    expect(useEditorStore.getState().notice).toBe("only B has a notice");
  });

  it("subscribe survives an active-instance swap", () => {
    const storeA = createEditorStore();
    const storeB = createEditorStore();
    setActiveEditorStore(storeA);

    const seenNotices: (string | null)[] = [];
    const unsubscribe = useEditorStore.subscribe((state) => {
      seenNotices.push(state.notice);
    });

    storeA.setState({ notice: "from A" });
    setActiveEditorStore(storeB);
    storeB.setState({ notice: "from B" });
    /*
      A is no longer active: its updates must not reach the subscription.
    */
    storeA.setState({ notice: "from A again" });

    expect(seenNotices).toEqual(["from A", "from B"]);
    unsubscribe();
    storeB.setState({ notice: "after unsubscribe" });
    expect(seenNotices).toEqual(["from A", "from B"]);
  });
});

describe("dispatch provenance — who owns the undo", () => {
  /*
    The owner-reported bug in its smallest form. The chat panel overrides
    `authorId` with the chat id so the History panel can say "Agent"; before
    the fix that override also decided whose undo stack the op landed on, so
    the agent's edit landed on NOBODY's and "undo" did nothing. Attribution and
    ownership are now answered separately, and this pins that they stay
    separate — every op this browser dispatches is undoable by the session
    sitting in front of it, whatever name the op wears.
  */
  it("keeps an agent-attributed op on the connected session's undo stack", () => {
    const context = buildDispatchContext({
      sessionAuthorId: "session-a1b2",
      provenance: {
        caller: "tool",
        author: "agent",
        authorId: "chat_7c1d",
        batchId: "batch_9f2a",
        threadId: "chat_7c1d",
      },
    });

    expect(context.authorId).toBe("chat_7c1d");
    expect(context.author).toBe("agent");
    expect(context.undoOwnerId).toBe("session-a1b2");
  });

  /*
    The same lesson as the line above, one field further on. `authorId` is
    self-asserted and callers move it freely; `verifiedCaller` is the server's
    own answer about who is asking, and a browser has no way to establish one —
    so client-supplied provenance cannot carry one in, however it is typed.

    Two things ride on this. The gate: `sendTestEmail` requires a verified
    caller, and a forgeable field would make that requirement decorative. And
    the wire: this context goes straight to Convex as a mutation argument,
    whose validator rejects fields it does not declare — a field that cannot
    get here is a field production cannot receive before its schema does.
  */
  it("drops a verifiedCaller a client caller tried to assert", () => {
    const context = buildDispatchContext({
      sessionAuthorId: "session-a1b2",
      provenance: {
        authorId: "chat_7c1d",
        verifiedCaller: { isVerified: true, ownerId: "somebody_else" },
      },
    });

    expect(context.verifiedCaller).toBeUndefined();
    expect("verifiedCaller" in context).toBe(false);
    expect(context.authorId).toBe("chat_7c1d");
  });

  it("defaults an ordinary UI edit to the session as both author and owner", () => {
    const context = buildDispatchContext({ sessionAuthorId: "session-a1b2" });

    expect(context).toEqual({
      caller: "frontend",
      author: "user",
      authorId: "session-a1b2",
      undoOwnerId: "session-a1b2",
    });
  });
});
