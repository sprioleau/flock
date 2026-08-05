import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockId } from "@flock/email-sdk";
import type { Id } from "@convex/_generated/dataModel";
import {
  selectAnchoredSuggestion,
  useBlockSuggestionSurfaceStore,
  type BlockSuggestionAnchor,
} from "./suggestion-surface-store";

/**
 * The canvas half of the suggestion surface, tested where all the decisions
 * actually live: which shell shows the pill, and what its × costs.
 *
 * The two rules worth breaking a build over:
 *
 * 1. THE PILL BELONGS TO ONE FRAME. Forked sibling drafts share block ids and
 *    several frames render live canvases at once, so a pill matched on block
 *    id alone would appear once per fork.
 * 2. HIDING IS NOT DISMISSING. The chat card's × writes a permanent
 *    per-document pattern dismissal to localStorage. A pill that just
 *    appeared under the cursor must never be able to do that.
 */

const docA = "doc_aaaa" as Id<"documents">;
const docB = "doc_bbbb" as Id<"documents">;
const buttonId = "btn_aaaa" as BlockId;
const otherBlockId = "btn_bbbb" as BlockId;

function makeAnchor(overrides: Partial<BlockSuggestionAnchor> = {}): BlockSuggestionAnchor {
  return {
    documentId: docA,
    blockId: buttonId,
    suggestionId: "suggestion-1",
    title: "Style the other buttons to match?",
    defaultRungId: "section",
    defaultRungLabel: "The other 2 buttons in this section",
    applyDefaultRung: () => {},
    ...overrides,
  };
}

function select(args: {
  anchor: BlockSuggestionAnchor | null;
  hiddenSuggestionId?: string | null;
  blockId?: BlockId;
  documentId?: Id<"documents"> | null;
  isMobilePreview?: boolean;
}): BlockSuggestionAnchor | null {
  return selectAnchoredSuggestion({
    state: {
      anchor: args.anchor,
      hiddenSuggestionId: args.hiddenSuggestionId ?? null,
    },
    blockId: args.blockId ?? buttonId,
    documentId: args.documentId === undefined ? docA : args.documentId,
    isMobilePreview: args.isMobilePreview ?? false,
  });
}

describe("which shell shows the pill", () => {
  it("shows it on the block the suggestion is about", () => {
    const anchor = makeAnchor();
    expect(select({ anchor })).toBe(anchor);
  });

  it("shows nothing when no suggestion is live", () => {
    expect(select({ anchor: null })).toBeNull();
  });

  it("shows nothing on any other block", () => {
    expect(select({ anchor: makeAnchor(), blockId: otherBlockId })).toBeNull();
  });

  it("shows nothing in a sibling draft frame that happens to share the block id", () => {
    // The load-bearing case: forked drafts carry IDENTICAL block ids, so
    // without the document check every fork would sprout the same pill.
    expect(select({ anchor: makeAnchor({ documentId: docA }), documentId: docB })).toBeNull();
  });

  it("shows nothing in a frame with no connected document", () => {
    expect(select({ anchor: makeAnchor({ documentId: docA }), documentId: null })).toBeNull();
  });

  it("shows nothing in the mobile preview — v1 places no canvas chrome there", () => {
    expect(select({ anchor: makeAnchor(), isMobilePreview: true })).toBeNull();
  });

  it("shows nothing once this suggestion has been hidden", () => {
    expect(select({ anchor: makeAnchor(), hiddenSuggestionId: "suggestion-1" })).toBeNull();
  });

  it("still shows a DIFFERENT suggestion after one was hidden", () => {
    const anchor = makeAnchor({ suggestionId: "suggestion-2" });
    expect(select({ anchor, hiddenSuggestionId: "suggestion-1" })).toBe(anchor);
  });
});

