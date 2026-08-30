import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyDocument,
  type Block,
  type BlockId,
  type BlockType,
  type EmailDocument,
} from "@flock/email-sdk";
import { getBlockLevelAccent } from "@/lib/block-level-accent";
import { createDefaultColumnsPreset, createDefaultSection } from "./block-defaults";

/*
  The chip stack's COLOUR CONTRACT and its hover wiring, checked the way this
  app checks components: there is no DOM here (vitest.config.ts pins
  `environment: "node"`), so the component is called as a plain function over
  a stubbed store and the element tree it returns is walked.

  What matters and is provable here: every chip is painted in ITS OWN nesting
  level's colour (so the SECTION pill is the section's magenta, not a shared
  grey), the selected chip is the filled variant while ancestors are the
  tinted one, and pointing at an ancestor chip arms the shared hover preview
  with THAT ancestor's id — which is the entire mechanism behind the dashed
  outline BlockShell draws.
*/

const setHoverPreviewBlock = vi.hoisted(() => vi.fn());
const selectBlock = vi.hoisted(() => vi.fn());
const docRef: { current: EmailDocument | undefined } = vi.hoisted(() => ({
  current: undefined,
}));

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: unknown) => unknown) =>
    selector({ doc: docRef.current, selectBlock, setHoverPreviewBlock }),
}));

import { BlockBreadcrumb } from "./BlockBreadcrumb";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
  };
  visit(node);
  return found;
}

/*
  A real four-deep document — section › row › column › spacer — built with
  the app's own block factories, so the trail these tests walk is the one the
  schema actually produces rather than a hand-rolled shape.
*/
const section = createDefaultSection("sec_aaaa");
const preset = createDefaultColumnsPreset({
  columnCount: 2,
  sectionId: section.id,
  doc: createEmptyDocument(),
});

function requireBlock(type: BlockType): Block {
  const found = preset.blocks.find((block) => block.type === type);
  if (found === undefined) {
    throw new Error(`the columns preset produced no ${type} block`);
  }
  return found;
}

const row = requireBlock("row");
const column = requireBlock("column");
const leaf = requireBlock("spacer");

const doc: EmailDocument = {
  ...createEmptyDocument(),
  [section.id]: section,
  ...Object.fromEntries(preset.blocks.map((block) => [block.id, block])),
};

/*
  The chip element for one block in the rendered stack.
*/
function chipFor(selectedId: BlockId, chipBlockId: BlockId): ElementWithProps {
  const chip = collectElements(BlockBreadcrumb({ blockId: selectedId })).find(
    (element) => element.props["data-testid"] === `block-breadcrumb-chip-${chipBlockId}`,
  );
  if (chip === undefined) {
    throw new Error(`no chip rendered for ${chipBlockId}`);
  }
  return chip;
}

function classNameOf(element: ElementWithProps): string {
  return String(element.props.className ?? "");
}

beforeEach(() => {
  docRef.current = doc;
  setHoverPreviewBlock.mockReset();
  selectBlock.mockReset();
});

describe("the stack", () => {
  it("shows one chip per nesting level, innermost first", () => {
    const levels = collectElements(BlockBreadcrumb({ blockId: leaf.id }))
      .filter((element) => element.props["data-block-level"] !== undefined)
      .map((element) => element.props["data-block-level"]);
    expect(levels).toEqual(["content", "column", "row", "section"]);
  });
});

describe("chip colours", () => {
  it("paints every chip in ITS OWN level's hue, not the selection's", () => {
    /*
      The owner's requirement: the section label pill corresponds to the
      section. Selecting the innermost leaf must still give the section chip
      the section's magenta and the column chip the column's violet.
    */
    for (const block of [leaf, column, row, section]) {
      const accent = getBlockLevelAccent({ block });
      expect(classNameOf(chipFor(leaf.id, block.id))).toContain(accent.hue);
    }
  });

  it("gives each chip the hue the shell outlines that same block in", () => {
    /*
      Chip and outline come from ONE accent record, so agreement is
      structural — this pins that the component reads the right field of it.
    */
    const sectionAccent = getBlockLevelAccent({ block: section });
    expect(classNameOf(chipFor(leaf.id, section.id))).toContain(sectionAccent.ancestorChipClassName);
    expect(sectionAccent.hoverPreviewOutlineClassName).toContain(sectionAccent.hue);
  });

  it("tells the four levels apart — no two chips share a hue", () => {
    const hues = [leaf, column, row, section].map((block) => getBlockLevelAccent({ block }).hue);
    expect(new Set(hues).size).toBe(4);
  });

  it("fills the SELECTED chip and only tints the ancestors", () => {
    const selectedChip = chipFor(row.id, row.id);
    expect(selectedChip.props["aria-current"]).toBe("true");
    expect(classNameOf(selectedChip)).toContain(getBlockLevelAccent({ block: row }).selectedChipClassName);

    const ancestorChip = chipFor(row.id, section.id);
    expect(ancestorChip.props["aria-current"]).toBeUndefined();
    expect(classNameOf(ancestorChip)).toContain(
      getBlockLevelAccent({ block: section }).ancestorChipClassName,
    );
  });

  it("changes the SAME block's chip from tinted to filled when it becomes the selection", () => {
    const asAncestor = classNameOf(chipFor(leaf.id, section.id));
    const asSelected = classNameOf(chipFor(section.id, section.id));
    expect(asAncestor).not.toBe(asSelected);
    /*
      Both are still the section's own hue — only the emphasis moves.
    */
    expect(asAncestor).toContain("fuchsia");
    expect(asSelected).toContain("fuchsia");
  });
});

describe("hover preview", () => {
  it("arms the preview with the ANCESTOR's id, not the selection's", () => {
    const chip = chipFor(leaf.id, column.id);
    (chip.props.onMouseEnter as () => void)();
    expect(setHoverPreviewBlock).toHaveBeenCalledWith(column.id);
  });

  it("clears the preview on the way out", () => {
    const chip = chipFor(leaf.id, section.id);
    (chip.props.onMouseLeave as () => void)();
    expect(setHoverPreviewBlock).toHaveBeenCalledWith(null);
  });

  it("previews on focus too — these are buttons and must answer to Tab", () => {
    const chip = chipFor(leaf.id, row.id);
    (chip.props.onFocus as () => void)();
    expect(setHoverPreviewBlock).toHaveBeenCalledWith(row.id);
    (chip.props.onBlur as () => void)();
    expect(setHoverPreviewBlock).toHaveBeenLastCalledWith(null);
  });

  it("never lets the selected chip preview itself — its outline is already solid", () => {
    const selectedChip = chipFor(leaf.id, leaf.id);
    expect(selectedChip.props.onMouseEnter).toBeUndefined();
    expect(selectedChip.props.onFocus).toBeUndefined();
  });
});

describe("clicking an ancestor", () => {
  it("selects it, so the dashed preview becomes that block's solid outline", () => {
    const chip = chipFor(leaf.id, section.id);
    const event = { stopPropagation: vi.fn() };
    (chip.props.onClick as (event: unknown) => void)(event);
    expect(selectBlock).toHaveBeenCalledWith(section.id);
    /*
      Without this the shell underneath re-selects the block being left.
    */
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("keeps every ancestor chip a plain button, never a Base UI control", () => {
    for (const block of [column, row, section]) {
      const chip = chipFor(leaf.id, block.id);
      expect(chip.type).toBe("button");
      expect(chip.props.type).toBe("button");
    }
  });
});
