import { describe, expect, it } from "vitest";
import { PALETTE_GROUPS } from "../add-blocks/palette-items";
import { computeQuickAddMenuPosition, QUICK_ADD_ITEMS } from "./use-hold-to-quick-add";

describe("QUICK_ADD_ITEMS", () => {
  it("derives every leaf palette item, in palette order (never hardcoded)", () => {
    const leafIds = PALETTE_GROUPS.flatMap((group) => group.items)
      .filter((item) => item.kind === "leaf")
      .map((item) => item.id);
    expect(QUICK_ADD_ITEMS.map((item) => item.id)).toEqual(leafIds);
    expect(QUICK_ADD_ITEMS.length).toBeGreaterThan(0);
  });

  it("contains only leaf items", () => {
    expect(QUICK_ADD_ITEMS.every((item) => item.kind === "leaf")).toBe(true);
  });
});

describe("computeQuickAddMenuPosition", () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 800 };
  const menu = { menuWidth: 176, menuHeight: 160 };

  it("offsets toward the bottom-right of the pointer", () => {
    const position = computeQuickAddMenuPosition({
      pointer: { x: 100, y: 100 },
      ...menu,
      ...viewport,
    });
    expect(position).toEqual({ left: 114, top: 114 });
  });

  it("flips left of the pointer at the right viewport edge", () => {
    const position = computeQuickAddMenuPosition({
      pointer: { x: 980, y: 100 },
      ...menu,
      ...viewport,
    });
    expect(position.left).toBe(980 - 14 - 176);
    expect(position.top).toBe(114);
  });

  it("flips above the pointer at the bottom viewport edge", () => {
    const position = computeQuickAddMenuPosition({
      pointer: { x: 100, y: 790 },
      ...menu,
      ...viewport,
    });
    expect(position.left).toBe(114);
    expect(position.top).toBe(790 - 14 - 160);
  });

  it("never leaves the 8px viewport margin, even in a corner", () => {
    const position = computeQuickAddMenuPosition({
      pointer: { x: 5, y: 5 },
      menuWidth: 990,
      menuHeight: 790,
      ...viewport,
    });
    expect(position.left).toBe(8);
    expect(position.top).toBe(8);
  });
});