describe("the published anchor", () => {
  beforeEach(() => {
    useBlockSuggestionSurfaceStore.setState({
      anchor: null,
      hiddenSuggestionId: null,
      mountedPillCount: 0,
    });
  });

  it("keeps its identity when an equivalent offer is republished", () => {
    // ChatPanel re-renders constantly while the agent streams; the canvas
    // must not rerender with it.
    const { publishAnchor } = useBlockSuggestionSurfaceStore.getState();
    publishAnchor(makeAnchor());
    const first = useBlockSuggestionSurfaceStore.getState().anchor;
    publishAnchor(makeAnchor());
    expect(useBlockSuggestionSurfaceStore.getState().anchor).toBe(first);
  });

  it("replaces itself when the suggestion changes", () => {
    const { publishAnchor } = useBlockSuggestionSurfaceStore.getState();
    publishAnchor(makeAnchor());
    publishAnchor(makeAnchor({ suggestionId: "suggestion-2" }));
    expect(useBlockSuggestionSurfaceStore.getState().anchor?.suggestionId).toBe("suggestion-2");
  });

  it("clears on publish(null) — apply, staleness, and dismissal all land here", () => {
    const { publishAnchor } = useBlockSuggestionSurfaceStore.getState();
    publishAnchor(makeAnchor());
    publishAnchor(null);
    expect(useBlockSuggestionSurfaceStore.getState().anchor).toBeNull();
  });
});

describe("hiding a pill", () => {
  beforeEach(() => {
    useBlockSuggestionSurfaceStore.setState({
      anchor: null,
      hiddenSuggestionId: null,
      mountedPillCount: 0,
    });
  });

  it("hides only the suggestion on screen, never a whole pattern", () => {
    const store = useBlockSuggestionSurfaceStore.getState();
    store.publishAnchor(makeAnchor());
    store.hideAnchoredSuggestion();
    expect(useBlockSuggestionSurfaceStore.getState().hiddenSuggestionId).toBe("suggestion-1");
    expect(select({ anchor: makeAnchor(), hiddenSuggestionId: "suggestion-1" })).toBeNull();
  });

  it("touches no persistence at all — the pattern survives the click", () => {
    // The chat card's × calls persistDismissedPatternKey; this path must not
    // reach storage by ANY route.
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null, removeItem: vi.fn() });
    const store = useBlockSuggestionSurfaceStore.getState();
    store.publishAnchor(makeAnchor());
    store.hideAnchoredSuggestion();
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lets the next suggestion through — the hide does not carry over", () => {
    const store = useBlockSuggestionSurfaceStore.getState();
    store.publishAnchor(makeAnchor());
    store.hideAnchoredSuggestion();
    store.publishAnchor(makeAnchor({ suggestionId: "suggestion-2" }));
    expect(useBlockSuggestionSurfaceStore.getState().hiddenSuggestionId).toBeNull();
  });
});

describe("the mounted-pill count (what makes ⌥A live with the panel collapsed)", () => {
  beforeEach(() => {
    useBlockSuggestionSurfaceStore.setState({
      anchor: null,
      hiddenSuggestionId: null,
      mountedPillCount: 0,
    });
  });

  it("counts a mounted pill and forgets it on unmount", () => {
    const { registerMountedPill } = useBlockSuggestionSurfaceStore.getState();
    const unregister = registerMountedPill();
    expect(useBlockSuggestionSurfaceStore.getState().mountedPillCount).toBe(1);
    unregister();
    expect(useBlockSuggestionSurfaceStore.getState().mountedPillCount).toBe(0);
  });

  it("survives a strict-mode double mount without stranding a phantom pill", () => {
    const { registerMountedPill } = useBlockSuggestionSurfaceStore.getState();
    const first = registerMountedPill();
    const second = registerMountedPill();
    first();
    expect(useBlockSuggestionSurfaceStore.getState().mountedPillCount).toBe(1);
    second();
    expect(useBlockSuggestionSurfaceStore.getState().mountedPillCount).toBe(0);
  });

  it("never goes negative", () => {
    const { registerMountedPill } = useBlockSuggestionSurfaceStore.getState();
    const unregister = registerMountedPill();
    unregister();
    unregister();
    expect(useBlockSuggestionSurfaceStore.getState().mountedPillCount).toBe(0);
  });
});
