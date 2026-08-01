import { createStarterDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import {
  acquireEditorStore,
  createEditorStore,
  getActiveEditorStore,
  peekEditorStore,
  releaseEditorStore,
  setActiveEditorStore,
  useEditorStore,
} from "./editor-store";

/**
 * Drafts v2 — the per-document store factory. These tests pin the structural
 * guarantees the multi-frame editing seam depends on: instance isolation
 * (two stores never share document state), the refcounted per-documentId
 * registry, and the active-instance delegation that keeps the historical
 * `useEditorStore.getState()/.subscribe()` consumer surface working across
 * instance swaps.
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
    // One holder remains: still cached.
    expect(peekEditorStore(DOCUMENT_A)).toBe(firstHold);

    releaseEditorStore(DOCUMENT_A);
    // Last holder gone: evicted; the next acquire builds a fresh instance.
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
    // A is no longer active: its updates must not reach the subscription.
    storeA.setState({ notice: "from A again" });

    expect(seenNotices).toEqual(["from A", "from B"]);
    unsubscribe();
    storeB.setState({ notice: "after unsubscribe" });
    expect(seenNotices).toEqual(["from A", "from B"]);
  });
});
