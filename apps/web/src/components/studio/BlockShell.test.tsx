import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyDocument,
  type Block,
  type BlockId,
  type BlockType,
} from "@flock/email-sdk";
import { getBlockLevelAccent } from "@/lib/block-level-accent";
import { createDefaultColumnsPreset, createDefaultSection } from "./block-defaults";

/*
  The shell's OUTLINE STATE MACHINE, checked without a DOM (vitest.config.ts
  pins `environment: "node"`): the component is called as a plain function
  over stubbed hooks and the className it computes is read off the element it
  returns. Placement is CSS and belongs to the browser pass; the class string
  is where the real bugs live, because `cn` is tailwind-merge and a later
  conflicting class silently deletes an earlier one.

  Three things are load-bearing here:
  - each block outlines itself in ITS OWN level's colour;
  - selected is SOLID, a chip-hover preview is DASHED, and selection wins;
  - the drag-and-drop container highlight is a SEPARATE feature and still
    survives the merge intact on top of any level colour.
*/

interface EditorStubState {
  selectedBlockId: BlockId | null;
  editingBlockId: BlockId | null;
  hoverPreviewBlockId: BlockId | null;
}

const editorState: EditorStubState = vi.hoisted(() => ({
  selectedBlockId: null,
  editingBlockId: null,
  hoverPreviewBlockId: null,
}));

const dragState: { dropContainerId: BlockId | null } = vi.hoisted(() => ({
  dropContainerId: null,
}));

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: (selector: (state: unknown) => unknown) =>
    selector({
      ...editorState,
      documentId: "doc_aaaa",
      selectBlock: vi.fn(),
      startTextEditing: vi.fn(),
    }),
}));

vi.mock("./dnd/drag-drop-store", () => ({
  buildCanvasDraggableId: () => "doc_aaaa:blk",
  /*
    The shell's own selector reads dragSource/dropTarget; feeding it a shaped
    state keeps THAT predicate under test rather than stubbing its result.
  */
  useCanvasDragStore: (selector: (state: unknown) => unknown) =>
    selector({
      dragSource: dragState.dropContainerId === null ? null : { kind: "palette" },
      dropTarget:
        dragState.dropContainerId === null
          ? null
          : {
              isNoop: false,
              kind: "insert",
              parentId: dragState.dropContainerId,
              documentId: "doc_aaaa",
            },
    }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    isDragging: false,
  }),
}));

/*
  Selection chrome and presence chrome are their own components' business.
*/
vi.mock("./BlockActionRow", () => ({ BlockActionRow: () => null }));
vi.mock("./BlockBreadcrumb", () => ({ BlockBreadcrumb: () => null }));
vi.mock("./BlockSuggestionPill", () => ({ BlockSuggestionPill: () => null }));
vi.mock("./presence/BlockPresenceIndicator", () => ({ BlockPresenceIndicator: () => null }));

import { BlockShell } from "./BlockShell";

