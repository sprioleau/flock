import { createStarterDocument } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { createEditorStore } from "@/lib/editor-store";
import {
  bindQuickPromptToBlock,
  computeQuickPromptPlacement,
  type AnchorRect,
} from "./use-quick-prompt-anchor";

/*
  The two halves of the cursor binding that can be proven without a browser:
  the placement maths (pure), and the fact that opening over a block SELECTS
  it — which is the entire reason the feature is worth having, since the chat
  transport turns that selection into the model's referent for "this".

  Deliberately absent: anything about rendered position, focus, or textarea
  height. These tests run in node, and asserting them here would prove only
  that jsdom exists.
*/

const VIEWPORT = { viewportWidth: 1200, viewportHeight: 800 };
const CARD = { cardWidth: 450, cardHeight: 240 };

/*
  A block sitting comfortably mid-canvas, with room above and below.
*/
const MID_CANVAS_BLOCK: AnchorRect = { left: 400, top: 300, right: 800, bottom: 360 };

describe("computeQuickPromptPlacement", () => {
  it("returns null with no anchor, so the card falls back to centered", () => {
    expect(computeQuickPromptPlacement({ anchor: null, ...CARD, ...VIEWPORT })).toBeNull();
  });

  it("centres on the pointer and sits in the gutter below the block", () => {
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 600, y: 330 }, blockRect: MID_CANVAS_BLOCK },
      ...CARD,
      ...VIEWPORT,
    });
    expect(placement).toEqual({ left: 600 - 225, top: 360 + 10 });
  });

  it("flips to the gutter above when the card would not fit below", () => {
    /*
      Bottom-anchored block: only the space above it can hold the card.
    */
    const lowBlock: AnchorRect = { left: 400, top: 600, right: 800, bottom: 700 };
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 600, y: 650 }, blockRect: lowBlock },
      ...CARD,
      ...VIEWPORT,
    });
    expect(placement).toEqual({ left: 375, top: 600 - 10 - 240 });
  });

  it("clamps to the left margin when the pointer is at the left edge", () => {
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 4, y: 330 }, blockRect: MID_CANVAS_BLOCK },
      ...CARD,
      ...VIEWPORT,
    });
    expect(placement?.left).toBe(8);
  });

  it("clamps to the right margin when the pointer is at the right edge", () => {
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 1196, y: 330 }, blockRect: MID_CANVAS_BLOCK },
      ...CARD,
      ...VIEWPORT,
    });
    expect(placement?.left).toBe(1200 - 450 - 8);
  });

  it("keeps a card taller than both gutters fully on screen at a corner", () => {
    /*
      A block filling the viewport: neither gutter fits, overlap is forced.
    */
    const fullBleedBlock: AnchorRect = { left: 0, top: 0, right: 1200, bottom: 800 };
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 1198, y: 798 }, blockRect: fullBleedBlock },
      ...CARD,
      ...VIEWPORT,
    });
    expect(placement).toEqual({ left: 1200 - 450 - 8, top: 800 - 240 - 8 });
  });

  it("keeps the card on screen when the viewport is narrower than the card", () => {
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 150, y: 330 }, blockRect: MID_CANVAS_BLOCK },
      ...CARD,
      viewportWidth: 320,
      viewportHeight: 800,
    });
    expect(placement?.left).toBe(8);
  });

  it("ignores a block scrolled off the top and falls back to the pointer", () => {
    const scrolledPastBlock: AnchorRect = { left: 400, top: -400, right: 800, bottom: -60 };
    const placement = computeQuickPromptPlacement({
      anchor: { pointer: { x: 600, y: 120 }, blockRect: scrolledPastBlock },
      ...CARD,
      ...VIEWPORT,
    });
    expect(placement).toEqual({ left: 375, top: 130 });
  });
});

describe("bindQuickPromptToBlock", () => {
  const blockRect: AnchorRect = { left: 0, top: 0, right: 100, bottom: 40 };
  const pointer = { x: 50, y: 20 };

  it("selects the block, which is what carries it to the model", () => {
    const editorStore = createEditorStore();
    editorStore.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 1 });

    const anchor = bindQuickPromptToBlock({
      blockId: "btn_ct01",
      blockRect,
      pointer,
      editorStore,
    });

    expect(anchor?.blockId).toBe("btn_ct01");
    expect(editorStore.getState().selectedBlockId).toBe("btn_ct01");
  });

  it("describes the block and its parents, so the user sees what 'this' means", () => {
    const editorStore = createEditorStore();
    editorStore.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 1 });

    const anchor = bindQuickPromptToBlock({
      blockId: "btn_ct01",
      blockRect,
      pointer,
      editorStore,
    });

    expect(anchor?.breadcrumb).toBe("Section › Button");
    expect(anchor?.blockType).toBe("Button");
    expect(anchor?.textSnippet).toBeTypeOf("string");
  });

  it("binds nothing when the id is not in the doc, rather than a phantom selection", () => {
    const editorStore = createEditorStore();
    editorStore.getState().applyServerSnapshot({ doc: createStarterDocument(), headVersion: 1 });
    editorStore.getState().selectBlock("sec_hero");

    const anchor = bindQuickPromptToBlock({
      blockId: "btn_gone01",
      blockRect,
      pointer,
      editorStore,
    });

    expect(anchor).toBeNull();
    expect(editorStore.getState().selectedBlockId).toBe("sec_hero");
  });
});