/*
  One real block of each level, built with the app's own factories so the
  types under test are the ones the schema actually produces.
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
const everyLevel = [leaf, column, row, section];

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function shellClassName(block: Block): string {
  const element = BlockShell({ block, children: null }) as ElementWithProps;
  return String(element.props.className ?? "");
}

beforeEach(() => {
  editorState.selectedBlockId = null;
  editorState.editingBlockId = null;
  editorState.hoverPreviewBlockId = null;
  dragState.dropContainerId = null;
});

describe("the selected block", () => {
  it("outlines itself SOLID in its own level's colour", () => {
    for (const block of everyLevel) {
      editorState.selectedBlockId = block.id;
      const accent = getBlockLevelAccent({ block });
      const className = shellClassName(block);
      expect(className).toContain(`after:border-${accent.hue}-500`);
      expect(className).toContain("after:border-solid");
      expect(className).not.toContain("after:border-dashed");
    }
  });

  it("gives the four levels four different outlines", () => {
    const outlines = everyLevel.map((block) => {
      editorState.selectedBlockId = block.id;
      return shellClassName(block);
    });
    expect(new Set(outlines).size).toBe(4);
  });

  it("keeps the content block on the sky blue it has always used", () => {
    editorState.selectedBlockId = leaf.id;
    expect(shellClassName(leaf)).toContain("after:border-sky-500");
  });

  it("raises itself to z-10 so its chrome sits above every outline", () => {
    editorState.selectedBlockId = section.id;
    expect(shellClassName(section)).toContain("z-10");
  });
});

describe("the chip-hover preview", () => {
  it("outlines the previewed ancestor DASHED, in that ancestor's colour", () => {
    for (const block of [column, row, section]) {
      editorState.selectedBlockId = leaf.id;
      editorState.hoverPreviewBlockId = block.id;
      const accent = getBlockLevelAccent({ block });
      const className = shellClassName(block);
      expect(className).toContain("after:border-dashed");
      expect(className).toContain(`after:border-${accent.hue}-500`);
    }
  });

  it("differs from the selected outline ONLY in stroke style", () => {
    /*
      Clicking the chip must not make the outline move, resize, or recolour.
    */
    editorState.selectedBlockId = leaf.id;
    editorState.hoverPreviewBlockId = section.id;
    const previewed = shellClassName(section);

    editorState.hoverPreviewBlockId = null;
    editorState.selectedBlockId = section.id;
    const selected = shellClassName(section);

    expect(previewed.replace("dashed", "solid")).toBe(selected.replace(" z-10", ""));
  });

  it("never dashes the block that is ALSO the selection", () => {
    /*
      A stale preview id must not downgrade the real selection's outline.
    */
    editorState.selectedBlockId = section.id;
    editorState.hoverPreviewBlockId = section.id;
    const className = shellClassName(section);
    expect(className).toContain("after:border-solid");
    expect(className).not.toContain("after:border-dashed");
  });

  it("leaves every OTHER block on the faint pointer hairline", () => {
    editorState.selectedBlockId = leaf.id;
    editorState.hoverPreviewBlockId = section.id;
    const className = shellClassName(row);
    expect(className).toContain("hover:after:border");
    expect(className).toContain(`after:border-${getBlockLevelAccent({ block: row }).hue}-300`);
    expect(className).not.toContain("after:border-2");
  });
});

describe("the drag-and-drop container highlight", () => {
  it("still paints its own sky tint and stroke on a valid drop container", () => {
    dragState.dropContainerId = column.id;
    const className = shellClassName(column);
    expect(className).toContain("bg-sky-400/10");
    expect(className).toContain("after:border-sky-300");
  });

  it("survives tailwind-merge on an ORANGE row — the level colour must not eat it", () => {
    /*
      Rows are a likely drop target and are now orange, so this is the pair
      most at risk: `cn` drops earlier conflicting classes, and the drop
      highlight is declared LAST precisely so it wins during a drag.
    */
    dragState.dropContainerId = row.id;
    const className = shellClassName(row);
    expect(className).toContain("bg-sky-400/10");
    expect(className).toContain("after:border-sky-300");
    expect(className).not.toContain("after:border-orange-300");
    expect(className).not.toContain("after:border-orange-500");
  });

  it("wins over a SELECTED block's outline, exactly as it did before", () => {
    dragState.dropContainerId = section.id;
    editorState.selectedBlockId = section.id;
    const className = shellClassName(section);
    expect(className).toContain("after:border-sky-300");
    expect(className).not.toContain("after:border-fuchsia-500");
  });

  it("stays off every block that is not the drop target", () => {
    dragState.dropContainerId = column.id;
    expect(shellClassName(row)).not.toContain("bg-sky-400/10");
  });

  it("stays off entirely when nothing is being dragged", () => {
    dragState.dropContainerId = null;
    for (const block of everyLevel) {
      expect(shellClassName(block)).not.toContain("bg-sky-400/10");
    }
  });
});
